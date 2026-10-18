use crate::bridge::{check_cancel, is_hid_cancellation, Bridge, Completion};
use crate::protocol::{encode_command, HidCancelled, HidOperation, HidStatus};
use crate::{Cancel, Result};
use anyhow::{bail, ensure, Context};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Notify, RwLock, Semaphore};

pub type CoordinateGuard = Arc<dyn Fn() -> Result<()> + Send + Sync>;
pub type InputFuture = Pin<Box<dyn Future<Output = Result<InputState>> + Send>>;
pub type ArmFuture = Pin<Box<dyn Future<Output = Result<StatusWithInput>> + Send>>;
const MAX_REPORTS_PER_MOVE: usize = 8192;
const MAX_COORDINATE_REPORTS: usize = 300;
const POINTER_HOME_SETTLE_MS: u64 = 550;
const POINTER_REPORT_GAP_MS: u64 = 100;
// Android may coalesce the final pointer movement with an immediate press,
// interpreting a click as a drag. Count elapsed ACK time rather than charging
// every click another fixed delay.
const POINTER_PRESS_SETTLE: Duration = Duration::from_millis(350);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ScreenGeometry {
  pub width: u32,
  pub height: u32,
  #[serde(default)]
  pub rotation: u8,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Point {
  pub x: f64,
  pub y: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputState {
  pub screen: ScreenGeometry,
  pub calibrated: bool,
  pub scale_x: Option<f64>,
  pub scale_y: Option<f64>,
  pub position_estimated: bool,
  pub pointer: Option<Point>,
  pub armed: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct StatusWithInput {
  #[serde(flatten)]
  pub status: HidStatus,
  pub input: InputState,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInputResult {
  #[serde(flatten)]
  pub input: InputState,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub text_transfer: Option<crate::text::TextStatus>,
}
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RemoteReport {
  Mouse {
    dx: i32,
    dy: i32,
    wheel: i32,
    buttons: i32,
  },
  Key {
    modifier: i32,
    keycode: i32,
  },
}
struct State {
  screen: ScreenGeometry,
  scale_x: Option<f64>,
  scale_y: Option<f64>,
  pointer: Option<Point>,
  armed: bool,
  pending_arms: usize,
  buttons: i32,
  last_motion: Option<Instant>,
  generation: u64,
  activation_epoch: u64,
  revision: u64,
  bridge_used: bool,
  active: Option<(u64, Cancel)>,
  action_id: u64,
  remote_cancel: Cancel,
  remote_inflight: usize,
  remote_sequence: u64,
  remote_acknowledged: u64,
  recovering: bool,
  remote_launch_tail: Option<oneshot::Receiver<()>>,
  remote_reservations: Vec<Arc<Completion>>,
  action_tail: Option<Arc<Completion>>,
  remote_tokens: HashMap<u64, Cancel>,
}
impl State {
  fn snapshot(&self) -> InputState {
    InputState {
      screen: self.screen,
      calibrated: self.scale_x.is_some() && self.scale_y.is_some(),
      scale_x: self.scale_x,
      scale_y: self.scale_y,
      position_estimated: true,
      pointer: self.pointer,
      armed: self.armed,
    }
  }
  fn epoch(&self) -> u64 {
    self.generation.wrapping_add(self.activation_epoch)
  }
  fn abort_remote(&mut self) {
    if self.remote_inflight > 0 {
      self.armed = false;
    }
    for token in self.remote_tokens.values() {
      token.cancel();
    }
    self.remote_cancel.cancel();
    self.remote_cancel = Cancel::new();
  }
  fn invalidate(&mut self) {
    self.generation = self.generation.wrapping_add(1);
    if let Some((_, active)) = &self.active {
      active.cancel();
    }
    self.abort_remote();
  }
}
struct Inner {
  bridge: Bridge,
  state: Mutex<State>,
  gate: RwLock<()>,
  remote_window: Arc<Semaphore>,
  recovery_done: Notify,
  runtime: Option<tokio::runtime::Handle>,
}
struct RemoteReservation {
  inner: Arc<Inner>,
  completion: Arc<Completion>,
  sequence: u64,
  started: bool,
  finished: bool,
}
impl Drop for RemoteReservation {
  fn drop(&mut self) {
    let mut state = self.inner.state.lock().unwrap();
    state.remote_inflight -= 1;
    state.remote_tokens.remove(&self.sequence);
    let abandoned = self.started && !self.finished;
    if abandoned {
      state.invalidate();
      state.armed = false;
      state.pointer = None;
      state.buttons = 0;
    }
    drop(state);
    if abandoned {
      InputController {
        inner: self.inner.clone(),
      }
      .start_remote_recovery();
    }
    self.completion.finish();
  }
}
struct ActionLifetime {
  input: InputController,
  id: u64,
  token: Cancel,
  cleanup: bool,
  finished: bool,
}
impl Drop for ActionLifetime {
  fn drop(&mut self) {
    self.token.cancel();
    let mut state = self.input.inner.state.lock().unwrap();
    if state.active.as_ref().map(|(id, _)| *id) == Some(self.id) {
      state.active = None;
    }
    let abandoned = self.cleanup && !self.finished && state.bridge_used;
    if abandoned {
      state.invalidate();
      state.armed = false;
      state.pointer = None;
      state.buttons = 0;
    }
    drop(state);
    if abandoned {
      self.input.start_remote_recovery();
    }
  }
}
struct ActionReservation {
  generation: u64,
  reports: Vec<Arc<Completion>>,
  previous: Option<Arc<Completion>>,
  completion: Arc<Completion>,
}
impl Drop for ActionReservation {
  fn drop(&mut self) {
    self.completion.finish();
  }
}
fn reserve_action(state: &mut State) -> ActionReservation {
  let previous = state.action_tail.clone().filter(|c| !c.is_done());
  let completion = Completion::new_after(previous.iter().cloned().collect());
  state.action_tail = Some(completion.clone());
  ActionReservation {
    generation: state.generation,
    reports: state.remote_reservations.clone(),
    previous,
    completion,
  }
}
#[derive(Clone)]
pub struct InputController {
  inner: Arc<Inner>,
}

/// JS Math.round rounds negative half values toward positive infinity.
fn js_round(value: f64) -> f64 {
  (value + 0.5).floor()
}

pub fn ascii_key(character: char) -> Result<[i32; 2]> {
  let c = character as u32;
  if character.is_ascii_lowercase() {
    return Ok([0, c as i32 - 97 + 4]);
  }
  if character.is_ascii_uppercase() {
    return Ok([2, c as i32 - 65 + 4]);
  }
  if character.is_ascii_digit() {
    return Ok([
      0,
      if character == '0' {
        0x27
      } else {
        c as i32 - 49 + 0x1e
      },
    ]);
  }
  match character {
    ' ' => return Ok([0, 0x2c]),
    '\n' | '\r' => return Ok([0, 0x28]),
    '\t' => return Ok([0, 0x2b]),
    _ => {}
  }
  let punctuation = "-=[]\\;'`,./";
  let shifted = "_+{}|:\"~<>?";
  let codes = [
    0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
  ];
  if let Some(i) = punctuation.chars().position(|v| v == character) {
    return Ok([0, codes[i]]);
  }
  if let Some(i) = shifted.chars().position(|v| v == character) {
    return Ok([2, codes[i]]);
  }
  if let Some(i) = ")!@#$%^&*(".chars().position(|v| v == character) {
    return Ok([2, if i == 0 { 0x27 } else { 0x1e + i as i32 - 1 }]);
  }
  bail!("Text input supports US keyboard ASCII only; select an English hardware keyboard layout on the phone.")
}
pub fn parse_key_combo(combo: &str) -> Result<[i32; 2]> {
  let normalized = combo.trim().to_ascii_lowercase();
  ensure!(
    !normalized.is_empty(),
    "A key or key combination is required."
  );
  if combo.chars().count() == 1 {
    return ascii_key(combo.chars().next().unwrap());
  }
  let mut parts: Vec<_> = normalized.split('+').collect();
  let key = parts.pop().unwrap();
  let mut modifier = 0;
  for part in parts {
    modifier |= match part {
      "ctrl" | "control" => 1,
      "shift" => 2,
      "alt" => 4,
      "meta" | "gui" | "win" | "cmd" => 8,
      _ => bail!("Unknown keyboard modifier: {part}."),
    };
  }
  let special = match key {
    "enter" | "return" => Some(0x28),
    "esc" | "escape" => Some(0x29),
    "backspace" => Some(0x2a),
    "tab" => Some(0x2b),
    "space" => Some(0x2c),
    "capslock" => Some(0x39),
    "printscreen" => Some(0x46),
    "scrolllock" => Some(0x47),
    "pause" => Some(0x48),
    "insert" => Some(0x49),
    "home" => Some(0x4a),
    "pageup" => Some(0x4b),
    "delete" => Some(0x4c),
    "end" => Some(0x4d),
    "pagedown" => Some(0x4e),
    "right" => Some(0x4f),
    "left" => Some(0x50),
    "down" => Some(0x51),
    "up" => Some(0x52),
    _ => None,
  };
  if let Some(code) = special {
    return Ok([modifier, code]);
  }
  if let Some(number) = key.strip_prefix('f').and_then(|s| s.parse::<i32>().ok()) {
    if (1..=12).contains(&number) && key == format!("f{number}") {
      return Ok([modifier, 0x3a + number - 1]);
    }
  }
  if key.chars().count() == 1 {
    let [extra, code] = ascii_key(key.chars().next().unwrap())?;
    return Ok([modifier | extra, code]);
  }
  bail!("Unknown keyboard key: {key}.")
}
pub fn split_move(dx: i64, dy: i64, wheel: i64) -> Result<Vec<[i32; 3]>> {
  let maximum = [dx, dy, wheel]
    .into_iter()
    .map(i64::checked_abs)
    .collect::<Option<Vec<_>>>()
    .context("Mouse deltas and wheel must be safe integers.")?
    .into_iter()
    .max()
    .unwrap();
  let count = ((maximum as u64 + 126) / 127).max(1);
  ensure!(
    count <= MAX_REPORTS_PER_MOVE as u64,
    "Mouse movement is too large; split it into smaller calls."
  );
  let mut previous = [0i64; 3];
  let mut reports = Vec::with_capacity(count as usize);
  for i in 1..=count {
    let next = [dx, dy, wheel].map(|v| js_round(v as f64 * i as f64 / count as f64) as i64);
    reports.push(std::array::from_fn(|axis| {
      (next[axis] - previous[axis]) as i32
    }));
    previous = next;
  }
  Ok(reports)
}

impl InputController {
  pub fn new(bridge: Bridge, screen: ScreenGeometry) -> Result<Self> {
    Self::validate_screen(screen)?;
    Ok(Self {
      inner: Arc::new(Inner {
        bridge,
        state: Mutex::new(State {
          screen,
          scale_x: None,
          scale_y: None,
          pointer: None,
          armed: false,
          pending_arms: 0,
          buttons: 0,
          last_motion: None,
          generation: 0,
          activation_epoch: 0,
          revision: 0,
          bridge_used: false,
          active: None,
          action_id: 0,
          remote_cancel: Cancel::new(),
          remote_inflight: 0,
          remote_sequence: 0,
          remote_acknowledged: 0,
          recovering: false,
          remote_launch_tail: None,
          remote_reservations: Vec::new(),
          action_tail: None,
          remote_tokens: HashMap::new(),
        }),
        gate: RwLock::new(()),
        remote_window: Arc::new(Semaphore::new(4)),
        recovery_done: Notify::new(),
        runtime: tokio::runtime::Handle::try_current().ok(),
      }),
    })
  }
  pub fn state(&self) -> InputState {
    self.inner.state.lock().unwrap().snapshot()
  }
  pub fn control_epoch(&self) -> u64 {
    self.inner.state.lock().unwrap().epoch()
  }
  pub fn input_revision(&self) -> u64 {
    self.inner.state.lock().unwrap().revision
  }
  pub fn set_screen(&self, next: ScreenGeometry) -> Result<InputState> {
    Self::validate_screen(next)?;
    let mut state = self.inner.state.lock().unwrap();
    if state.screen != next {
      state.screen = next;
      state.scale_x = None;
      state.scale_y = None;
      state.pointer = None;
      state.invalidate();
    }
    Ok(state.snapshot())
  }
  pub fn set_calibration(&self, scale_x: f64, scale_y: f64) -> Result<InputState> {
    ensure!(
      [scale_x, scale_y].iter().all(|v| v.is_finite() && *v > 0.0),
      "Pointer calibration needs positive finite HID counts per screen pixel for both axes."
    );
    let mut state = self.inner.state.lock().unwrap();
    ensure!(
      (state.screen.width as f64 * scale_x).max(state.screen.height as f64 * scale_y) / 127.0
        <= (MAX_REPORTS_PER_MOVE - 2) as f64,
      "Pointer calibration would exceed the supported movement report limit."
    );
    state.invalidate();
    state.scale_x = Some(scale_x);
    state.scale_y = Some(scale_y);
    state.pointer = None;
    Ok(state.snapshot())
  }
  pub fn reset_calibration(&self) -> InputState {
    let mut state = self.inner.state.lock().unwrap();
    state.invalidate();
    state.scale_x = None;
    state.scale_y = None;
    state.pointer = None;
    state.snapshot()
  }

  async fn wait_recovery(&self) {
    loop {
      let notified = self.inner.recovery_done.notified();
      if !self.inner.state.lock().unwrap().recovering {
        return;
      }
      notified.await;
    }
  }
  async fn run<T, F, Fut>(
    &self,
    cancel: Option<&Cancel>,
    cleanup: bool,
    inspection: bool,
    action: F,
  ) -> Result<T>
  where
    F: FnOnce(Cancel) -> Fut,
    Fut: Future<Output = Result<T>>,
  {
    let reservation = reserve_action(&mut self.inner.state.lock().unwrap());
    self
      .run_reserved(reservation, cancel, cleanup, inspection, action)
      .await
  }
  async fn run_reserved<T, F, Fut>(
    &self,
    reservation: ActionReservation,
    cancel: Option<&Cancel>,
    cleanup: bool,
    inspection: bool,
    action: F,
  ) -> Result<T>
  where
    F: FnOnce(Cancel) -> Fut,
    Fut: Future<Output = Result<T>>,
  {
    let generation = reservation.generation;
    if let Some(previous) = &reservation.previous {
      previous.wait().await;
    }
    for report in &reservation.reports {
      report.wait().await;
    }
    let _gate = loop {
      self.wait_recovery().await;
      let gate = self.inner.gate.write().await;
      if !self.inner.state.lock().unwrap().recovering {
        break gate;
      }
      drop(gate);
    };
    check_cancel(cancel)?;
    let controller = cancel.map(Cancel::child_token).unwrap_or_default();
    let (action_id, independent) = {
      let mut state = self.inner.state.lock().unwrap();
      let independent = inspection && !state.bridge_used;
      ensure!(
        cleanup || independent || generation == state.generation,
        "Queued input was cancelled by pause, release or screen geometry change."
      );
      state.action_id = state.action_id.wrapping_add(1);
      let id = state.action_id;
      if !independent {
        state.active = Some((id, controller.clone()));
      }
      (id, independent)
    };
    let mut lifetime = ActionLifetime {
      input: self.clone(),
      id: action_id,
      token: controller.clone(),
      cleanup: !inspection && !independent,
      finished: false,
    };
    let result = action(controller.clone()).await;
    if let Err(error) = &result {
      let used = self.inner.state.lock().unwrap().bridge_used;
      if !(inspection
        && (is_hid_cancellation(error, cancel) && is_hid_cancellation(error, Some(&controller))
          || !used))
      {
        {
          let mut state = self.inner.state.lock().unwrap();
          state.armed = false;
          state.pointer = None;
          state.buttons = 0;
        }
        let _ = self.request(HidOperation::Release, &[], None).await;
        let _ = self.request(HidOperation::Pause, &[], None).await;
      }
    }
    if !independent {
      let mut state = self.inner.state.lock().unwrap();
      if state.active.as_ref().map(|(id, _)| *id) == Some(action_id) {
        state.active = None;
      }
    }
    lifetime.finished = true;
    result
  }

  pub async fn status(&self, cancel: Option<&Cancel>) -> Result<StatusWithInput> {
    check_cancel(cancel)?;
    let cached = {
      let state = self.inner.state.lock().unwrap();
      if state.armed && state.pending_arms == 0 {
        self.inner.bridge.control_status()
      } else {
        None
      }
    };
    if let Some(status) = cached {
      self.observe_status(&status);
      return Ok(StatusWithInput {
        status,
        input: self.state(),
      });
    }
    self
      .run(cancel, false, true, |token| async move {
        let status = self.send(HidOperation::Status, &[], &token).await?;
        Ok(StatusWithInput {
          status,
          input: self.state(),
        })
      })
      .await
  }
  pub async fn arm(&self, cancel: Option<&Cancel>) -> Result<StatusWithInput> {
    self.begin_arm(cancel).1.await
  }
  pub fn begin_arm(&self, cancel: Option<&Cancel>) -> (u64, ArmFuture) {
    let cancel = cancel.cloned();
    let (epoch, queued) = {
      let mut state = self.inner.state.lock().unwrap();
      state.activation_epoch = state.activation_epoch.wrapping_add(1);
      state.pending_arms += 1;
      state.abort_remote();
      (state.epoch(), reserve_action(&mut state))
    };
    let input = self.clone();
    // Drop also retires a reservation whose returned waiter is never executed.
    struct Reservation(InputController);
    impl Drop for Reservation {
      fn drop(&mut self) {
        self.0.inner.state.lock().unwrap().pending_arms -= 1;
      }
    }
    let reservation = Reservation(self.clone());
    (
      epoch,
      Box::pin(async move {
        let _reservation = reservation;
        ensure!(
          input.control_epoch() == epoch,
          "Queued ARM belongs to an expired control round."
        );
        let target = input.clone();
        input.run_reserved(queued, cancel.as_ref(), false, false, |token| async move {
      ensure!(target.control_epoch() == epoch, "Queued ARM belongs to an expired control round.");
      target.send(HidOperation::Ping, &[], &token).await?;
      ensure!(target.control_epoch() == epoch, "Queued ARM belongs to an expired control round.");
      let status = target.send(HidOperation::Arm, &[], &token).await?;
      ensure!(status.input_ready(), "Device controller did not arm. Pair its keyboard on the phone; select Cancel emergency stop on the controller and confirm there.");
      target.inner.state.lock().unwrap().armed = true; Ok(StatusWithInput { status, input: target.state() })
    }).await
      }),
    )
  }
  pub async fn pause(&self) -> Result<StatusWithInput> {
    let queued = {
      let mut state = self.inner.state.lock().unwrap();
      state.invalidate();
      state.armed = false;
      reserve_action(&mut state)
    };
    self
      .run_reserved(queued, None, false, false, |_| async move {
        self.request(HidOperation::Release, &[], None).await?;
        self.clear_pointer_buttons();
        let status = self.request(HidOperation::Pause, &[], None).await?;
        Ok(StatusWithInput {
          status,
          input: self.state(),
        })
      })
      .await
  }
  pub async fn stop(&self) -> Result<InputState> {
    let queued = {
      let mut state = self.inner.state.lock().unwrap();
      state.invalidate();
      state.armed = false;
      reserve_action(&mut state)
    };
    self
      .run_reserved(queued, None, true, false, |_| async move {
        self.clear_pointer_buttons();
        let used = self.inner.state.lock().unwrap().bridge_used;
        if used {
          self.request(HidOperation::Release, &[], None).await?;
          self.request(HidOperation::Pause, &[], None).await?;
        }
        Ok(self.state())
      })
      .await
  }
  /// Checking ownership and invalidating it share one state lock. The recovery
  /// barrier is installed before a competing ARM can begin its next round.
  pub async fn stop_if_epoch(&self, expected: u64) -> Result<bool> {
    let start = {
      let mut state = self.inner.state.lock().unwrap();
      if state.epoch() != expected {
        return Ok(false);
      }
      state.invalidate();
      state.armed = false;
      state.pointer = None;
      state.buttons = 0;
      if state.recovering {
        false
      } else {
        state.recovering = true;
        true
      }
    };
    if start {
      self.spawn_remote_recovery();
    }
    self.wait_recovery().await;
    Ok(true)
  }
  pub async fn release_all(&self) -> Result<InputState> {
    self.begin_release().1.await
  }
  pub fn begin_release(&self) -> (u64, InputFuture) {
    let (epoch, queued) = {
      let mut state = self.inner.state.lock().unwrap();
      state.invalidate();
      (state.epoch(), reserve_action(&mut state))
    };
    let input = self.clone();
    let target = input.clone();
    (
      epoch,
      Box::pin(async move {
        input
          .run_reserved(queued, None, false, false, |_| async move {
            target.request(HidOperation::Release, &[], None).await?;
            target.clear_pointer_buttons();
            Ok(target.state())
          })
          .await
      }),
    )
  }
  pub async fn move_delta(
    &self,
    dx: i64,
    dy: i64,
    wheel: i64,
    buttons: u8,
    cancel: Option<&Cancel>,
    guard: Option<CoordinateGuard>,
  ) -> Result<InputState> {
    let reports = split_move(dx, dy, wheel)?;
    Self::validate_buttons(buttons as i32)?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        self.inner.state.lock().unwrap().pointer = None;
        for [dx, dy, wheel] in reports {
          Self::check_guard(&guard)?;
          self
            .mouse_report(dx, dy, wheel, buttons as i32, &token)
            .await?;
        }
        Ok(self.state())
      })
      .await
  }

  pub async fn remote_report(
    &self,
    report: RemoteReport,
    cancel: Option<&Cancel>,
  ) -> Result<InputState> {
    self
      .submit_remote(report, cancel.cloned().unwrap_or_default())?
      .await
  }
  pub fn submit_remote(&self, report: RemoteReport, cancel: Cancel) -> Result<InputFuture> {
    let (op, args) = match report {
      RemoteReport::Mouse {
        dx,
        dy,
        wheel,
        buttons,
      } => (HidOperation::Move, vec![dx, dy, wheel, buttons]),
      RemoteReport::Key { modifier, keycode } => (HidOperation::Key, vec![modifier, keycode]),
    };
    encode_command(1, op, &args)?;
    check_cancel(Some(&cancel))?;
    self.require_armed()?;
    let permit = self
      .inner
      .remote_window
      .clone()
      .try_acquire_owned()
      .context("Realtime input window is full.")?;
    let (launch_tx, launch_rx) = oneshot::channel();
    let completion = Completion::new();
    let token = cancel.child_token();
    let (epoch, sequence, previous, exclusive) = {
      let mut state = self.inner.state.lock().unwrap();
      state.remote_sequence = state.remote_sequence.wrapping_add(1);
      let previous = state.remote_launch_tail.replace(launch_rx);
      state.remote_reservations.retain(|r| !r.is_done());
      state.remote_reservations.push(completion.clone());
      let sequence = state.remote_sequence;
      state.remote_tokens.insert(sequence, token.clone());
      state.remote_inflight += 1;
      (state.epoch(), sequence, previous, state.action_tail.clone())
    };
    let input = self.clone();
    let reservation = RemoteReservation {
      inner: self.inner.clone(),
      completion,
      sequence,
      started: false,
      finished: false,
    };
    Ok(Box::pin(async move {
      let mut reservation = reservation;
      if let Some(previous) = previous {
        tokio::select! { biased; _ = token.cancelled() => {}, _ = previous => {} }
      }
      if let Some(exclusive) = exclusive {
        tokio::select! { biased; _ = token.cancelled() => {}, _ = exclusive.wait() => {} }
      }
      let gate = tokio::select! { biased; _ = token.cancelled() => None, gate = input.inner.gate.read() => Some(gate) };
      let result = async {
        check_cancel(Some(&token))?;
        ensure!(
          epoch == input.control_epoch(),
          "Queued realtime input was cancelled."
        );
        input.require_armed()?;
        {
          let mut state = input.inner.state.lock().unwrap();
          state.pointer = None;
          state.bridge_used = true;
          state.revision = state.revision.wrapping_add(1);
        }
        reservation.started = true;
        let pending = input
          .inner
          .bridge
          .submit_realtime(op, args, token.clone())?;
        // Bridge's synchronous reservation has fixed wire order. ACK waits overlap.
        let _ = launch_tx.send(());
        let status = pending.await?;
        check_cancel(Some(&token))?;
        ensure!(
          epoch == input.control_epoch(),
          "Realtime input belongs to an expired control round."
        );
        ensure!(
          status.input_ready(),
          "ESP32 stopped realtime input; reconnect or clear the physical emergency stop."
        );
        if let RemoteReport::Mouse {
          buttons, dx, dy, ..
        } = report
        {
          let mut state = input.inner.state.lock().unwrap();
          if dx != 0 || dy != 0 {
            state.last_motion = Some(Instant::now());
          }
          if sequence >= state.remote_acknowledged {
            state.remote_acknowledged = sequence;
            state.buttons = buttons;
          }
        }
        Ok(input.state())
      }
      .await;
      if result.is_err() {
        {
          let mut state = input.inner.state.lock().unwrap();
          if epoch == state.epoch() {
            state.generation = state.generation.wrapping_add(1);
            state.armed = false;
            state.pointer = None;
            state.buttons = 0;
            state.abort_remote();
          }
        }
        input.start_remote_recovery();
      }
      drop(gate);
      drop(permit);
      if result.is_err() {
        input.wait_recovery().await;
      }
      reservation.finished = true;
      result
    }))
  }
  fn start_remote_recovery(&self) {
    {
      let mut state = self.inner.state.lock().unwrap();
      if state.recovering {
        return;
      }
      state.recovering = true;
    }
    self.spawn_remote_recovery();
  }
  fn spawn_remote_recovery(&self) {
    let input = self.clone();
    let runtime = self
      .inner
      .runtime
      .clone()
      .or_else(|| tokio::runtime::Handle::try_current().ok());
    let Some(runtime) = runtime else {
      self.inner.bridge.fail_closed("Input waiter was cancelled.");
      self.inner.state.lock().unwrap().recovering = false;
      self.inner.recovery_done.notify_waiters();
      return;
    };
    runtime.spawn(async move {
      let _gate = input.inner.gate.write().await;
      let used = input.inner.state.lock().unwrap().bridge_used;
      if used {
        let _ = input.request(HidOperation::Release, &[], None).await;
        let _ = input.request(HidOperation::Pause, &[], None).await;
      }
      input.inner.state.lock().unwrap().recovering = false;
      input.inner.recovery_done.notify_waiters();
    });
  }

  pub async fn mouse_button(
    &self,
    button: &str,
    pressed: bool,
    cancel: Option<&Cancel>,
  ) -> Result<InputState> {
    let bit = Self::button_bit(button)?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        let buttons = self.inner.state.lock().unwrap().buttons;
        self
          .mouse_report(
            0,
            0,
            0,
            if pressed {
              buttons | bit
            } else {
              buttons & !bit
            },
            &token,
          )
          .await?;
        Ok(self.state())
      })
      .await
  }
  pub async fn click(
    &self,
    button: &str,
    count: u8,
    cancel: Option<&Cancel>,
  ) -> Result<InputState> {
    ensure!(matches!(count, 1 | 2), "Click count must be 1 or 2.");
    let bit = Self::button_bit(button)?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        for i in 0..count {
          self.mouse_pulse(bit, &token).await?;
          if i < count - 1 {
            Self::sleep(80, &token).await?;
          }
        }
        Ok(self.state())
      })
      .await
  }
  pub async fn home_pointer(
    &self,
    cancel: Option<&Cancel>,
    guard: Option<CoordinateGuard>,
  ) -> Result<InputState> {
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        Self::check_guard(&guard)?;
        self.home_internal(&token).await?;
        Ok(self.state())
      })
      .await
  }
  pub async fn pointer_to(
    &self,
    x: f64,
    y: f64,
    buttons: u8,
    wheel: i32,
    cancel: Option<&Cancel>,
    guard: Option<CoordinateGuard>,
  ) -> Result<InputState> {
    ensure!(
      [x, y]
        .iter()
        .all(|v| v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0),
      "Pointer coordinates must be safe integers."
    );
    self.validate_point(x, y)?;
    Self::validate_buttons(buttons as i32)?;
    ensure!(
      (-127..=127).contains(&wheel),
      "Pointer wheel must be in -127..127."
    );
    self.run(cancel, false, false, |token| async move {
      self.require_armed()?; self.require_calibration()?; Self::check_guard(&guard)?;
      let (pointer, old_buttons) = { let state = self.inner.state.lock().unwrap(); (state.pointer, state.buttons) };
      ensure!(pointer.is_some() || old_buttons == 0, "Pointer position is unknown while a mouse button is held. Pause and start control again.");
      let target = self.coordinate_target(x, y)?; self.position_budget(target, 1)?;
      if pointer.is_none() { self.home_internal(&token).await?; }
      self.move_to(target, old_buttons, &token).await?; check_cancel(Some(&token))?;
      if buttons as i32 != old_buttons || wheel != 0 { self.mouse_report(0, 0, wheel, buttons as i32, &token).await?; }
      Ok(self.state())
    }).await
  }
  pub async fn hover(
    &self,
    x: f64,
    y: f64,
    cancel: Option<&Cancel>,
    guard: Option<CoordinateGuard>,
  ) -> Result<InputState> {
    self.validate_point(x, y)?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        self.require_calibration()?;
        Self::check_guard(&guard)?;
        let target = self.coordinate_target(x, y)?;
        self.position_budget(target, 0)?;
        if self.inner.state.lock().unwrap().buttons != 0 {
          self.mouse_report(0, 0, 0, 0, &token).await?;
        }
        if self.state().pointer.is_none() {
          self.home_internal(&token).await?;
        }
        self.move_to(target, 0, &token).await?;
        Ok(self.state())
      })
      .await
  }
  pub async fn tap(
    &self,
    x: f64,
    y: f64,
    cancel: Option<&Cancel>,
    guard: Option<CoordinateGuard>,
  ) -> Result<InputState> {
    self.validate_point(x, y)?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        self.require_calibration()?;
        Self::check_guard(&guard)?;
        let target = self.coordinate_target(x, y)?;
        self.position_budget(target, 0)?;
        if self.state().pointer.is_none() {
          self.home_internal(&token).await?;
        }
        self.move_to(target, 0, &token).await?;
        self.mouse_pulse(1, &token).await?;
        Ok(self.state())
      })
      .await
  }
  pub async fn swipe(
    &self,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    duration_ms: u64,
    cancel: Option<&Cancel>,
    guard: Option<CoordinateGuard>,
  ) -> Result<serde_json::Value> {
    self.validate_point(x1, y1)?;
    self.validate_point(x2, y2)?;
    ensure!(
      (50..=10_000).contains(&duration_ms),
      "Swipe duration must be between 50 and 10000 ms."
    );
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        self.require_calibration()?;
        Self::check_guard(&guard)?;
        let start = self.coordinate_target(x1, y1)?;
        let end = self.coordinate_target(x2, y2)?;
        let reports = self.coordinate_reports(end.x - start.x, end.y - start.y)?;
        self.position_budget(start, reports.len())?;
        let planned_duration_ms = duration_ms.max(reports.len() as u64 * POINTER_REPORT_GAP_MS);
        if self.state().pointer.is_none() {
          self.home_internal(&token).await?;
        }
        self.move_to(start, 0, &token).await?;
        let origin = self.state().pointer.unwrap();
        self.mouse_report(0, 0, 0, 1, &token).await?;
        let drag = async {
          if reports.is_empty() {
            Self::sleep(planned_duration_ms, &token).await?;
          } else {
            for &[dx, dy, wheel] in &reports {
              self.mouse_report(dx, dy, wheel, 1, &token).await?;
              Self::sleep(planned_duration_ms.div_ceil(reports.len() as u64), &token).await?;
            }
          }
          self.inner.state.lock().unwrap().pointer = Some(self.estimate_after(origin, &reports)?);
          Ok::<(), anyhow::Error>(())
        }
        .await;
        let release = self.request(HidOperation::Move, &[0, 0, 0, 0], None).await;
        self.inner.state.lock().unwrap().buttons = 0;
        release?;
        drag?;
        let mut result = serde_json::to_value(self.state())?;
        result["plannedDurationMs"] = planned_duration_ms.into();
        Ok(result)
      })
      .await
  }
  pub async fn scroll(&self, amount: i64, cancel: Option<&Cancel>) -> Result<InputState> {
    let reports = split_move(0, 0, amount)?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        for [dx, dy, wheel] in reports {
          self.mouse_report(dx, dy, wheel, 0, &token).await?;
        }
        Ok(self.state())
      })
      .await
  }
  pub async fn type_text(&self, text: &str, cancel: Option<&Cancel>) -> Result<TextInputResult> {
    crate::text::validate_text(text)?;
    if !text.is_ascii() {
      self.require_armed()?;
      return self
        .run(cancel, false, false, |token| async move {
          self.require_armed()?;
          {
            let mut state = self.inner.state.lock().unwrap();
            state.bridge_used = true;
            state.revision = state.revision.wrapping_add(1);
          }
          let status = self.inner.bridge.unicode_text(text, Some(&token)).await?;
          check_cancel(Some(&token))?;
          Ok(TextInputResult {
            input: self.state(),
            text_transfer: Some(status),
          })
        })
        .await;
    }
    let reports: Vec<_> = text.chars().map(ascii_key).collect::<Result<_>>()?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        let typed = async {
          for report in reports {
            self.pulse(HidOperation::Key, &report, &token).await?;
          }
          Ok::<(), anyhow::Error>(())
        }
        .await;
        let release = self.request(HidOperation::Release, &[], None).await;
        self.inner.state.lock().unwrap().buttons = 0;
        release?;
        typed?;
        Ok(TextInputResult {
          input: self.state(),
          text_transfer: None,
        })
      })
      .await
  }
  pub async fn key(&self, combo: &str, cancel: Option<&Cancel>) -> Result<InputState> {
    let report = parse_key_combo(combo)?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        self.pulse(HidOperation::Key, &report, &token).await?;
        Ok(self.state())
      })
      .await
  }
  pub async fn key_report(
    &self,
    modifier: i32,
    keycode: i32,
    cancel: Option<&Cancel>,
  ) -> Result<InputState> {
    encode_command(1, HidOperation::Key, &[modifier, keycode])?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        self
          .send(HidOperation::Key, &[modifier, keycode], &token)
          .await?;
        Ok(self.state())
      })
      .await
  }
  pub async fn consumer_report(&self, usage: i32, cancel: Option<&Cancel>) -> Result<InputState> {
    encode_command(1, HidOperation::Consumer, &[usage])?;
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        self.send(HidOperation::Consumer, &[usage], &token).await?;
        Ok(self.state())
      })
      .await
  }
  pub async fn home(&self, cancel: Option<&Cancel>) -> Result<InputState> {
    self.consumer_key(0x223, cancel).await
  }
  pub async fn back(&self, cancel: Option<&Cancel>) -> Result<InputState> {
    self.consumer_key(0x224, cancel).await
  }
  async fn consumer_key(&self, usage: i32, cancel: Option<&Cancel>) -> Result<InputState> {
    self
      .run(cancel, false, false, |token| async move {
        self.require_armed()?;
        self.pulse(HidOperation::Consumer, &[usage], &token).await?;
        Ok(self.state())
      })
      .await
  }

  async fn home_internal(&self, token: &Cancel) -> Result<()> {
    self.require_calibration()?;
    let count = self.home_report_count()?;
    Self::coordinate_budget(count)?;
    for _ in 0..count {
      self.mouse_report(-127, -127, 0, 0, token).await?;
    }
    Self::sleep(POINTER_HOME_SETTLE_MS, token).await?;
    self.inner.state.lock().unwrap().pointer = Some(Point { x: 0.0, y: 0.0 });
    Ok(())
  }
  async fn move_to(&self, target: Point, buttons: i32, token: &Cancel) -> Result<()> {
    self.validate_point(target.x, target.y)?;
    let origin = self
      .state()
      .pointer
      .context("Pointer position is unknown; home it first.")?;
    let reports = self.coordinate_reports(target.x - origin.x, target.y - origin.y)?;
    for &[dx, dy, wheel] in &reports {
      self.mouse_report(dx, dy, wheel, buttons, token).await?;
      Self::sleep(POINTER_REPORT_GAP_MS, token).await?;
    }
    let pointer = self.estimate_after(origin, &reports)?;
    self.inner.state.lock().unwrap().pointer = Some(pointer);
    Ok(())
  }
  fn scales(&self) -> Result<(f64, f64)> {
    let state = self.inner.state.lock().unwrap();
    Ok((
      state.scale_x.context(
        "Absolute pointer actions need explicit calibration for the current screen geometry.",
      )?,
      state.scale_y.context(
        "Absolute pointer actions need explicit calibration for the current screen geometry.",
      )?,
    ))
  }
  fn coordinate_target(&self, x: f64, y: f64) -> Result<Point> {
    let (sx, sy) = self.scales()?;
    let screen = self.state().screen;
    Ok(Point {
      x: js_round(x * sx).min((screen.width as f64 * sx).ceil() - 1.0) / sx,
      y: js_round(y * sy).min((screen.height as f64 * sy).ceil() - 1.0) / sy,
    })
  }
  fn estimate_after(&self, origin: Point, reports: &[[i32; 3]]) -> Result<Point> {
    let (sx, sy) = self.scales()?;
    let mut x = js_round(origin.x * sx);
    let mut y = js_round(origin.y * sy);
    for [dx, dy, _] in reports {
      x += *dx as f64;
      y += *dy as f64;
    }
    Ok(Point {
      x: x / sx,
      y: y / sy,
    })
  }
  fn coordinate_reports(&self, dx: f64, dy: f64) -> Result<Vec<[i32; 3]>> {
    let (sx, sy) = self.scales()?;
    Ok(
      split_move(js_round(dx * sx) as i64, js_round(dy * sy) as i64, 0)?
        .into_iter()
        .filter(|v| v[0] != 0 || v[1] != 0)
        .collect(),
    )
  }
  fn home_report_count(&self) -> Result<usize> {
    let (sx, sy) = self.scales()?;
    let screen = self.state().screen;
    Ok(((screen.width as f64 * sx).max(screen.height as f64 * sy) / 127.0).ceil() as usize + 2)
  }
  fn position_budget(&self, target: Point, extra: usize) -> Result<()> {
    let pointer = self.state().pointer;
    let origin = pointer.unwrap_or(Point { x: 0.0, y: 0.0 });
    Self::coordinate_budget(
      if pointer.is_none() {
        self.home_report_count()?
      } else {
        0
      } + self
        .coordinate_reports(target.x - origin.x, target.y - origin.y)?
        .len()
        + extra,
    )
  }
  fn coordinate_budget(reports: usize) -> Result<()> {
    ensure!(reports <= MAX_COORDINATE_REPORTS, "Coordinate action exceeds 300 reports; reduce calibration counts per pixel or use raw relative movement.");
    Ok(())
  }
  async fn mouse_report(
    &self,
    dx: i32,
    dy: i32,
    wheel: i32,
    buttons: i32,
    token: &Cancel,
  ) -> Result<()> {
    self.settle_press(buttons, token).await?;
    self
      .send(HidOperation::Move, &[dx, dy, wheel, buttons], token)
      .await?;
    let mut state = self.inner.state.lock().unwrap();
    state.buttons = buttons;
    if dx != 0 || dy != 0 {
      state.last_motion = Some(Instant::now());
    }
    Ok(())
  }
  async fn settle_press(&self, buttons: i32, token: &Cancel) -> Result<()> {
    let settle = {
      let state = self.inner.state.lock().unwrap();
      if buttons & !state.buttons != 0 {
        state
          .last_motion
          .map(|at| POINTER_PRESS_SETTLE.saturating_sub(at.elapsed()))
      } else {
        None
      }
    };
    if let Some(remaining) = settle.filter(|duration| !duration.is_zero()) {
      tokio::select! {
        biased;
        _ = token.cancelled() => return Err(HidCancelled.into()),
        _ = tokio::time::sleep(remaining) => {}
      }
      check_cancel(Some(token))?;
      self.require_armed()?;
    }
    Ok(())
  }
  async fn mouse_pulse(&self, buttons: i32, token: &Cancel) -> Result<()> {
    self.settle_press(buttons, token).await?;
    self.inner.state.lock().unwrap().buttons = buttons;
    let result = self
      .pulse(HidOperation::Move, &[0, 0, 0, buttons], token)
      .await;
    self.inner.state.lock().unwrap().buttons = 0;
    result
  }
  async fn pulse(&self, op: HidOperation, args: &[i32], token: &Cancel) -> Result<()> {
    check_cancel(Some(token))?;
    {
      let mut state = self.inner.state.lock().unwrap();
      state.bridge_used = true;
      state.revision = state.revision.wrapping_add(2);
    }
    let status = self
      .inner
      .bridge
      .pulse(op, args, Duration::from_millis(50), Some(token))
      .await?;
    self.observe_status(&status);
    check_cancel(Some(token))?;
    Ok(())
  }
  async fn send(&self, op: HidOperation, args: &[i32], token: &Cancel) -> Result<HidStatus> {
    check_cancel(Some(token))?;
    let status = self.request(op, args, Some(token)).await?;
    check_cancel(Some(token))?;
    self.observe_status(&status);
    Ok(status)
  }
  fn observe_status(&self, status: &HidStatus) {
    if !status.input_ready() {
      let mut state = self.inner.state.lock().unwrap();
      if state.armed {
        state.activation_epoch = state.activation_epoch.wrapping_add(1);
      }
      state.armed = false;
      state.pointer = None;
    }
  }
  async fn request(
    &self,
    op: HidOperation,
    args: &[i32],
    cancel: Option<&Cancel>,
  ) -> Result<HidStatus> {
    {
      let mut state = self.inner.state.lock().unwrap();
      if op != HidOperation::Status {
        state.bridge_used = true;
      }
      if op.is_input() || matches!(op, HidOperation::Release | HidOperation::Pause) {
        state.revision = state.revision.wrapping_add(1);
      }
    }
    self.inner.bridge.request(op, args, cancel).await
  }
  async fn sleep(ms: u64, token: &Cancel) -> Result<()> {
    tokio::select! { biased; _ = token.cancelled() => Err(HidCancelled.into()), _ = tokio::time::sleep(Duration::from_millis(ms)) => Ok(()) }
  }
  fn clear_pointer_buttons(&self) {
    let mut state = self.inner.state.lock().unwrap();
    state.buttons = 0;
    state.pointer = None;
  }
  fn check_guard(guard: &Option<CoordinateGuard>) -> Result<()> {
    if let Some(guard) = guard {
      guard()?;
    }
    Ok(())
  }
  fn require_armed(&self) -> Result<()> {
    ensure!(
      self.inner.state.lock().unwrap().armed,
      "ESP32 input is paused. Call ARM explicitly after pairing and physical unlock."
    );
    Ok(())
  }
  fn require_calibration(&self) -> Result<()> {
    self.scales().map(|_| ())
  }
  fn validate_screen(screen: ScreenGeometry) -> Result<()> {
    ensure!(
      screen.width > 0 && screen.height > 0 && screen.rotation <= 3,
      "Screen geometry needs positive integer width/height and an optional rotation from 0 to 3."
    );
    Ok(())
  }
  fn validate_point(&self, x: f64, y: f64) -> Result<()> {
    let screen = self.state().screen;
    ensure!(
      x.is_finite()
        && y.is_finite()
        && x >= 0.0
        && y >= 0.0
        && x < screen.width as f64
        && y < screen.height as f64,
      "Pointer coordinates must be inside the {} x {} screenshot.",
      screen.width,
      screen.height
    );
    Ok(())
  }
  fn validate_buttons(buttons: i32) -> Result<()> {
    ensure!(
      (0..=7).contains(&buttons),
      "Mouse buttons must be a bit mask from 0 to 7."
    );
    Ok(())
  }
  fn button_bit(button: &str) -> Result<i32> {
    match button {
      "left" => Ok(1),
      "right" => Ok(2),
      "middle" => Ok(4),
      _ => bail!("Unknown mouse button."),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{BufRead, BufReader, Write};
  use std::time::Instant;
  type Records = Arc<Mutex<Vec<(String, Instant)>>>;
  fn mock_input(reverse: bool) -> (InputController, Records, std::thread::JoinHandle<()>) {
    mock_input_delayed_press(reverse, Duration::ZERO)
  }
  fn mock_input_delayed_press(
    reverse: bool,
    press_delay: Duration,
  ) -> (InputController, Records, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut options =
      crate::bridge::BridgeOptions::tcp("127.0.0.1", listener.local_addr().unwrap().port());
    options.timeout = Duration::from_millis(400);
    options.heartbeat = Duration::from_millis(80);
    let records: Records = Arc::new(Mutex::new(Vec::new()));
    let observed = records.clone();
    let server = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let delayed_writer = Arc::new(Mutex::new(stream.try_clone().unwrap()));
      let mut armed = false;
      let mut held = Vec::new();
      loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
          break;
        }
        observed
          .lock()
          .unwrap()
          .push((line.trim().to_owned(), Instant::now()));
        let parts: Vec<_> = line.split_whitespace().collect();
        match parts[2] {
          "ARM" => armed = true,
          "PAUSE" => armed = false,
          _ => {}
        }
        let reply = format!(
          "QDDHID/1 {} OK {}\n",
          parts[1],
          serde_json::json!({"v":1,"connected":true,"encrypted":true,"armed":armed,"locked":false,"bonded":true,"name":"mock"})
        );
        let pressed = (parts[2] == "KEY" && parts.get(4).is_some_and(|key| *key != "0"))
          || (parts[2] == "MOVE" && parts.get(6).is_some_and(|buttons| *buttons != "0"))
          || (parts[2] == "CONSUMER" && parts.get(3).is_some_and(|usage| *usage != "0"));
        if !press_delay.is_zero() && pressed {
          let writer = delayed_writer.clone();
          std::thread::spawn(move || {
            std::thread::sleep(press_delay);
            let _ = writer.lock().unwrap().write_all(reply.as_bytes());
          });
        } else if reverse && matches!(parts[2], "MOVE" | "KEY") {
          held.push(reply);
          if held.len() < 4 {
            continue;
          }
          for reply in held.drain(..).rev() {
            if stream.write_all(reply.as_bytes()).is_err() {
              return;
            }
          }
        } else if stream.write_all(reply.as_bytes()).is_err() {
          return;
        }
      }
    });
    let input = InputController::new(
      Bridge::new(options).unwrap(),
      ScreenGeometry {
        width: 200,
        height: 200,
        rotation: 0,
      },
    )
    .unwrap();
    (input, records, server)
  }
  fn moves(records: &Records) -> Vec<(Vec<i32>, Instant)> {
    records
      .lock()
      .unwrap()
      .iter()
      .filter_map(|(line, at)| {
        let parts: Vec<_> = line.split_whitespace().collect();
        (parts[2] == "MOVE").then(|| (parts[3..].iter().map(|v| v.parse().unwrap()).collect(), *at))
      })
      .collect()
  }
  #[test]
  fn ascii_mapping_and_split_totals_match_js() {
    assert_eq!(ascii_key('!').unwrap(), [2, 0x1e]);
    assert!(ascii_key('中').is_err());
    assert_eq!(parse_key_combo("ctrl+A").unwrap(), [1, 4]);
    assert_eq!(parse_key_combo("ctrl+shift+a").unwrap(), [3, 4]);
    assert_eq!(parse_key_combo("f12").unwrap(), [0, 0x45]);
    let reports = split_move(-300, 400, -130).unwrap();
    let sums = reports
      .into_iter()
      .fold([0i32; 3], |sum, v| std::array::from_fn(|i| sum[i] + v[i]));
    assert_eq!(sums, [-300, 400, -130]);
    assert_eq!(split_move(-1, 128, 0).unwrap()[0][0], 0);
    assert!(split_move(127 * 8192 + 1, 0, 0).is_err());
  }
  #[test]
  fn calibration_quantizes_counts_and_geometry_invalidates() {
    let bridge = Bridge::new(crate::bridge::BridgeOptions::tcp("127.0.0.1", 3333)).unwrap();
    let input = InputController::new(
      bridge,
      ScreenGeometry {
        width: 100,
        height: 100,
        rotation: 0,
      },
    )
    .unwrap();
    input.set_calibration(0.75, 0.5).unwrap();
    let target = input.coordinate_target(1.0, 1.0).unwrap();
    assert_eq!(
      target,
      Point {
        x: 1.0 / 0.75,
        y: 2.0
      }
    );
    input
      .set_screen(ScreenGeometry {
        width: 100,
        height: 100,
        rotation: 1,
      })
      .unwrap();
    assert!(!input.state().calibrated);
    assert_eq!(input.state().pointer, None);
  }
  #[tokio::test]
  async fn screenshot_only_stop_is_lazy_and_unarmed_unicode_is_rejected_before_dispatch() {
    let bridge = Bridge::new(crate::bridge::BridgeOptions::serial("", 115200)).unwrap();
    let input = InputController::new(
      bridge,
      ScreenGeometry {
        width: 100,
        height: 100,
        rotation: 0,
      },
    )
    .unwrap();
    input.stop().await.unwrap();
    assert_eq!(input.input_revision(), 0);
    assert!(input.type_text("hello中", None).await.is_err());
    assert_eq!(input.input_revision(), 0);
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn input_reservations_keep_mouse_edges_and_key_reports_in_wire_order() {
    let (input, records, server) = mock_input(true);
    input.arm(None).await.unwrap();
    let reports = [
      RemoteReport::Mouse {
        dx: 1,
        dy: 0,
        wheel: 0,
        buttons: 1,
      },
      RemoteReport::Key {
        modifier: 0,
        keycode: 4,
      },
      RemoteReport::Mouse {
        dx: 2,
        dy: 0,
        wheel: 0,
        buttons: 1,
      },
      RemoteReport::Mouse {
        dx: 0,
        dy: 0,
        wheel: 0,
        buttons: 0,
      },
    ];
    let futures: Vec<_> = reports
      .into_iter()
      .map(|r| input.submit_remote(r, Cancel::new()).unwrap())
      .collect();
    let tasks: Vec<_> = futures.into_iter().rev().map(tokio::spawn).collect();
    for task in tasks {
      task.await.unwrap().unwrap();
    }
    assert_eq!(input.input_revision(), 4);
    assert_eq!(input.inner.state.lock().unwrap().buttons, 0);
    let order: Vec<_> = records
      .lock()
      .unwrap()
      .iter()
      .filter_map(|(l, _)| {
        let p: Vec<_> = l.split_whitespace().collect();
        matches!(p[2], "MOVE" | "KEY").then(|| p[2..].join(" "))
      })
      .collect();
    assert_eq!(
      order,
      ["MOVE 1 0 0 1", "KEY 0 4", "MOVE 2 0 0 1", "MOVE 0 0 0 0"]
    );
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn coordinate_packets_settle_after_home_and_after_last_move_before_click() {
    let (input, records, server) = mock_input(false);
    input.set_calibration(1.0, 1.0).unwrap();
    input.arm(None).await.unwrap();
    assert_eq!(input.input_revision(), 0);
    input.tap(10.0, 20.0, None, None).await.unwrap();
    let reports = moves(&records);
    let home = reports
      .iter()
      .rposition(|(v, _)| v == &[-127, -127, 0, 0])
      .unwrap();
    assert!(reports[home + 1].1.duration_since(reports[home].1) >= Duration::from_millis(520));
    assert_eq!(reports[home + 1].0, [10, 20, 0, 0]);
    assert_eq!(reports[home + 2].0, [0, 0, 0, 1]);
    assert!(reports[home + 2].1.duration_since(reports[home + 1].1) >= Duration::from_millis(340));
    assert!(reports[home + 3].1.duration_since(reports[home + 2].1) >= Duration::from_millis(40));
    assert_eq!(input.state().pointer, Some(Point { x: 10.0, y: 20.0 }));
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn raw_move_then_click_settles_once_without_replaying_the_move() {
    let (input, records, server) = mock_input(false);
    input.arm(None).await.unwrap();
    input.move_delta(30, 40, 0, 0, None, None).await.unwrap();
    input.click("left", 1, None).await.unwrap();
    let reports = moves(&records);
    assert_eq!(reports.len(), 3);
    assert_eq!(reports[0].0, [30, 40, 0, 0]);
    assert_eq!(reports[1].0, [0, 0, 0, 1]);
    assert!(reports[1].1.duration_since(reports[0].1) >= Duration::from_millis(340));
    // Once movement has settled, a second click has no new 350 ms penalty.
    let began = Instant::now();
    input.click("left", 1, None).await.unwrap();
    assert!(began.elapsed() < Duration::from_millis(300));
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn cancellation_during_click_settle_never_sends_button_down() {
    let (input, records, server) = mock_input(false);
    input.arm(None).await.unwrap();
    input.move_delta(30, 40, 0, 0, None, None).await.unwrap();
    let cancel = Cancel::new();
    let cancelling = cancel.clone();
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_millis(50)).await;
      cancelling.cancel();
    });
    assert!(input.click("left", 1, Some(&cancel)).await.is_err());
    assert!(moves(&records).iter().all(|(report, _)| report[3] == 0));
    assert!(!input.state().armed);
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn delayed_press_ack_cannot_hold_text_key_mouse_click_or_home_down() {
    for action in ["text", "click", "home"] {
      let (input, records, server) = mock_input_delayed_press(false, Duration::from_millis(300));
      input.arm(None).await.unwrap();
      match action {
        "text" => {
          input.type_text("a", None).await.unwrap();
        }
        "click" => {
          input.click("left", 1, None).await.unwrap();
        }
        "home" => {
          input.home(None).await.unwrap();
        }
        _ => unreachable!(),
      }
      let reports: Vec<_> = records
        .lock()
        .unwrap()
        .iter()
        .filter(|(line, _)| {
          let p: Vec<_> = line.split_whitespace().collect();
          matches!(p[2], "KEY" | "MOVE" | "CONSUMER")
        })
        .cloned()
        .collect();
      assert_eq!(reports.len(), 2, "{action}: {reports:?}");
      let held = reports[1].1.duration_since(reports[0].1);
      assert!(
        held >= Duration::from_millis(40),
        "{action} needs a deliberate short press"
      );
      assert!(
        held < Duration::from_millis(200),
        "{action}: ACK delay held the input for {held:?}"
      );
      input.inner.bridge.close().await.unwrap();
      server.join().unwrap();
    }
  }
  #[tokio::test]
  async fn missing_press_ack_releases_promptly_and_never_replays_text_or_remaining_characters() {
    let (input, records, server) = mock_input_delayed_press(false, Duration::from_millis(600));
    input.arm(None).await.unwrap();
    assert!(input.type_text("ab", None).await.is_err());
    let reports: Vec<_> = records
      .lock()
      .unwrap()
      .iter()
      .filter(|(line, _)| line.contains(" KEY "))
      .cloned()
      .collect();
    assert_eq!(reports.len(), 2);
    assert!(reports[0].0.ends_with(" KEY 0 4"));
    assert!(reports[1].0.ends_with(" KEY 0 0"));
    assert!(reports[1].1.duration_since(reports[0].1) < Duration::from_millis(200));
    assert!(!input.state().armed);
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn cancelled_press_releases_before_its_ack_and_late_ack_cannot_pause_new_arm() {
    let (input, records, server) = mock_input_delayed_press(false, Duration::from_millis(300));
    input.arm(None).await.unwrap();
    let cancel = Cancel::new();
    let cancelling = cancel.clone();
    tokio::spawn(async move {
      tokio::time::sleep(Duration::from_millis(20)).await;
      cancelling.cancel();
    });
    assert!(input.key("a", Some(&cancel)).await.is_err());
    let reports: Vec<_> = records
      .lock()
      .unwrap()
      .iter()
      .filter(|(line, _)| line.contains(" KEY "))
      .cloned()
      .collect();
    assert_eq!(reports.len(), 2);
    assert!(reports[1].0.ends_with(" KEY 0 0"));
    assert!(reports[1].1.duration_since(reports[0].1) < Duration::from_millis(200));
    input.arm(None).await.unwrap();
    let rearmed = Instant::now();
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(input.state().armed);
    assert!(records
      .lock()
      .unwrap()
      .iter()
      .all(|(line, at)| *at < rearmed || !line.ends_with(" PAUSE")));
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn hover_neutralizes_a_held_mouse_without_clicking_and_keeps_quantized_estimate() {
    let (input, records, server) = mock_input(false);
    input.set_calibration(0.75, 0.5).unwrap();
    input.arm(None).await.unwrap();
    input.move_delta(0, 0, 0, 1, None, None).await.unwrap();
    let before = moves(&records).len();
    input.hover(1.0, 1.0, None, None).await.unwrap();
    let reports = moves(&records);
    assert_eq!(reports[before].0, [0, 0, 0, 0]);
    assert!(reports[before..].iter().all(|(r, _)| r[3] == 0));
    assert_eq!(
      input.state().pointer,
      Some(Point {
        x: 1.0 / 0.75,
        y: 2.0
      })
    );
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn pause_aborts_paced_coordinates_and_old_cleanup_precedes_new_arm() {
    let (input, records, server) = mock_input(false);
    input.set_calibration(1.0, 1.0).unwrap();
    input.arm(None).await.unwrap();
    let clone = input.clone();
    let tapping = tokio::spawn(async move { clone.tap(150.0, 150.0, None, None).await });
    for _ in 0..100 {
      if !moves(&records).is_empty() {
        break;
      }
      tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let clone = input.clone();
    let pausing = tokio::spawn(async move { clone.pause().await });
    tokio::task::yield_now().await;
    assert!(tapping.await.unwrap().is_err());
    pausing.await.unwrap().unwrap();
    input.arm(None).await.unwrap();
    assert!(input.state().armed);
    assert!(moves(&records).iter().all(|(r, _)| r[3] == 0));
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn stale_cleanup_and_dropped_arm_reservations_cannot_adopt_or_pause_new_owner() {
    let (input, _records, server) = mock_input(false);
    input.arm(None).await.unwrap();
    let old = input.control_epoch();
    let (_new_epoch, pending) = input.begin_arm(None);
    assert!(!input.stop_if_epoch(old).await.unwrap());
    drop(pending);
    assert_eq!(input.inner.state.lock().unwrap().pending_arms, 0);
    let (epoch, pending) = input.begin_arm(None);
    pending.await.unwrap();
    assert_eq!(input.control_epoch(), epoch);
    assert!(input.state().armed);
    assert!(input.stop_if_epoch(epoch).await.unwrap());
    assert!(!input.state().armed);
    input.arm(None).await.unwrap();
    assert!(input.state().armed);
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn abandoning_a_drag_sleep_releases_held_mouse_and_pauses() {
    let (input, records, server) = mock_input(false);
    input.set_calibration(1.0, 1.0).unwrap();
    input.arm(None).await.unwrap();
    let clone = input.clone();
    let drag =
      tokio::spawn(async move { clone.swipe(0.0, 0.0, 10.0, 10.0, 2000, None, None).await });
    for _ in 0..300 {
      if moves(&records).iter().any(|(v, _)| v[3] == 1) {
        break;
      }
      tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(moves(&records).iter().any(|(v, _)| v[3] == 1));
    drag.abort();
    let _ = drag.await;
    input.wait_recovery().await;
    assert!(!input.state().armed);
    assert_eq!(input.state().pointer, None);
    assert_eq!(input.inner.state.lock().unwrap().buttons, 0);
    assert!(
      records
        .lock()
        .unwrap()
        .iter()
        .filter(|(v, _)| v.ends_with(" PAUSE"))
        .count()
        >= 2
    );
    input.arm(None).await.unwrap();
    assert!(input.state().armed);
    input.inner.bridge.close().await.unwrap();
    server.join().unwrap();
  }
}
