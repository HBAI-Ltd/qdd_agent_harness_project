//! Session-scoped MCP dispatch. The physical phone and input controller are shared,
//! while screenshots and calibration tickets belong to one caller only.
use crate::screen::{PointerCalibrationPoint, PointerCalibrationState, ScreenCapture};
use crate::{Cancel, Result};
use anyhow::{anyhow, bail, ensure};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{
  atomic::{AtomicBool, AtomicU64, Ordering},
  Arc, Mutex,
};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub type Guard = Arc<dyn Fn() -> Result<()> + Send + Sync>;

const MAX_TOOL_REQUEST_IDS: usize = 4096;

fn request_key(id: &Value) -> [u8; 32] {
  Sha256::digest(id.to_string().as_bytes()).into()
}

/// Names passed to `input` are the existing android_* tool names. In addition,
/// android_pointer_to receives x/y/buttons/wheel for a bound browser pointer.
pub trait Backend: Send + Sync {
  fn pointer_calibration(&self, serial: &str, cancel: &Cancel) -> Result<PointerCalibrationState>;
  fn capture(&self, serial: Option<&str>, preview: bool, cancel: &Cancel) -> Result<ScreenCapture>;
  fn input(&self, name: &str, args: &Value, cancel: &Cancel, guard: Option<Guard>)
    -> Result<Value>;
  fn submit_remote(
    &self,
    report: Value,
    cancel: Cancel,
  ) -> Result<Box<dyn FnOnce() -> Result<Value> + Send>>;
  fn arm(&self, cancel: &Cancel) -> Result<(Value, u64)>;
  fn release(&self, cancel: &Cancel) -> Result<(Value, u64)>;
  fn state(&self) -> Value;
  fn control_epoch(&self) -> u64;
  fn input_revision(&self) -> u64;
  fn observe(&self, capture: &ScreenCapture) -> Result<()>;
  fn reset_calibration(&self);
  fn stop(&self) -> Result<()>;
  fn stop_if_epoch(&self, expected: u64) -> Result<bool>;
  fn devices(&self) -> Result<Value>;
  fn profile(&self, selected: Option<&str>, cancel: &Cancel) -> Result<Value>;
}

#[derive(Clone)]
struct Frame {
  capture: ScreenCapture,
  id: String,
  observed: Instant,
  epoch: u64,
}

#[derive(Clone)]
struct Probe {
  id: String,
  created: Instant,
  epoch: u64,
  input_epoch: u64,
  revision: u64,
  serial: String,
  width: u32,
  height: u32,
  rotation: u8,
  dx: i64,
  dy: i64,
}

pub struct Session {
  pub id: String,
  pub protocol_version: Mutex<String>,
  frame: Mutex<Option<Frame>>,
  probe: Mutex<Option<Probe>>,
  // A completed call retains only its ID digest, never arguments or a response.
  // Read-only IDs are retained too: reusing one for input would let a delayed
  // cancellation of the old observation cancel an unrelated new action.
  calls: Mutex<HashMap<[u8; 32], Option<Cancel>>>,
  closed: AtomicBool,
  pub event_stream: AtomicBool,
}

impl Session {
  fn new() -> Self {
    Self {
      id: Uuid::new_v4().to_string(),
      protocol_version: Mutex::new("2025-03-26".into()),
      frame: Mutex::new(None),
      probe: Mutex::new(None),
      calls: Mutex::new(HashMap::new()),
      closed: AtomicBool::new(false),
      event_stream: AtomicBool::new(false),
    }
  }
  pub fn is_closed(&self) -> bool {
    self.closed.load(Ordering::SeqCst)
  }
}

#[derive(Clone, PartialEq)]
struct Geometry {
  serial: String,
  width: u32,
  height: u32,
  rotation: u8,
}

pub struct Mcp {
  pub backend: Arc<dyn Backend>,
  sessions: Mutex<HashMap<String, Arc<Session>>>,
  owner: Mutex<Option<String>>,
  observation: Mutex<Option<Geometry>>,
  epoch: AtomicU64,
  controls: Mutex<()>,
  specs: Value,
}

pub const INSTRUCTIONS: &str = "Observe the device with android_screenshot, then prefer android_control with its frameId. It prepares input, executes one action once and returns a real newer phone image captured after completion. Before a coordinate tap use android_preview_tap to inspect a SIMULATED TARGET and 2x local zoom; this sends no HID and does not prove physical mouse accuracy. Use calibrated hover to observe the real cursor before a separate click only if this phone includes its system cursor in capture. Coordinates are original phone pixels; relative move uses HID counts. Relative move/click, scroll, key, home and back need no calibration. Prefer android_pointer_calibration phase auto after the user manually opens Pointer calibration in the phone App; it measures actual mouse events even if system cursor capture is unavailable, sends no click and cannot open the page. Otherwise probe returns BEFORE/AFTER images and finish computes scales from visible real cursor centers without further movement. When probe says measurable:false, no finish ticket exists: never invent positions or gain. Coordinate tap/hover/swipe require measured calibration. Keep this session's latest frameId and probeId. Intervening input invalidates calibration tickets. Coordinates remain estimates under mouse acceleration. Button presses automatically wait for recent movement to settle; no extra per-click sleep is needed. CONFIGURING, paused input and ACK timeout are instrument failures, not evidence the target App failed. Home/back ACK confirms HID delivery only, not OEM navigation success; inspect the result rather than repeat blindly. Never use ADB input as a fallback. Input is through the ESP32 BLE keyboard/mouse using Wi-Fi TCP or USB serial. Legacy input tools require android_hid_arm and a separate screenshot. If input completed but its image failed, never repeat it blindly; observe again. Physical emergency stop can be cleared only on the board. ASCII uses short HID pulses. Non-ASCII text up to 512 UTF-8 bytes uses the user-selected QDD device IME over encrypted ESP BLE. In the phone App select the current controller, enable and select Device Chinese Input once, then focus the target editable field. Keep that IME selected for continuous use; switching away requires selecting it again. No accessibility service or clipboard is used. BEGIN/DATA uploads one transaction; COMMIT is sent once and only STATUS is polled. accepted means the current InputConnection accepted the text, while insertionVerified remains false. Inspect the new real phone image before continuing. Lost ACK, cancellation or timeout is uncertain and must never be blindly resubmitted. Clipboard receiver modes are rejected before uploading text and never trigger a paste. Each tools/call request ID is single-use within a session; use a new ID only for an intentional new action, and renew the session at 4096 calls. No model API key is required.";

impl Mcp {
  pub fn new(backend: Arc<dyn Backend>) -> Arc<Self> {
    Arc::new(Self {
      backend,
      sessions: Mutex::new(HashMap::new()),
      owner: Mutex::new(None),
      observation: Mutex::new(None),
      epoch: AtomicU64::new(0),
      controls: Mutex::new(()),
      specs: serde_json::from_str(crate::assets::TOOLS_JSON).expect("embedded tool schemas"),
    })
  }

  pub fn create_session(&self) -> Result<Arc<Session>> {
    let mut sessions = self.sessions.lock().unwrap();
    ensure!(
      sessions.len() < 32,
      "Too many MCP sessions. Close an existing session first."
    );
    let session = Arc::new(Session::new());
    sessions.insert(session.id.clone(), session.clone());
    Ok(session)
  }

  pub fn session(&self, id: &str) -> Option<Arc<Session>> {
    self.sessions.lock().unwrap().get(id).cloned()
  }
  pub fn owns_input(&self, session: &str) -> bool {
    self.owner.lock().unwrap().as_deref() == Some(session)
  }
  pub fn has_session(&self, id: &str) -> bool {
    self.session(id).is_some_and(|s| !s.is_closed())
  }
  pub fn close_session(&self, session: &Arc<Session>) {
    if session.closed.swap(true, Ordering::SeqCst) {
      return;
    }
    self.sessions.lock().unwrap().remove(&session.id);
    for cancel in session.calls.lock().unwrap().values().flatten() {
      cancel.cancel();
    }
    let mut owner = self.owner.lock().unwrap();
    let cleanup_epoch = if owner.as_deref() == Some(&session.id) {
      let epoch = self.backend.control_epoch();
      *owner = None;
      Some(epoch)
    } else {
      None
    };
    drop(owner);
    if let Some(epoch) = cleanup_epoch {
      let _ = self.backend.stop_if_epoch(epoch);
    }
  }

  pub fn close(&self) {
    let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
    for session in sessions {
      self.close_session(&session);
    }
  }

  pub fn is_mutating(&self, name: &str, args: &Value) -> bool {
    self
      .specs
      .as_array()
      .unwrap()
      .iter()
      .any(|spec| spec["name"] == name && spec["annotations"]["readOnlyHint"] != true)
      && !(name == "android_control" && args["action"] == "wait")
      && !(name == "android_pointer_calibration" && args["phase"] == "finish")
  }

  fn claim(&self, session: &Arc<Session>) -> Result<()> {
    let mut owner = self.owner.lock().unwrap();
    ensure!(!session.is_closed(), "MCP session closed.");
    *owner = Some(session.id.clone());
    Ok(())
  }

  pub fn observe(&self, capture: &ScreenCapture) -> Result<()> {
    let next = Geometry {
      serial: capture.serial.clone(),
      width: capture.device_width,
      height: capture.device_height,
      rotation: capture.rotation.unwrap_or(0),
    };
    let mut current = self.observation.lock().unwrap();
    if current.as_ref().is_some_and(|old| old != &next) {
      self.epoch.fetch_add(1, Ordering::SeqCst);
      let stopped = self.backend.stop();
      self.backend.reset_calibration();
      *current = Some(next);
      self.backend.observe(capture)?;
      stopped?;
    } else {
      *current = Some(next);
      self.backend.observe(capture)?;
    }
    Ok(())
  }

  pub fn visual_lost(&self) {
    self.epoch.fetch_add(1, Ordering::SeqCst);
    let _ = self.backend.stop();
  }

  pub fn read_live(&self, cancel: &Cancel) -> Result<ScreenCapture> {
    check(cancel)?;
    let capture = self.backend.capture(None, true, cancel)?;
    check(cancel)?;
    self.observe(&capture)?;
    Ok(capture)
  }

  fn require_frame(&self, session: &Session, args: &Value) -> Result<Frame> {
    let frame_id = text(args, "frameId")?;
    let frame = session.frame.lock().unwrap().clone().ok_or_else(|| {
      anyhow!("Screenshot is missing or superseded. Call android_screenshot again.")
    })?;
    ensure!(
      !session.is_closed()
        && frame.id == frame_id
        && frame.epoch == self.epoch.load(Ordering::SeqCst),
      "Screenshot is missing or superseded. Call android_screenshot again."
    );
    ensure!(
      frame.observed.elapsed() <= Duration::from_secs(30),
      "Screenshot has expired. Call android_screenshot again."
    );
    Ok(frame)
  }

  fn guard(self: &Arc<Self>, session: &Arc<Session>, args: &Value) -> Result<Guard> {
    let id = self.require_frame(session, args)?.id;
    let this = Arc::downgrade(self);
    let session = session.clone();
    Ok(Arc::new(move || {
      this
        .upgrade()
        .ok_or_else(|| anyhow!("MCP service closed."))?
        .require_frame(&session, &json!({"frameId":id}))?;
      Ok(())
    }))
  }

  fn probe_guard(
    self: &Arc<Self>,
    session: &Arc<Session>,
    args: &Value,
    epoch: u64,
    input_epoch: u64,
    revision: u64,
  ) -> Result<Guard> {
    let frame = self.guard(session, args)?;
    let this = Arc::downgrade(self);
    let owner = session.id.clone();
    Ok(Arc::new(move || {
      frame()?;
      let this = this
        .upgrade()
        .ok_or_else(|| anyhow!("MCP service closed."))?;
      ensure!(
        this.owns_input(&owner)
          && this.epoch.load(Ordering::SeqCst) == epoch
          && this.backend.control_epoch() == input_epoch
          && this.backend.input_revision() == revision,
        "Input, owner or phone changed before the calibration movement could execute."
      );
      Ok(())
    }))
  }

  fn point(&self, session: &Session, args: &Value, x_key: &str, y_key: &str) -> Result<(u32, u32)> {
    let frame = self.require_frame(session, args)?;
    let (x, y) = (integer(args, x_key, None)?, integer(args, y_key, None)?);
    match args
      .get("coordinateSpace")
      .and_then(Value::as_str)
      .unwrap_or("pixels")
    {
      "normalized1000" => {
        ensure!(
          (0..=1000).contains(&x) && (0..=1000).contains(&y),
          "Normalized coordinates must be in 0..1000."
        );
        Ok((
          ((x as f64 * (frame.capture.width - 1) as f64 / 1000.0) + 0.5).floor() as u32,
          ((y as f64 * (frame.capture.height - 1) as f64 / 1000.0) + 0.5).floor() as u32,
        ))
      }
      "pixels" => {
        ensure!(
          x >= 0 && x < frame.capture.width as i64 && y >= 0 && y < frame.capture.height as i64,
          "Coordinates fall outside the latest screenshot."
        );
        Ok((x as u32, y as u32))
      }
      _ => bail!("coordinateSpace must be pixels or normalized1000."),
    }
  }

  fn snapshot(&self, session: &Session, capture: ScreenCapture, extra: Value) -> Result<Value> {
    self.snapshot_expected(session, capture, extra, None)
  }
  fn snapshot_expected(
    &self,
    session: &Session,
    capture: ScreenCapture,
    extra: Value,
    expected: Option<&str>,
  ) -> Result<Value> {
    let geometry = self.observation.lock().unwrap();
    ensure!(
      geometry
        .as_ref()
        .is_some_and(|current| current.serial == capture.serial
          && current.width == capture.device_width
          && current.height == capture.device_height
          && current.rotation == capture.rotation.unwrap_or(0)),
      "Phone or display geometry changed before publishing the image; observe again."
    );
    ensure!(!session.is_closed(), "MCP session closed.");
    let mut frame = session.frame.lock().unwrap();
    if let Some(expected) = expected {
      ensure!(
        frame.as_ref().is_some_and(
          |frame| frame.id == expected && frame.epoch == self.epoch.load(Ordering::SeqCst)
        ),
        "Screenshot was superseded before this observation completed; observe again."
      );
    }
    let id = Uuid::new_v4().to_string();
    let mut metadata = capture.metadata();
    let object = metadata
      .as_object_mut()
      .ok_or_else(|| anyhow!("Invalid capture metadata."))?;
    object.insert("frameId".into(), json!(id));
    object.insert("deviceSerial".into(), json!(capture.serial));
    object.insert("sha256".into(), json!(hash(&capture.bytes)));
    object.insert("input".into(), self.backend.state());
    object.insert("note".into(),json!("Coordinates refer to this session's latest image. Relative HID position is estimated; phone and rotation changes invalidate all sessions' old frames."));
    if let Some(extra) = extra.as_object() {
      object.extend(extra.clone());
    }
    *frame = Some(Frame {
      capture: capture.clone(),
      id,
      observed: Instant::now(),
      epoch: self.epoch.load(Ordering::SeqCst),
    });
    Ok(
      json!({"content":[{"type":"text","text":metadata.to_string()}, image(&capture.bytes,&capture.mime_type)],"structuredContent":metadata}),
    )
  }

  /// Handle one JSON-RPC message. Notifications produce no JSON-RPC response.
  pub fn handle(
    self: &Arc<Self>,
    session: &Arc<Session>,
    message: &Value,
    external: &Cancel,
  ) -> Option<Value> {
    self.handle_tracked(session, message, external, None)
  }

  pub fn handle_tracked(
    self: &Arc<Self>,
    session: &Arc<Session>,
    message: &Value,
    external: &Cancel,
    round: Option<&AtomicU64>,
  ) -> Option<Value> {
    self.handle_tracked_with_hook(session, message, external, round, None)
  }

  /// HTTP input-owner handoff runs only after the request ID is reserved and
  /// arguments are validated. Replayed/rejected calls cannot release a new owner.
  pub(crate) fn handle_tracked_with_hook(
    self: &Arc<Self>,
    session: &Arc<Session>,
    message: &Value,
    external: &Cancel,
    round: Option<&AtomicU64>,
    before_dispatch: Option<&dyn Fn() -> Result<()>>,
  ) -> Option<Value> {
    let id = message.get("id").cloned();
    if message.get("jsonrpc") != Some(&json!("2.0")) || !message.is_object() {
      return Some(rpc_error(
        id.unwrap_or(Value::Null),
        -32600,
        "Invalid JSON-RPC request.",
      ));
    }
    let method = match message.get("method").and_then(Value::as_str) {
      Some(value) => value,
      None => {
        return Some(rpc_error(
          id.unwrap_or(Value::Null),
          -32600,
          "JSON-RPC method is required.",
        ))
      }
    };
    if method == "notifications/cancelled" {
      if let Some(request_id) = message["params"].get("requestId") {
        if let Some(Some(cancel)) = session.calls.lock().unwrap().get(&request_key(request_id)) {
          cancel.cancel();
        }
      }
      return None;
    }
    let id = id?;
    if !(id.is_string() || id.as_i64().is_some()) {
      return Some(rpc_error(
        id,
        -32600,
        "Request id must be a string or integer.",
      ));
    }
    if session.is_closed() {
      return Some(rpc_error(id, -32600, "MCP session closed."));
    }
    let result: Result<Value> = match method {
      "initialize" => {
        let proposed = message["params"]["protocolVersion"].as_str().unwrap_or("");
        let supported = [
          "2025-11-25",
          "2025-06-18",
          "2025-03-26",
          "2024-11-05",
          "2024-10-07",
        ];
        let version = if supported.contains(&proposed) {
          proposed
        } else {
          supported[0]
        };
        *session.protocol_version.lock().unwrap() = version.into();
        Ok(
          json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"qdd-android-hid","version":"0.0.0"},"instructions":INSTRUCTIONS}),
        )
      }
      "ping" => Ok(json!({})),
      "tools/list" => Ok(json!({"tools":self.specs})),
      "tools/call" => {
        let name = message["params"]["name"].as_str().unwrap_or("");
        let args = message["params"]
          .get("arguments")
          .cloned()
          .unwrap_or_else(|| json!({}));
        let cancel = external.child_token();
        let key = request_key(&id);
        {
          let mut calls = session.calls.lock().unwrap();
          if session.is_closed() {
            return Some(rpc_error(id, -32600, "MCP session closed."));
          }
          if calls.contains_key(&key) {
            return Some(rpc_error(
              id,
              -32600,
              "This MCP tools/call request id was already used; the action was not dispatched again. Use a new request id for an intentional new call.",
            ));
          }
          if calls.len() >= MAX_TOOL_REQUEST_IDS {
            return Some(rpc_error(
              id,
              -32600,
              "This MCP session reached its tools/call request ID limit; no action was dispatched. Close it and create a new MCP session before continuing.",
            ));
          }
          calls.insert(key, Some(cancel.clone()));
        }
        let local_round = AtomicU64::new(u64::MAX);
        let checked = self
          .preflight_dispatch(session, name, &args)
          .and_then(|_| before_dispatch.map_or(Ok(()), |hook| hook()));
        let value = match checked {
          Ok(()) => self.call_tracked(session, name, &args, &cancel, round.unwrap_or(&local_round)),
          Err(error) => error_result(&error.to_string()),
        };
        // Keep the reservation through success, failure and cancellation. The
        // same mutex covers registration and completion, so no replay gap exists.
        if let Some(call) = session.calls.lock().unwrap().get_mut(&key) {
          *call = None;
        }
        Ok(value)
      }
      _ => return Some(rpc_error(id, -32601, "Method not found.")),
    };
    Some(match result {
      Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
      Err(error) => rpc_error(id, -32603, &error.to_string()),
    })
  }

  pub fn call(
    self: &Arc<Self>,
    session: &Arc<Session>,
    name: &str,
    args: &Value,
    cancel: &Cancel,
  ) -> Value {
    self.call_tracked(session, name, args, cancel, &AtomicU64::new(u64::MAX))
  }
  fn preflight_dispatch(
    self: &Arc<Self>,
    session: &Arc<Session>,
    name: &str,
    args: &Value,
  ) -> Result<()> {
    self.validate(name, args)?;
    match name {
      "android_control" => {
        self.action(session, args)?;
      }
      "android_type" => {
        let value = text(args, "text")?;
        crate::text::validate_text(value)?;
        if value.is_ascii() {
          for ch in value.chars() {
            crate::input::ascii_key(ch)?;
          }
        }
      }
      "android_key" => {
        crate::input::parse_key_combo(text(args, "combo")?)?;
      }
      "android_mouse_move" => {
        crate::input::split_move(
          integer(args, "dx", None)?,
          integer(args, "dy", None)?,
          integer(args, "wheel", Some(0))?,
        )?;
      }
      "android_scroll" => {
        crate::input::split_move(0, 0, integer(args, "amount", None)?)?;
      }
      "android_pointer_calibration" => {
        self.require_frame(session, args)?;
        let phase = text(args, "phase")?;
        let allowed: &[&str] = match phase {
          "auto" => &["phase", "frameId", "counts"],
          "probe" => &["phase", "frameId", "counts", "direction"],
          "finish" => &[
            "phase", "frameId", "probeId", "startX", "startY", "endX", "endY",
          ],
          _ => bail!("Unknown calibration phase."),
        };
        ensure!(
          args
            .as_object()
            .unwrap()
            .keys()
            .all(|key| allowed.contains(&key.as_str())),
          "Unexpected calibration phase argument."
        );
      }
      "android_calibrate_pointer" => {
        let frame = self.require_frame(session, args)?;
        ensure!(
          number(args, "scaleX")? > 0.0 && number(args, "scaleY")? > 0.0,
          "Pointer calibration scales must be positive."
        );
        ensure!(
          (0..=3).contains(&integer(
            args,
            "rotation",
            Some(frame.capture.rotation.unwrap_or(0) as i64)
          )?),
          "rotation must be 0, 1, 2 or 3."
        );
      }
      "android_pointer_home" | "android_tap" | "android_swipe" => {
        self.require_frame(session, args)?;
        ensure!(
          self.backend.state()["calibrated"] == true,
          "Coordinate actions require measured calibration."
        );
        if name == "android_tap" {
          self.point(session, args, "x", "y")?;
        }
        if name == "android_swipe" {
          self.point(session, args, "x1", "y1")?;
          self.point(session, args, "x2", "y2")?;
        }
      }
      _ => {}
    }
    Ok(())
  }
  fn call_tracked(
    self: &Arc<Self>,
    session: &Arc<Session>,
    name: &str,
    args: &Value,
    cancel: &Cancel,
    round: &AtomicU64,
  ) -> Value {
    let epoch = self.backend.control_epoch();
    let result = (|| -> Result<Value> {
      check(cancel)?;
      self.validate(name, args)?;
      if self.is_mutating(name, args) {
        self.claim(session)?;
        round.store(epoch, Ordering::SeqCst);
      }
      match name {
        "android_devices" => Ok(json_result(self.backend.devices()?)),
        "android_screenshot" => {
          let serial = args
            .get("deviceSerial")
            .map(|_| text(args, "deviceSerial"))
            .transpose()?;
          let capture = self.backend.capture(serial, false, cancel)?;
          check(cancel)?;
          self.observe(&capture)?;
          check(cancel)?;
          self.snapshot(session, capture, json!({}))
        }
        "android_preview_tap" => self.preview(session, args, cancel),
        "android_hid_arm" => {
          let (value, epoch) = self.backend.arm(cancel)?;
          round.store(epoch, Ordering::SeqCst);
          Ok(json_result(value))
        }
        "android_release" => {
          let (value, epoch) = self.backend.release(cancel)?;
          round.store(epoch, Ordering::SeqCst);
          Ok(json_result(value))
        }
        "android_control" => self.control(session, args, cancel, round),
        "android_pointer_calibration" => self.calibration(session, args, cancel, round),
        "android_calibrate_pointer" => {
          let frame = self.require_frame(session, args)?;
          let x = number(args, "scaleX")?;
          let y = number(args, "scaleY")?;
          ensure!(
            x > 0.0 && y > 0.0,
            "Pointer calibration scales must be positive."
          );
          let rotation = integer(
            args,
            "rotation",
            Some(frame.capture.rotation.unwrap_or(0) as i64),
          )?;
          ensure!(
            (0..=3).contains(&rotation),
            "rotation must be 0, 1, 2 or 3."
          );
          let mut capture = frame.capture.clone();
          capture.rotation = Some(rotation as u8);
          self.observe(&capture)?;
          check(cancel)?;
          Ok(json_result(self.backend.input(name, args, cancel, None)?))
        }
        "android_tap" | "android_swipe" | "android_pointer_home" => {
          let mut data = args.clone();
          if name == "android_tap" {
            let (x, y) = self.point(session, args, "x", "y")?;
            data["x"] = json!(x);
            data["y"] = json!(y);
          }
          if name == "android_swipe" {
            let (x, y) = self.point(session, args, "x1", "y1")?;
            data["x1"] = json!(x);
            data["y1"] = json!(y);
            let (x, y) = self.point(session, args, "x2", "y2")?;
            data["x2"] = json!(x);
            data["y2"] = json!(y);
          }
          data["coordinateSpace"] = json!("pixels");
          Ok(json_result(self.backend.input(
            name,
            &data,
            cancel,
            Some(self.guard(session, args)?),
          )?))
        }
        _ => Ok(json_result(self.backend.input(name, args, cancel, None)?)),
      }
    })();
    match result {
      Ok(value) => value,
      Err(error) => {
        if name == "android_screenshot" {
          *session.frame.lock().unwrap() = None;
        }
        let cleanup_epoch = if name == "android_screenshot" {
          epoch
        } else {
          round.load(Ordering::SeqCst)
        };
        if cleanup_epoch != u64::MAX
          && self.owns_input(&session.id)
          && self.backend.control_epoch() == cleanup_epoch
          && ((name == "android_screenshot" && !cancel.is_cancelled())
            || (cancel.is_cancelled() && self.is_mutating(name, args)))
        {
          if name == "android_screenshot" {
            self.epoch.fetch_add(1, Ordering::SeqCst);
          }
          let _ = self.backend.stop_if_epoch(cleanup_epoch);
        }
        let mut result = error_result(&error.to_string());
        annotate_text_error(&mut result, &error);
        result
      }
    }
  }

  fn validate(&self, name: &str, args: &Value) -> Result<()> {
    let spec = self
      .specs
      .as_array()
      .unwrap()
      .iter()
      .find(|s| s["name"] == name)
      .ok_or_else(|| anyhow!("Unknown tool: {name}"))?;
    let args = args
      .as_object()
      .ok_or_else(|| anyhow!("Tool arguments must be an object."))?;
    let properties = spec["inputSchema"]["properties"].as_object().unwrap();
    ensure!(
      args.keys().all(|key| properties.contains_key(key)),
      "Unknown tool argument."
    );
    ensure!(
      spec["inputSchema"]["required"]
        .as_array()
        .unwrap()
        .iter()
        .all(|key| args.contains_key(key.as_str().unwrap())),
      "Required tool argument is missing."
    );
    for (key, value) in args {
      let property = &properties[key];
      match property["type"].as_str() {
        Some("string") => ensure!(value.is_string(), "{key} must be a string."),
        Some("integer") => {
          integer(&json!({key:value}), key, None)?;
        }
        Some("number") => {
          number(&json!({key:value}), key)?;
        }
        _ => {}
      }
      if let Some(choices) = property["enum"].as_array() {
        ensure!(choices.contains(value), "Invalid {key}.");
      }
      if let Some(min) = property["minimum"].as_f64() {
        ensure!(
          value.as_f64().is_some_and(|n| n >= min),
          "{key} is below its minimum."
        );
      }
      if let Some(max) = property["maximum"].as_f64() {
        ensure!(
          value.as_f64().is_some_and(|n| n <= max),
          "{key} is above its maximum."
        );
      }
      if let Some(min) = property["exclusiveMinimum"].as_f64() {
        ensure!(
          value.as_f64().is_some_and(|n| n > min),
          "{key} must be greater than {min}."
        );
      }
    }
    Ok(())
  }

  fn preview(
    self: &Arc<Self>,
    session: &Arc<Session>,
    args: &Value,
    cancel: &Cancel,
  ) -> Result<Value> {
    let before = self.require_frame(session, args)?;
    let (x, y) = self.point(session, args, "x", "y")?;
    let guard = self.guard(session, args)?;
    guard()?;
    let capture = self
      .backend
      .capture(Some(&before.capture.serial), false, cancel)?;
    check(cancel)?;
    guard()?;
    self.observe(&capture)?;
    guard()?;
    ensure!(
      capture.serial == before.capture.serial
        && capture.width == before.capture.width
        && capture.height == before.capture.height
        && capture.rotation == before.capture.rotation,
      "Target preview no longer matches the observed phone geometry."
    );
    original(&capture)?;
    let rendered = crate::target_preview::render_target_preview(
      &capture.bytes,
      &capture.mime_type,
      capture.width,
      capture.height,
      x,
      y,
      cancel,
    )?;
    check(cancel)?;
    guard()?;
    ensure!(capture.age_ms()<=crate::screen::MAX_SCREEN_FRAME_AGE_MS,"Target preview's source image became stale during rendering; request another preview before tapping.");
    let crop = json!({"x":rendered.crop.x,"y":rendered.crop.y,"width":rendered.crop.width,"height":rendered.crop.height,"scale":rendered.crop.scale});
    let mut result=self.snapshot_expected(session,capture.clone(),json!({"action":"preview_tap","simulatedTarget":true,"realMouseMoved":false,"realClickSent":false,
      "target":{"x":x,"y":y,"coordinateSpace":"pixels"},"crop":crop,
      "zoomTarget":{"x":(x-rendered.crop.x)*rendered.crop.scale,"y":(y-rendered.crop.y)*rendered.crop.scale,"coordinateSpace":"zoomPixels"},
      "annotation":rendered.annotation,
      "sourceMimeType":capture.mime_type,"sourceSha256":hash(&capture.bytes),"annotatedImageSha256":hash(&rendered.png),"zoomImageSha256":hash(&rendered.zoom_png),
      "mimeType":"image/png","imageOrder":["simulated_target_original","simulated_target_zoom"],
      "note":"Both images visibly label PHONE PX X/Y in original phone pixels. Their bottom captions and any right padding are annotations, not phone content; annotation.original.sourceRect and annotation.zoom.sourceRect preserve the source at (0,0). SIMULATED TARGET marks the proposed pixel only; no real mouse movement or click was sent. The source sha256 identifies the real phone image. Inspect the marker and local zoom before tapping. It does not prove physical mouse accuracy; calibrated hover returns the actual cursor before a separate click."}),Some(&before.id))?;
    result["structuredContent"]["tapArguments"] = json!({"action":"tap","frameId":result["structuredContent"]["frameId"],"x":x,"y":y,"coordinateSpace":"pixels"});
    let metadata = result["structuredContent"].clone();
    result["content"] = json!([{"type":"text","text":metadata.to_string()},
      {"type":"text","text":format!("PHONE PX: X={x} Y={y} — full original-resolution phone content with a separate simulated-target caption; no real mouse input.")},image(&rendered.png,"image/png"),
      {"type":"text","text":format!("PHONE PX: X={x} Y={y} — 2x local zoom; caption coordinates and tapArguments remain original phone pixels.")},image(&rendered.zoom_png,"image/png")]);
    Ok(result)
  }

  fn action(
    self: &Arc<Self>,
    session: &Arc<Session>,
    args: &Value,
  ) -> Result<(String, Value, Option<Guard>)> {
    let action = text(args, "action")?;
    let fields: &[&str] = match action {
      "move" => &["dx", "dy"],
      "click" => &["button", "count"],
      "scroll" => &["amount"],
      "key" => &["combo"],
      "type" => &["text"],
      "home" | "back" => &[],
      "tap" | "hover" => &["x", "y", "coordinateSpace"],
      "swipe" => &["x1", "y1", "x2", "y2", "durationMs", "coordinateSpace"],
      "wait" => &["waitMs"],
      _ => bail!("Unknown control action."),
    };
    ensure!(
      args
        .as_object()
        .unwrap()
        .keys()
        .all(|key| key == "action" || key == "frameId" || fields.contains(&key.as_str())),
      "Unexpected argument for {action}."
    );
    self.require_frame(session, args)?;
    let mut data = args.clone();
    let guard = if ["tap", "hover", "swipe"].contains(&action) {
      ensure!(self.backend.state()["calibrated"]==true,"Coordinate actions need explicit calibration. Use android_pointer_calibration probe/finish or relative move/click first.");
      if action == "swipe" {
        let (x, y) = self.point(session, args, "x1", "y1")?;
        data["x1"] = json!(x);
        data["y1"] = json!(y);
        let (x, y) = self.point(session, args, "x2", "y2")?;
        data["x2"] = json!(x);
        data["y2"] = json!(y);
      } else {
        let (x, y) = self.point(session, args, "x", "y")?;
        data["x"] = json!(x);
        data["y"] = json!(y);
      }
      Some(self.guard(session, args)?)
    } else {
      None
    };
    match action {
      "move" => {
        crate::input::split_move(integer(args, "dx", None)?, integer(args, "dy", None)?, 0)?;
      }
      "scroll" => {
        crate::input::split_move(0, 0, integer(args, "amount", None)?)?;
      }
      "key" => {
        crate::input::parse_key_combo(text(args, "combo")?)?;
      }
      "type" => {
        let value = text(args, "text")?;
        crate::text::validate_text(value)?;
        if value.is_ascii() {
          for character in value.chars() {
            crate::input::ascii_key(character)?;
          }
        }
      }
      "click" => {
        ensure!(
          ["left", "right", "middle"]
            .contains(&args.get("button").and_then(Value::as_str).unwrap_or("left")),
          "Unknown mouse button."
        );
        ensure!(
          (1..=2).contains(&integer(args, "count", Some(1))?),
          "count must be 1 or 2."
        );
      }
      "swipe" => {
        ensure!(
          (50..=10000).contains(&integer(args, "durationMs", Some(400))?),
          "durationMs must be in 50..10000."
        );
      }
      "wait" => {
        ensure!(
          (0..=3000).contains(&integer(args, "waitMs", Some(200))?),
          "waitMs must be in 0..3000."
        );
      }
      _ => {}
    }
    let name = match action {
      "move" => "android_mouse_move",
      "click" => "android_mouse_click",
      "scroll" => "android_scroll",
      "key" => "android_key",
      "type" => "android_type",
      "home" => "android_home",
      "back" => "android_back",
      "tap" => "android_tap",
      "hover" => "android_hover",
      "swipe" => "android_swipe",
      _ => "wait",
    };
    data.as_object_mut().unwrap().remove("action");
    Ok((name.into(), data, guard))
  }

  fn after(
    &self,
    before: &ScreenCapture,
    completed: Instant,
    cancel: &Cancel,
  ) -> Result<ScreenCapture> {
    let waiting = cancel.child_token();
    let timer = waiting.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(2500));
      timer.cancel();
    });
    loop {
      check(&waiting)?;
      let capture = self
        .backend
        .capture(Some(&before.serial), false, &waiting)?;
      check(&waiting)?;
      ensure!(
        capture.serial == before.serial,
        "Phone identity changed while waiting for the action result."
      );
      let newer = if !before.source_frame_id.is_empty() {
        capture.source_frame_id != before.source_frame_id
      } else {
        capture.captured_at != before.captured_at
      };
      if newer && capture.age_ms() <= completed.elapsed().as_millis() as u64 {
        return Ok(capture);
      }
      sleep(Duration::from_millis(25), &waiting)?;
    }
  }

  fn control(
    self: &Arc<Self>,
    session: &Arc<Session>,
    args: &Value,
    cancel: &Cancel,
    round: &AtomicU64,
  ) -> Result<Value> {
    let _queue = self.controls.lock().unwrap();
    let action = text(args, "action")?.to_owned();
    let mut input_epoch = self.backend.control_epoch();
    let mut started = false;
    let mut completed = false;
    let mut visual_checked = false;
    let result = (|| -> Result<Value> {
      check(cancel)?;
      let (name, data, guard) = self.action(session, args)?;
      visual_checked = true;
      let before = self.read_live(cancel)?;
      ensure!(action=="wait"||input_epoch==self.backend.control_epoch(),"Input control round changed while this action was waiting; observe again before controlling.");
      self.require_frame(session, args)?;
      let epoch = self.epoch.load(Ordering::SeqCst);
      if action != "wait" && self.backend.state()["armed"] != true {
        let (_, reserved_epoch) = self.backend.arm(cancel)?;
        input_epoch = reserved_epoch;
        round.store(input_epoch, Ordering::SeqCst);
        ensure!(
          input_epoch == self.backend.control_epoch(),
          "Input control round changed while ARM was waiting; observe again."
        );
      }
      check(cancel)?;
      self.require_frame(session, args)?;
      started = action != "wait";
      let action_result = if action == "wait" {
        sleep(
          Duration::from_millis(integer(args, "waitMs", Some(200))? as u64),
          cancel,
        )?;
        Value::Null
      } else {
        self.backend.input(&name, &data, cancel, guard)?
      };
      completed = true;
      ensure!(
        action == "wait" || input_epoch == self.backend.control_epoch(),
        "Input control round changed; observe again."
      );
      let capture = self.after(&before, Instant::now(), cancel)?;
      check(cancel)?;
      ensure!(
        epoch == self.epoch.load(Ordering::SeqCst),
        "Phone or display geometry changed during the action; observe again."
      );
      ensure!(
        action == "wait" || input_epoch == self.backend.control_epoch(),
        "Input control round changed; observe again."
      );
      self.observe(&capture)?;
      self.snapshot_expected(session,capture,json!({"action":action,"actionCompleted":true,"observedAfterAction":true,"actionResult":action_result,"previousSourceFrameId":before.source_frame_id}),Some(text(args,"frameId")?))
    })();
    match result {
      Ok(value) => Ok(value),
      Err(error) => {
        if visual_checked
          && input_epoch == self.backend.control_epoch()
          && !(action == "wait" && cancel.is_cancelled())
        {
          *session.frame.lock().unwrap() = None;
          self.epoch.fetch_add(1, Ordering::SeqCst);
          let _ = self.backend.stop_if_epoch(input_epoch);
        }
        let message = if completed {
          format!("Action completed, but a new post-action phone image was not available: {error}. Do not repeat the action blindly; call android_screenshot to observe.")
        } else {
          error.to_string()
        };
        let mut result = json_result(
          json!({"action":action,"actionCompleted":completed,"actionStarted":started,"observedAfterAction":false,"message":message}),
        );
        result["isError"] = json!(true);
        annotate_text_error(&mut result, &error);
        Ok(result)
      }
    }
  }

  fn calibration(
    self: &Arc<Self>,
    session: &Arc<Session>,
    args: &Value,
    cancel: &Cancel,
    round: &AtomicU64,
  ) -> Result<Value> {
    let _queue = self.controls.lock().unwrap();
    let phase = text(args, "phase")?;
    if phase == "auto" {
      return self.auto_calibration(session, args, cancel, round);
    }
    if phase == "finish" {
      return self.finish(session, args, cancel);
    }
    ensure!(
      phase == "probe",
      "Calibration phase must be auto, probe or finish."
    );
    ensure!(
      args
        .as_object()
        .unwrap()
        .keys()
        .all(|key| ["phase", "frameId", "direction", "counts"].contains(&key.as_str())),
      "Unexpected calibration probe argument."
    );
    let frame = self.require_frame(session, args)?;
    original(&frame.capture)?;
    let direction = args
      .get("direction")
      .and_then(Value::as_str)
      .unwrap_or("up-left");
    ensure!(
      ["up-left", "up-right", "down-left", "down-right"].contains(&direction),
      "Unknown calibration direction."
    );
    let counts = integer(args, "counts", Some(96))?;
    ensure!(
      (16..=127).contains(&counts),
      "Calibration counts must be in 16..127."
    );
    let dx = if direction.ends_with("left") {
      -counts
    } else {
      counts
    };
    let dy = if direction.starts_with("up") {
      -counts
    } else {
      counts
    };
    let epoch = self.epoch.load(Ordering::SeqCst);
    let mut input_epoch = self.backend.control_epoch();
    let mut revision = self.backend.input_revision();
    let mut preparing = false;
    let mut attempted = false;
    *session.probe.lock().unwrap() = None;
    let check_probe = |input_epoch: u64, revision: u64| -> Result<()> {
      check(cancel)?;
      self.require_frame(session, args)?;
      ensure!(
        self.owns_input(&session.id)
          && input_epoch == self.backend.control_epoch()
          && revision == self.backend.input_revision()
          && epoch == self.epoch.load(Ordering::SeqCst),
        "Input, owner or phone changed during calibration; observe again before probing."
      );
      Ok(())
    };
    let result = (|| -> Result<Value> {
      self.read_live(cancel)?;
      check_probe(input_epoch, revision)?;
      let (_, reserved_epoch) = self.backend.release(cancel)?;
      preparing = true;
      input_epoch = reserved_epoch;
      round.store(input_epoch, Ordering::SeqCst);
      revision += 1;
      check_probe(input_epoch, revision)?;
      let (_, reserved_epoch) = self.backend.arm(cancel)?;
      input_epoch = reserved_epoch;
      round.store(input_epoch, Ordering::SeqCst);
      check_probe(input_epoch, revision)?;
      attempted = true;
      self.backend.input(
        "android_mouse_move",
        &json!({"dx":1,"dy":1}),
        cancel,
        Some(self.probe_guard(session, args, epoch, input_epoch, revision)?),
      )?;
      revision += 1;
      sleep(Duration::from_millis(250), cancel)?;
      check_probe(input_epoch, revision)?;
      let before = self.after(&frame.capture, Instant::now(), cancel)?;
      check_probe(input_epoch, revision)?;
      original(&before)?;
      self.backend.input(
        "android_mouse_move",
        &json!({"dx":dx,"dy":dy}),
        cancel,
        Some(self.probe_guard(session, args, epoch, input_epoch, revision)?),
      )?;
      revision += 1;
      sleep(Duration::from_millis(250), cancel)?;
      check_probe(input_epoch, revision)?;
      let after = self.after(&before, Instant::now(), cancel)?;
      check_probe(input_epoch, revision)?;
      original(&after)?;
      ensure!(
        after.serial == frame.capture.serial
          && before.serial == frame.capture.serial
          && after.width == frame.capture.width
          && after.height == frame.capture.height
          && before.width == after.width
          && before.height == after.height
          && after.rotation == frame.capture.rotation
          && before.rotation == after.rotation,
        "Calibration images no longer match the observed phone geometry."
      );
      if before.bytes == after.bytes {
        // A fresh capture can still omit Android's system pointer. Never issue
        // a measurable ticket or infer a gain from identical images.
        self.backend.stop_if_epoch(input_epoch)?;
        let mut result = self.snapshot_expected(session, after.clone(), json!({
          "phase":"probe", "measurable":false, "measurementAvailable":false, "reason":"identical_images",
          "calibrated":false,"measurementSource":"cursor-images","counts":{"dx":dx,"dy":dy},"direction":direction,
          "before":{"sourceFrameId":before.source_frame_id,"capturedAt":before.captured_at,"width":before.width,"height":before.height,"sha256":hash(&before.bytes)},"imageOrder":["before","after"],
          "movementAttempted":true, "beforeSha256":hash(&before.bytes), "afterSha256":hash(&after.bytes),
          "message":"BEFORE and AFTER images are identical. The cursor may be absent from screen capture, movement may be clipped, or the screen may be unchanged. No calibration was measured or applied; input was paused. Open the phone App's Pointer calibration page and use phase auto, or use a page that visibly captures the real cursor. Do not invent cursor centers or repeat the movement blindly."
        }), Some(&frame.id))?;
        result["content"] = json!([
          {"type":"text","text":result["structuredContent"].to_string()},
          {"type":"text","text":"BEFORE: no measurable visible cursor displacement."}, image(&before.bytes,&before.mime_type),
          {"type":"text","text":"AFTER: identical bytes; no calibration ticket was created."}, image(&after.bytes,&after.mime_type)
        ]);
        return Ok(result);
      }
      let probe_id = Uuid::new_v4().to_string();
      let mut result=self.snapshot_expected(session,after.clone(),json!({"phase":"probe","measurable":true,"measurementAvailable":true,"measurementSource":"cursor-images","probeId":probe_id,"counts":{"dx":dx,"dy":dy},"direction":direction,
        "before":{"sourceFrameId":before.source_frame_id,"capturedAt":before.captured_at,"width":before.width,"height":before.height,"sha256":hash(&before.bytes)},"imageOrder":["before","after"],
        "next":"Observe cursor centers in BEFORE and AFTER, then call android_pointer_calibration phase finish with probeId, latest frameId, startX/startY/endX/endY. No additional movement is needed."}),Some(&frame.id))?;
      *session.probe.lock().unwrap() = Some(Probe {
        id: probe_id,
        created: Instant::now(),
        epoch,
        input_epoch,
        revision,
        serial: after.serial.clone(),
        width: after.width,
        height: after.height,
        rotation: after.rotation.unwrap_or(0),
        dx,
        dy,
      });
      result["content"] = json!([{"type":"text","text":result["structuredContent"].to_string()},{"type":"text","text":"BEFORE: cursor after warmup, before measured movement."},image(&before.bytes,&before.mime_type),{"type":"text","text":"AFTER: cursor after measured movement. Observe its center without moving again."},image(&after.bytes,&after.mime_type)]);
      Ok(result)
    })();
    match result {
      Ok(value) => Ok(value),
      Err(error) => {
        *session.probe.lock().unwrap() = None;
        if preparing && self.owns_input(&session.id) && input_epoch == self.backend.control_epoch()
        {
          let _ = self.backend.stop_if_epoch(input_epoch);
        }
        let mut value = json_result(
          json!({"phase":"probe","movementAttempted":attempted,"message":format!("{error}{}",if attempted{" Movement may already have occurred; observe again rather than repeat it blindly."}else{""})}),
        );
        value["isError"] = json!(true);
        Ok(value)
      }
    }
  }

  fn calibration_page(
    &self,
    frame: &ScreenCapture,
    page: &PointerCalibrationState,
    expected_session: Option<&str>,
  ) -> Result<()> {
    ensure!(page.active, "Open Pointer calibration in the phone screen App first and keep that page in the foreground. The MCP cannot open it for you.");
    ensure!(
      page.device_id.eq_ignore_ascii_case(&frame.serial)
        && page.width == frame.width
        && page.height == frame.height
        && page.rotation == frame.rotation.unwrap_or(0),
      "Pointer calibration page belongs to another phone or display geometry; observe again."
    );
    let page_session = page
      .session_id
      .as_deref()
      .ok_or_else(|| anyhow!("Active pointer calibration page has no session."))?;
    ensure!(
      crate::screen::valid_device_id(page_session)
        && expected_session.is_none_or(|id| id == page_session),
      "Pointer calibration page changed or lost focus; no calibration was applied."
    );
    Ok(())
  }

  fn calibration_point(
    &self,
    frame: &ScreenCapture,
    page_session: &str,
    after_sequence: u64,
    cancel: &Cancel,
  ) -> Result<PointerCalibrationPoint> {
    let waiting = cancel.child_token();
    let timer = waiting.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(1000));
      timer.cancel();
    });
    let result = (|| loop {
      check(&waiting)?;
      let page = self.backend.pointer_calibration(&frame.serial, &waiting)?;
      check(&waiting)?;
      self.calibration_page(frame, &page, Some(page_session))?;
      if let Some(point) = page
        .point
        .filter(|p| p.sequence > after_sequence && p.age_ms <= 1000)
      {
        ensure!(
          point.x.is_finite()
            && point.y.is_finite()
            && point.x >= 0.0
            && point.y >= 0.0
            && point.x < frame.width as f64
            && point.y < frame.height as f64,
          "Pointer calibration returned an invalid actual mouse coordinate."
        );
        return Ok(point);
      }
      sleep(Duration::from_millis(40), &waiting)?;
    })();
    if waiting.is_cancelled() && !cancel.is_cancelled() {
      bail!("No fresh actual mouse event arrived on the calibration page within 1000 ms. No calibration was applied; do not repeat movement blindly.");
    }
    result
  }

  fn auto_calibration(
    self: &Arc<Self>,
    session: &Arc<Session>,
    args: &Value,
    cancel: &Cancel,
    round: &AtomicU64,
  ) -> Result<Value> {
    ensure!(
      args
        .as_object()
        .unwrap()
        .keys()
        .all(|key| ["phase", "frameId", "counts"].contains(&key.as_str())),
      "Unexpected automatic calibration argument; direction is selected toward the screen center."
    );
    let frame = self.require_frame(session, args)?;
    original(&frame.capture)?;
    let counts = integer(args, "counts", Some(96))?;
    ensure!(
      (16..=127).contains(&counts),
      "Calibration counts must be in 16..127."
    );
    let epoch = self.epoch.load(Ordering::SeqCst);
    let mut input_epoch = self.backend.control_epoch();
    let mut revision = self.backend.input_revision();
    let mut preparing = false;
    let mut attempted = false;
    *session.probe.lock().unwrap() = None;
    let check_round = |input_epoch: u64, revision: u64| -> Result<()> {
      check(cancel)?;
      self.require_frame(session, args)?;
      ensure!(
        self.owns_input(&session.id)
          && epoch == self.epoch.load(Ordering::SeqCst)
          && input_epoch == self.backend.control_epoch()
          && revision == self.backend.input_revision(),
        "Input, owner or phone changed during automatic calibration; no calibration was applied."
      );
      Ok(())
    };
    let result = (|| -> Result<Value> {
      self.read_live(cancel)?;
      check_round(input_epoch, revision)?;
      let initial = self
        .backend
        .pointer_calibration(&frame.capture.serial, cancel)?;
      check_round(input_epoch, revision)?;
      self.calibration_page(&frame.capture, &initial, None)?;
      let page_session = initial.session_id.as_deref().unwrap();
      let initial_sequence = initial.point.as_ref().map_or(0, |p| p.sequence);
      let (_, reserved_epoch) = self.backend.release(cancel)?;
      preparing = true;
      input_epoch = reserved_epoch;
      revision += 1;
      round.store(input_epoch, Ordering::SeqCst);
      check_round(input_epoch, revision)?;
      let (_, reserved_epoch) = self.backend.arm(cancel)?;
      input_epoch = reserved_epoch;
      round.store(input_epoch, Ordering::SeqCst);
      check_round(input_epoch, revision)?;
      attempted = true;
      self.backend.input(
        "android_mouse_move",
        &json!({"dx":1,"dy":1}),
        cancel,
        Some(self.probe_guard(session, args, epoch, input_epoch, revision)?),
      )?;
      revision += 1;
      check_round(input_epoch, revision)?;
      let start = self.calibration_point(&frame.capture, page_session, initial_sequence, cancel)?;
      check_round(input_epoch, revision)?;
      // Let acceleration from the reveal movement decay, matching the
      // coordinate homing path. Heartbeats continue during this cancellable wait.
      sleep(Duration::from_millis(550), cancel)?;
      check_round(input_epoch, revision)?;
      let before_move = self
        .backend
        .pointer_calibration(&frame.capture.serial, cancel)?;
      check_round(input_epoch, revision)?;
      self.calibration_page(&frame.capture, &before_move, Some(page_session))?;
      ensure!(
        before_move
          .point
          .as_ref()
          .is_some_and(|p| p.sequence == start.sequence
            && p.x == start.x
            && p.y == start.y
            && p.age_ms <= 1000),
        "Actual mouse changed before the measured probe; no calibration was applied."
      );
      let dx = if start.x < frame.capture.width as f64 / 2.0 {
        counts
      } else {
        -counts
      };
      let dy = if start.y < frame.capture.height as f64 / 2.0 {
        counts
      } else {
        -counts
      };
      self.backend.input(
        "android_mouse_move",
        &json!({"dx":dx,"dy":dy}),
        cancel,
        Some(self.probe_guard(session, args, epoch, input_epoch, revision)?),
      )?;
      revision += 1;
      check_round(input_epoch, revision)?;
      let end = self.calibration_point(&frame.capture, page_session, start.sequence, cancel)?;
      check_round(input_epoch, revision)?;
      let pixels_x = end.x - start.x;
      let pixels_y = end.y - start.y;
      ensure!(pixels_x.abs() >= 12.0 && pixels_y.abs() >= 12.0
        && pixels_x * dx as f64 > 0.0 && pixels_y * dy as f64 > 0.0
        && end.x >= 8.0 && end.y >= 8.0
        && end.x < frame.capture.width as f64 - 8.0 && end.y < frame.capture.height as f64 - 8.0,
        "Actual mouse movement is too small, reversed or clipped at the screen edge. No calibration was applied; observe rather than repeat blindly.");
      let after = self.after(&frame.capture, Instant::now(), cancel)?;
      check_round(input_epoch, revision)?;
      original(&after)?;
      ensure!(after.serial == frame.capture.serial && after.width == frame.capture.width
        && after.height == frame.capture.height && after.rotation == frame.capture.rotation,
        "Phone or display geometry changed while capturing automatic calibration; no calibration was applied.");
      let final_page = self
        .backend
        .pointer_calibration(&frame.capture.serial, cancel)?;
      check_round(input_epoch, revision)?;
      self.calibration_page(&after, &final_page, Some(page_session))?;
      ensure!(final_page.point.as_ref().is_some_and(|p| p.sequence == end.sequence
        && p.x == end.x && p.y == end.y && p.age_ms <= 1000),
        "Actual mouse changed or became stale while capturing the calibration result; no calibration was applied.");
      let scale_x = dx as f64 / pixels_x;
      let scale_y = dy as f64 / pixels_y;
      let input = self.backend.input(
        "android_calibrate_pointer",
        &json!({"scaleX":scale_x,"scaleY":scale_y}),
        cancel,
        None,
      )?;
      self.snapshot_expected(session, after, json!({"phase":"auto", "calibrated":true,
        "measurementSource":"android-mouse-events", "measurementAvailable":true,
        "calibrationSessionId":page_session, "counts":{"dx":dx,"dy":dy},
        "start":start, "end":end, "scaleX":scale_x, "scaleY":scale_y, "input":input,
        "note":"Measured actual HID mouse events on the user-opened calibration page, without a business click. The page draws its actual event marker into screen capture. Android acceleration still makes later coordinates estimates."}), Some(&frame.id))
    })();
    match result {
      Ok(value) => Ok(value),
      Err(error) => {
        if preparing && self.owns_input(&session.id) && input_epoch == self.backend.control_epoch()
        {
          let _ = self.backend.stop_if_epoch(input_epoch);
        }
        let mut value = json_result(json!({"phase":"auto", "measurementAvailable":false,
          "calibrated":false, "movementAttempted":attempted,
          "message":format!("{error}{}", if attempted { " Movement may already have occurred; no gain was guessed. Observe again instead of blindly replaying input." } else { "" })}));
        value["isError"] = json!(true);
        Ok(value)
      }
    }
  }

  fn finish(&self, session: &Session, args: &Value, cancel: &Cancel) -> Result<Value> {
    ensure!(
      args.as_object().unwrap().keys().all(|key| [
        "phase", "frameId", "probeId", "startX", "startY", "endX", "endY"
      ]
      .contains(&key.as_str())),
      "Unexpected calibration finish argument."
    );
    let ticket = session
      .probe
      .lock()
      .unwrap()
      .clone()
      .ok_or_else(|| anyhow!("No pending calibration probe belongs to this session."))?;
    let check_ticket = || -> Result<Frame> {
      check(cancel)?;
      let frame = self.require_frame(session, args)?;
      original(&frame.capture)?;
      ensure!(
        text(args, "probeId")? == ticket.id,
        "No pending calibration probe belongs to this session."
      );
      ensure!(
        ticket.created.elapsed() <= Duration::from_secs(30),
        "Calibration probe expired; observe and request a new probe."
      );
      ensure!(self.owns_input(&session.id)&&ticket.epoch==self.epoch.load(Ordering::SeqCst)&&ticket.input_epoch==self.backend.control_epoch()&&ticket.revision==self.backend.input_revision()&&self.backend.state()["armed"]==true&&frame.capture.serial==ticket.serial&&frame.capture.width==ticket.width&&frame.capture.height==ticket.height&&frame.capture.rotation.unwrap_or(0)==ticket.rotation,"Input, owner, phone or geometry changed after the calibration probe; observe and request a new probe.");
      Ok(frame)
    };
    check_ticket()?;
    self.read_live(cancel)?;
    let frame = check_ticket()?;
    let sx = integer(args, "startX", None)?;
    let sy = integer(args, "startY", None)?;
    let ex = integer(args, "endX", None)?;
    let ey = integer(args, "endY", None)?;
    for (value, limit) in [
      (sx, frame.capture.width),
      (ex, frame.capture.width),
      (sy, frame.capture.height),
      (ey, frame.capture.height),
    ] {
      ensure!(value>=0&&value<limit as i64,"Cursor centers must be inside the original images; correct the coordinates without repeating the movement.");
    }
    let dx = ex - sx;
    let dy = ey - sy;
    ensure!(dx.abs()>=12&&dy.abs()>=12&&dx*ticket.dx>0&&dy*ticket.dy>0&&ex>=8&&ey>=8&&ex<(frame.capture.width as i64)-8&&ey<(frame.capture.height as i64)-8,"Cursor movement is too small, reversed, or touches an edge and may be clipped. Recheck the two images; do not blindly repeat the movement.");
    let scale_x = ticket.dx as f64 / dx as f64;
    let scale_y = ticket.dy as f64 / dy as f64;
    check_ticket()?;
    let input = self.backend.input(
      "android_calibrate_pointer",
      &json!({"scaleX":scale_x,"scaleY":scale_y}),
      cancel,
      None,
    )?;
    *session.probe.lock().unwrap() = None;
    Ok(json_result(
      json!({"phase":"finish","probeId":ticket.id,"calibrated":true,"scaleX":scale_x,"scaleY":scale_y,"input":input,"note":"Measured HID counts per pixel; coordinates remain estimates under mouse acceleration."}),
    ))
  }
}

pub fn check(cancel: &Cancel) -> Result<()> {
  ensure!(!cancel.is_cancelled(), "Tool call was cancelled.");
  Ok(())
}
pub fn sleep(duration: Duration, cancel: &Cancel) -> Result<()> {
  let until = Instant::now() + duration;
  while Instant::now() < until {
    check(cancel)?;
    std::thread::sleep(
      until
        .saturating_duration_since(Instant::now())
        .min(Duration::from_millis(10)),
    );
  }
  check(cancel)
}
pub fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
  args
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| anyhow!("{key} must be a string."))
}
pub fn integer(args: &Value, key: &str, fallback: Option<i64>) -> Result<i64> {
  let value = args
    .get(key)
    .and_then(Value::as_i64)
    .or_else(|| {
      if args.get(key).is_none() {
        fallback
      } else {
        None
      }
    })
    .ok_or_else(|| anyhow!("{key} must be a safe integer."))?;
  ensure!(
    (-9007199254740991..=9007199254740991).contains(&value),
    "{key} must be a safe integer."
  );
  Ok(value)
}
pub fn number(args: &Value, key: &str) -> Result<f64> {
  let value = args
    .get(key)
    .and_then(Value::as_f64)
    .ok_or_else(|| anyhow!("{key} must be a finite number."))?;
  ensure!(value.is_finite(), "{key} must be a finite number.");
  Ok(value)
}
pub fn json_result(value: Value) -> Value {
  let mut result = json!({"content":[{"type":"text","text":value.to_string()}]});
  if value.is_object() {
    result["structuredContent"] = value;
  }
  result
}
pub fn error_result(message: &str) -> Value {
  json!({"content":[{"type":"text","text":message}],"isError":true})
}
fn annotate_text_error(result: &mut Value, error: &anyhow::Error) {
  if let Some(transfer) = error.downcast_ref::<crate::text::TextTransferError>() {
    if !result["structuredContent"].is_object() {
      result["structuredContent"] = json!({"message":error.to_string()});
    }
    result["structuredContent"]["textTransfer"] = json!({
      "id":format!("{:016x}", transfer.transfer_id),
      "status":if transfer.uncertain { "uncertain" } else { "not_accepted" },
      "automaticallyRetried":false, "retrySafe":false,
    });
  }
}
pub fn rpc_error(id: Value, code: i64, message: &str) -> Value {
  json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn image(bytes: &[u8], mime: &str) -> Value {
  json!({"type":"image","mimeType":mime,"data":STANDARD.encode(bytes)})
}
fn hash(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}
fn original(capture: &ScreenCapture) -> Result<()> {
  ensure!(
    capture.preview_profile == "original"
      && capture.device_width == capture.width
      && capture.device_height == capture.height,
    "An original-resolution phone image is required, not a scaled preview."
  );
  Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use std::sync::atomic::AtomicUsize;

  pub struct FakeBackend {
    pub epoch: AtomicU64,
    pub revision: AtomicU64,
    pub armed: AtomicBool,
    pub stops: AtomicUsize,
    pub captures: AtomicUsize,
    pub fail_capture: AtomicBool,
    pub fail_input: AtomicBool,
    pub input_gate: Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>,
    pub repeat_frame: AtomicBool,
    pub identical_image: AtomicBool,
    pub calibration_mode: Mutex<&'static str>,
    pub calibration_reads: AtomicUsize,
    pub calibrated: AtomicBool,
    pub actions: Arc<Mutex<Vec<String>>>,
    pub geometry: Mutex<(u32, u32, u8)>,
  }
  impl Default for FakeBackend {
    fn default() -> Self {
      Self {
        epoch: AtomicU64::new(0),
        revision: AtomicU64::new(0),
        armed: AtomicBool::new(false),
        stops: AtomicUsize::new(0),
        captures: AtomicUsize::new(0),
        fail_capture: AtomicBool::new(false),
        fail_input: AtomicBool::new(false),
        input_gate: Mutex::new(None),
        repeat_frame: AtomicBool::new(false),
        identical_image: AtomicBool::new(false),
        calibration_mode: Mutex::new("inactive"),
        calibration_reads: AtomicUsize::new(0),
        calibrated: AtomicBool::new(false),
        actions: Arc::new(Mutex::new(Vec::new())),
        geometry: Mutex::new((128, 256, 0)),
      }
    }
  }
  impl Backend for FakeBackend {
    fn pointer_calibration(
      &self,
      serial: &str,
      cancel: &Cancel,
    ) -> Result<PointerCalibrationState> {
      check(cancel)?;
      let mode = *self.calibration_mode.lock().unwrap();
      let reads = self.calibration_reads.fetch_add(1, Ordering::SeqCst);
      let (width, height, rotation) = *self.geometry.lock().unwrap();
      let movements = self
        .actions
        .lock()
        .unwrap()
        .iter()
        .filter(|name| name.as_str() == "android_mouse_move")
        .count();
      let sequence = if movements >= 2 { 2 } else { 1 };
      Ok(PointerCalibrationState {
        active: mode != "inactive",
        device_id: serial.into(),
        session_id: (mode != "inactive").then(|| {
          if mode == "changed-session" && movements >= 2 {
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into()
          } else {
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into()
          }
        }),
        width,
        height,
        rotation: if mode == "rotated" && movements >= 2 {
          1
        } else {
          rotation
        },
        point: if movements == 0 || mode == "no-event" || mode == "inactive" {
          None
        } else {
          Some(PointerCalibrationPoint {
            x: if sequence == 1 {
              40.0
            } else if mode == "edge" {
              width as f64 - 1.0
            } else if mode == "reversed" {
              30.0
            } else {
              88.0
            },
            y: if sequence == 1 { 60.0 } else { 156.0 },
            sequence: if mode == "changed-final" && reads >= 4 {
              3
            } else {
              sequence
            },
            age_ms: if mode == "stale" { 2001 } else { 0 },
          })
        },
      })
    }
    fn capture(
      &self,
      serial: Option<&str>,
      _preview: bool,
      cancel: &Cancel,
    ) -> Result<ScreenCapture> {
      check(cancel)?;
      ensure!(
        !self.fail_capture.load(Ordering::SeqCst),
        "Mock screen unavailable."
      );
      let serial = serial.unwrap_or("12345678-1234-1234-1234-123456789abc");
      let count = self.captures.fetch_add(1, Ordering::SeqCst);
      let count = if self.repeat_frame.load(Ordering::SeqCst) {
        0
      } else {
        count
      };
      let (w, h, r) = *self.geometry.lock().unwrap();
      let red = if self.identical_image.load(Ordering::SeqCst) {
        12
      } else {
        12 + (count % 200) as u8
      };
      let image = image::RgbaImage::from_pixel(w, h, image::Rgba([red, 34, 56, 255]));
      let mut bytes = std::io::Cursor::new(Vec::new());
      image::DynamicImage::ImageRgba8(image).write_to(&mut bytes, image::ImageFormat::Png)?;
      Ok(ScreenCapture {
        bytes: bytes.into_inner().into(),
        serial: serial.into(),
        width: w,
        height: h,
        rotation: Some(r),
        source_frame_id: count.to_string(),
        captured_at: count.to_string(),
        frame_age_ms: 0,
        mime_type: "image/png".into(),
        device_width: w,
        device_height: h,
        preview_profile: "original".into(),
        received_at: Instant::now(),
      })
    }
    fn input(
      &self,
      name: &str,
      args: &Value,
      cancel: &Cancel,
      guard: Option<Guard>,
    ) -> Result<Value> {
      check(cancel)?;
      if let Some(guard) = guard {
        guard()?;
      }
      if name == "android_hid_arm" {
        return self.arm(cancel).map(|(value, _)| value);
      }
      if ["android_hid_pause", "android_release"].contains(&name) {
        self.stop()?;
        return Ok(self.state());
      }
      if name != "android_hid_status" {
        self.actions.lock().unwrap().push(name.into());
        self.revision.fetch_add(1, Ordering::SeqCst);
        let gate = self.input_gate.lock().unwrap().clone();
        if let Some((entered, release)) = gate {
          entered.wait();
          release.wait();
        }
        check(cancel)?;
        ensure!(
          !self.fail_input.load(Ordering::SeqCst),
          "Mock input failed after dispatch."
        );
      }
      if name == "android_calibrate_pointer" {
        ensure!(
          args["scaleX"].as_f64().is_some_and(|x| x > 0.0),
          "Bad calibration."
        );
        self.calibrated.store(true, Ordering::SeqCst);
      }
      Ok(self.state())
    }
    fn submit_remote(
      &self,
      report: Value,
      cancel: Cancel,
    ) -> Result<Box<dyn FnOnce() -> Result<Value> + Send>> {
      self.actions.lock().unwrap().push(report.to_string());
      let state = self.state();
      Ok(Box::new(move || {
        check(&cancel)?;
        Ok(state)
      }))
    }
    fn arm(&self, cancel: &Cancel) -> Result<(Value, u64)> {
      check(cancel)?;
      let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
      self.armed.store(true, Ordering::SeqCst);
      Ok((self.state(), epoch))
    }
    fn release(&self, cancel: &Cancel) -> Result<(Value, u64)> {
      check(cancel)?;
      self.revision.fetch_add(1, Ordering::SeqCst);
      let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
      self.armed.store(false, Ordering::SeqCst);
      Ok((self.state(), epoch))
    }
    fn state(&self) -> Value {
      let (w, h, r) = *self.geometry.lock().unwrap();
      json!({"screen":{"width":w,"height":h,"rotation":r},"calibrated":self.calibrated.load(Ordering::SeqCst),"scaleX":null,"scaleY":null,"pointer":null,"positionEstimated":true,"armed":self.armed.load(Ordering::SeqCst)})
    }
    fn control_epoch(&self) -> u64 {
      self.epoch.load(Ordering::SeqCst)
    }
    fn input_revision(&self) -> u64 {
      self.revision.load(Ordering::SeqCst)
    }
    fn observe(&self, _: &ScreenCapture) -> Result<()> {
      Ok(())
    }
    fn reset_calibration(&self) {
      self.calibrated.store(false, Ordering::SeqCst);
    }
    fn stop(&self) -> Result<()> {
      self.epoch.fetch_add(1, Ordering::SeqCst);
      self.armed.store(false, Ordering::SeqCst);
      self.stops.fetch_add(1, Ordering::SeqCst);
      Ok(())
    }
    fn stop_if_epoch(&self, expected: u64) -> Result<bool> {
      if self
        .epoch
        .compare_exchange(expected, expected + 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
      {
        self.armed.store(false, Ordering::SeqCst);
        self.stops.fetch_add(1, Ordering::SeqCst);
        Ok(true)
      } else {
        Ok(false)
      }
    }
    fn devices(&self) -> Result<Value> {
      Ok(json!({"android":[],"serialPorts":[],"errors":[]}))
    }
    fn profile(&self, selected: Option<&str>, _: &Cancel) -> Result<Value> {
      Ok(json!({"profile":selected.unwrap_or("standard")}))
    }
  }

  #[test]
  fn initialization_lists_all_frozen_tools_and_frames_stay_in_their_session() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let a = mcp.create_session().unwrap();
    let b = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let initialized=mcp.handle(&a,&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}),&cancel).unwrap();
    assert_eq!(initialized["result"]["protocolVersion"], "2025-03-26");
    let tools = mcp
      .handle(
        &a,
        &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        &cancel,
      )
      .unwrap();
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 22);
    let capture = mcp.call(&a, "android_screenshot", &json!({}), &cancel);
    assert!(capture.get("isError").is_none());
    let frame = capture["structuredContent"]["frameId"].clone();
    assert!(capture["structuredContent"]["deviceSerial"].is_string());
    let invalid = mcp.call(
      &b,
      "android_preview_tap",
      &json!({"frameId":frame,"x":10,"y":20}),
      &cancel,
    );
    assert_eq!(invalid["isError"], true);
    assert_eq!(backend.actions.lock().unwrap().len(), 0);
    let preview = mcp.call(
      &a,
      "android_preview_tap",
      &json!({"frameId":frame,"x":10,"y":20}),
      &cancel,
    );
    assert!(preview.get("isError").is_none(), "{preview}");
    assert_eq!(preview["structuredContent"]["realClickSent"], false);
    assert_eq!(
      preview["structuredContent"]["target"],
      json!({"x":10,"y":20,"coordinateSpace":"pixels"})
    );
    assert_eq!(
      preview["structuredContent"]["annotation"]["label"],
      "PHONE PX: X=10 Y=20"
    );
    assert_eq!(
      preview["structuredContent"]["annotation"]["coordinateSpace"],
      "originalPhonePixels"
    );
    assert_eq!(
      preview["structuredContent"]["annotation"]["original"]["sourceRect"]["x"],
      0
    );
    assert_eq!(
      preview["structuredContent"]["annotation"]["zoom"]["legend"]["height"],
      52
    );
    assert_eq!(preview["content"].as_array().unwrap().len(), 5);
    assert_eq!(backend.actions.lock().unwrap().len(), 0);
    let old = mcp.call(
      &a,
      "android_preview_tap",
      &json!({"frameId":frame,"x":10,"y":20}),
      &cancel,
    );
    assert_eq!(old["isError"], true);
  }

  #[test]
  fn inspection_and_failed_readonly_work_cannot_steal_or_stop_input() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let a = mcp.create_session().unwrap();
    let b = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    mcp.call(&a, "android_hid_arm", &json!({}), &cancel);
    assert!(mcp.owns_input(&a.id));
    let missing = mcp.call(&b, "android_mouse_move", &json!({}), &cancel);
    assert_eq!(missing["isError"], true);
    assert!(mcp.owns_input(&a.id));
    backend.fail_capture.store(true, Ordering::SeqCst);
    let failed = mcp.call(&b, "android_screenshot", &json!({}), &cancel);
    assert_eq!(failed["isError"], true);
    assert_eq!(backend.stops.load(Ordering::SeqCst), 0);
    mcp.close_session(&b);
    assert_eq!(backend.stops.load(Ordering::SeqCst), 0);
    mcp.close_session(&a);
    assert_eq!(backend.stops.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn geometry_change_invalidates_all_callers_and_integer_extremes_are_errors() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let a = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let capture = mcp.call(&a, "android_screenshot", &json!({}), &cancel);
    let frame = capture["structuredContent"]["frameId"].clone();
    *backend.geometry.lock().unwrap() = (256, 128, 1);
    mcp.read_live(&cancel).unwrap();
    let result = mcp.call(
      &a,
      "android_preview_tap",
      &json!({"frameId":frame,"x":10,"y":20}),
      &cancel,
    );
    assert_eq!(result["isError"], true);
    assert_eq!(backend.stops.load(Ordering::SeqCst), 1);
    assert!(integer(&json!({"x":i64::MIN}), "x", None).is_err());
    assert!(integer(&json!({"x":1.2}), "x", None).is_err());
  }

  #[test]
  fn control_executes_once_and_wait_never_arms() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let a = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let capture = mcp.call(&a, "android_screenshot", &json!({}), &cancel);
    let frame = capture["structuredContent"]["frameId"].clone();
    let wait = mcp.call(
      &a,
      "android_control",
      &json!({"action":"wait","frameId":frame,"waitMs":0}),
      &cancel,
    );
    assert!(wait.get("isError").is_none(), "{wait}");
    assert!(!backend.armed.load(Ordering::SeqCst));
    let controlled = mcp.call(
      &a,
      "android_control",
      &json!({"action":"click","frameId":wait["structuredContent"]["frameId"]}),
      &cancel,
    );
    assert!(controlled.get("isError").is_none(), "{controlled}");
    assert_eq!(controlled["structuredContent"]["actionCompleted"], true);
    assert_eq!(
      *backend.actions.lock().unwrap(),
      vec!["android_mouse_click"]
    );
  }

  #[test]
  fn measured_probe_is_session_bound_and_finish_never_repeats_the_movement() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let other = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let capture = mcp.call(&session, "android_screenshot", &json!({}), &cancel);
    let frame = capture["structuredContent"]["frameId"].clone();
    let invalid = mcp.call(
      &session,
      "android_pointer_calibration",
      &json!({"phase":"probe","frameId":frame,"counts":0}),
      &cancel,
    );
    assert_eq!(invalid["isError"], true);
    assert!(!backend.armed.load(Ordering::SeqCst));
    let probe = mcp.call(
      &session,
      "android_pointer_calibration",
      &json!({"phase":"probe","frameId":frame}),
      &cancel,
    );
    assert!(probe.get("isError").is_none(), "{probe}");
    assert_eq!(probe["content"].as_array().unwrap().len(), 5);
    let args = json!({"phase":"finish","frameId":probe["structuredContent"]["frameId"],"probeId":probe["structuredContent"]["probeId"],"startX":80,"startY":160,"endX":40,"endY":120});
    let stolen = mcp.call(&other, "android_pointer_calibration", &args, &cancel);
    assert_eq!(stolen["isError"], true);
    assert!(mcp.owns_input(&session.id));
    let aborted = Cancel::new();
    aborted.cancel();
    let failed = mcp.call(&session, "android_pointer_calibration", &args, &aborted);
    assert_eq!(failed["isError"], true);
    assert!(session.probe.lock().unwrap().is_some());
    let count = backend
      .actions
      .lock()
      .unwrap()
      .iter()
      .filter(|name| name.as_str() == "android_mouse_move")
      .count();
    assert_eq!(count, 2);
    let finish = mcp.call(&session, "android_pointer_calibration", &args, &cancel);
    assert!(finish.get("isError").is_none(), "{finish}");
    assert_eq!(finish["structuredContent"]["scaleX"], 2.4);
    assert_eq!(finish["structuredContent"]["scaleY"], 2.4);
    assert!(session.probe.lock().unwrap().is_none());
    assert_eq!(
      backend
        .actions
        .lock()
        .unwrap()
        .iter()
        .filter(|name| name.as_str() == "android_mouse_move")
        .count(),
      2
    );
  }

  #[test]
  fn identical_probe_images_are_not_measurable_and_cannot_finish() {
    let backend = Arc::new(FakeBackend::default());
    backend.identical_image.store(true, Ordering::SeqCst);
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let capture = mcp.call(&session, "android_screenshot", &json!({}), &cancel);
    let result = mcp.call(
      &session,
      "android_pointer_calibration",
      &json!({"phase":"probe","frameId":capture["structuredContent"]["frameId"]}),
      &cancel,
    );
    assert!(result.get("isError").is_none(), "{result}");
    assert_eq!(result["structuredContent"]["measurable"], false);
    assert_eq!(result["structuredContent"]["measurementAvailable"], false);
    assert_eq!(result["structuredContent"]["reason"], "identical_images");
    assert_eq!(result["structuredContent"]["movementAttempted"], true);
    assert!(session.probe.lock().unwrap().is_none());
    assert!(!backend.calibrated.load(Ordering::SeqCst));
    assert!(!backend.armed.load(Ordering::SeqCst));
    assert_eq!(
      backend
        .actions
        .lock()
        .unwrap()
        .iter()
        .filter(|name| name.as_str() == "android_mouse_move")
        .count(),
      2
    );
    assert_eq!(
      result["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["type"] == "image")
        .count(),
      2
    );
  }

  #[test]
  fn auto_calibration_uses_actual_mouse_events_without_clicking_or_opening_a_page() {
    let backend = Arc::new(FakeBackend::default());
    *backend.calibration_mode.lock().unwrap() = "active";
    // The cursor can be completely missing from the system screenshots.
    backend.identical_image.store(true, Ordering::SeqCst);
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let capture = mcp.call(&session, "android_screenshot", &json!({}), &cancel);
    let result = mcp.call(
      &session,
      "android_pointer_calibration",
      &json!({"phase":"auto","frameId":capture["structuredContent"]["frameId"]}),
      &cancel,
    );
    assert!(result.get("isError").is_none(), "{result}");
    assert_eq!(result["structuredContent"]["calibrated"], true);
    assert_eq!(
      result["structuredContent"]["measurementSource"],
      "android-mouse-events"
    );
    assert_eq!(result["structuredContent"]["scaleX"], 2.0);
    assert_eq!(result["structuredContent"]["scaleY"], 1.0);
    assert_eq!(result["structuredContent"]["start"]["sequence"], 1);
    assert_eq!(result["structuredContent"]["end"]["sequence"], 2);
    assert_eq!(
      *backend.actions.lock().unwrap(),
      [
        "android_mouse_move",
        "android_mouse_move",
        "android_calibrate_pointer"
      ]
    );
    assert!(backend.calibrated.load(Ordering::SeqCst));
  }

  #[test]
  fn auto_calibration_rejects_inactive_stale_replaced_rotated_and_clipped_pages() {
    for mode in [
      "inactive",
      "no-event",
      "stale",
      "changed-session",
      "rotated",
      "edge",
      "reversed",
      "changed-final",
    ] {
      let backend = Arc::new(FakeBackend::default());
      *backend.calibration_mode.lock().unwrap() = mode;
      backend.calibrated.store(true, Ordering::SeqCst);
      let mcp = Mcp::new(backend.clone());
      let session = mcp.create_session().unwrap();
      let cancel = Cancel::new();
      let capture = mcp.call(&session, "android_screenshot", &json!({}), &cancel);
      let result = mcp.call(
        &session,
        "android_pointer_calibration",
        &json!({"phase":"auto","frameId":capture["structuredContent"]["frameId"]}),
        &cancel,
      );
      assert_eq!(result["isError"], true, "mode={mode}: {result}");
      assert_eq!(result["structuredContent"]["measurementAvailable"], false);
      assert!(
        backend.calibrated.load(Ordering::SeqCst),
        "existing calibration was changed for {mode}"
      );
      assert!(!backend.armed.load(Ordering::SeqCst));
      assert!(backend
        .actions
        .lock()
        .unwrap()
        .iter()
        .all(|name| name == "android_mouse_move"));
      assert_eq!(
        backend.actions.lock().unwrap().len(),
        if mode == "inactive" {
          0
        } else if ["no-event", "stale"].contains(&mode) {
          1
        } else {
          2
        }
      );
    }
  }

  #[test]
  fn cancelling_auto_calibration_during_settle_does_not_send_the_measured_probe() {
    let backend = Arc::new(FakeBackend::default());
    *backend.calibration_mode.lock().unwrap() = "active";
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let capture = mcp.call(&session, "android_screenshot", &json!({}), &cancel);
    let cancelling = cancel.clone();
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(100));
      cancelling.cancel();
    });
    let result = mcp.call(
      &session,
      "android_pointer_calibration",
      &json!({"phase":"auto","frameId":capture["structuredContent"]["frameId"]}),
      &cancel,
    );
    assert_eq!(result["isError"], true);
    assert_eq!(*backend.actions.lock().unwrap(), ["android_mouse_move"]);
    assert!(!backend.armed.load(Ordering::SeqCst));
    assert!(!backend.calibrated.load(Ordering::SeqCst));
  }

  #[test]
  fn completed_action_with_repeated_cached_picture_is_reported_without_replay() {
    let backend = Arc::new(FakeBackend::default());
    backend.repeat_frame.store(true, Ordering::SeqCst);
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let capture = mcp.call(&session, "android_screenshot", &json!({}), &cancel);
    let result = mcp.call(
      &session,
      "android_control",
      &json!({"action":"click","frameId":capture["structuredContent"]["frameId"]}),
      &cancel,
    );
    assert_eq!(result["isError"], true);
    assert_eq!(result["structuredContent"]["actionCompleted"], true);
    assert_eq!(
      *backend.actions.lock().unwrap(),
      vec!["android_mouse_click"]
    );
    assert!(!backend.armed.load(Ordering::SeqCst));
  }

  #[test]
  fn completed_request_tracks_its_own_arm_and_old_cleanup_cannot_stop_new_arm() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let round = AtomicU64::new(u64::MAX);
    let first = mcp
      .handle_tracked(
        &session,
        &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"android_hid_arm"}}),
        &cancel,
        Some(&round),
      )
      .unwrap();
    assert!(first["result"].get("isError").is_none());
    let old_round = round.load(Ordering::SeqCst);
    assert_eq!(old_round, backend.control_epoch());
    mcp.call(&session, "android_hid_arm", &json!({}), &cancel);
    assert_ne!(old_round, backend.control_epoch());
    assert!(!backend.stop_if_epoch(old_round).unwrap());
    assert!(backend.armed.load(Ordering::SeqCst));
    assert_eq!(backend.stops.load(Ordering::SeqCst), 0);
    let readonly = AtomicU64::new(u64::MAX);
    mcp.handle_tracked(
      &session,
      &json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"android_hid_status"}}),
      &cancel,
      Some(&readonly),
    );
    assert_eq!(readonly.load(Ordering::SeqCst), u64::MAX);
  }

  fn request(id: Value, name: &str, args: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})
  }

  #[test]
  fn request_id_completed_calls_cannot_replay_but_new_ids_and_sessions_can_repeat_text() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let first = request(json!(1), "android_type", json!({"text":"repeat"}));
    let result = mcp.handle(&session, &first, &cancel).unwrap();
    assert!(result["result"].get("isError").is_none(), "{result}");
    let duplicate = mcp.handle(&session, &first, &cancel).unwrap();
    assert_eq!(duplicate["error"]["code"], -32600, "{duplicate}");
    let changed = mcp
      .handle(
        &session,
        &request(json!(1), "android_key", json!({"combo":"escape"})),
        &cancel,
      )
      .unwrap();
    assert_eq!(changed["error"]["code"], -32600, "{changed}");
    assert_eq!(*backend.actions.lock().unwrap(), ["android_type"]);
    for id in [json!(2), json!("1")] {
      let result = mcp
        .handle(
          &session,
          &request(id, "android_type", json!({"text":"repeat"})),
          &cancel,
        )
        .unwrap();
      assert!(result["result"].get("isError").is_none(), "{result}");
    }
    let other = mcp.create_session().unwrap();
    let result = mcp.handle(&other, &first, &cancel).unwrap();
    assert!(result["result"].get("isError").is_none(), "{result}");
    assert_eq!(*backend.actions.lock().unwrap(), ["android_type"; 4]);
  }

  #[test]
  fn request_id_failed_dispatch_cannot_replay_or_claim_or_stop_a_new_owner() {
    let backend = Arc::new(FakeBackend::default());
    backend.fail_input.store(true, Ordering::SeqCst);
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let first = request(json!("failed"), "android_type", json!({"text":"partial"}));
    let failed = mcp.handle(&session, &first, &cancel).unwrap();
    assert_eq!(failed["result"]["isError"], true, "{failed}");
    backend.fail_input.store(false, Ordering::SeqCst);
    let other = mcp.create_session().unwrap();
    mcp.call(&other, "android_hid_arm", &json!({}), &cancel);
    let epoch = backend.control_epoch();
    let stops = backend.stops.load(Ordering::SeqCst);
    let round = AtomicU64::new(u64::MAX);
    let duplicate = mcp
      .handle_tracked(&session, &first, &cancel, Some(&round))
      .unwrap();
    assert_eq!(duplicate["error"]["code"], -32600, "{duplicate}");
    assert_eq!(*backend.actions.lock().unwrap(), ["android_type"]);
    assert!(mcp.owns_input(&other.id));
    assert_eq!(backend.control_epoch(), epoch);
    assert_eq!(backend.stops.load(Ordering::SeqCst), stops);
    assert_eq!(round.load(Ordering::SeqCst), u64::MAX);
  }

  #[test]
  fn request_id_cancellation_retains_the_id_before_and_after_dispatch() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancelled = Cancel::new();
    cancelled.cancel();
    let first = request(
      json!("cancelled-before"),
      "android_type",
      json!({"text":"never"}),
    );
    assert_eq!(
      mcp.handle(&session, &first, &cancelled).unwrap()["result"]["isError"],
      true
    );
    let duplicate = mcp.handle(&session, &first, &Cancel::new()).unwrap();
    assert_eq!(duplicate["error"]["code"], -32600, "{duplicate}");
    assert!(backend.actions.lock().unwrap().is_empty());

    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    *backend.input_gate.lock().unwrap() = Some((entered.clone(), release.clone()));
    let first = request(
      json!("cancelled-during"),
      "android_type",
      json!({"text":"partial"}),
    );
    let worker_mcp = mcp.clone();
    let worker_session = session.clone();
    let worker_request = first.clone();
    let worker = std::thread::spawn(move || {
      worker_mcp
        .handle(&worker_session, &worker_request, &Cancel::new())
        .unwrap()
    });
    entered.wait();
    let duplicate = mcp.handle(&session, &first, &Cancel::new()).unwrap();
    assert_eq!(duplicate["error"]["code"], -32600, "{duplicate}");
    let notification = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"cancelled-during"}});
    assert!(mcp
      .handle(&session, &notification, &Cancel::new())
      .is_none());
    release.wait();
    assert_eq!(worker.join().unwrap()["result"]["isError"], true);
    *backend.input_gate.lock().unwrap() = None;
    let duplicate = mcp.handle(&session, &first, &Cancel::new()).unwrap();
    assert_eq!(duplicate["error"]["code"], -32600, "{duplicate}");

    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    *backend.input_gate.lock().unwrap() = Some((entered.clone(), release.clone()));
    let worker_mcp = mcp.clone();
    let worker_session = session.clone();
    let worker = std::thread::spawn(move || {
      worker_mcp
        .handle(
          &worker_session,
          &request(json!("new"), "android_type", json!({"text":"new"})),
          &Cancel::new(),
        )
        .unwrap()
    });
    entered.wait();
    assert!(mcp
      .handle(&session, &notification, &Cancel::new())
      .is_none());
    release.wait();
    let result = worker.join().unwrap();
    assert!(result["result"].get("isError").is_none(), "{result}");
    assert_eq!(*backend.actions.lock().unwrap(), ["android_type"; 2]);
  }

  #[test]
  fn request_id_readonly_ids_cannot_be_repurposed_for_input() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    let read = request(json!("read"), "android_hid_status", json!({}));
    assert!(mcp.handle(&session, &read, &cancel).unwrap()["result"]
      .get("isError")
      .is_none());
    let duplicate = mcp
      .handle(
        &session,
        &request(json!("read"), "android_type", json!({"text":"unexpected"})),
        &cancel,
      )
      .unwrap();
    assert_eq!(duplicate["error"]["code"], -32600, "{duplicate}");
    assert!(backend.actions.lock().unwrap().is_empty());
    assert!(!mcp.owns_input(&session.id));
  }

  #[test]
  fn request_id_budget_fails_closed_without_eviction_until_a_new_session() {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let session = mcp.create_session().unwrap();
    let cancel = Cancel::new();
    for id in 0..4096 {
      let read = request(json!(id), "android_hid_status", json!({}));
      assert!(mcp.handle(&session, &read, &cancel).unwrap()["result"]
        .get("isError")
        .is_none());
    }
    let next = request(json!(4096), "android_type", json!({"text":"capacity"}));
    let full = mcp.handle(&session, &next, &cancel).unwrap();
    assert_eq!(full["error"]["code"], -32600, "{full}");
    assert!(
      full["error"]["message"]
        .as_str()
        .unwrap()
        .contains("new MCP session"),
      "{full}"
    );
    let old = mcp
      .handle(
        &session,
        &request(json!(0), "android_type", json!({"text":"old"})),
        &cancel,
      )
      .unwrap();
    assert_eq!(old["error"]["code"], -32600, "{old}");
    assert!(backend.actions.lock().unwrap().is_empty());
    assert_eq!(session.calls.lock().unwrap().len(), 4096);
    mcp.close_session(&session);
    let other = mcp.create_session().unwrap();
    let result = mcp.handle(&other, &next, &cancel).unwrap();
    assert!(result["result"].get("isError").is_none(), "{result}");
    assert_eq!(*backend.actions.lock().unwrap(), ["android_type"]);
  }
}
