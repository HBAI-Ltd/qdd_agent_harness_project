use crate::protocol::{
  decode_reply, encode_command, AckTimeoutError, HidCancelled, HidOperation, HidProtocolError,
  HidReply, HidStatus, MAX_REQUEST_ID,
};
use crate::text::{TextCommand, TextMode, TextPhase, TextReply, TextStatus};
use crate::{Cancel, Result};
use anyhow::{anyhow, bail, ensure, Context};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::future::Future;
use std::io::{Read, Write};
use std::pin::Pin;
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc, Mutex, Weak,
};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Notify, RwLock, Semaphore};

#[derive(Clone, Debug)]
pub enum BridgeTarget {
  Serial { path: String, baud_rate: u32 },
  Tcp { host: String, port: u16 },
}

#[derive(Clone, Debug)]
pub struct BridgeOptions {
  pub target: BridgeTarget,
  pub timeout: Duration,
  pub observation_timeout: Duration,
  pub heartbeat: Duration,
}
impl BridgeOptions {
  pub fn tcp(host: impl Into<String>, port: u16) -> Self {
    Self {
      target: BridgeTarget::Tcp {
        host: host.into(),
        port,
      },
      timeout: Duration::from_millis(1200),
      observation_timeout: Duration::from_millis(3000),
      heartbeat: Duration::from_millis(300),
    }
  }
  pub fn serial(path: impl Into<String>, baud_rate: u32) -> Self {
    Self {
      target: BridgeTarget::Serial {
        path: path.into(),
        baud_rate,
      },
      ..Self::tcp("", 3333)
    }
  }
}

enum Writer {
  Tcp(std::net::TcpStream),
  Serial(Box<dyn serialport::SerialPort>),
}
impl Writer {
  fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
    match self {
      Self::Tcp(socket) => socket.write_all(bytes),
      Self::Serial(port) => port.write_all(bytes),
    }
  }
  fn close(&mut self) {
    if let Self::Tcp(socket) = self {
      let _ = socket.shutdown(std::net::Shutdown::Both);
    }
  }
}
struct Connection {
  epoch: u64,
  writer: Arc<Mutex<Writer>>,
  stop: Arc<AtomicBool>,
  heartbeat: Cancel,
}
impl Connection {
  fn close(&self) {
    self.stop.store(true, Ordering::Release);
    self.heartbeat.cancel();
    if let Ok(mut writer) = self.writer.try_lock() {
      writer.close();
    }
  }
}
struct Pending {
  tx: oneshot::Sender<Result<HidStatus>>,
  sequence: u64,
  round: u64,
}
struct TextPending {
  tx: oneshot::Sender<Result<TextStatus>>,
  identity: Arc<()>,
}
struct Cached {
  status: HidStatus,
  sequence: u64,
  round: u64,
  at: Instant,
}
pub(crate) struct Completion {
  done: AtomicBool,
  notify: Notify,
  dependencies: Vec<Arc<Completion>>,
}
impl Completion {
  pub(crate) fn new() -> Arc<Self> {
    Self::new_after(Vec::new())
  }
  pub(crate) fn new_after(dependencies: Vec<Arc<Completion>>) -> Arc<Self> {
    Arc::new(Self {
      done: AtomicBool::new(false),
      notify: Notify::new(),
      dependencies,
    })
  }
  pub(crate) fn finish(&self) {
    self.done.store(true, Ordering::Release);
    self.notify.notify_waiters();
  }
  pub(crate) fn is_done(&self) -> bool {
    self.done.load(Ordering::Acquire) && self.dependencies.iter().all(|d| d.is_done())
  }
  pub(crate) async fn wait(&self) {
    for dependency in &self.dependencies {
      Box::pin(dependency.wait()).await;
    }
    loop {
      let notified = self.notify.notified();
      if self.done.load(Ordering::Acquire) {
        return;
      }
      notified.await;
    }
  }
}
struct State {
  connection: Option<Arc<Connection>>,
  connection_epoch: u64,
  ready: bool,
  observing: bool,
  control_attempted: bool,
  disposed: bool,
  fault: Option<String>,
  next_id: u32,
  sequence: u64,
  round: u64,
  latest: Option<Cached>,
  pending: HashMap<u32, Pending>,
  text_pending: HashMap<u32, TextPending>,
  heartbeats: BTreeMap<u32, u64>,
  retired: VecDeque<u32>,
  retired_heartbeats: VecDeque<u32>,
  buffer: Vec<u8>,
  realtime_epoch: u64,
  realtime_cancel: Cancel,
  realtime_inflight: usize,
  recovering: bool,
  launch_tail: Option<oneshot::Receiver<()>>,
  realtime_reservations: Vec<Arc<Completion>>,
  exclusive_tail: Option<Arc<Completion>>,
}
impl Default for State {
  fn default() -> Self {
    Self {
      connection: None,
      connection_epoch: 0,
      ready: false,
      observing: false,
      control_attempted: false,
      disposed: false,
      fault: None,
      next_id: 1,
      sequence: 0,
      round: 0,
      latest: None,
      pending: HashMap::new(),
      text_pending: HashMap::new(),
      heartbeats: BTreeMap::new(),
      retired: VecDeque::new(),
      retired_heartbeats: VecDeque::new(),
      buffer: Vec::new(),
      realtime_epoch: 0,
      realtime_cancel: Cancel::new(),
      realtime_inflight: 0,
      recovering: false,
      launch_tail: None,
      realtime_reservations: Vec::new(),
      exclusive_tail: None,
    }
  }
}
struct Inner {
  options: BridgeOptions,
  state: Mutex<State>,
  gate: RwLock<()>,
  write_gate: tokio::sync::Mutex<()>,
  realtime_window: Arc<Semaphore>,
  recovery_done: Notify,
  runtime: Option<tokio::runtime::Handle>,
}
impl Drop for Inner {
  fn drop(&mut self) {
    if let Ok(state) = self.state.get_mut() {
      if let Some(connection) = &state.connection {
        connection.close();
      }
      state.realtime_cancel.cancel();
      fail_pending(state, "HID bridge is closing.");
    }
  }
}

/// One lazy connection owns the complete HID lease. No reconnect ever arms it.
#[derive(Clone)]
pub struct Bridge {
  inner: Arc<Inner>,
}
pub type RealtimeFuture = Pin<Box<dyn Future<Output = Result<HidStatus>> + Send>>;
struct RealtimeReservation(Arc<Completion>);
impl Drop for RealtimeReservation {
  fn drop(&mut self) {
    self.0.finish();
  }
}
struct WireReservation(Arc<Inner>);
impl Drop for WireReservation {
  fn drop(&mut self) {
    self.0.state.lock().unwrap().realtime_inflight -= 1;
  }
}
struct PendingReservation {
  inner: Arc<Inner>,
  id: u32,
  sequence: u64,
  op: HidOperation,
  finished: bool,
}
impl Drop for PendingReservation {
  fn drop(&mut self) {
    let abandoned = take_current_pending(
      &mut self.inner.state.lock().unwrap(),
      self.id,
      self.sequence,
    )
    .is_some();
    if abandoned && !self.finished && (self.op.is_input() || self.op == HidOperation::Arm) {
      Bridge {
        inner: self.inner.clone(),
      }
      .start_recovery("HID waiter was cancelled before acknowledgement.".into());
    }
  }
}
struct TextPendingReservation {
  inner: Arc<Inner>,
  id: u32,
  identity: Arc<()>,
  finished: bool,
}
impl Drop for TextPendingReservation {
  fn drop(&mut self) {
    let abandoned = take_current_text_pending(
      &mut self.inner.state.lock().unwrap(),
      self.id,
      &self.identity,
    )
    .is_some();
    if abandoned && !self.finished {
      Bridge {
        inner: self.inner.clone(),
      }
      .start_recovery(
        "Text waiter abandoned; delivery may be uncertain and was not retried.".into(),
      );
    }
  }
}

pub fn check_cancel(cancel: Option<&Cancel>) -> Result<()> {
  if cancel.is_some_and(Cancel::is_cancelled) {
    return Err(HidCancelled.into());
  }
  Ok(())
}
pub fn is_hid_cancellation(error: &anyhow::Error, cancel: Option<&Cancel>) -> bool {
  cancel.is_some_and(Cancel::is_cancelled) && error.is::<HidCancelled>()
}
async fn cancelled(cancel: Option<&Cancel>) {
  if let Some(cancel) = cancel {
    cancel.cancelled().await;
  } else {
    std::future::pending::<()>().await;
  }
}
fn retire(window: &mut VecDeque<u32>, id: u32) {
  window.push_back(id);
  if window.len() > 64 {
    window.pop_front();
  }
}
fn take_pending(state: &mut State, id: u32) -> Option<Pending> {
  let pending = state.pending.remove(&id);
  if pending.is_some() {
    retire(&mut state.retired, id);
  }
  pending
}
fn take_current_pending(state: &mut State, id: u32, sequence: u64) -> Option<Pending> {
  if state
    .pending
    .get(&id)
    .is_some_and(|pending| pending.sequence == sequence)
  {
    take_pending(state, id)
  } else {
    None
  }
}
fn fail_pending(state: &mut State, message: &str) {
  let ids: Vec<_> = state.pending.keys().copied().collect();
  for id in ids {
    if let Some(p) = take_pending(state, id) {
      let _ = p.tx.send(Err(anyhow!(message.to_owned())));
    }
  }
  let text_ids: Vec<_> = state.text_pending.keys().copied().collect();
  for id in text_ids {
    if let Some(p) = take_text_pending(state, id) {
      let _ = p.tx.send(Err(anyhow!(message.to_owned())));
    }
  }
}
fn take_text_pending(state: &mut State, id: u32) -> Option<TextPending> {
  let pending = state.text_pending.remove(&id);
  if pending.is_some() {
    retire(&mut state.retired, id);
  }
  pending
}
fn take_current_text_pending(
  state: &mut State,
  id: u32,
  identity: &Arc<()>,
) -> Option<TextPending> {
  if state
    .text_pending
    .get(&id)
    .is_some_and(|pending| Arc::ptr_eq(&pending.identity, identity))
  {
    take_text_pending(state, id)
  } else {
    None
  }
}
fn retire_heartbeats(state: &mut State) {
  state.round = state.round.wrapping_add(1);
  let ids: Vec<_> = state.heartbeats.keys().copied().collect();
  for id in ids {
    retire_heartbeat(state, id);
  }
}
fn retire_heartbeat(state: &mut State, id: u32) {
  state.heartbeats.remove(&id);
  retire(&mut state.retired_heartbeats, id);
  if let Some(p) = take_pending(state, id) {
    let _ = p.tx.send(Err(anyhow!("Neutral heartbeat was superseded.")));
  }
}
fn fault(inner: &Inner, epoch: u64, message: String) {
  let mut state = inner.state.lock().unwrap();
  if state.connection.as_ref().map(|c| c.epoch) != Some(epoch) {
    return;
  }
  state.ready = false;
  state.latest = None;
  state.fault = Some(message.clone());
  if let Some(c) = &state.connection {
    c.heartbeat.cancel();
  }
  retire_heartbeats(&mut state);
  fail_pending(&mut state, &message);
}

fn receive(inner: &Inner, epoch: u64, bytes: &[u8]) {
  let mut state = inner.state.lock().unwrap();
  if state.connection.as_ref().map(|c| c.epoch) != Some(epoch) {
    return;
  }
  state.buffer.extend_from_slice(bytes);
  if state.buffer.len() > 8192 {
    drop(state);
    fault(
      inner,
      epoch,
      "ESP32 reply buffer exceeded its limit.".into(),
    );
    return;
  }
  while let Some(end) = state.buffer.iter().position(|&c| c == b'\n') {
    let line: Vec<u8> = state.buffer.drain(..=end).collect();
    match crate::text::decode_reply(&String::from_utf8_lossy(&line)) {
      Ok(Some(reply)) => {
        let id = match &reply {
          TextReply::Ok { id, .. } | TextReply::Err { id, .. } => *id,
        };
        if let Some(waiting) = take_text_pending(&mut state, id) {
          let result = match reply {
            TextReply::Ok { status, .. } => Ok(status),
            TextReply::Err { code, .. } => Err(
              HidProtocolError {
                message: format!("ESP32 text channel rejected command: {code}."),
                code,
              }
              .into(),
            ),
          };
          let _ = waiting.tx.send(result);
        }
        continue;
      }
      Ok(None) => {}
      Err(error) => {
        drop(state);
        fault(inner, epoch, error.to_string());
        return;
      }
    }
    let reply = match decode_reply(&String::from_utf8_lossy(&line)) {
      Ok(Some(reply)) => reply,
      Ok(None) => continue,
      Err(error) => {
        drop(state);
        fault(inner, epoch, error.to_string());
        return;
      }
    };
    let id = match &reply {
      HidReply::Ok { id, .. } | HidReply::Err { id, .. } => *id,
    };
    if let Some(waiting) = take_text_pending(&mut state, id) {
      let message = match reply {
        HidReply::Err { code, .. } => format!("ESP32 text channel unavailable ({code}); update the ESP firmware and phone App for clipboard input."),
        HidReply::Ok { .. } => "Unexpected HID acknowledgement for a text command; update matching firmware.".into(),
      };
      let _ = waiting.tx.send(Err(anyhow!(message)));
      continue;
    }
    let Some(waiting) = take_pending(&mut state, id) else {
      if state.realtime_inflight != 0
        && !state.pending.is_empty()
        && !state.retired.contains(&id)
        && !state.retired_heartbeats.contains(&id)
      {
        drop(state);
        fault(
          inner,
          epoch,
          "ESP32 returned an unknown realtime acknowledgement id.".into(),
        );
        return;
      }
      continue;
    };
    let result = match reply {
      HidReply::Ok { status, .. } => {
        if state
          .latest
          .as_ref()
          .is_none_or(|cached| waiting.sequence >= cached.sequence)
        {
          state.latest = Some(Cached {
            status: status.clone(),
            sequence: waiting.sequence,
            round: waiting.round,
            at: Instant::now(),
          });
        }
        Ok(status)
      }
      HidReply::Err { code, .. } => {
        let message = match code.as_str() {
          "CONTROL_BUSY" => "控制板正在由另一个连接控制，请先停止那个连接后再试。".to_owned(),
          "USB_ONLY" => {
            "首次蓝牙配对需要用 USB 连接控制板，完成配对后可通过 Wi-Fi 控制。".to_owned()
          }
          _ => format!("ESP32 rejected command: {code}."),
        };
        Err(HidProtocolError { code, message }.into())
      }
    };
    let _ = waiting.tx.send(result);
  }
}

impl Bridge {
  pub fn new(options: BridgeOptions) -> Result<Self> {
    ensure!(
      !options.timeout.is_zero()
        && !options.observation_timeout.is_zero()
        && !options.heartbeat.is_zero()
        && options.heartbeat < Duration::from_millis(1500),
      "HID timeout must be positive and heartbeat must be below 1500 ms."
    );
    Ok(Self {
      inner: Arc::new(Inner {
        options,
        state: Mutex::new(State::default()),
        gate: RwLock::new(()),
        write_gate: tokio::sync::Mutex::new(()),
        realtime_window: Arc::new(Semaphore::new(4)),
        recovery_done: Notify::new(),
        runtime: tokio::runtime::Handle::try_current().ok(),
      }),
    })
  }

  pub fn control_status(&self) -> Option<HidStatus> {
    let state = self.inner.state.lock().unwrap();
    let c = state.connection.as_ref()?;
    let latest = state.latest.as_ref()?;
    (state.ready
      && state.fault.is_none()
      && !c.stop.load(Ordering::Acquire)
      && latest.round == state.round
      && latest.at.elapsed() <= self.inner.options.timeout)
      .then(|| latest.status.clone())
  }

  async fn wait_recovery(&self) {
    loop {
      let notified = self.inner.recovery_done.notified();
      if !self.inner.state.lock().unwrap().recovering {
        break;
      }
      notified.await;
    }
  }

  pub async fn request(
    &self,
    op: HidOperation,
    args: &[i32],
    cancel: Option<&Cancel>,
  ) -> Result<HidStatus> {
    encode_command(1, op, args)?;
    let (previous, completion, reports) = {
      let mut state = self.inner.state.lock().unwrap();
      if op.starts_round() {
        retire_heartbeats(&mut state);
      }
      let previous = state.exclusive_tail.clone().filter(|c| !c.is_done());
      let completion = Completion::new_after(previous.iter().cloned().collect());
      state.exclusive_tail = Some(completion.clone());
      (previous, completion, state.realtime_reservations.clone())
    };
    let _reservation = RealtimeReservation(completion);
    if let Some(previous) = previous {
      previous.wait().await;
    }
    for report in reports {
      tokio::select! { biased; _ = cancelled(cancel) => return Err(HidCancelled.into()), _ = report.wait() => {} }
    }
    let guard = loop {
      self.wait_recovery().await;
      let guard = tokio::select! { biased; _ = cancelled(cancel) => return Err(HidCancelled.into()), guard = self.inner.gate.write() => guard };
      if !self.inner.state.lock().unwrap().recovering {
        break guard;
      }
      drop(guard);
    };
    check_cancel(cancel)?;
    let observe = {
      let mut state = self.inner.state.lock().unwrap();
      ensure!(!state.disposed, "HID bridge is closed.");
      if op != HidOperation::Status {
        state.control_attempted = true;
      }
      op == HidOperation::Status && !state.control_attempted
    };
    self.connect(observe).await?;
    check_cancel(cancel)?;
    let result = async {
      if op == HidOperation::Arm {
        self
          .exchange(
            HidOperation::Ping,
            &[],
            None,
            self.inner.options.timeout,
            false,
          )
          .await?;
      }
      if op.starts_round() {
        retire_heartbeats(&mut self.inner.state.lock().unwrap());
      }
      let observing = self.inner.state.lock().unwrap().observing;
      let timeout = if observing {
        self.inner.options.observation_timeout
      } else {
        self.inner.options.timeout
      };
      Ok(self.exchange(op, args, cancel, timeout, false).await?.1)
    }
    .await;
    if let Err(error) = &result {
      let observing = self.inner.state.lock().unwrap().observing;
      if observing {
        if !is_hid_cancellation(error, cancel) {
          self.disconnect();
        }
      } else if op != HidOperation::Release
        && !(op == HidOperation::Status && is_hid_cancellation(error, cancel))
      {
        let _ = self
          .exchange(
            HidOperation::Release,
            &[],
            None,
            self.inner.options.timeout,
            false,
          )
          .await;
      }
    }
    drop(guard);
    result
  }

  /// Send one intentional press and its neutral release in a single exclusive
  /// reservation. A delayed press ACK must not keep the physical key/button
  /// held. Each wire report has its own id and unchanged ACK deadline.
  pub async fn pulse(
    &self,
    op: HidOperation,
    args: &[i32],
    hold: Duration,
    cancel: Option<&Cancel>,
  ) -> Result<HidStatus> {
    let neutral: &[i32] = match op {
      HidOperation::Move => &[0, 0, 0, 0],
      HidOperation::Key => &[0, 0],
      HidOperation::Consumer => &[0],
      _ => bail!("Only mouse, key and consumer presses support a neutral pulse."),
    };
    encode_command(1, op, args)?;
    let (previous, completion, reports) = {
      let mut state = self.inner.state.lock().unwrap();
      let previous = state.exclusive_tail.clone().filter(|c| !c.is_done());
      let completion = Completion::new_after(previous.iter().cloned().collect());
      state.exclusive_tail = Some(completion.clone());
      (previous, completion, state.realtime_reservations.clone())
    };
    let _reservation = RealtimeReservation(completion);
    if let Some(previous) = previous {
      previous.wait().await;
    }
    for report in reports {
      tokio::select! { biased; _ = cancelled(cancel) => return Err(HidCancelled.into()), _ = report.wait() => {} }
    }
    let guard = loop {
      self.wait_recovery().await;
      let guard = tokio::select! { biased; _ = cancelled(cancel) => return Err(HidCancelled.into()), guard = self.inner.gate.write() => guard };
      if !self.inner.state.lock().unwrap().recovering {
        break guard;
      }
      drop(guard);
    };
    check_cancel(cancel)?;
    {
      let mut state = self.inner.state.lock().unwrap();
      ensure!(!state.disposed, "HID bridge is closed.");
      state.control_attempted = true;
    }
    self.connect(false).await?;
    check_cancel(cancel)?;
    let (launched, written) = oneshot::channel();
    let press = self.exchange_inner(
      op,
      args,
      cancel,
      self.inner.options.timeout,
      false,
      Some(launched),
      None,
    );
    let release = async {
      written
        .await
        .context("Press was not written; no pulse release was queued.")?;
      // Cancellation shortens an intended hold; it never suppresses cleanup.
      tokio::select! { biased; _ = cancelled(cancel) => {}, _ = tokio::time::sleep(hold) => {} }
      self
        .exchange(op, neutral, None, self.inner.options.timeout, false)
        .await
    };
    let (pressed, released) = tokio::join!(press, release);
    let result = match pressed {
      Err(error) => Err(error),
      Ok(_) => released.map(|(_, status)| status),
    };
    if result.is_err() {
      // The old reservation remains exclusive through neutral cleanup; a new
      // ARM cannot be affected by this operation's delayed error or cancellation.
      let _ = self
        .exchange(
          HidOperation::Release,
          &[],
          None,
          self.inner.options.timeout,
          false,
        )
        .await;
    }
    drop(guard);
    result
  }

  pub async fn unicode_text(&self, text: &str, cancel: Option<&Cancel>) -> Result<TextStatus> {
    crate::text::validate_text(text)?;
    ensure!(
      !text.is_ascii(),
      "The device input method channel is only used for text containing non-ASCII characters."
    );
    let (previous, completion, reports) = {
      let mut state = self.inner.state.lock().unwrap();
      let previous = state.exclusive_tail.clone().filter(|c| !c.is_done());
      let completion = Completion::new_after(previous.iter().cloned().collect());
      state.exclusive_tail = Some(completion.clone());
      (previous, completion, state.realtime_reservations.clone())
    };
    let _reservation = RealtimeReservation(completion);
    if let Some(previous) = previous {
      previous.wait().await;
    }
    for report in reports {
      tokio::select! { biased; _ = cancelled(cancel) => return Err(HidCancelled.into()), _ = report.wait() => {} }
    }
    let _guard = loop {
      self.wait_recovery().await;
      let guard = tokio::select! { biased; _ = cancelled(cancel) => return Err(HidCancelled.into()), guard = self.inner.gate.write() => guard };
      if !self.inner.state.lock().unwrap().recovering {
        break guard;
      }
      drop(guard);
    };
    check_cancel(cancel)?;
    self.connect(false).await?;
    ensure!(
      self
        .inner
        .state
        .lock()
        .unwrap()
        .latest
        .as_ref()
        .is_some_and(|cached| cached.status.input_ready()),
      "Unicode input requires explicit ARM, encrypted BLE and a ready phone; no text was sent."
    );
    let editor = self.text_exchange(&TextCommand::Status(0), cancel).await
      .context("TEXT_IME_UNAVAILABLE: The device input method channel is unavailable. Use the phone APK with the device input method and matching ESP firmware, then select the current controller in the phone App. No text was sent.")?;
    ensure!(editor.mode == TextMode::Ime,
      "TEXT_IME_UNAVAILABLE: This phone is using the clipboard receiver. Update the phone APK with the device input method, enable and select it, then focus the target field. No text was sent.");
    ensure!(editor.ready && editor.editor_epoch != 0,
      "TEXT_IME_NOT_READY: Select the current controller in the phone App, enable and select the device input method, then focus the target editable field. No text was sent.");
    let transfer = crate::text::next_transfer_id(crate::text::parse_transfer_id(&editor.id)?)?;
    let mut began = false;
    let mut commit_attempted = false;
    let result = async {
      // Even a missing BEGIN acknowledgement may have reserved the transfer.
      began = true;
      let begin = self.text_exchange(&TextCommand::Begin { transfer, editor_epoch:editor.editor_epoch, bytes:text.len() }, cancel).await?;
      Self::check_text_identity(&begin, transfer, editor.editor_epoch, text.len())?;
      ensure!(begin.status == TextPhase::Receiving && begin.received == 0, "Unexpected text BEGIN state; no COMMIT was sent.");
      for (index, chunk) in text.as_bytes().chunks(crate::text::TEXT_CHUNK_BYTES).enumerate() {
        check_cancel(cancel)?;
        let offset = index * crate::text::TEXT_CHUNK_BYTES;
        let data = self.text_exchange(&TextCommand::Data { transfer, offset, bytes:chunk }, cancel).await?;
        Self::check_text_identity(&data, transfer, editor.editor_epoch, text.len())?;
        ensure!(data.status == TextPhase::Receiving && data.received == offset + chunk.len(),
          "Text DATA acknowledgement has unexpected progress; no COMMIT was sent.");
      }
      check_cancel(cancel)?;
      // COMMIT is attempted once. A lost acknowledgement never authorizes a
      // replacement transfer, clipboard paste or HID fallback.
      commit_attempted = true;
      let mut status = self.text_exchange(&TextCommand::Commit(transfer), cancel).await?;
      Self::check_text_identity(&status, transfer, editor.editor_epoch, text.len())?;
      let waiting = cancel.map(Cancel::child_token).unwrap_or_default();
      let timer = waiting.clone();
      tokio::spawn(async move { tokio::time::sleep(Duration::from_secs(10)).await; timer.cancel(); });
      loop {
        check_cancel(Some(&waiting))?;
        match status.status {
          TextPhase::Accepted => return Ok(status),
          TextPhase::Rejected => bail!(crate::text::TextTransferError { transfer_id:transfer, uncertain:false,
            message:"TEXT_IME_REJECTED: The device input method rejected the text. Select the current controller, enable and select the device input method, then focus the target editable field before a new intentional action.".into() }),
          TextPhase::Uncertain | TextPhase::Cancelled => bail!("Device input method delivery could not be confirmed; observe the phone and do not resubmit."),
          TextPhase::Queued | TextPhase::Sending | TextPhase::AwaitingAck => {},
          _ => bail!("Unexpected device input method state; observe the phone and do not resubmit."),
        }
        tokio::select! { biased; _ = waiting.cancelled() => return Err(HidCancelled.into()), _ = tokio::time::sleep(Duration::from_millis(40)) => {} }
        status = self.text_exchange(&TextCommand::Status(transfer), Some(&waiting)).await?;
        Self::check_text_identity(&status, transfer, editor.editor_epoch, text.len())?;
      }
    }.await;
    match result {
      Ok(status) => Ok(status),
      Err(error) => {
        if began {
          // CANCEL is neutral cleanup. It stays inside this reservation and
          // never authorizes retransmission of an uncertain COMMIT.
          let _ = self
            .text_exchange(&TextCommand::Cancel(transfer), None)
            .await;
        }
        if error.is::<crate::text::TextTransferError>() {
          return Err(error);
        }
        Err(
          crate::text::TextTransferError {
            transfer_id: transfer,
            uncertain: commit_attempted,
            message: error.to_string(),
          }
          .into(),
        )
      }
    }
  }

  fn check_text_identity(
    status: &TextStatus,
    transfer: u64,
    editor_epoch: u32,
    bytes: usize,
  ) -> Result<()> {
    let terminal = matches!(
      status.status,
      TextPhase::Accepted
        | TextPhase::Rejected
        | TextPhase::Uncertain
        | TextPhase::Cancelled
        | TextPhase::ClipboardDispatched
        | TextPhase::ClipboardVerified
        | TextPhase::PastePending
        | TextPhase::PasteSent
        | TextPhase::PasteUncertain
    );
    // The board clears its text buffer on completion/failure, retaining only
    // identity/result. Terminal zero byte counts are an intentional privacy boundary.
    ensure!(
      status.mode == TextMode::Ime
        && status.id == format!("{transfer:016x}")
        && status.editor_epoch == editor_epoch
        && (status.bytes == bytes || (terminal && status.bytes == 0 && status.received == 0)),
      "Text transfer identity, editor focus or byte count changed."
    );
    Ok(())
  }

  async fn text_exchange(
    &self,
    command: &TextCommand<'_>,
    cancel: Option<&Cancel>,
  ) -> Result<TextStatus> {
    check_cancel(cancel)?;
    let deadline = Instant::now() + self.inner.options.timeout;
    let identity = Arc::new(());
    let (id, line, receiver, connection) = {
      let mut state = self.inner.state.lock().unwrap();
      let connection = state
        .connection
        .clone()
        .context("ESP32 link is not open.")?;
      ensure!(
        !connection.stop.load(Ordering::Acquire),
        "ESP32 link is not open."
      );
      let id = state.next_id;
      state.next_id = if id == MAX_REQUEST_ID { 1 } else { id + 1 };
      let line = command.encode(id)?;
      let (tx, receiver) = oneshot::channel();
      state.text_pending.insert(
        id,
        TextPending {
          tx,
          identity: identity.clone(),
        },
      );
      (id, line, receiver, connection)
    };
    let mut reservation = TextPendingReservation {
      inner: self.inner.clone(),
      id,
      identity: identity.clone(),
      finished: false,
    };
    let operation = async {
      let _wire = tokio::select! { biased; _ = cancelled(cancel) => return Err(HidCancelled.into()), guard = self.inner.write_gate.lock() => guard };
      check_cancel(cancel)?;
      {
        let state = self.inner.state.lock().unwrap();
        ensure!(
          state
            .text_pending
            .get(&id)
            .is_some_and(|pending| Arc::ptr_eq(&pending.identity, &identity))
            && state.connection.as_ref().map(|c| c.epoch) == Some(connection.epoch),
          "Queued text command was cancelled."
        );
      }
      let writer = connection.writer.clone();
      let stop = connection.stop.clone();
      let inner = self.inner.clone();
      let epoch = connection.epoch;
      let queued_cancel = cancel.cloned();
      let write = tokio::task::spawn_blocking(move || -> Result<std::io::Result<()>> {
        let mut writer = writer.lock().unwrap();
        // spawn_blocking can outlive its timed-out/abandoned waiter. Recheck
        // admission only after the final writer lock, against this exact request.
        // A rejection here is local cancellation, not a fault in a newer link.
        check_cancel(queued_cancel.as_ref())?;
        ensure!(!stop.load(Ordering::Acquire), "ESP32 link is not open.");
        {
          let state = inner.state.lock().unwrap();
          ensure!(
            !state.disposed
              && state
                .text_pending
                .get(&id)
                .is_some_and(|pending| Arc::ptr_eq(&pending.identity, &identity))
              && state.connection.as_ref().map(|c| c.epoch) == Some(epoch),
            "Queued text command was cancelled before write."
          );
        }
        check_cancel(queued_cancel.as_ref())?;
        ensure!(
          Instant::now() < deadline,
          "Queued text command expired before write."
        );
        // From this boundary onward write_all may have written some/all bytes.
        // Cancellation or missing ACK must remain uncertain, never a safe retry.
        Ok(writer.write_all(line.as_bytes()))
      });
      let written = tokio::select! { biased;
        _ = cancelled(cancel) => return Err(HidCancelled.into()),
        result = write => result??,
      };
      if let Err(error) = written {
        fault(&self.inner, connection.epoch, error.to_string());
      }
      drop(_wire);
      tokio::select! { biased;
        result = receiver => result.context("ESP32 text request channel closed.")?,
        _ = cancelled(cancel) => Err(HidCancelled.into()),
      }
    };
    let result = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), operation)
      .await
      .unwrap_or_else(|_| {
        Err(anyhow!(
          "ESP32 text {} acknowledgement timed out; action was not retried.",
          command.name()
        ))
      });
    reservation.finished = true;
    take_current_text_pending(
      &mut self.inner.state.lock().unwrap(),
      id,
      &reservation.identity,
    );
    result
  }

  pub async fn request_realtime(
    &self,
    op: HidOperation,
    args: &[i32],
    cancel: Option<&Cancel>,
  ) -> Result<HidStatus> {
    self
      .submit_realtime(op, args.to_vec(), cancel.cloned().unwrap_or_default())?
      .await
  }

  /// Reserve wire order synchronously, before HTTP worker threads start waiting.
  pub fn submit_realtime(
    &self,
    op: HidOperation,
    args: Vec<i32>,
    cancel: Cancel,
  ) -> Result<RealtimeFuture> {
    ensure!(
      matches!(op, HidOperation::Move | HidOperation::Key),
      "Only MOVE and KEY support realtime input."
    );
    encode_command(1, op, &args)?;
    check_cancel(Some(&cancel))?;
    let permit = self
      .inner
      .realtime_window
      .clone()
      .try_acquire_owned()
      .context("ESP32 realtime input window is full.")?;
    let (launch_tx, launch_rx) = oneshot::channel();
    let completion = Completion::new();
    let (epoch, lane, previous, exclusive) = {
      let mut state = self.inner.state.lock().unwrap();
      ensure!(
        !state.disposed && state.ready && state.latest.as_ref().is_some_and(|s| s.status.armed),
        "ESP32 realtime input is unavailable; arm explicitly after reconnecting."
      );
      let previous = state.launch_tail.replace(launch_rx);
      state.realtime_reservations.retain(|r| !r.is_done());
      state.realtime_reservations.push(completion.clone());
      (
        state.realtime_epoch,
        state.realtime_cancel.clone(),
        previous,
        state.exclusive_tail.clone(),
      )
    };
    let bridge = self.clone();
    let reservation = RealtimeReservation(completion);
    Ok(Box::pin(async move {
      let _reservation = reservation;
      let mut guard = None;
      let result = async {
    if let Some(previous) = previous {
      tokio::select! { biased; _ = cancel.cancelled() => return Err(HidCancelled.into()), _ = lane.cancelled() => bail!("Queued realtime input was cancelled."), _ = previous => {} }
    }
    if let Some(exclusive) = exclusive {
      tokio::select! { biased; _ = cancel.cancelled() => return Err(HidCancelled.into()), _ = lane.cancelled() => bail!("Queued realtime input was cancelled."), _ = exclusive.wait() => {} }
    }
    guard = Some(tokio::select! { biased;
      _ = cancel.cancelled() => return Err(HidCancelled.into()),
      _ = lane.cancelled() => bail!("Queued realtime input was cancelled."),
      guard = bridge.inner.gate.read() => guard,
    });
    {
      let mut state = bridge.inner.state.lock().unwrap();
      ensure!(epoch == state.realtime_epoch && !state.disposed && state.ready
        && state.latest.as_ref().is_some_and(|s| s.status.armed), "Queued realtime input was cancelled.");
      state.realtime_inflight += 1;
    }
    let _wire_reservation = WireReservation(bridge.inner.clone());
    let result = bridge.exchange_inner(op, &args, Some(&cancel), bridge.inner.options.timeout, false, Some(launch_tx), None).await.map(|(_, status)| status);
    result
    }.await;
      if let Err(error) = &result {
        bridge.start_recovery(error.to_string());
      }
      drop(guard);
      drop(permit);
      if result.is_err() {
        bridge.wait_recovery().await;
      }
      result
    }))
  }

  fn start_recovery(&self, message: String) {
    {
      let mut state = self.inner.state.lock().unwrap();
      if state.recovering || state.disposed {
        return;
      }
      state.recovering = true;
      state.realtime_epoch = state.realtime_epoch.wrapping_add(1);
      state.realtime_cancel.cancel();
      state.realtime_cancel = Cancel::new();
      state.ready = false;
      if let Some(c) = &state.connection {
        c.heartbeat.cancel();
      }
      retire_heartbeats(&mut state);
      fail_pending(&mut state, &message);
    }
    let bridge = self.clone();
    let runtime = self
      .inner
      .runtime
      .clone()
      .or_else(|| tokio::runtime::Handle::try_current().ok());
    let Some(runtime) = runtime else {
      self.disconnect();
      self.inner.state.lock().unwrap().recovering = false;
      self.inner.recovery_done.notify_waiters();
      return;
    };
    runtime.spawn(async move {
      let _guard = bridge.inner.gate.write().await;
      let _ = bridge
        .exchange(
          HidOperation::Release,
          &[],
          None,
          bridge.inner.options.timeout,
          false,
        )
        .await;
      let _ = bridge
        .exchange(
          HidOperation::Pause,
          &[],
          None,
          bridge.inner.options.timeout,
          false,
        )
        .await;
      bridge.inner.state.lock().unwrap().recovering = false;
      bridge.inner.recovery_done.notify_waiters();
    });
  }
  pub(crate) fn fail_closed(&self, message: &str) {
    self.start_recovery(message.to_owned());
  }

  pub async fn close(&self) -> Result<()> {
    {
      let mut state = self.inner.state.lock().unwrap();
      if state.disposed {
        return Ok(());
      }
      state.disposed = true;
      state.ready = false;
      state.latest = None;
      state.realtime_epoch = state.realtime_epoch.wrapping_add(1);
      state.realtime_cancel.cancel();
      if let Some(c) = &state.connection {
        c.heartbeat.cancel();
      }
      retire_heartbeats(&mut state);
      fail_pending(&mut state, "HID bridge is closing.");
    }
    let _guard = self.inner.gate.write().await;
    let observing = self.inner.state.lock().unwrap().observing;
    if !observing {
      let _ = self
        .exchange(
          HidOperation::Release,
          &[],
          None,
          self.inner.options.timeout,
          false,
        )
        .await;
      let _ = self
        .exchange(
          HidOperation::Pause,
          &[],
          None,
          self.inner.options.timeout,
          false,
        )
        .await;
    }
    self.disconnect();
    Ok(())
  }

  fn disconnect(&self) {
    let mut state = self.inner.state.lock().unwrap();
    if let Some(c) = state.connection.take() {
      c.close();
    }
    state.ready = false;
    state.observing = false;
    state.latest = None;
    state.buffer.clear();
    retire_heartbeats(&mut state);
    fail_pending(
      &mut state,
      "ESP32 link disconnected; re-arm explicitly after reconnecting.",
    );
  }

  async fn connect(&self, observe_only: bool) -> Result<()> {
    let (reusable, observing) = {
      let state = self.inner.state.lock().unwrap();
      (
        state
          .connection
          .as_ref()
          .is_some_and(|c| !c.stop.load(Ordering::Acquire))
          && state.fault.is_none()
          && (state.ready || observe_only && state.observing),
        state.observing,
      )
    };
    if reusable {
      return Ok(());
    }
    if !observing && self.inner.state.lock().unwrap().connection.is_some() {
      let _ = self
        .exchange(
          HidOperation::Release,
          &[],
          None,
          self.inner.options.timeout,
          false,
        )
        .await;
      let _ = self
        .exchange(
          HidOperation::Pause,
          &[],
          None,
          self.inner.options.timeout,
          false,
        )
        .await;
    }
    self.disconnect();
    let options = self.inner.options.clone();
    let open_timeout = options.timeout * 3;
    let opened = tokio::time::timeout(
      open_timeout,
      tokio::task::spawn_blocking(move || -> Result<(Writer, Box<dyn Read + Send>)> {
        match &options.target {
          BridgeTarget::Tcp { host, port } => {
            ensure!(
              !host.trim().is_empty() && *port != 0,
              "ESP_HOST/ESP_TCP_PORT is not configured."
            );
            let socket =
              crate::lan::connect_tcp(host, *port, Duration::from_millis(3000).min(open_timeout))?;
            socket.set_nonblocking(false)?;
            socket.set_nodelay(true)?;
            socket.set_read_timeout(Some(Duration::from_millis(100)))?;
            socket.set_write_timeout(Some(options.timeout))?;
            socket2::SockRef::from(&socket)
              .set_tcp_keepalive(&socket2::TcpKeepalive::new().with_time(Duration::from_secs(1)))?;
            let reader = socket.try_clone()?;
            Ok((Writer::Tcp(socket), Box::new(reader)))
          }
          BridgeTarget::Serial { path, baud_rate } => {
            ensure!(
              !path.trim().is_empty(),
              "ESP_PORT is not configured. Set it to the ESP32 serial port to use HID input."
            );
            let mut port = serialport::new(path, *baud_rate)
              .timeout(Duration::from_millis(100))
              .open()?;
            port.write_data_terminal_ready(true)?;
            port.write_request_to_send(false)?;
            let reader = port.try_clone()?;
            Ok((Writer::Serial(port), Box::new(reader)))
          }
        }
      }),
    )
    .await
    .context("Opening ESP32 connection timed out.")
    .and_then(|task| task.context("Opening ESP32 connection task failed."))
    .and_then(|result| result)
    .map_err(|error| {
      if let BridgeTarget::Tcp { host, port } = &self.inner.options.target {
        // Do not echo an invalid raw host that could contain a URL credential
        // or query. Valid hosts are just a private IPv4 address or LAN name.
        let target = if crate::lan::validate_host(host).is_ok() && *port != 0 {
          format!("{host}:{port}")
        } else {
          "地址无效".into()
        };
        let message = format!("ESP_CONNECTION_ERROR: 设备控制器连接失败（{target}）：{error:#}");
        error.context(message)
      } else {
        error
      }
    })?;
    let (writer, reader) = opened;
    let connection = {
      let mut state = self.inner.state.lock().unwrap();
      ensure!(!state.disposed, "HID bridge is closing.");
      state.connection_epoch = state.connection_epoch.wrapping_add(1);
      let c = Arc::new(Connection {
        epoch: state.connection_epoch,
        writer: Arc::new(Mutex::new(writer)),
        stop: Arc::new(AtomicBool::new(false)),
        heartbeat: Cancel::new(),
      });
      state.connection = Some(c.clone());
      state.fault = None;
      state.observing = observe_only;
      c
    };
    Self::start_reader(Arc::downgrade(&self.inner), connection.clone(), reader);
    if observe_only {
      return Ok(());
    }
    self.start_heartbeat(connection.clone());
    let handshake = async {
      if let Err(error) = self
        .exchange(
          HidOperation::Ping,
          &[],
          None,
          self.inner.options.timeout,
          false,
        )
        .await
      {
        if !error
          .downcast_ref::<AckTimeoutError>()
          .is_some_and(|e| e.0 == HidOperation::Ping)
        {
          return Err(error);
        }
        self.assert_connection(&connection)?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        self.assert_connection(&connection)?;
        self
          .exchange(
            HidOperation::Ping,
            &[],
            None,
            self.inner.options.timeout,
            false,
          )
          .await?;
      }
      self.assert_connection(&connection)?;
      self
        .exchange(
          HidOperation::Release,
          &[],
          None,
          self.inner.options.timeout,
          false,
        )
        .await?;
      self.assert_connection(&connection)?;
      self
        .exchange(
          HidOperation::Pause,
          &[],
          None,
          self.inner.options.timeout,
          false,
        )
        .await?;
      self.assert_connection(&connection)?;
      self.inner.state.lock().unwrap().ready = true;
      Ok(())
    }
    .await;
    if handshake.is_err() {
      self.disconnect();
    }
    handshake
  }

  fn assert_connection(&self, connection: &Connection) -> Result<()> {
    let state = self.inner.state.lock().unwrap();
    ensure!(!state.disposed, "HID bridge is closing.");
    if let Some(error) = &state.fault {
      bail!(error.clone());
    }
    ensure!(
      state.connection.as_ref().map(|c| c.epoch) == Some(connection.epoch)
        && !connection.stop.load(Ordering::Acquire),
      "ESP32 link is not open."
    );
    Ok(())
  }

  fn start_reader(
    inner: Weak<Inner>,
    connection: Arc<Connection>,
    mut reader: Box<dyn Read + Send>,
  ) {
    std::thread::spawn(move || {
      let mut bytes = [0u8; 2048];
      while !connection.stop.load(Ordering::Acquire) {
        match reader.read(&mut bytes) {
          Ok(0) => {
            if let Some(inner) = inner.upgrade() {
              fault(
                &inner,
                connection.epoch,
                "ESP32 link disconnected; re-arm explicitly after reconnecting.".into(),
              );
            }
            break;
          }
          Ok(count) => {
            if let Some(inner) = inner.upgrade() {
              receive(&inner, connection.epoch, &bytes[..count]);
            } else {
              break;
            }
          }
          Err(e)
            if matches!(
              e.kind(),
              std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::WouldBlock
                | std::io::ErrorKind::Interrupted
            ) =>
          {
            if inner.strong_count() == 0 {
              break;
            }
            continue;
          }
          Err(error) => {
            if let Some(inner) = inner.upgrade() {
              fault(&inner, connection.epoch, error.to_string());
            }
            break;
          }
        }
      }
    });
  }

  fn start_heartbeat(&self, connection: Arc<Connection>) {
    let weak = Arc::downgrade(&self.inner);
    tokio::spawn(async move {
      loop {
        let Some(inner) = weak.upgrade() else {
          return;
        };
        let interval = inner.options.heartbeat;
        drop(inner);
        tokio::select! { biased; _ = connection.heartbeat.cancelled() => return, _ = tokio::time::sleep(interval) => {} }
        let Some(inner) = weak.upgrade() else {
          return;
        };
        let round = {
          let state = inner.state.lock().unwrap();
          if state.disposed || state.connection.as_ref().map(|c| c.epoch) != Some(connection.epoch)
          {
            return;
          }
          if state.heartbeats.len() >= 4 {
            continue;
          }
          state.round
        };
        let bridge = Bridge { inner };
        let connection = connection.clone();
        tokio::spawn(async move {
          let result = bridge
            .exchange_inner(
              HidOperation::Ping,
              &[],
              None,
              bridge.inner.options.timeout,
              true,
              None,
              Some(round),
            )
            .await;
          let mut recover = None;
          {
            let mut state = bridge.inner.state.lock().unwrap();
            if state.round != round
              || state.disposed
              || state.connection.as_ref().map(|c| c.epoch) != Some(connection.epoch)
            {
              return;
            }
            match &result {
              Ok((id, _)) => {
                if let Some(&sequence) = state.heartbeats.get(id) {
                  let earlier: Vec<_> = state
                    .heartbeats
                    .iter()
                    .filter(|(_, seq)| **seq < sequence)
                    .map(|(&id, _)| id)
                    .collect();
                  for id in earlier {
                    retire_heartbeat(&mut state, id);
                  }
                }
                state.heartbeats.remove(id);
              }
              Err(error) => {
                if error.to_string() != "Neutral heartbeat was superseded." {
                  recover = Some(error.to_string());
                }
              }
            }
          }
          if let Some(error) = recover {
            bridge.start_recovery(error);
          }
        });
      }
    });
  }

  async fn exchange(
    &self,
    op: HidOperation,
    args: &[i32],
    cancel: Option<&Cancel>,
    timeout: Duration,
    heartbeat: bool,
  ) -> Result<(u32, HidStatus)> {
    self
      .exchange_inner(op, args, cancel, timeout, heartbeat, None, None)
      .await
  }
  async fn exchange_inner(
    &self,
    op: HidOperation,
    args: &[i32],
    cancel: Option<&Cancel>,
    timeout: Duration,
    heartbeat: bool,
    launched: Option<oneshot::Sender<()>>,
    expected_round: Option<u64>,
  ) -> Result<(u32, HidStatus)> {
    check_cancel(cancel)?;
    let deadline = Instant::now() + timeout;
    let (id, line, receiver, connection, sequence, round) = {
      let mut state = self.inner.state.lock().unwrap();
      ensure!(
        expected_round.is_none_or(|round| round == state.round),
        "Neutral heartbeat was superseded."
      );
      let connection = state
        .connection
        .clone()
        .context("ESP32 link is not open.")?;
      ensure!(
        !connection.stop.load(Ordering::Acquire),
        "ESP32 link is not open."
      );
      let id = state.next_id;
      state.next_id = if id == MAX_REQUEST_ID { 1 } else { id + 1 };
      let line = encode_command(id, op, args)?;
      let (tx, rx) = oneshot::channel();
      state.sequence = state.sequence.wrapping_add(1);
      let sequence = state.sequence;
      let round = state.round;
      state.pending.insert(
        id,
        Pending {
          tx,
          sequence,
          round,
        },
      );
      if heartbeat {
        state.heartbeats.insert(id, sequence);
      }
      (id, line, rx, connection, sequence, round)
    };
    let mut reservation = PendingReservation {
      inner: self.inner.clone(),
      id,
      sequence,
      op,
      finished: false,
    };
    let operation = async {
      let _wire = tokio::select! { biased; _ = cancelled(cancel) => return Err(HidCancelled.into()), gate = self.inner.write_gate.lock() => gate };
      check_cancel(cancel)?;
      {
        let state = self.inner.state.lock().unwrap();
        ensure!(
          state
            .pending
            .get(&id)
            .is_some_and(|pending| pending.sequence == sequence && pending.round == round)
            && state.round == round
            && state.connection.as_ref().map(|c| c.epoch) == Some(connection.epoch),
          "Queued HID request was cancelled."
        );
      }
      let writer = connection.writer.clone();
      let stop = connection.stop.clone();
      let inner = self.inner.clone();
      let epoch = connection.epoch;
      let queued_cancel = cancel.cloned();
      let write = tokio::task::spawn_blocking(move || -> Result<std::io::Result<()>> {
        let mut writer = writer.lock().unwrap();
        // A blocking task can survive timeout or cancellation while waiting for
        // this lock. Its original pending sequence and control round must still
        // own admission; do not let an old task fault or write into a new round.
        check_cancel(queued_cancel.as_ref())?;
        ensure!(!stop.load(Ordering::Acquire), "ESP32 link is not open.");
        {
          let state = inner.state.lock().unwrap();
          ensure!(
            state
              .pending
              .get(&id)
              .is_some_and(|pending| pending.sequence == sequence && pending.round == round)
              && state.round == round
              && state.connection.as_ref().map(|c| c.epoch) == Some(epoch),
            "Queued HID request was cancelled before write."
          );
        }
        check_cancel(queued_cancel.as_ref())?;
        ensure!(
          Instant::now() < deadline,
          "Queued HID request expired before write."
        );
        // The state lock is released before IO. This is dispatch admission;
        // subsequent cancellation cannot retract bytes already being written.
        Ok(writer.write_all(line.as_bytes()))
      });
      let write = tokio::select! { biased;
        _ = cancelled(cancel) => return Err(HidCancelled.into()),
        result = write => result??,
      };
      if let Err(error) = write {
        fault(&self.inner, connection.epoch, error.to_string());
      }
      drop(_wire);
      if let Some(launched) = launched {
        let _ = launched.send(());
      }
      tokio::select! { biased;
        result = receiver => result.context("ESP32 request channel closed.")?,
        _ = cancelled(cancel) => {
          if let Some(error) = &self.inner.state.lock().unwrap().fault { return Err(anyhow!(error.clone())); }
          Err(HidCancelled.into())
        }
      }
    };
    let result = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), operation)
      .await
      .unwrap_or_else(|_| Err(AckTimeoutError(op).into()));
    reservation.finished = true;
    take_current_pending(&mut self.inner.state.lock().unwrap(), id, sequence);
    result.map(|status| (id, status))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  async fn blocked_writer_case(command: &'static str, invalidate: &'static str) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let stream = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (mut peer, _) = listener.accept().unwrap();
    peer
      .set_read_timeout(Some(Duration::from_millis(180)))
      .unwrap();
    let writer = Arc::new(Mutex::new(Writer::Tcp(stream)));
    let connection = Arc::new(Connection {
      epoch: 1,
      writer: writer.clone(),
      stop: Arc::new(AtomicBool::new(false)),
      heartbeat: Cancel::new(),
    });
    let mut options = BridgeOptions::tcp("127.0.0.1", listener.local_addr().unwrap().port());
    options.timeout = Duration::from_millis(70);
    let bridge = Bridge::new(options).unwrap();
    bridge.inner.state.lock().unwrap().connection = Some(connection);
    // The writer mutex, not the async write gate, is the production race boundary.
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let locked_writer = writer.clone();
    let lock_thread = std::thread::spawn(move || {
      let _guard = locked_writer.lock().unwrap();
      held_tx.send(()).unwrap();
      release_rx.recv().unwrap();
    });
    held_rx.recv().unwrap();
    let cancel = Cancel::new();
    let queued_cancel = cancel.clone();
    let queued = bridge.clone();
    let mut task = Some(tokio::spawn(async move {
      if matches!(command, "COMMIT" | "PASTE") {
        let command = if command == "COMMIT" {
          TextCommand::Commit(1)
        } else {
          TextCommand::Paste(1)
        };
        queued
          .text_exchange(&command, Some(&queued_cancel))
          .await
          .map(|_| ())
      } else {
        let (op, args) = match command {
          "ARM" => (HidOperation::Arm, vec![]),
          "KEY" => (HidOperation::Key, vec![1, 25]),
          "PING" => (HidOperation::Ping, vec![]),
          _ => unreachable!(),
        };
        queued
          .exchange(
            op,
            &args,
            Some(&queued_cancel),
            queued.inner.options.timeout,
            false,
          )
          .await
          .map(|_| ())
      }
    }));
    for _ in 0..100 {
      let has_pending = {
        let state = bridge.inner.state.lock().unwrap();
        !state.text_pending.is_empty() || !state.pending.is_empty()
      };
      if has_pending && bridge.inner.write_gate.try_lock().is_err() {
        break;
      }
      tokio::time::sleep(Duration::from_millis(1)).await;
    }
    {
      let state = bridge.inner.state.lock().unwrap();
      assert_eq!(state.text_pending.len() + state.pending.len(), 1);
    }
    tokio::time::sleep(Duration::from_millis(5)).await;
    let mut completed = None;
    let mut _replacement_text_receiver = None;
    let mut _replacement_hid_receiver = None;
    match invalidate {
      "timeout" => {
        completed = Some(task.take().unwrap().await.unwrap());
      }
      "cancel" => {
        cancel.cancel();
      }
      "round" => {
        bridge.inner.state.lock().unwrap().round += 1;
      }
      "deadline" => {
        // This variant runs on a current-thread runtime: block its timers so
        // pending is still present when the blocking worker gets the writer.
        std::thread::sleep(Duration::from_millis(100));
      }
      "replacement" => {
        let mut state = bridge.inner.state.lock().unwrap();
        if matches!(command, "COMMIT" | "PASTE") {
          take_text_pending(&mut state, 1);
          let (tx, rx) = oneshot::channel();
          _replacement_text_receiver = Some(rx);
          state.text_pending.insert(
            1,
            TextPending {
              tx,
              identity: Arc::new(()),
            },
          );
        } else {
          let sequence = take_pending(&mut state, 1).unwrap().sequence + 1;
          let round = state.round;
          let (tx, rx) = oneshot::channel();
          _replacement_hid_receiver = Some(rx);
          state.pending.insert(
            1,
            Pending {
              tx,
              sequence,
              round,
            },
          );
        }
      }
      "connection-epoch" => {
        bridge.inner.state.lock().unwrap().connection = Some(Arc::new(Connection {
          epoch: 2,
          writer: writer.clone(),
          stop: Arc::new(AtomicBool::new(false)),
          heartbeat: Cancel::new(),
        }));
      }
      _ => unreachable!(),
    }
    release_tx.send(()).unwrap();
    lock_thread.join().unwrap();
    if invalidate == "deadline" {
      std::thread::sleep(Duration::from_millis(30));
      let state = bridge.inner.state.lock().unwrap();
      assert_eq!(state.text_pending.len() + state.pending.len(), 1);
    }
    // A bounded real socket read sees any late first write, including after timeout.
    let bytes = tokio::task::spawn_blocking(move || {
      let mut bytes = [0u8; 256];
      match peer.read(&mut bytes) {
        Ok(n) => bytes[..n].to_vec(),
        Err(e)
          if matches!(
            e.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
          ) =>
        {
          Vec::new()
        }
        Err(e) => panic!("{e}"),
      }
    })
    .await
    .unwrap();
    let result = if let Some(result) = completed {
      result
    } else {
      task.take().unwrap().await.unwrap()
    };
    assert!(result.is_err());
    if invalidate == "replacement" {
      let state = bridge.inner.state.lock().unwrap();
      assert_eq!(
        state.text_pending.len() + state.pending.len(),
        1,
        "old completion removed a newer pending request"
      );
    }
    bridge.disconnect();
    assert!(
      bytes.is_empty(),
      "{command}/{invalidate} sent after invalidation: {}",
      String::from_utf8_lossy(&bytes)
    );
  }

  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn text_writer_wait_cannot_send_commit_or_paste_after_timeout() {
    for command in ["COMMIT", "PASTE"] {
      blocked_writer_case(command, "timeout").await;
    }
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn text_writer_wait_cannot_send_commit_or_paste_after_cancellation() {
    for command in ["COMMIT", "PASTE"] {
      blocked_writer_case(command, "cancel").await;
    }
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn text_writer_wait_cannot_send_commit_or_paste_into_replaced_connection() {
    for command in ["COMMIT", "PASTE"] {
      blocked_writer_case(command, "connection-epoch").await;
    }
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn hid_writer_wait_cannot_send_key_arm_or_ping_after_timeout() {
    for command in ["KEY", "ARM", "PING"] {
      blocked_writer_case(command, "timeout").await;
    }
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn hid_writer_wait_cannot_send_key_arm_or_ping_after_cancellation() {
    for command in ["KEY", "ARM", "PING"] {
      blocked_writer_case(command, "cancel").await;
    }
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn hid_writer_wait_cannot_send_key_arm_or_ping_into_replaced_connection_or_round() {
    for invalidation in ["connection-epoch", "round"] {
      for command in ["KEY", "ARM", "PING"] {
        blocked_writer_case(command, invalidation).await;
      }
    }
  }
  #[tokio::test]
  async fn writer_wait_checks_absolute_deadline_even_before_async_timeout_retires_pending() {
    for command in ["COMMIT", "PASTE", "KEY", "ARM", "PING"] {
      blocked_writer_case(command, "deadline").await;
    }
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn text_writer_wait_cannot_use_or_remove_a_reused_pending_id() {
    for command in ["COMMIT", "PASTE"] {
      blocked_writer_case(command, "replacement").await;
    }
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn hid_writer_wait_cannot_use_or_remove_a_reused_pending_id() {
    for command in ["KEY", "ARM", "PING"] {
      blocked_writer_case(command, "replacement").await;
    }
  }

  #[tokio::test]
  async fn refused_connection_identifies_esp_endpoint_and_retains_os_reason() {
    let reserved = socket2::Socket::new(
      socket2::Domain::IPV4,
      socket2::Type::STREAM,
      Some(socket2::Protocol::TCP),
    )
    .unwrap();
    reserved
      .bind(
        &"127.0.0.1:0"
          .parse::<std::net::SocketAddr>()
          .unwrap()
          .into(),
      )
      .unwrap();
    // Bound but deliberately not listening: reserve the port without racing
    // another test or opening a fake board capable of accepting input.
    let address = reserved.local_addr().unwrap().as_socket().unwrap();
    let bridge = Bridge::new(BridgeOptions::tcp("127.0.0.1", address.port())).unwrap();
    let error = tokio::time::timeout(
      Duration::from_secs(4),
      bridge.request(HidOperation::Status, &[], None),
    )
    .await
    .expect("A refused loopback connection must remain bounded")
    .unwrap_err();
    let original = error.downcast_ref::<std::io::Error>().unwrap();
    assert_eq!(original.kind(), std::io::ErrorKind::ConnectionRefused);
    let message = error.to_string();
    assert!(message.contains("ESP_CONNECTION_ERROR"), "{message}");
    assert!(message.contains("设备控制器"), "{message}");
    assert!(message.contains(&address.to_string()), "{message}");
    assert!(message.contains(&original.to_string()), "{message}");
    assert!(!message.contains("SCREEN_CONNECTION_ERROR"));
    let state = bridge.inner.state.lock().unwrap();
    assert!(state.connection.is_none());
    assert!(!state.control_attempted);
    assert!(state.pending.is_empty());
    assert!(state.heartbeats.is_empty());
  }

  #[tokio::test]
  async fn connection_context_does_not_echo_invalid_raw_host_credentials_or_query() {
    for host in [
      "http://user:fixture-secret@127.0.0.1",
      "127.0.0.1?token=fixture-secret",
    ] {
      let bridge = Bridge::new(BridgeOptions::tcp(host, 3333)).unwrap();
      let message = bridge
        .request(HidOperation::Status, &[], None)
        .await
        .unwrap_err()
        .to_string();
      assert!(message.contains("ESP_CONNECTION_ERROR"), "{message}");
      assert!(!message.contains("fixture-secret"), "{message}");
      assert!(!message.contains(host), "{message}");
      assert!(bridge.inner.state.lock().unwrap().connection.is_none());
    }
  }

  fn text_mock(
    mode: &'static str,
    cancel: Cancel,
  ) -> (Bridge, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    use std::io::{BufRead, BufReader};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut options = BridgeOptions::tcp("127.0.0.1", listener.local_addr().unwrap().port());
    options.timeout = Duration::from_millis(120);
    options.heartbeat = Duration::from_millis(30);
    let records = Arc::new(Mutex::new(Vec::new()));
    let observed = records.clone();
    let server = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let mut armed = false;
      let mut transfer = "0000000000000000".to_owned();
      let mut total = 0usize;
      let mut received = 0usize;
      let mut phase = "idle";
      let mut polls = 0usize;
      loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
          break;
        }
        observed.lock().unwrap().push(line.trim().into());
        let p: Vec<_> = line.split_whitespace().collect();
        let reply = if p[0] == "QDDHID/1" {
          match p[2] {
            "ARM" => armed = true,
            "PAUSE" => armed = false,
            _ => {}
          }
          format!(
            "QDDHID/1 {} OK {}\n",
            p[1],
            serde_json::json!({"v":1,"connected":true,"encrypted":true,
            "armed":armed,"locked":false,"bonded":true,"name":"text-mock"})
          )
        } else {
          assert_eq!(p[0], "QDDTXT/1");
          if mode == "legacy" {
            continue;
          }
          match p[2] {
            "BEGIN" | "CLIP_BEGIN" => {
              transfer = p[3].into();
              total = p[5].parse().unwrap();
              received = 0;
              phase = "receiving";
            }
            "DATA" => {
              assert_eq!(p[3], transfer);
              assert_eq!(p[4].parse::<usize>().unwrap(), received);
              received += p[5].len() / 2;
              if mode == "cancel-before-commit" {
                cancel.cancel();
              }
            }
            "COMMIT" => {
              phase = "queued";
              if mode == "lost-commit" {
                continue;
              }
              if mode == "late-commit" {
                std::thread::sleep(Duration::from_millis(180));
                phase = "accepted";
              }
            }
            "PASTE" => phase = "paste_sent",
            "CANCEL" => phase = "cancelled",
            "STATUS" if phase == "queued" || phase == "awaiting_ack" => {
              polls += 1;
              if polls == 1 {
                phase = "awaiting_ack";
                std::thread::sleep(Duration::from_millis(75));
              } else {
                phase = match mode {
                  "rejected" => "rejected",
                  "uncertain" => "uncertain",
                  "cancelled" => "cancelled",
                  "clipboard-state" => "clipboard_dispatched",
                  "clipboard-verified" => "clipboard_verified",
                  "paste-state" => "paste_sent",
                  _ => "accepted",
                };
              }
              if mode == "cancel-after-commit" {
                cancel.cancel();
              }
            }
            _ => {}
          }
          if mode == "reject-data" && p[2] == "DATA" {
            format!("QDDTXT/1 {} ERR BAD_OFFSET\n", p[1])
          } else {
            if !matches!(
              phase,
              "idle" | "receiving" | "queued" | "sending" | "awaiting_ack"
            ) {
              total = 0;
              received = 0;
            }
            let epoch = if mode == "ime-unready-epoch-zero" {
              0
            } else if mode == "focus-changed" && p[2] == "STATUS" && polls > 0 {
              8
            } else {
              7
            };
            let reply_id = if mode == "id-changed" && polls > 0 {
              "ffffffffffffffff"
            } else {
              &transfer
            };
            let mut status = serde_json::json!({"id":reply_id,"status":phase,"editorEpoch":epoch,
              "ready":!matches!(mode, "ime-unready" | "ime-unready-epoch-zero"),"received":received,"bytes":total});
            if mode != "legacy-ime" {
              status["mode"] = serde_json::json!(if mode == "clipboard"
                || (mode == "mode-changed" && polls > 0)
              {
                "clipboard"
              } else {
                "ime"
              });
              status["clipboardVerified"] =
                serde_json::json!(mode == "clipboard-verified" && phase == "clipboard_verified");
              status["pasteSent"] = serde_json::json!(phase == "paste_sent");
              status["insertionVerified"] = serde_json::json!(false);
            }
            format!("QDDTXT/1 {} OK {}\n", p[1], status)
          }
        };
        if stream.write_all(reply.as_bytes()).is_err() {
          return;
        }
        // A duplicate transport reply must not become permission to resubmit COMMIT.
        if mode == "duplicate-commit-ack"
          && p[0] == "QDDTXT/1"
          && p[2] == "COMMIT"
          && stream.write_all(reply.as_bytes()).is_err()
        {
          return;
        }
      }
    });
    (Bridge::new(options).unwrap(), records, server)
  }

  #[tokio::test]
  async fn unicode_ime_acceptance_sends_one_commit_without_clipboard_or_hid_fallback() {
    for mode in ["ime", "legacy-ime", "duplicate-commit-ack"] {
      let cancel = Cancel::new();
      let (bridge, records, server) = text_mock(mode, cancel.clone());
      bridge.request(HidOperation::Arm, &[], None).await.unwrap();
      let result = bridge
        .unicode_text("中文🙂".repeat(12).as_str(), Some(&cancel))
        .await;
      let log = records.lock().unwrap().clone();
      bridge.close().await.unwrap();
      server.join().unwrap();
      let status = serde_json::to_value(result.unwrap()).unwrap();
      assert_eq!(status["mode"], "ime");
      assert_eq!(status["status"], "accepted");
      assert_eq!(status["clipboardVerified"], false);
      assert_eq!(status["pasteSent"], false);
      assert_eq!(status["insertionVerified"], false);
      assert_eq!(log.iter().filter(|l| l.contains(" BEGIN ")).count(), 1);
      assert_eq!(log.iter().filter(|l| l.contains(" COMMIT ")).count(), 1);
      assert_eq!(log.iter().filter(|l| l.contains(" DATA ")).count(), 5);
      assert!(log.iter().all(|l| l.len() < 128
        && !l.contains(" CLIP_BEGIN ")
        && !l.contains(" PASTE ")
        && !l.contains(" KEY ")));
      assert!(log.iter().filter(|l| l.ends_with(" PING")).count() > 3);
    }
  }

  #[tokio::test]
  async fn unicode_ime_preflight_explains_setup_and_rejects_clipboard_before_upload() {
    for mode in [
      "ime-unready",
      "ime-unready-epoch-zero",
      "clipboard",
      "legacy",
    ] {
      let cancel = Cancel::new();
      let (bridge, records, server) = text_mock(mode, cancel.clone());
      bridge.request(HidOperation::Arm, &[], None).await.unwrap();
      let result = bridge.unicode_text("中文", Some(&cancel)).await;
      let log = records.lock().unwrap().clone();
      bridge.close().await.unwrap();
      server.join().unwrap();
      let error = result.expect_err(mode).to_string();
      if matches!(mode, "ime-unready" | "ime-unready-epoch-zero") {
        assert!(error.contains("TEXT_IME_NOT_READY"), "{error}");
        assert!(
          error.contains("enable and select") && error.contains("focus"),
          "{error}"
        );
      } else if mode == "clipboard" {
        assert!(
          error.contains("TEXT_IME_UNAVAILABLE") && error.contains("APK"),
          "{error}"
        );
      }
      assert!(!error.contains("keep screen sharing active"), "{error}");
      assert!(
        log.iter().all(|l| !l.contains(" BEGIN ")
          && !l.contains(" CLIP_BEGIN ")
          && !l.contains(" DATA ")
          && !l.contains(" COMMIT ")
          && !l.contains(" PASTE ")
          && !l.contains(" KEY ")),
        "{mode}: {log:?}"
      );
    }
  }

  #[tokio::test]
  async fn unicode_ime_failures_cancel_and_late_ack_never_resubmit_or_paste() {
    for mode in [
      "lost-commit",
      "late-commit",
      "cancel-before-commit",
      "cancel-after-commit",
      "focus-changed",
      "id-changed",
      "mode-changed",
      "rejected",
      "reject-data",
      "uncertain",
      "cancelled",
      "clipboard-state",
      "clipboard-verified",
      "paste-state",
    ] {
      let cancel = Cancel::new();
      let (bridge, records, server) = text_mock(mode, cancel.clone());
      bridge.request(HidOperation::Arm, &[], None).await.unwrap();
      let result = bridge.unicode_text("中文", Some(&cancel)).await;
      let log = records.lock().unwrap().clone();
      bridge.close().await.unwrap();
      server.join().unwrap();
      let error = result.expect_err(mode);
      let transfer_error = error
        .downcast_ref::<crate::text::TextTransferError>()
        .expect(mode);
      assert_eq!(
        transfer_error.uncertain,
        !["rejected", "reject-data", "cancel-before-commit"].contains(&mode),
        "{mode}: {error}"
      );
      if mode == "rejected" {
        assert!(error.to_string().contains("TEXT_IME_REJECTED"));
      }
      assert!(
        log.iter().filter(|l| l.contains(" COMMIT ")).count() <= 1,
        "{mode}: {log:?}"
      );
      assert!(
        log.iter().all(|l| !l.contains(" CLIP_BEGIN ")
          && !l.contains(" PASTE ")
          && !l.contains(" KEY ")
          && !l.contains(" MOVE ")),
        "{mode}: {log:?}"
      );
      if ["reject-data", "cancel-before-commit"].contains(&mode) {
        assert!(
          log.iter().all(|l| !l.contains(" COMMIT ")),
          "{mode}: {log:?}"
        );
        assert_eq!(log.iter().filter(|l| l.contains(" CANCEL ")).count(), 1);
      }
    }
  }
  use std::io::{BufRead, BufReader};
  fn mock(connections: usize) -> (Bridge, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut options = BridgeOptions::tcp("127.0.0.1", listener.local_addr().unwrap().port());
    options.timeout = Duration::from_millis(120);
    options.observation_timeout = Duration::from_millis(300);
    options.heartbeat = Duration::from_millis(30);
    let records = Arc::new(Mutex::new(Vec::new()));
    let observed = records.clone();
    let handle = std::thread::spawn(move || {
      // Observation upgrades create a distinct connection.
      for stream in listener.incoming().take(connections) {
        let mut stream = stream.unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut armed = false;
        loop {
          let mut line = String::new();
          if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
          }
          let parts: Vec<_> = line.split_whitespace().collect();
          observed.lock().unwrap().push(parts[2].into());
          match parts[2] {
            "ARM" => armed = true,
            "PAUSE" => armed = false,
            _ => {}
          }
          let status = serde_json::json!({"v":1,"connected":true,"encrypted":true,"armed":armed,"locked":false,"bonded":true,"name":"mock"});
          if writeln!(stream, "QDDHID/1 {} OK {}", parts[1], status).is_err() {
            break;
          }
        }
      }
    });
    (Bridge::new(options).unwrap(), records, handle)
  }
  #[tokio::test]
  async fn observation_never_claims_control_and_upgrade_starts_paused() {
    let (bridge, records, handle) = mock(2);
    bridge
      .request(HidOperation::Status, &[], None)
      .await
      .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(&*records.lock().unwrap(), &["STATUS"]);
    bridge.request(HidOperation::Arm, &[], None).await.unwrap();
    assert_eq!(
      &records.lock().unwrap()[..6],
      &["STATUS", "PING", "RELEASE", "PAUSE", "PING", "ARM"]
    );
    assert!(bridge.control_status().unwrap().armed);
    bridge.close().await.unwrap();
    handle.join().unwrap();
  }
  #[tokio::test]
  async fn observer_close_never_releases() {
    let (bridge, records, handle) = mock(1);
    bridge
      .request(HidOperation::Status, &[], None)
      .await
      .unwrap();
    bridge.close().await.unwrap();
    assert_eq!(&*records.lock().unwrap(), &["STATUS"]);
    handle.join().unwrap();
  }

  fn controlled_mock(
    mode: &'static str,
  ) -> (Bridge, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let mut options = BridgeOptions::tcp("127.0.0.1", listener.local_addr().unwrap().port());
    options.timeout = Duration::from_millis(160);
    options.heartbeat = Duration::from_millis(30);
    let records = Arc::new(Mutex::new(Vec::new()));
    let observed = records.clone();
    let server = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let mut armed = false;
      let mut held = Vec::new();
      let mut pings = 0;
      loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
          break;
        }
        observed.lock().unwrap().push(line.trim().to_owned());
        let parts: Vec<_> = line.split_whitespace().collect();
        match parts[2] {
          "ARM" => armed = true,
          "PAUSE" => armed = false,
          // Fault injection belongs to the armed round, never a cold handshake.
          "PING" if armed => pings += 1,
          _ => {}
        }
        let status = serde_json::json!({"v":1,"connected":true,"encrypted":true,"armed":armed,"locked":false,"bonded":true,"name":format!("mock-{}",parts.get(3).unwrap_or(&"0"))});
        let reply = format!("QDDHID/1 {} OK {}\n", parts[1], status);
        if mode == "lost-move" && parts[2] == "MOVE" {
          continue;
        }
        if mode == "lost-heartbeat" && parts[2] == "PING" && armed && pings == 3 {
          continue;
        }
        if mode == "all-heartbeats" && parts[2] == "PING" && armed {
          continue;
        }
        if mode == "reverse" && parts[2] == "MOVE" {
          held.push(reply);
          if held.len() < 4 {
            continue;
          }
          for reply in held.drain(..).rev() {
            if stream.write_all(reply.as_bytes()).is_err() {
              return;
            }
          }
        } else if mode == "unknown" && parts[2] == "MOVE" {
          let _ = stream.write_all(b"QDDHID/1 999999 OK {\"v\":1,\"connected\":true,\"encrypted\":true,\"armed\":true,\"locked\":false,\"bonded\":true,\"name\":\"mock\"}\n");
        } else if stream.write_all(reply.as_bytes()).is_err() {
          return;
        }
      }
    });
    (Bridge::new(options).unwrap(), records, server)
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn synchronous_reservation_orders_four_reports_with_reversed_waiters_and_acks() {
    let (bridge, records, server) = controlled_mock("reverse");
    bridge.request(HidOperation::Arm, &[], None).await.unwrap();
    let futures: Vec<_> = (1..=4)
      .map(|dx| {
        bridge
          .submit_realtime(HidOperation::Move, vec![dx, 0, 0, 0], Cancel::new())
          .unwrap()
      })
      .collect();
    assert!(bridge
      .submit_realtime(HidOperation::Key, vec![0, 4], Cancel::new())
      .is_err());
    let tasks: Vec<_> = futures.into_iter().rev().map(tokio::spawn).collect();
    for task in tasks {
      task.await.unwrap().unwrap();
    }
    assert_eq!(bridge.control_status().unwrap().name, "mock-4");
    let moves: Vec<_> = records
      .lock()
      .unwrap()
      .iter()
      .filter(|v| v.contains(" MOVE "))
      .map(|s| s.split_whitespace().nth(3).unwrap().to_owned())
      .collect();
    assert_eq!(moves, ["1", "2", "3", "4"]);
    bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn lost_report_ack_and_unknown_ack_fail_closed_without_retry() {
    for mode in ["lost-move", "unknown"] {
      let (bridge, records, server) = controlled_mock(mode);
      bridge.request(HidOperation::Arm, &[], None).await.unwrap();
      assert!(bridge
        .request_realtime(HidOperation::Move, &[1, 0, 0, 1], None)
        .await
        .is_err());
      assert!(bridge.control_status().is_none());
      assert!(bridge
        .request_realtime(HidOperation::Key, &[0, 4], None)
        .await
        .is_err());
      let snapshot = records.lock().unwrap().clone();
      assert_eq!(snapshot.iter().filter(|v| v.contains(" MOVE ")).count(), 1);
      assert!(snapshot.iter().rev().take(2).any(|v| v.ends_with(" PAUSE")));
      bridge.close().await.unwrap();
      server.join().unwrap();
    }
  }
  #[tokio::test]
  async fn newer_neutral_ack_supersedes_only_a_lost_heartbeat() {
    let (bridge, records, server) = controlled_mock("lost-heartbeat");
    bridge.request(HidOperation::Arm, &[], None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(230)).await;
    assert!(bridge.control_status().unwrap().armed);
    bridge
      .request_realtime(HidOperation::Key, &[0, 4], None)
      .await
      .unwrap();
    assert_eq!(
      records
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v.ends_with(" PAUSE"))
        .count(),
      1
    );
    bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn losing_every_current_round_heartbeat_releases_and_pauses() {
    let (bridge, records, server) = controlled_mock("all-heartbeats");
    bridge.request(HidOperation::Arm, &[], None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(280)).await;
    assert!(bridge.control_status().is_none());
    assert!(
      records
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v.ends_with(" PAUSE"))
        .count()
        >= 2
    );
    bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
  async fn abandoning_an_inflight_report_retires_pending_id_and_releases() {
    let (bridge, records, server) = controlled_mock("lost-move");
    bridge.request(HidOperation::Arm, &[], None).await.unwrap();
    let future = bridge
      .submit_realtime(HidOperation::Move, vec![1, 0, 0, 1], Cancel::new())
      .unwrap();
    let task = tokio::spawn(future);
    for _ in 0..100 {
      if records.lock().unwrap().iter().any(|v| v.contains(" MOVE ")) {
        break;
      }
      tokio::time::sleep(Duration::from_millis(2)).await;
    }
    task.abort();
    let _ = task.await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(bridge.control_status().is_none());
    assert!(bridge.inner.state.lock().unwrap().pending.is_empty());
    assert_eq!(bridge.inner.state.lock().unwrap().realtime_inflight, 0);
    assert!(
      records
        .lock()
        .unwrap()
        .iter()
        .filter(|v| v.ends_with(" PAUSE"))
        .count()
        >= 2
    );
    bridge.close().await.unwrap();
    server.join().unwrap();
  }
  #[tokio::test]
  async fn dropping_last_bridge_handle_closes_the_socket_and_stops_reader() {
    let (bridge, _records, server) = controlled_mock("normal");
    bridge.request(HidOperation::Arm, &[], None).await.unwrap();
    let inner = Arc::downgrade(&bridge.inner);
    drop(bridge);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(inner.upgrade().is_none());
    server.join().unwrap();
  }
}
