use crate::{
  screen::{
    check_cancel, ScreenCapture, ScreenClient, MAX_SCREEN_FRAME_AGE_MS, MAX_SCREEN_FRAME_BYTES,
  },
  Cancel, Result,
};
use anyhow::{anyhow, bail, ensure};
use serde_json::Value;
use std::{
  collections::BTreeMap,
  io::Read,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
  },
  thread::{self, JoinHandle},
  time::{Duration, Instant},
};

#[derive(Clone)]
pub struct LiveScreenSource {
  inner: Arc<Inner>,
}
struct Inner {
  phone: Arc<ScreenClient>,
  state: Mutex<State>,
  changed: Condvar,
  stopped: Cancel,
  started: AtomicBool,
  task: Mutex<Option<JoinHandle<()>>>,
}
#[derive(Default)]
struct State {
  latest: Option<ScreenCapture>,
  error: Option<String>,
  version: u64,
}

impl LiveScreenSource {
  pub fn new(phone: Arc<ScreenClient>) -> Self {
    Self {
      inner: Arc::new(Inner {
        phone,
        state: Mutex::new(State::default()),
        changed: Condvar::new(),
        stopped: Cancel::new(),
        started: AtomicBool::new(false),
        task: Mutex::new(None),
      }),
    }
  }
  pub fn list_devices(&self) -> Result<Value> {
    self.inner.phone.list_devices()
  }
  pub fn get_preview_profile(&self) -> Result<Value> {
    self.inner.phone.get_preview_profile()
  }
  pub fn set_preview_profile(&self, profile: &str) -> Result<Value> {
    self.inner.phone.set_preview_profile(profile)
  }
  pub fn capture(&self, serial: Option<&str>, cancel: &Cancel) -> Result<ScreenCapture> {
    check_cancel(cancel)?;
    self.start()?;
    self.inner.phone.capture(serial, cancel)
  }
  pub fn preview(&self, serial: Option<&str>, cancel: &Cancel) -> Result<ScreenCapture> {
    check_cancel(cancel)?;
    self.start()?;
    if let Some(frame) = self.latest() {
      check_serial(&frame, serial)?;
      return Ok(frame);
    }
    let mut subscriber = self.subscribe()?;
    let frame = subscriber.next(cancel, Duration::from_secs(10))?;
    check_serial(&frame, serial)?;
    Ok(frame)
  }
  pub fn latest(&self) -> Option<ScreenCapture> {
    if self.inner.stopped.is_cancelled() {
      return None;
    }
    self
      .inner
      .state
      .lock()
      .ok()?
      .latest
      .as_ref()
      .filter(|f| f.age_ms() <= MAX_SCREEN_FRAME_AGE_MS)
      .cloned()
  }
  pub fn subscribe(&self) -> Result<FrameSubscription> {
    self.start()?;
    Ok(FrameSubscription {
      inner: self.inner.clone(),
      seen_version: 0,
    })
  }
  pub fn close(&self) {
    self.inner.stopped.cancel();
    self.inner.phone.close();
    if let Ok(mut state) = self.inner.state.lock() {
      state.latest = None;
      state.error = Some("手机画面连接已关闭。".into());
      state.version = state.version.wrapping_add(1);
    }
    self.inner.changed.notify_all();
    if let Ok(mut task) = self.inner.task.lock() {
      if let Some(task) = task.take() {
        let _ = task.join();
      }
    }
  }
  fn start(&self) -> Result<()> {
    let mut task_slot = self
      .inner
      .task
      .lock()
      .map_err(|_| anyhow!("Preview thread lock poisoned"))?;
    ensure!(!self.inner.stopped.is_cancelled(), "手机画面连接已关闭。");
    if self
      .inner
      .started
      .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
      .is_ok()
    {
      let inner = self.inner.clone();
      let task = thread::Builder::new()
        .name("phone-preview".into())
        .spawn(move || run(inner));
      match task {
        Ok(task) => *task_slot = Some(task),
        Err(error) => {
          self.inner.started.store(false, Ordering::Release);
          return Err(error.into());
        }
      }
    }
    Ok(())
  }
}

pub struct FrameSubscription {
  inner: Arc<Inner>,
  seen_version: u64,
}
impl FrameSubscription {
  pub fn next(&mut self, cancel: &Cancel, timeout: Duration) -> Result<ScreenCapture> {
    let started = Instant::now();
    let mut state = self
      .inner
      .state
      .lock()
      .map_err(|_| anyhow!("Preview state lock poisoned"))?;
    loop {
      check_cancel(cancel)?;
      ensure!(!self.inner.stopped.is_cancelled(), "手机画面连接已关闭。");
      if state.version != self.seen_version {
        self.seen_version = state.version;
        if let Some(frame) = state
          .latest
          .as_ref()
          .filter(|f| f.age_ms() <= MAX_SCREEN_FRAME_AGE_MS)
        {
          return Ok(frame.clone());
        }
        if let Some(error) = &state.error {
          bail!("{error}");
        }
      }
      ensure!(
        started.elapsed() < timeout,
        "SCREEN_TIMEOUT: 还没有收到手机画面，请在手机上开始投屏。"
      );
      let wait = (timeout - started.elapsed().min(timeout)).min(Duration::from_millis(50));
      state = self
        .inner
        .changed
        .wait_timeout(state, wait)
        .map_err(|_| anyhow!("Preview state lock poisoned"))?
        .0;
    }
  }
}

fn check_serial(frame: &ScreenCapture, serial: Option<&str>) -> Result<()> {
  ensure!(
    serial.is_none_or(|id| frame.serial.eq_ignore_ascii_case(id)),
    "SCREEN_DEVICE_MISMATCH: 连接的是另一台手机。"
  );
  Ok(())
}

fn run(inner: Arc<Inner>) {
  while !inner.stopped.is_cancelled() {
    let cancel = inner.stopped.child_token();
    let finished = Cancel::new();
    let deadline = Arc::new(Mutex::new(Instant::now() + Duration::from_secs(10)));
    let (guard_cancel, guard_finished, guard_deadline) =
      (cancel.clone(), finished.clone(), deadline.clone());
    let watcher = thread::spawn(move || {
      while !guard_finished.is_cancelled() {
        if guard_deadline
          .lock()
          .map(|deadline| Instant::now() >= *deadline)
          .unwrap_or(true)
        {
          guard_cancel.cancel();
          break;
        }
        thread::sleep(Duration::from_millis(10));
      }
    });
    let result = receive_stream(&inner, &cancel, &deadline);
    finished.cancel();
    cancel.cancel();
    let _ = watcher.join();
    if inner.stopped.is_cancelled() {
      break;
    }
    let message = result
      .err()
      .map(|e| e.to_string())
      .unwrap_or_else(|| "SCREEN_UNREACHABLE: 手机已停止传送画面。".into());
    if let Ok(mut state) = inner.state.lock() {
      let first_loss = state.error.is_none();
      state.latest = None;
      state.error = Some(message);
      if first_loss {
        state.version = state.version.wrapping_add(1);
      }
    }
    inner.changed.notify_all();
    let started = Instant::now();
    while !inner.stopped.is_cancelled() && started.elapsed() < Duration::from_secs(1) {
      thread::sleep(Duration::from_millis(10));
    }
  }
}

fn receive_stream(inner: &Inner, cancel: &Cancel, deadline: &Mutex<Instant>) -> Result<()> {
  let mut response = inner.phone.open_stream(cancel)?;
  let mut parser = MultipartFrameParser::new(MAX_SCREEN_FRAME_BYTES);
  let mut previous = None;
  let mut chunk = [0u8; 16 * 1024];
  loop {
    check_cancel(cancel)?;
    let count = match response.body.read(&mut chunk) {
      Ok(count) => count,
      Err(error)
        if matches!(
          error.kind(),
          std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) =>
      {
        continue
      }
      Err(error) => return Err(error.into()),
    };
    ensure!(count > 0, "SCREEN_UNREACHABLE: 手机已停止传送画面。");
    for part in parser.push(&chunk[..count])? {
      check_cancel(cancel)?;
      let frame =
        inner
          .phone
          .frame_from_parts(&part.headers, part.bytes, part.received_at, None)?;
      ensure!(
        previous.as_deref() != Some(frame.source_frame_id.as_str()),
        "SCREEN_INVALID_FRAME: 手机重复发送旧画面。"
      );
      previous = Some(frame.source_frame_id.clone());
      let remaining = MAX_SCREEN_FRAME_AGE_MS
        .saturating_sub(frame.age_ms())
        .max(1);
      *deadline
        .lock()
        .map_err(|_| anyhow!("Preview deadline lock poisoned"))? =
        Instant::now() + Duration::from_millis(remaining);
      let mut state = inner
        .state
        .lock()
        .map_err(|_| anyhow!("Preview state lock poisoned"))?;
      state.latest = Some(frame);
      state.error = None;
      state.version = state.version.wrapping_add(1);
      drop(state);
      inner.changed.notify_all();
    }
  }
}

pub struct MultipartPart {
  pub headers: BTreeMap<String, String>,
  pub bytes: Vec<u8>,
  pub received_at: Instant,
}
pub struct MultipartFrameParser {
  buffer: Vec<u8>,
  headers: Option<BTreeMap<String, String>>,
  length: usize,
  received_at: Instant,
  max_bytes: usize,
}
impl MultipartFrameParser {
  pub fn new(max_bytes: usize) -> Self {
    Self {
      buffer: vec![],
      headers: None,
      length: 0,
      received_at: Instant::now(),
      max_bytes,
    }
  }
  pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<MultipartPart>> {
    ensure!(
      self
        .buffer
        .len()
        .checked_add(chunk.len())
        .is_some_and(|size| size <= self.max_bytes.saturating_add(16_384)),
      "SCREEN_TOO_LARGE: 手机视频帧超过大小限制。"
    );
    self.buffer.extend_from_slice(chunk);
    let mut frames = vec![];
    loop {
      if self.headers.is_none() {
        let end = self.buffer.windows(4).position(|w| w == b"\r\n\r\n");
        let Some(end) = end else {
          ensure!(
            self.buffer.len() <= 8192,
            "SCREEN_INVALID_FRAME: 手机视频帧头过长。"
          );
          break;
        };
        ensure!(end <= 8192, "SCREEN_INVALID_FRAME: 手机视频帧头过长。");
        let header_text = std::str::from_utf8(&self.buffer[..end])
          .map_err(|_| anyhow!("SCREEN_INVALID_FRAME: 非法帧头。"))?;
        let mut lines = header_text.split("\r\n");
        ensure!(
          lines.next() == Some("--qdd-frame"),
          "SCREEN_INVALID_FRAME: 手机视频流边界无效。"
        );
        let mut headers = BTreeMap::new();
        for line in lines {
          let (name, value) = line
            .split_once(':')
            .ok_or_else(|| anyhow!("SCREEN_INVALID_FRAME: 手机视频帧头无效。"))?;
          ensure!(
            !name.is_empty()
              && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
              && value.bytes().all(|b| b == b'\t' || (32..=126).contains(&b)),
            "SCREEN_INVALID_FRAME: 手机视频帧头无效。"
          );
          ensure!(
            headers
              .insert(name.to_ascii_lowercase(), value.trim().into())
              .is_none(),
            "SCREEN_INVALID_FRAME: 手机视频帧头重复。"
          );
        }
        let length = headers
          .get("content-length")
          .map(String::as_str)
          .unwrap_or_default();
        ensure!(
          !length.is_empty()
            && !length.starts_with('0')
            && length.bytes().all(|b| b.is_ascii_digit()),
          "SCREEN_INVALID_FRAME: 手机视频帧长度无效。"
        );
        self.length = length
          .parse()
          .context("SCREEN_INVALID_FRAME: 手机视频帧长度溢出。")?;
        ensure!(
          self.length > 0 && self.length <= self.max_bytes,
          "SCREEN_INVALID_FRAME: 手机视频帧长度超过限制。"
        );
        self.headers = Some(headers);
        self.received_at = Instant::now();
        self.buffer.drain(..end + 4);
      }
      if self.buffer.len() < self.length + 2 {
        break;
      }
      ensure!(
        &self.buffer[self.length..self.length + 2] == b"\r\n",
        "SCREEN_INVALID_FRAME: 手机视频帧没有完整结束。"
      );
      frames.push(MultipartPart {
        headers: self.headers.take().unwrap(),
        bytes: self.buffer[..self.length].to_vec(),
        received_at: self.received_at,
      });
      self.buffer.drain(..self.length + 2);
    }
    Ok(frames)
  }
}

use anyhow::Context;

#[cfg(test)]
mod tests {
  use super::*;
  fn part(bytes: &[u8]) -> Vec<u8> {
    let mut part = format!(
      "--qdd-frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nX-Frame-Id: unique\r\n\r\n",
      bytes.len()
    )
    .into_bytes();
    part.extend_from_slice(bytes);
    part.extend_from_slice(b"\r\n");
    part
  }
  #[test]
  fn multipart_uses_length_even_when_payload_contains_boundary() {
    let body = b"real\r\n--qdd-frame\r\nbytes";
    let encoded = part(body);
    let mut parser = MultipartFrameParser::new(1024);
    let mut frames = vec![];
    for byte in encoded {
      frames.extend(parser.push(&[byte]).unwrap());
    }
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].bytes, body);
    assert_eq!(frames[0].headers["x-frame-id"], "unique");
  }
  #[test]
  fn multipart_rejects_ambiguous_headers_limits_and_missing_ending() {
    for input in [
      b"--qdd-frame\r\nContent-Length: 1\r\ncontent-length: 1\r\n\r\nx\r\n".as_slice(),
      b"--wrong\r\nContent-Length: 1\r\n\r\nx\r\n",
      b"--qdd-frame\r\nContent-Length: 1025\r\n\r\n",
      b"--qdd-frame\r\nContent-Length: 1\r\n\r\nx!!",
    ] {
      assert!(MultipartFrameParser::new(1024).push(input).is_err());
    }
    assert!(MultipartFrameParser::new(1024)
      .push(&vec![b'x'; 8193])
      .is_err());
  }
  #[test]
  fn cancelled_subscriber_returns_without_waiting_for_source() {
    let phone = Arc::new(ScreenClient::new("http://127.0.0.1:1".into(), None).unwrap());
    let source = LiveScreenSource::new(phone);
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(source.preview(None, &cancel).is_err());
    source.close();
    assert!(source.latest().is_none());
  }
}
