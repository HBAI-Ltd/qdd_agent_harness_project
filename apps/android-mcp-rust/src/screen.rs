use crate::{net, Cancel, Result};
use anyhow::{anyhow, bail, ensure, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
  collections::BTreeMap,
  net::Ipv4Addr,
  sync::{Arc, Mutex, MutexGuard, TryLockError},
  thread::{self, JoinHandle},
  time::{Duration, Instant},
};

pub const MAX_SCREEN_FRAME_AGE_MS: u64 = 3000;
pub const MAX_SCREEN_FRAME_BYTES: usize = 32 * 1024 * 1024;
pub const PREVIEW_PROFILES: [&str; 4] = ["turbo", "fast", "standard", "original"];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerCalibrationPoint {
  pub x: f64,
  pub y: f64,
  pub sequence: u64,
  pub age_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerCalibrationState {
  pub active: bool,
  pub device_id: String,
  pub session_id: Option<String>,
  pub width: u32,
  pub height: u32,
  pub rotation: u8,
  pub point: Option<PointerCalibrationPoint>,
}

impl PointerCalibrationState {
  fn parse(bytes: &[u8]) -> Result<Self> {
    let state: Self = serde_json::from_slice(bytes)
      .context("SCREEN_INVALID_CALIBRATION: Invalid pointer calibration response.")?;
    ensure!(
      valid_device_id(&state.device_id),
      "SCREEN_INVALID_CALIBRATION: Invalid device identity."
    );
    if state.active {
      ensure!(
        state.session_id.as_deref().is_some_and(valid_device_id)
          && state.width > 0
          && state.height > 0
          && state.rotation <= 3,
        "SCREEN_INVALID_CALIBRATION: Invalid active calibration geometry or session."
      );
    }
    if let Some(point) = &state.point {
      ensure!(
        state.active
          && point.sequence > 0
          && point.x.is_finite()
          && point.y.is_finite()
          && point.x >= 0.0
          && point.y >= 0.0
          && point.x < f64::from(state.width)
          && point.y < f64::from(state.height),
        "SCREEN_INVALID_CALIBRATION: Invalid actual mouse coordinates."
      );
    }
    Ok(state)
  }
}

#[derive(Clone, Debug)]
pub struct ScreenCapture {
  pub bytes: Arc<[u8]>,
  pub serial: String,
  pub width: u32,
  pub height: u32,
  pub rotation: Option<u8>,
  pub source_frame_id: String,
  pub captured_at: String,
  pub frame_age_ms: u64,
  pub mime_type: String,
  pub device_width: u32,
  pub device_height: u32,
  pub preview_profile: String,
  pub received_at: Instant,
}

impl ScreenCapture {
  pub fn age_ms(&self) -> u64 {
    self.frame_age_ms.saturating_add(
      self
        .received_at
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64,
    )
  }

  pub fn metadata(&self) -> Value {
    let mut value = json!({
      "serial": self.serial, "width": self.width, "height": self.height,
      "capturedAt": self.captured_at, "source": "screen-app",
      "sourceFrameId": self.source_frame_id, "frameAgeMs": self.age_ms(),
      "mimeType": self.mime_type, "deviceWidth": self.device_width,
      "deviceHeight": self.device_height, "previewProfile": self.preview_profile,
      "sha256": format!("{:x}", Sha256::digest(&self.bytes)),
    });
    if let Some(rotation) = self.rotation {
      value["rotation"] = rotation.into();
    }
    value
  }
}

pub struct ScreenClient {
  pub endpoint: String,
  device_id: Option<String>,
  captures: Mutex<()>,
  profiles: Mutex<()>,
  closed: Cancel,
}

impl ScreenClient {
  pub fn new(endpoint: String, device_id: Option<String>) -> Result<Self> {
    let endpoint = endpoint_origin(&endpoint)?;
    if let Some(id) = &device_id {
      ensure!(
        valid_device_id(id),
        "SCREEN_DEVICE_MISMATCH: deviceId 必须是手机 App 的完整 UUID。"
      );
    }
    Ok(Self {
      endpoint,
      device_id: device_id.map(|v| v.to_ascii_lowercase()),
      captures: Mutex::new(()),
      profiles: Mutex::new(()),
      closed: Cancel::new(),
    })
  }

  pub fn close(&self) {
    self.closed.cancel();
  }

  pub fn list_devices(&self) -> Result<Value> {
    let response = self.request("GET", "/health", &[], None, 64 * 1024)?;
    ensure!(
      mime(&response.headers) == Some("application/json"),
      "SCREEN_INVALID_HEALTH: 手机健康信息不是 JSON。"
    );
    let health: Value = serde_json::from_slice(&response.body)
      .context("SCREEN_INVALID_HEALTH: 手机健康信息不是有效 JSON。")?;
    let id = health["deviceId"].as_str().unwrap_or_default();
    let model = health["model"].as_str().unwrap_or_default();
    ensure!(
      health["status"] == "ok"
        && health["service"] == "qdd-android-screen"
        && valid_device_id(id)
        && !model.is_empty()
        && model.chars().count() <= 256
        && health["projecting"].is_boolean(),
      "SCREEN_INVALID_HEALTH: 手机设备 ID、型号或投屏状态无效。"
    );
    self.check_device(id, None)?;
    let projecting = health["projecting"].as_bool().unwrap();
    let mut properties = json!({ "source": "screen-app", "endpoint": self.endpoint, "projecting": projecting.to_string() });
    if let Some(ready) = health["frameReady"].as_bool() {
      properties["frameReady"] = ready.to_string().into();
    }
    Ok(
      json!([{ "serial": id.to_ascii_lowercase(), "state": if projecting { "device" } else { "not_projecting" },
      "model": model, "properties": properties }]),
    )
  }

  pub fn capture(&self, serial: Option<&str>, cancel: &Cancel) -> Result<ScreenCapture> {
    let _guard = cancellable_lock(&self.captures, cancel)?;
    check_cancel(cancel)?;
    let response = self.request(
      "GET",
      "/frame.jpg",
      &[],
      Some(cancel),
      MAX_SCREEN_FRAME_BYTES,
    )?;
    let frame = self.frame_from_parts(
      &response.headers,
      response.body,
      response.received_at,
      serial,
    )?;
    ensure!(
      frame.width == frame.device_width
        && frame.height == frame.device_height
        && frame.preview_profile == "original",
      "SCREEN_INVALID_FRAME: MCP 原图接口返回了缩小预览，请更新手机 App。"
    );
    check_cancel(cancel)?;
    Ok(frame)
  }

  pub fn pointer_calibration(
    &self,
    serial: &str,
    cancel: &Cancel,
  ) -> Result<PointerCalibrationState> {
    let requested = Instant::now();
    let response = self.request("GET", "/pointer/calibration", &[], Some(cancel), 4096)?;
    ensure!(
      mime(&response.headers) == Some("application/json"),
      "SCREEN_INVALID_CALIBRATION: Pointer calibration response is not JSON."
    );
    let mut state = PointerCalibrationState::parse(&response.body)?;
    self.check_device(&state.device_id, Some(serial))?;
    if let Some(point) = &mut state.point {
      // Server age is measured before transfer. Conservatively include the
      // whole request RTT so delayed coordinates cannot appear freshly read.
      point.age_ms = point
        .age_ms
        .saturating_add(requested.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
    }
    Ok(state)
  }

  pub fn get_preview_profile(&self) -> Result<Value> {
    self.profile_request(None)
  }

  pub fn set_preview_profile(&self, profile: &str) -> Result<Value> {
    ensure!(
      PREVIEW_PROFILES.contains(&profile),
      "SCREEN_INVALID_PROFILE: 未知画质档位。"
    );
    self.profile_request(Some(profile))
  }

  fn profile_request(&self, profile: Option<&str>) -> Result<Value> {
    let _guard = self
      .profiles
      .lock()
      .map_err(|_| anyhow!("Screen profile lock poisoned"))?;
    let operation = Operation::new(&self.closed, None);
    let body = profile
      .map(|p| serde_json::to_vec(&json!({ "profile": p })).unwrap())
      .unwrap_or_default();
    let headers = if profile.is_some() {
      vec![("Content-Type".into(), "application/json".into())]
    } else {
      vec![]
    };
    let response = net::request(
      if profile.is_some() { "POST" } else { "GET" },
      &format!("{}/preview/profile", self.endpoint),
      &headers,
      &body,
      &operation.cancel,
      2048,
    )?;
    check_cancel(&operation.cancel)?;
    if response.status == 404 {
      if profile.is_none() {
        return Ok(json!({ "profile": "original" }));
      }
      bail!("SCREEN_HTTP_ERROR: 请先更新手机 App，才能切换预览画质。");
    }
    successful(response.status)?;
    ensure!(
      mime(&response.headers) == Some("application/json"),
      "SCREEN_INVALID_PROFILE: 手机画质设置不是 JSON。"
    );
    let state: Value = serde_json::from_slice(&response.body)
      .context("SCREEN_INVALID_PROFILE: 手机画质设置不是有效 JSON。")?;
    let actual = state["profile"].as_str().unwrap_or_default();
    ensure!(
      PREVIEW_PROFILES.contains(&actual),
      "SCREEN_INVALID_PROFILE: 手机返回了未知画质档位。"
    );
    ensure!(
      profile.is_none() || profile == Some(actual),
      "SCREEN_INVALID_PROFILE: 手机未应用所选画质。"
    );
    let mut result = json!({ "profile": actual });
    match (state.get("deviceWidth"), state.get("deviceHeight")) {
      (None, None) => {}
      (Some(w), Some(h)) => {
        let (w, h) = (w.as_u64().unwrap_or(0), h.as_u64().unwrap_or(0));
        ensure!(
          (1..=65535).contains(&w) && (1..=65535).contains(&h),
          "SCREEN_INVALID_PROFILE: 手机物理屏幕尺寸无效。"
        );
        result["deviceWidth"] = w.into();
        result["deviceHeight"] = h.into();
      }
      _ => bail!("SCREEN_INVALID_PROFILE: 手机物理屏幕尺寸必须成对出现。"),
    }
    Ok(result)
  }

  fn request(
    &self,
    method: &str,
    path: &str,
    body: &[u8],
    caller: Option<&Cancel>,
    limit: usize,
  ) -> Result<net::Response> {
    let operation = Operation::new(&self.closed, caller);
    check_cancel(&operation.cancel)?;
    let response = net::request(
      method,
      &format!("{}{path}", self.endpoint),
      &[],
      body,
      &operation.cancel,
      limit,
    )?;
    check_cancel(&operation.cancel)?;
    successful(response.status)?;
    Ok(response)
  }

  pub(crate) fn open_stream(&self, cancel: &Cancel) -> Result<net::OpenResponse> {
    ensure!(!self.closed.is_cancelled(), "手机画面连接已关闭。");
    check_cancel(cancel)?;
    let response = net::open(
      "GET",
      &format!("{}/stream.mjpg", self.endpoint),
      &[],
      &[],
      cancel,
    )?;
    successful(response.status)?;
    let content_type = response
      .headers
      .get("content-type")
      .map(|v| v.to_ascii_lowercase())
      .unwrap_or_default();
    let parts: Vec<_> = content_type.split(';').map(str::trim).collect();
    ensure!(
      parts.len() == 2
        && parts[0] == "multipart/x-mixed-replace"
        && matches!(parts[1], "boundary=qdd-frame" | "boundary=\"qdd-frame\""),
      "SCREEN_HTTP_ERROR: 手机连续流的 MIME 或边界无效，请更新手机 App。"
    );
    Ok(response)
  }

  pub(crate) fn frame_from_parts(
    &self,
    headers: &BTreeMap<String, String>,
    bytes: Vec<u8>,
    received_at: Instant,
    expected_id: Option<&str>,
  ) -> Result<ScreenCapture> {
    let mime_type = mime(headers).unwrap_or_default();
    ensure!(
      matches!(mime_type, "image/jpeg" | "image/png"),
      "SCREEN_INVALID_FRAME: 手机未返回 JPEG 或 PNG。"
    );
    ensure!(
      !bytes.is_empty() && bytes.len() <= MAX_SCREEN_FRAME_BYTES,
      "SCREEN_TOO_LARGE: 手机画面大小无效或超过 32 MiB。"
    );
    let serial = headers
      .get("x-device-id")
      .map(String::as_str)
      .unwrap_or_default();
    ensure!(
      valid_device_id(serial),
      "SCREEN_INVALID_FRAME: 手机画面缺少有效 X-Device-Id。"
    );
    self.check_device(serial, expected_id)?;
    let source_frame_id = headers
      .get("x-frame-id")
      .map(|v| v.trim())
      .unwrap_or_default();
    ensure!(
      !source_frame_id.is_empty() && source_frame_id.len() <= 256,
      "SCREEN_INVALID_FRAME: 手机画面缺少有效 X-Frame-Id。"
    );
    let frame_age_ms = decimal_header(headers, "x-frame-age-ms", false)?;
    ensure!(
      frame_age_ms <= MAX_SCREEN_FRAME_AGE_MS,
      "SCREEN_STALE_FRAME: 手机画面超过三秒未更新。"
    );
    let captured_at = headers
      .get("x-captured-at")
      .map(String::as_str)
      .unwrap_or_default();
    ensure!(
      valid_timestamp(captured_at),
      "SCREEN_INVALID_FRAME: 手机画面缺少有效 X-Captured-At。"
    );
    let rotation = match headers.get("x-display-rotation") {
      None => None,
      Some(v) if v.len() == 1 && matches!(v.as_bytes()[0], b'0'..=b'3') => {
        Some(v.as_bytes()[0] - b'0')
      }
      _ => bail!("SCREEN_INVALID_FRAME: X-Display-Rotation 必须为 0 到 3。"),
    };
    let (width, height) = if mime_type == "image/jpeg" {
      read_jpeg_dimensions(&bytes)?
    } else {
      read_png_dimensions(&bytes)?
    };
    for (name, size) in [("x-frame-width", width), ("x-frame-height", height)] {
      if headers.contains_key(name) {
        ensure!(
          decimal_header(headers, name, false)? == u64::from(size),
          "SCREEN_INVALID_FRAME: 图像尺寸与帧头不一致。"
        );
      }
    }
    let preview_keys = ["x-device-width", "x-device-height", "x-preview-profile"];
    let (device_width, device_height, preview_profile) =
      if preview_keys.iter().any(|key| headers.contains_key(*key)) {
        let dw = decimal_header(headers, "x-device-width", true)?;
        let dh = decimal_header(headers, "x-device-height", true)?;
        let profile = headers
          .get("x-preview-profile")
          .map(String::as_str)
          .unwrap_or_default();
        ensure!(
          dw <= 65535 && dh <= 65535 && PREVIEW_PROFILES.contains(&profile),
          "SCREEN_INVALID_FRAME: 物理屏幕尺寸或画质档位无效。"
        );
        ensure!(
          dw >= u64::from(width)
            && dh >= u64::from(height)
            && (i128::from(width) * i128::from(dh) - i128::from(height) * i128::from(dw)).abs()
              <= i128::from(dw + dh)
            && (profile != "original" || (dw == u64::from(width) && dh == u64::from(height))),
          "SCREEN_INVALID_FRAME: 手机预览尺寸与真实屏幕尺寸不一致。"
        );
        (dw as u32, dh as u32, profile.to_owned())
      } else {
        (width, height, "original".into())
      };
    let frame = ScreenCapture {
      bytes: bytes.into(),
      serial: serial.to_ascii_lowercase(),
      width,
      height,
      rotation,
      source_frame_id: source_frame_id.into(),
      captured_at: captured_at.into(),
      frame_age_ms,
      mime_type: mime_type.into(),
      device_width,
      device_height,
      preview_profile,
      received_at,
    };
    ensure!(
      frame.age_ms() <= MAX_SCREEN_FRAME_AGE_MS,
      "SCREEN_STALE_FRAME: 图像传输后已超过三秒。"
    );
    Ok(frame)
  }

  fn check_device(&self, serial: &str, expected: Option<&str>) -> Result<()> {
    for id in [self.device_id.as_deref(), expected].into_iter().flatten() {
      ensure!(
        id.eq_ignore_ascii_case(serial),
        "SCREEN_DEVICE_MISMATCH: 连接的是另一台手机，请重新选择。"
      );
    }
    Ok(())
  }
}

pub(crate) fn check_cancel(cancel: &Cancel) -> Result<()> {
  ensure!(!cancel.is_cancelled(), "Operation cancelled.");
  Ok(())
}

pub(crate) fn cancellable_lock<'a>(
  mutex: &'a Mutex<()>,
  cancel: &Cancel,
) -> Result<MutexGuard<'a, ()>> {
  loop {
    check_cancel(cancel)?;
    match mutex.try_lock() {
      Ok(guard) => return Ok(guard),
      Err(TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(5)),
      Err(TryLockError::Poisoned(_)) => bail!("Operation lock poisoned."),
    }
  }
}

fn successful(status: u16) -> Result<()> {
  if status == 503 {
    bail!("SCREEN_NOT_PROJECTING: 手机暂时没有新画面，请开始投屏并确认系统屏幕共享授权。");
  }
  ensure!(
    status == 200,
    "SCREEN_HTTP_ERROR: 手机返回 HTTP {status}，拒绝错误或重定向响应。"
  );
  Ok(())
}

fn mime(headers: &BTreeMap<String, String>) -> Option<&str> {
  headers
    .get("content-type")
    .map(|v| v.split(';').next().unwrap_or_default().trim())
}

fn decimal_header(headers: &BTreeMap<String, String>, key: &str, positive: bool) -> Result<u64> {
  let text = headers
    .get(key)
    .ok_or_else(|| anyhow!("SCREEN_INVALID_FRAME: missing {key}"))?;
  ensure!(
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
    "SCREEN_INVALID_FRAME: invalid {key}"
  );
  if positive {
    ensure!(
      !text.starts_with('0'),
      "SCREEN_INVALID_FRAME: invalid {key}"
    );
  }
  let value: u64 = text
    .parse()
    .with_context(|| format!("SCREEN_INVALID_FRAME: invalid {key}"))?;
  ensure!(
    value <= 9_007_199_254_740_991 && (!positive || value > 0),
    "SCREEN_INVALID_FRAME: invalid {key}"
  );
  Ok(value)
}

pub(crate) fn valid_device_id(id: &str) -> bool {
  let parts: Vec<_> = id.split('-').collect();
  parts.len() == 5
    && parts
      .iter()
      .zip([8, 4, 4, 4, 12])
      .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn endpoint_origin(input: &str) -> Result<String> {
  let input = input.trim();
  let (scheme, rest, default_port) = if let Some(rest) = input.strip_prefix("http://") {
    ("http", rest, 80)
  } else if let Some(rest) = input.strip_prefix("https://") {
    ("https", rest, 443)
  } else {
    bail!("SCREEN_INVALID_ENDPOINT: 需要内网 IPv4 HTTP 地址。");
  };
  ensure!(
    !rest.contains(['@', '?', '#', '\\']),
    "SCREEN_INVALID_ENDPOINT: 地址不得包含账号、查询参数或片段。"
  );
  let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
  ensure!(
    path.is_empty() || path == "frame.jpg",
    "SCREEN_INVALID_ENDPOINT: 地址路径无效。"
  );
  let (host, port) = if let Some((host, port)) = authority.split_once(':') {
    (
      host,
      port
        .parse::<u16>()
        .context("SCREEN_INVALID_ENDPOINT: invalid port")?,
    )
  } else {
    (authority, default_port)
  };
  let ip: Ipv4Addr = host
    .parse()
    .context("SCREEN_INVALID_ENDPOINT: 需要明确内网 IPv4 地址。")?;
  ensure!(
    port > 0 && (ip.is_private() || ip.is_loopback()),
    "SCREEN_INVALID_ENDPOINT: 禁止公开互联网地址。"
  );
  Ok(if port == default_port {
    format!("{scheme}://{ip}")
  } else {
    format!("{scheme}://{ip}:{port}")
  })
}

fn valid_timestamp(value: &str) -> bool {
  let b = value.as_bytes();
  if b.len() < 20
    || [4, 7].iter().any(|i| b.get(*i) != Some(&b'-'))
    || b.get(10) != Some(&b'T')
    || b.get(13) != Some(&b':')
    || b.get(16) != Some(&b':')
  {
    return false;
  }
  let number = |start: usize, end: usize| -> Option<u32> {
    let slice = b.get(start..end)?;
    if !slice.iter().all(u8::is_ascii_digit) {
      return None;
    }
    std::str::from_utf8(slice).ok()?.parse().ok()
  };
  let Some(year) = number(0, 4) else {
    return false;
  };
  let Some(month) = number(5, 7) else {
    return false;
  };
  let Some(day) = number(8, 10) else {
    return false;
  };
  let Some(hour) = number(11, 13) else {
    return false;
  };
  let Some(minute) = number(14, 16) else {
    return false;
  };
  let Some(second) = number(17, 19) else {
    return false;
  };
  let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  let days = match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 => {
      if leap {
        29
      } else {
        28
      }
    }
    _ => return false,
  };
  if day == 0 || day > days || hour > 23 || minute > 59 || second > 59 {
    return false;
  }
  let mut offset = 19;
  if b.get(offset) == Some(&b'.') {
    offset += 1;
    let start = offset;
    while b.get(offset).is_some_and(u8::is_ascii_digit) {
      offset += 1;
    }
    if !(1..=9).contains(&(offset - start)) {
      return false;
    }
  }
  if b.get(offset..) == Some(&b"Z"[..]) {
    return true;
  }
  b.len() == offset + 6
    && matches!(b[offset], b'+' | b'-')
    && b[offset + 3] == b':'
    && number(offset + 1, offset + 3).is_some_and(|n| n <= 23)
    && number(offset + 4, offset + 6).is_some_and(|n| n <= 59)
}

struct Operation {
  cancel: Cancel,
  done: Cancel,
  watcher: Option<JoinHandle<()>>,
}
impl Operation {
  fn new(closed: &Cancel, caller: Option<&Cancel>) -> Self {
    let cancel = Cancel::new();
    let done = Cancel::new();
    let (active, finished, closed, caller) = (
      cancel.clone(),
      done.clone(),
      closed.clone(),
      caller.cloned(),
    );
    if closed.is_cancelled() || caller.as_ref().is_some_and(Cancel::is_cancelled) {
      cancel.cancel();
    }
    let watcher = thread::spawn(move || {
      let started = Instant::now();
      while !finished.is_cancelled() {
        if closed.is_cancelled()
          || caller.as_ref().is_some_and(Cancel::is_cancelled)
          || started.elapsed() >= Duration::from_secs(10)
        {
          active.cancel();
          break;
        }
        thread::sleep(Duration::from_millis(5));
      }
    });
    Self {
      cancel,
      done,
      watcher: Some(watcher),
    }
  }
}
impl Drop for Operation {
  fn drop(&mut self) {
    self.done.cancel();
    self.cancel.cancel();
    if let Some(watcher) = self.watcher.take() {
      let _ = watcher.join();
    }
  }
}

pub fn read_jpeg_dimensions(jpeg: &[u8]) -> Result<(u32, u32)> {
  ensure!(
    jpeg.len() >= 4 && jpeg[..2] == [0xff, 0xd8],
    "Invalid or incomplete JPEG image."
  );
  let (mut offset, mut width, mut height, mut components) = (2usize, 0u32, 0u32, 0usize);
  let (mut scan, mut saw_scan, mut entropy) = (false, false, 0usize);
  while offset < jpeg.len() {
    if scan {
      while offset < jpeg.len() && jpeg[offset] != 0xff {
        offset += 1;
        entropy += 1;
      }
      ensure!(offset < jpeg.len(), "Invalid JPEG scan ending.");
      let mut next = offset + 1;
      while jpeg.get(next) == Some(&0xff) {
        next += 1;
      }
      if jpeg
        .get(next)
        .is_some_and(|b| *b == 0 || (0xd0..=0xd7).contains(b))
      {
        offset = next + 1;
        entropy += 1;
        continue;
      }
      ensure!(entropy > 0, "Empty JPEG entropy scan.");
      scan = false;
    }
    ensure!(jpeg[offset] == 0xff, "Invalid JPEG marker.");
    offset += 1;
    while jpeg.get(offset) == Some(&0xff) {
      offset += 1;
    }
    let marker = *jpeg
      .get(offset)
      .ok_or_else(|| anyhow!("Truncated JPEG marker."))?;
    offset += 1;
    ensure!(
      marker != 0 && marker != 0xd8 && !(0xd0..=0xd7).contains(&marker),
      "Invalid JPEG marker."
    );
    if marker == 0xd9 {
      ensure!(
        offset == jpeg.len() && width > 0 && height > 0 && saw_scan && entropy > 0,
        "Invalid JPEG end."
      );
      return Ok((width, height));
    }
    if marker == 1 {
      continue;
    }
    ensure!(offset + 2 <= jpeg.len(), "Truncated JPEG segment.");
    let length = u16::from_be_bytes([jpeg[offset], jpeg[offset + 1]]) as usize;
    let end = offset + length;
    ensure!(
      length >= 2 && end <= jpeg.len(),
      "Invalid JPEG segment length."
    );
    if matches!(
      marker,
      0xc0 | 0xc1 | 0xc2 | 0xc3 | 0xc5 | 0xc6 | 0xc7 | 0xc9 | 0xca | 0xcb | 0xcd | 0xce | 0xcf
    ) {
      ensure!(
        width == 0 && length >= 11 && jpeg[offset + 2] == 8,
        "Invalid JPEG frame."
      );
      height = u16::from_be_bytes([jpeg[offset + 3], jpeg[offset + 4]]) as u32;
      width = u16::from_be_bytes([jpeg[offset + 5], jpeg[offset + 6]]) as u32;
      components = jpeg[offset + 7] as usize;
      ensure!(
        width > 0 && height > 0 && (1..=4).contains(&components) && length == 8 + 3 * components,
        "Invalid JPEG geometry."
      );
    }
    if marker == 0xda {
      ensure!(length >= 3, "Invalid JPEG scan header.");
      let count = jpeg[offset + 2] as usize;
      ensure!(
        width > 0 && (1..=components).contains(&count) && length == 6 + 2 * count,
        "Invalid JPEG scan header."
      );
      scan = true;
      saw_scan = true;
      entropy = 0;
    }
    offset = end;
  }
  bail!("Invalid or incomplete JPEG image.")
}

const fn crc_table() -> [u32; 256] {
  let mut table = [0; 256];
  let mut i = 0;
  while i < 256 {
    let mut value = i as u32;
    let mut bit = 0;
    while bit < 8 {
      value = if value & 1 != 0 {
        0xedb88320 ^ (value >> 1)
      } else {
        value >> 1
      };
      bit += 1;
    }
    table[i] = value;
    i += 1;
  }
  table
}
fn crc32(bytes: &[u8]) -> u32 {
  const TABLE: [u32; 256] = crc_table();
  let mut crc = u32::MAX;
  for byte in bytes {
    crc = TABLE[((crc ^ u32::from(*byte)) & 255) as usize] ^ (crc >> 8);
  }
  crc ^ u32::MAX
}
fn be32(bytes: &[u8], offset: usize) -> u32 {
  u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

pub fn read_png_dimensions(png: &[u8]) -> Result<(u32, u32)> {
  ensure!(
    png.len() >= 45 && png[..8] == [137, 80, 78, 71, 13, 10, 26, 10],
    "Invalid PNG signature or length."
  );
  ensure!(
    be32(png, 8) == 13 && &png[12..16] == b"IHDR",
    "Invalid PNG IHDR."
  );
  let (width, height) = (be32(png, 16), be32(png, 20));
  ensure!(
    width > 0 && height > 0 && width <= i32::MAX as u32 && height <= i32::MAX as u32,
    "Invalid PNG dimensions."
  );
  let valid_depth = match png[25] {
    0 => [1, 2, 4, 8, 16].contains(&png[24]),
    2 | 4 | 6 => [8, 16].contains(&png[24]),
    3 => [1, 2, 4, 8].contains(&png[24]),
    _ => false,
  };
  ensure!(
    valid_depth && png[26] == 0 && png[27] == 0 && png[28] <= 1,
    "Invalid PNG pixel format."
  );
  let (mut offset, mut image_data) = (8usize, false);
  while offset < png.len() {
    ensure!(png.len() - offset >= 12, "Truncated PNG chunk.");
    let length = be32(png, offset) as usize;
    ensure!(
      length <= png.len() - offset - 12,
      "PNG chunk exceeds remaining data."
    );
    let kind = &png[offset + 4..offset + 8];
    let end = offset + 8 + length;
    ensure!(
      crc32(&png[offset + 4..end]) == be32(png, end),
      "PNG chunk CRC mismatch."
    );
    ensure!(kind != b"IHDR" || offset == 8, "Duplicate PNG IHDR.");
    if kind == b"IDAT" && length > 0 {
      image_data = true;
    }
    offset = end + 4;
    if kind == b"IEND" {
      ensure!(
        length == 0 && image_data && offset == png.len(),
        "Invalid PNG ending."
      );
      return Ok((width, height));
    }
  }
  bail!("Missing PNG IEND.")
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Cursor;

  #[test]
  fn pointer_calibration_is_a_read_only_get_and_includes_transport_age() {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let mut line = String::new();
      reader.read_line(&mut line).unwrap();
      assert_eq!(line, "GET /pointer/calibration HTTP/1.1\r\n");
      let body = json!({"active":true,"deviceId":"00112233-4455-6677-8899-aabbccddeeff",
        "sessionId":"00112233-4455-4677-8899-aabbccddeeff","width":128,"height":256,"rotation":0,
        "point":{"x":40.5,"y":60.25,"sequence":1,"ageMs":9}})
      .to_string();
      std::thread::sleep(Duration::from_millis(80));
      write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    let client = ScreenClient::new(endpoint, None).unwrap();
    let state = client
      .pointer_calibration("00112233-4455-6677-8899-aabbccddeeff", &Cancel::new())
      .unwrap();
    assert!(state.point.unwrap().age_ms >= 80);
    server.join().unwrap();
  }

  #[test]
  fn pointer_calibration_schema_rejects_untrusted_mouse_coordinates_and_identity() {
    let page = json!({"active":true,"deviceId":"00112233-4455-6677-8899-aabbccddeeff",
      "sessionId":"00112233-4455-4677-8899-aabbccddeeff","width":128,"height":256,"rotation":0,
      "point":{"x":40.5,"y":60.25,"sequence":1,"ageMs":0}});
    let parse = |value: &Value| PointerCalibrationState::parse(&serde_json::to_vec(value).unwrap());
    assert_eq!(parse(&page).unwrap().point.unwrap().x, 40.5);
    for (key, value) in [
      ("deviceId", json!("wrong")),
      ("sessionId", Value::Null),
      ("width", json!(0)),
      ("rotation", json!(4)),
    ] {
      let mut invalid = page.clone();
      invalid[key] = value;
      assert!(parse(&invalid).is_err(), "{invalid}");
    }
    for (key, value) in [
      ("x", json!(-1)),
      ("y", json!(256)),
      ("sequence", json!(0)),
      ("ageMs", json!(-1)),
    ] {
      let mut invalid = page.clone();
      invalid["point"][key] = value;
      assert!(parse(&invalid).is_err(), "{invalid}");
    }
    let inactive = json!({"active":false,"deviceId":"00112233-4455-6677-8899-aabbccddeeff",
      "sessionId":null,"width":0,"height":0,"rotation":0,"point":null});
    assert!(!parse(&inactive).unwrap().active);
  }

  pub(super) fn fixture() -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(20, 30, image::Rgba([14, 28, 42, 255]));
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
      .write_to(&mut output, image::ImageFormat::Png)
      .unwrap();
    output.into_inner()
  }
  fn headers() -> BTreeMap<String, String> {
    [
      ("content-type", "image/png"),
      ("x-device-id", "00112233-4455-6677-8899-aabbccddeeff"),
      ("x-frame-id", "frame-1"),
      ("x-frame-age-ms", "1"),
      ("x-captured-at", "2026-10-18T01:02:03.123Z"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
  }
  #[test]
  fn png_structure_checks_every_chunk_and_ending() {
    let bytes = fixture();
    assert_eq!(read_png_dimensions(&bytes).unwrap(), (20, 30));
    for cut in [1, 12, bytes.len() - 1] {
      assert!(read_png_dimensions(&bytes[..cut]).is_err());
    }
    let mut bad = bytes.clone();
    bad[30] ^= 1;
    assert!(read_png_dimensions(&bad).is_err());
    let mut trailing = bytes;
    trailing.push(0);
    assert!(read_png_dimensions(&trailing).is_err());
  }
  #[test]
  fn frame_guards_identity_metadata_transport_age_and_geometry() {
    let client = ScreenClient::new("http://127.0.0.1:8791".into(), None).unwrap();
    let frame = client
      .frame_from_parts(&headers(), fixture(), Instant::now(), None)
      .unwrap();
    assert_eq!(frame.device_width, 20);
    assert_eq!(frame.preview_profile, "original");
    assert!(client
      .frame_from_parts(
        &headers(),
        fixture(),
        Instant::now() - Duration::from_secs(4),
        None
      )
      .is_err());
    assert!(client
      .frame_from_parts(
        &headers(),
        fixture(),
        Instant::now(),
        Some("different-phone")
      )
      .is_err());
    let mut bad = headers();
    bad.insert("x-frame-age-ms".into(), "-1".into());
    assert!(client
      .frame_from_parts(&bad, fixture(), Instant::now(), None)
      .is_err());
    let mut bad = headers();
    bad.insert("x-display-rotation".into(), "4".into());
    assert!(client
      .frame_from_parts(&bad, fixture(), Instant::now(), None)
      .is_err());
    let mut bad = headers();
    bad.insert("x-device-width".into(), "40".into());
    assert!(client
      .frame_from_parts(&bad, fixture(), Instant::now(), None)
      .is_err());
  }
  #[test]
  fn endpoint_and_timestamp_validation_rejects_public_or_malformed_values() {
    for url in [
      "http://example.com",
      "http://8.8.8.8",
      "http://127.0.0.1/?x=1",
      "http://user@127.0.0.1",
      "http://127.0.0.1/other",
    ] {
      assert!(ScreenClient::new(url.into(), None).is_err(), "{url}");
    }
    assert_eq!(
      endpoint_origin("https://192.168.1.2:443/frame.jpg").unwrap(),
      "https://192.168.1.2"
    );
    assert!(valid_timestamp("2024-02-29T23:59:59.123456789+08:00"));
    for stamp in [
      "2025-02-29T01:02:03Z",
      "2024-01-01T24:00:00Z",
      "2024-01-01T00:00:00.Z",
      "today",
    ] {
      assert!(!valid_timestamp(stamp), "{stamp}");
    }
  }
  #[test]
  fn cancelled_queued_capture_never_acquires_the_network() {
    let client = ScreenClient::new("http://127.0.0.1:1".into(), None).unwrap();
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(client
      .capture(None, &cancel)
      .unwrap_err()
      .to_string()
      .contains("cancelled"));
  }
}
