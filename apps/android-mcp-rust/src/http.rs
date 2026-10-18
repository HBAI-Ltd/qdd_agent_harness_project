//! Small HTTP/1 listener for MCP, the browser operator, and the persistent HID lane.
//! Each connection has an independent thread; slow picture readers cannot occupy
//! the request pool used for lease pings or cancellation.
use crate::mcp::{self, Mcp};
use crate::{Cancel, Result};
use anyhow::{anyhow, bail, ensure};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::{
  atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
  mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::{protocol::Role, Message};

pub struct Request {
  pub method: String,
  pub target: String,
  pub headers: BTreeMap<String, String>,
  pub body: Vec<u8>,
  pub peer: SocketAddr,
}
impl Request {
  pub fn header(&self, name: &str) -> Option<&str> {
    self
      .headers
      .get(&name.to_ascii_lowercase())
      .map(String::as_str)
  }
}

pub struct Response {
  pub status: u16,
  pub headers: BTreeMap<String, String>,
  pub body: Vec<u8>,
}
impl Response {
  pub fn json(status: u16, value: Value) -> Self {
    Self {
      status,
      headers: BTreeMap::from([
        ("Content-Type".into(), "application/json".into()),
        ("Cache-Control".into(), "no-store".into()),
      ]),
      body: value.to_string().into_bytes(),
    }
  }
  pub fn text(status: u16, mime: &str, text: impl Into<Vec<u8>>) -> Self {
    Self {
      status,
      headers: BTreeMap::from([
        ("Content-Type".into(), mime.into()),
        ("Cache-Control".into(), "no-store".into()),
      ]),
      body: text.into(),
    }
  }
}
pub type Hook = Arc<dyn Fn(&Request) -> Option<Response> + Send + Sync>;
pub struct HttpOptions {
  pub port: u16,
  pub shutdown: Cancel,
  pub hook: Option<Hook>,
}
impl Default for HttpOptions {
  fn default() -> Self {
    Self {
      port: 8790,
      shutdown: Cancel::new(),
      hook: None,
    }
  }
}

struct Remote {
  owner: Option<String>,
  generation: u64,
  input_epoch: u64,
  expires: Option<Instant>,
  next_sequence: u64,
  pending: HashSet<u64>,
  gap_since: Option<Instant>,
  sockets: HashSet<String>,
  cancel: Cancel,
}
impl Default for Remote {
  fn default() -> Self {
    Self {
      owner: None,
      generation: 0,
      input_epoch: 0,
      expires: None,
      next_sequence: 1,
      pending: HashSet::new(),
      gap_since: None,
      sockets: HashSet::new(),
      cancel: Cancel::new(),
    }
  }
}
impl Remote {
  fn clear(&mut self) {
    self.cancel.cancel();
    self.cancel = Cancel::new();
    self.generation += 1;
    self.owner = None;
    self.expires = None;
    self.next_sequence = 1;
    self.pending.clear();
    self.gap_since = None;
  }
  fn current(&self, id: &str, round: &str, epoch: u64) -> bool {
    self.owner.as_deref() == Some(id)
      && self.generation.to_string() == round
      && self.input_epoch == epoch
  }
}
struct State {
  mcp: Arc<Mcp>,
  remote: Mutex<Remote>,
  shutdown: Cancel,
  hook: Option<Hook>,
  port: u16,
  viewers: AtomicUsize,
  sockets: AtomicUsize,
  connections: AtomicUsize,
  streams: Mutex<HashMap<u64, TcpStream>>,
  next_connection: AtomicU64,
}

pub struct HttpServer {
  pub port: u16,
  pub url: String,
  state: Arc<State>,
  listener: Mutex<Option<thread::JoinHandle<()>>>,
}
impl HttpServer {
  pub fn close(&self) {
    self.state.shutdown.cancel();
    self.state.mcp.close();
    for stream in self.state.streams.lock().unwrap().values() {
      let _ = stream.shutdown(Shutdown::Both);
    }
    if let Some(listener) = self.listener.lock().unwrap().take() {
      let _ = listener.join();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while self.state.connections.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
      thread::sleep(Duration::from_millis(5));
    }
  }
}

pub fn start(mcp: Arc<Mcp>, options: HttpOptions) -> Result<HttpServer> {
  if options.port != 0 {
    ensure!(
      TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], options.port)),
        Duration::from_millis(150)
      )
      .is_err(),
      "listen EADDRINUSE: port {} is already in use",
      options.port
    );
  }
  let listener = TcpListener::bind(("0.0.0.0", options.port))?;
  listener.set_nonblocking(true)?;
  let port = listener.local_addr()?.port();
  let state = Arc::new(State {
    mcp,
    remote: Mutex::new(Remote::default()),
    shutdown: options.shutdown,
    hook: options.hook,
    port,
    viewers: AtomicUsize::new(0),
    sockets: AtomicUsize::new(0),
    connections: AtomicUsize::new(0),
    streams: Mutex::new(HashMap::new()),
    next_connection: AtomicU64::new(1),
  });
  let lease = state.clone();
  thread::spawn(move || {
    while !lease.shutdown.is_cancelled() {
      let mut remote = lease.remote.lock().unwrap();
      let expired = remote.expires.is_some_and(|time| Instant::now() >= time)
        || remote
          .gap_since
          .is_some_and(|time| time.elapsed() >= Duration::from_millis(500));
      if expired {
        let epoch = remote.input_epoch;
        remote.clear();
        drop(remote);
        let _ = lease.mcp.backend.stop_if_epoch(epoch);
      } else {
        drop(remote);
      }
      thread::sleep(Duration::from_millis(20));
    }
  });
  let accept = state.clone();
  let listener = thread::spawn(move || {
    while !accept.shutdown.is_cancelled() {
      match listener.accept() {
        Ok((stream, _)) => {
          if accept.connections.fetch_add(1, Ordering::SeqCst) >= 128 {
            accept.connections.fetch_sub(1, Ordering::SeqCst);
            drop(stream);
            continue;
          }
          let connection = accept.clone();
          let connection_id = accept.next_connection.fetch_add(1, Ordering::SeqCst);
          if let Ok(clone) = stream.try_clone() {
            accept.streams.lock().unwrap().insert(connection_id, clone);
          }
          thread::spawn(move || {
            let _ = handle(stream, &connection);
            connection.streams.lock().unwrap().remove(&connection_id);
            connection.connections.fetch_sub(1, Ordering::SeqCst);
          });
        }
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
          thread::sleep(Duration::from_millis(5))
        }
        Err(_) => break,
      }
    }
  });
  Ok(HttpServer {
    port,
    url: format!("http://127.0.0.1:{port}/mcp"),
    state,
    listener: Mutex::new(Some(listener)),
  })
}

fn handle(mut stream: TcpStream, state: &Arc<State>) -> Result<()> {
  // Winsock accepted sockets inherit the listener's nonblocking mode. Each
  // request worker uses bounded blocking I/O, including fragmented JSON bodies.
  stream.set_nonblocking(false)?;
  stream.set_nodelay(true)?;
  stream.set_read_timeout(Some(Duration::from_secs(5)))?;
  stream.set_write_timeout(Some(Duration::from_secs(2)))?;
  let request = match read_request(&mut stream) {
    Ok(request) => request,
    Err(error) => {
      let _ = write_response(
        &mut stream,
        Response::json(400, json!({"error":error.to_string()})),
        None,
      );
      return Ok(());
    }
  };
  if !private_request(&request) {
    return write_response(
      &mut stream,
      Response::json(403, json!({"error":"Private LAN requests only."})),
      None,
    );
  }
  let origin = request.header("origin");
  if request.method == "OPTIONS" {
    let mut response = Response::text(204, "application/json", Vec::new());
    response.headers.extend(BTreeMap::from([("Access-Control-Allow-Methods".into(),"GET, POST, DELETE, OPTIONS".into()),("Access-Control-Allow-Headers".into(),"Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Remote-Round, X-Remote-Sequence".into()),("Access-Control-Max-Age".into(),"600".into())]));
    return write_response(&mut stream, response, origin);
  }
  if request.target == "/remote/socket"
    && request
      .header("upgrade")
      .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
  {
    return remote_socket(stream, &request, state);
  }
  if let Some(response) = state.hook.as_ref().and_then(|hook| hook(&request)) {
    return write_response(&mut stream, response, origin);
  }
  if request.method == "GET" {
    let asset = match request.target.as_str() {
      "/" => Some((
        crate::assets::OPERATOR_HTML,
        "text/html; charset=utf-8",
      )),
      "/operator.js" => Some((
        crate::assets::OPERATOR_JS,
        "text/javascript; charset=utf-8",
      )),
      "/operator.css" => Some((
        crate::assets::OPERATOR_CSS,
        "text/css; charset=utf-8",
      )),
      "/screen-channel.js" => Some((
        crate::assets::SCREEN_CHANNEL_JS,
        "text/javascript; charset=utf-8",
      )),
      "/remote-channel.js" => Some((
        crate::assets::REMOTE_CHANNEL_JS,
        "text/javascript; charset=utf-8",
      )),
      _ => None,
    };
    if let Some((bytes, mime)) = asset {
      let mut response = Response::text(200, mime, bytes.to_vec());
      response.headers.extend(BTreeMap::from([("Referrer-Policy".into(),"no-referrer".into()),("X-Content-Type-Options".into(),"nosniff".into()),("Content-Security-Policy".into(),format!("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws://{} wss://{}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",request.header("host").unwrap_or(""),request.header("host").unwrap_or("")))]));
      return write_response(&mut stream, response, origin);
    }
  }
  match request.target.as_str() {
    "/health" if request.method == "GET" => {
      let urls = vec![format!("http://127.0.0.1:{}/", state.port)];
      write_response(
        &mut stream,
        Response::json(
          200,
          json!({"status":"ok","name":"qdd-android-hid","runtimeVersion":9,"operatorUrl":urls[0],"mcpUrl":format!("{}mcp",urls[0]),"lanUrls":urls,"implementation":"rust"}),
        ),
        origin,
      )
    }
    "/screen/profile" => profile(&mut stream, &request, state),
    "/screen/stream" | "/screen/events" if request.method == "GET" => {
      screen_stream(stream, &request, state)
    }
    "/remote/lease" => lease(&mut stream, &request, state),
    "/remote/input" if request.method == "POST" => remote_input(&mut stream, &request, state),
    "/mcp" => mcp_http(stream, &request, state),
    _ => write_response(
      &mut stream,
      Response::json(404, json!({"error":"Not found."})),
      origin,
    ),
  }
}

fn profile(stream: &mut TcpStream, request: &Request, state: &State) -> Result<()> {
  let mut validation_done = false;
  let result = (|| -> Result<Value> {
    ensure!(
      ["GET", "POST"].contains(&request.method.as_str()),
      "Use GET or POST."
    );
    let body: Value = if request.method == "POST" {
      ensure!(request.body.len() <= 256, "画质设置格式不正确或内容过长。");
      ensure!(
        request.header("content-type").is_some_and(|s| s
          .split(';')
          .next()
          .unwrap_or("")
          .trim()
          .eq_ignore_ascii_case("application/json")),
        "画质设置需要 JSON 格式。"
      );
      serde_json::from_slice(&request.body)?
    } else {
      Value::Null
    };
    let selected = if request.method == "POST" {
      ensure!(
        body.as_object().is_some_and(|object| object.len() == 1),
        "请选择极速、快速、标准或原画。"
      );
      let value = mcp::text(&body, "profile")?;
      ensure!(
        ["turbo", "fast", "standard", "original"].contains(&value),
        "请选择极速、快速、标准或原画。"
      );
      Some(value)
    } else {
      None
    };
    validation_done = true;
    state.mcp.backend.profile(selected, &state.shutdown)
  })();
  write_response(
    stream,
    match result {
      Ok(value) => Response::json(200, value),
      Err(error) => Response::json(
        if validation_done {
          502
        } else if !["GET", "POST"].contains(&request.method.as_str()) {
          405
        } else if request.method == "POST"
          && !request.header("content-type").is_some_and(|s| {
            s.split(';')
              .next()
              .unwrap_or("")
              .trim()
              .eq_ignore_ascii_case("application/json")
          })
        {
          415
        } else {
          400
        },
        json!({"error":error.to_string()}),
      ),
    },
    request.header("origin"),
  )
}

fn screen_stream(mut stream: TcpStream, request: &Request, state: &Arc<State>) -> Result<()> {
  if state.viewers.fetch_add(1, Ordering::SeqCst) >= 8 {
    state.viewers.fetch_sub(1, Ordering::SeqCst);
    return write_response(
      &mut stream,
      Response::json(503, json!({"error":"Too many screen viewers."})),
      request.header("origin"),
    );
  }
  let binary = request.target == "/screen/stream";
  let result = (|| -> Result<()> {
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;
    stream_header(
      &mut stream,
      if binary {
        "application/x-qdd-screen"
      } else {
        "text/event-stream"
      },
      request.header("origin"),
      &[],
    )?;
    let mut previous = String::new();
    let mut unavailable = false;
    let mut heartbeat = Instant::now();
    while !state.shutdown.is_cancelled() {
      let capture = state.mcp.read_live(&state.shutdown);
      match capture {
        Ok(capture) => {
          if capture.source_frame_id != previous
            && capture.age_ms() <= crate::screen::MAX_SCREEN_FRAME_AGE_MS
          {
            let mut metadata = capture.metadata();
            metadata["deviceSerial"] = json!(capture.serial);
            metadata["sentAt"] = json!(std::time::SystemTime::now()
              .duration_since(std::time::UNIX_EPOCH)
              .unwrap_or_default()
              .as_millis() as u64);
            metadata["type"] = json!("frame");
            if binary {
              let bytes = metadata.to_string().into_bytes();
              stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
              stream.write_all(&(capture.bytes.len() as u32).to_be_bytes())?;
              stream.write_all(&bytes)?;
              stream.write_all(&capture.bytes)?;
            } else {
              metadata["image"] = json!(STANDARD.encode(&capture.bytes));
              write!(stream, "event: frame\ndata: {metadata}\n\n")?;
            }
            stream.flush()?;
            previous = capture.source_frame_id;
            unavailable = false;
            heartbeat = Instant::now();
          }
        }
        Err(error) => {
          if !unavailable {
            state.mcp.visual_lost();
            let value = json!({"type":"unavailable","message":error.to_string()});
            if binary {
              let bytes = value.to_string().into_bytes();
              stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
              stream.write_all(&0u32.to_be_bytes())?;
              stream.write_all(&bytes)?;
            } else {
              write!(stream, "event: unavailable\ndata: {value}\n\n")?;
            }
            stream.flush()?;
            unavailable = true;
            previous.clear();
          }
        }
      }
      if !binary && heartbeat.elapsed() >= Duration::from_secs(1) {
        stream.write_all(b": connected\n\n")?;
        stream.flush()?;
        heartbeat = Instant::now();
      }
      thread::sleep(Duration::from_millis(15));
    }
    Ok(())
  })();
  state.viewers.fetch_sub(1, Ordering::SeqCst);
  result
}

fn lease(stream: &mut TcpStream, request: &Request, state: &State) -> Result<()> {
  let result = (|| -> Result<Option<u64>> {
    let id = request
      .header("mcp-session-id")
      .ok_or_else(|| anyhow!("Connect the operator first."))?;
    ensure!(state.mcp.has_session(id), "Connect the operator first.");
    let mut remote = state.remote.lock().unwrap();
    ensure!(
      remote.owner.as_deref().is_none_or(|owner| owner == id),
      "Another operator is controlling the phone."
    );
    if let Some(round) = request.header("x-remote-round") {
      ensure!(
        round == remote.generation.to_string(),
        "Old remote control round."
      );
    }
    if request.method == "DELETE" {
      let epoch = remote.input_epoch;
      let owned = remote.owner.as_deref() == Some(id);
      remote.clear();
      drop(remote);
      if owned {
        let _ = state.mcp.backend.stop_if_epoch(epoch);
      }
      return Ok(None);
    }
    ensure!(request.method == "POST", "Use POST or DELETE.");
    ensure!(
      state.mcp.backend.state()["armed"] == true,
      "Start control explicitly first."
    );
    ensure!(
      state.mcp.owns_input(id),
      "Start control explicitly in this session first."
    );
    let epoch = state.mcp.backend.control_epoch();
    if remote.owner.is_some() && remote.input_epoch != epoch {
      remote.clear();
    }
    if remote.owner.is_none() {
      remote.generation += 1;
      remote.owner = Some(id.into());
      remote.input_epoch = epoch;
    }
    remote.expires = Some(Instant::now() + Duration::from_millis(900));
    Ok(Some(remote.generation))
  })();
  let response = match result {
    Ok(round) => {
      let mut response = Response::text(204, "application/json", Vec::new());
      if let Some(round) = round {
        response
          .headers
          .insert("X-Remote-Round".into(), round.to_string());
      }
      response
    }
    Err(error) => Response::json(
      if !["POST", "DELETE"].contains(&request.method.as_str()) {
        405
      } else {
        409
      },
      json!({"error":error.to_string()}),
    ),
  };
  write_response(stream, response, request.header("origin"))
}

fn remote_current(state: &State, id: &str, round: &str, epoch: u64) -> bool {
  state.remote.lock().unwrap().current(id, round, epoch)
    && state.mcp.has_session(id)
    && state.mcp.backend.control_epoch() == epoch
    && state.mcp.backend.state()["armed"] == true
}
fn release_remote(state: &State, id: &str, round: &str, epoch: u64) {
  let mut remote = state.remote.lock().unwrap();
  if remote.current(id, round, epoch) {
    remote.clear();
    drop(remote);
    let _ = state.mcp.backend.stop_if_epoch(epoch);
  }
}
fn renew_remote(state: &State, id: &str, round: &str, epoch: u64) -> Result<()> {
  ensure!(
    remote_current(state, id, round, epoch),
    "The remote control round has ended."
  );
  state.remote.lock().unwrap().expires = Some(Instant::now() + Duration::from_millis(900));
  Ok(())
}

fn validate_report(report: &Value, pointer: bool) -> Result<()> {
  let fields: &[&str] = match report["kind"].as_str() {
    Some("mouse") => &["kind", "dx", "dy", "wheel", "buttons"],
    Some("key") => &["kind", "modifier", "keycode"],
    Some("pointer") if pointer => &[
      "kind",
      "x",
      "y",
      "width",
      "height",
      "rotation",
      "deviceSerial",
      "buttons",
      "wheel",
    ],
    _ => bail!("Unsupported remote HID report."),
  };
  ensure!(
    report
      .as_object()
      .is_some_and(|obj| obj.keys().all(|key| fields.contains(&key.as_str()))),
    "Invalid remote report."
  );
  let bound = |key: &str, min: i64, max: i64| -> Result<()> {
    ensure!(
      (min..=max).contains(&mcp::integer(report, key, None)?),
      "Invalid remote HID report."
    );
    Ok(())
  };
  match report["kind"].as_str().unwrap() {
    "mouse" => {
      for key in ["dx", "dy", "wheel"] {
        bound(key, -127, 127)?;
      }
      bound("buttons", 0, 7)?;
    }
    "key" => {
      bound("modifier", 0, 255)?;
      bound("keycode", 0, 255)?;
    }
    _ => {
      for key in ["width", "height"] {
        bound(key, 1, 0x7fffffff)?;
      }
      bound("x", 0, mcp::integer(report, "width", None)? - 1)?;
      bound("y", 0, mcp::integer(report, "height", None)? - 1)?;
      bound("rotation", 0, 3)?;
      bound("buttons", 0, 7)?;
      bound("wheel", -127, 127)?;
      uuid::Uuid::parse_str(mcp::text(report, "deviceSerial")?)?;
    }
  }
  Ok(())
}

fn remote_input(stream: &mut TcpStream, request: &Request, state: &Arc<State>) -> Result<()> {
  let id = request.header("mcp-session-id").unwrap_or("").to_owned();
  let (round, epoch, cancel) = {
    let remote = state.remote.lock().unwrap();
    (
      remote.generation.to_string(),
      remote.input_epoch,
      remote.cancel.child_token(),
    )
  };
  if !remote_current(state, &id, &round, epoch) {
    return write_response(
      stream,
      Response::json(409, json!({"error":"Start mouse control first."})),
      request.header("origin"),
    );
  }
  let done = Arc::new(AtomicBool::new(false));
  watch_disconnect(stream.try_clone()?, cancel.clone(), done.clone());
  let result = (|| -> Result<Value> {
    ensure!(
      request.body.len() <= 1024,
      "Request body exceeds its size limit."
    );
    let report: Value = serde_json::from_slice(&request.body)?;
    validate_report(&report, true)?;
    ensure!(
      remote_current(state, &id, &round, epoch),
      "Mouse control has paused."
    );
    if let Some(sequence) = request.header("x-remote-sequence") {
      ensure!(
        request.header("x-remote-round") == Some(round.as_str()),
        "Old remote control round."
      );
      let sequence: u64 = sequence.parse()?;
      ensure!(
        sequence > 0 && sequence <= 9999999999,
        "Invalid remote sequence."
      );
      {
        let mut remote = state.remote.lock().unwrap();
        ensure!(
          sequence >= remote.next_sequence
            && sequence < remote.next_sequence + 4
            && !remote.pending.contains(&sequence),
          "Remote report is outside its ordered window."
        );
        remote.pending.insert(sequence);
        if sequence != remote.next_sequence && remote.gap_since.is_none() {
          remote.gap_since = Some(Instant::now());
        }
      }
      loop {
        ensure!(
          remote_current(state, &id, &round, epoch),
          "Remote control round ended."
        );
        mcp::check(&cancel)?;
        let mut remote = state.remote.lock().unwrap();
        ensure!(
          remote.current(&id, &round, epoch),
          "Remote control round ended."
        );
        if sequence == remote.next_sequence {
          if report["kind"] != "pointer" {
            let waiter = state
              .mcp
              .backend
              .submit_remote(report.clone(), cancel.clone())?;
            remote.pending.remove(&sequence);
            remote.next_sequence += 1;
            if remote.pending.is_empty() {
              remote.gap_since = None;
            }
            drop(remote);
            return waiter();
          }
          remote.pending.remove(&sequence);
          remote.next_sequence += 1;
          if remote.pending.is_empty() {
            remote.gap_since = None;
          }
          break;
        }
        drop(remote);
        thread::sleep(Duration::from_millis(2));
      }
    }
    if report["kind"] == "pointer" {
      let frame = state.mcp.read_live(&cancel)?;
      ensure!(
        frame.age_ms() <= crate::screen::MAX_SCREEN_FRAME_AGE_MS,
        "A fresh phone screen is required for pointer input."
      );
      ensure!(
        mcp::text(&report, "deviceSerial")?.eq_ignore_ascii_case(&frame.serial)
          && report["width"] == frame.device_width
          && report["height"] == frame.device_height
          && report["rotation"] == frame.rotation.unwrap_or(0),
        "Phone identity or screen geometry changed. Reconnect the live picture first."
      );
      let guard_state = state.clone();
      let guard_id = id.clone();
      let guard_round = round.clone();
      let guard = Arc::new(move || {
        ensure!(
          remote_current(&guard_state, &guard_id, &guard_round, epoch)
            && frame.age_ms() <= crate::screen::MAX_SCREEN_FRAME_AGE_MS,
          "Pointer input expired while waiting. Start control again."
        );
        Ok(())
      });
      state
        .mcp
        .backend
        .input("android_pointer_to", &report, &cancel, Some(guard))
    } else {
      state.mcp.backend.input(
        if request.header("x-remote-sequence").is_some() {
          "android_remote_report"
        } else if report["kind"] == "mouse" {
          "android_mouse_move"
        } else {
          "android_key_report"
        },
        &report,
        &cancel,
        None,
      )
    }
  })();
  done.store(true, Ordering::SeqCst);
  let response = match result {
    Ok(value) => Response::json(200, value),
    Err(error) => {
      release_remote(state, &id, &round, epoch);
      Response::json(400, json!({"error":error.to_string()}))
    }
  };
  let result = write_response(stream, response, request.header("origin"));
  if result.is_err() {
    release_remote(state, &id, &round, epoch);
  }
  result
}

fn mcp_http(mut stream: TcpStream, request: &Request, state: &Arc<State>) -> Result<()> {
  let origin = request.header("origin");
  let id = request.header("mcp-session-id");
  let mut session = id.and_then(|id| state.mcp.session(id));
  if id.is_some() && session.is_none() {
    return write_response(
      &mut stream,
      Response::json(
        404,
        json!({"error":"MCP session not found. Initialize again."}),
      ),
      origin,
    );
  }
  if let Some(version) = request.header("mcp-protocol-version") {
    if ![
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
      "2024-10-07",
    ]
    .contains(&version)
    {
      return write_response(
        &mut stream,
        Response::json(400, json!({"error":"Unsupported MCP protocol version."})),
        origin,
      );
    }
  }
  if request.method == "DELETE" {
    let Some(session) = session else {
      return write_response(
        &mut stream,
        Response::json(
          405,
          json!({"error":"Initialize an MCP session with POST first."}),
        ),
        origin,
      );
    };
    state.mcp.close_session(&session);
    let remote = state.remote.lock().unwrap();
    let round = remote.generation.to_string();
    let epoch = remote.input_epoch;
    drop(remote);
    release_remote(state, &session.id, &round, epoch);
    return write_response(
      &mut stream,
      Response::text(200, "application/json", Vec::new()),
      origin,
    );
  }
  if request.method == "GET" {
    if !request
      .header("accept")
      .is_some_and(|value| value.contains("text/event-stream"))
    {
      return write_response(
        &mut stream,
        Response::json(
          406,
          json!({"error":"Accept must include text/event-stream."}),
        ),
        origin,
      );
    }
    let Some(session) = session else {
      return write_response(
        &mut stream,
        Response::json(
          405,
          json!({"error":"Initialize an MCP session with POST first."}),
        ),
        origin,
      );
    };
    if session.event_stream.swap(true, Ordering::SeqCst) {
      return write_response(
        &mut stream,
        Response::json(
          409,
          json!({"error":"An SSE stream is already open for this session."}),
        ),
        origin,
      );
    }
    let liveness_cancel = state.shutdown.child_token();
    let liveness_done = Arc::new(AtomicBool::new(false));
    watch_disconnect(
      stream.try_clone()?,
      liveness_cancel.clone(),
      liveness_done.clone(),
    );
    let result = (|| -> Result<()> {
      stream_header(
        &mut stream,
        "text/event-stream",
        origin,
        &[("Mcp-Session-Id", session.id.as_str())],
      )?;
      while !liveness_cancel.is_cancelled() && !session.is_closed() {
        stream.write_all(b": qdd-connected\n\n")?;
        stream.flush()?;
        let _ = mcp::sleep(Duration::from_secs(2), &liveness_cancel);
      }
      Ok(())
    })();
    liveness_done.store(true, Ordering::SeqCst);
    session.event_stream.store(false, Ordering::SeqCst);
    state.mcp.close_session(&session);
    return result;
  }
  if request.method != "POST" {
    return write_response(
      &mut stream,
      Response::json(405, json!({"error":"Unsupported MCP method."})),
      origin,
    );
  }
  if !request.header("content-type").is_some_and(|value| {
    value
      .split(';')
      .next()
      .unwrap_or("")
      .trim()
      .eq_ignore_ascii_case("application/json")
  }) {
    return write_response(
      &mut stream,
      Response::json(415, json!({"error":"MCP requires application/json."})),
      origin,
    );
  }
  let accept = request.header("accept").unwrap_or("");
  if !accept.contains("application/json") || !accept.contains("text/event-stream") {
    return write_response(
      &mut stream,
      Response::json(
        406,
        json!({"error":"Accept must include application/json and text/event-stream."}),
      ),
      origin,
    );
  }
  let message: Value = match serde_json::from_slice(&request.body) {
    Ok(value) => value,
    Err(error) => {
      return write_response(
        &mut stream,
        Response::json(400, json!({"error":error.to_string()})),
        origin,
      )
    }
  };
  if message.is_array() {
    return write_response(
      &mut stream,
      Response::json(400, json!({"error":"Send one MCP request per HTTP POST."})),
      origin,
    );
  }
  if session.as_ref().is_some_and(|session| session.is_closed()) {
    return write_response(
      &mut stream,
      Response::json(
        404,
        json!({"error":"MCP session not found. Initialize again."}),
      ),
      origin,
    );
  }
  if session.is_none() {
    if message["jsonrpc"] != "2.0"
      || message["method"] != "initialize"
      || message.get("id").is_none()
    {
      return write_response(
        &mut stream,
        Response::json(400, json!({"error":"Initialize an MCP session first."})),
        origin,
      );
    }
    session = match state.mcp.create_session() {
      Ok(session) => Some(session),
      Err(error) => {
        return write_response(
          &mut stream,
          Response::json(503, json!({"error":error.to_string()})),
          origin,
        )
      }
    };
  }
  let session = session.unwrap();
  let name = message["params"]["name"].as_str().unwrap_or("");
  let args = message["params"]
    .get("arguments")
    .cloned()
    .unwrap_or_else(|| json!({}));
  let before_dispatch = || -> Result<()> {
    if message["method"] == "tools/call" && state.mcp.is_mutating(name, &args) {
      let mut remote = state.remote.lock().unwrap();
      if remote
        .owner
        .as_ref()
        .is_some_and(|owner| owner != &session.id)
      {
        let previous = remote.owner.clone();
        remote.clear();
        drop(remote);
        let stopped = state.mcp.backend.stop();
        if let Some(previous) = previous.and_then(|id| state.mcp.session(&id)) {
          state.mcp.close_session(&previous);
        }
        if let Err(error) = stopped {
          bail!("Could not release the previous remote controller: {error}");
        }
      }
    }
    Ok(())
  };
  let cancel = state.shutdown.child_token();
  let done = Arc::new(AtomicBool::new(false));
  watch_disconnect(stream.try_clone()?, cancel.clone(), done.clone());
  let round = AtomicU64::new(u64::MAX);
  let response = state.mcp.handle_tracked_with_hook(
    &session,
    &message,
    &cancel,
    Some(&round),
    Some(&before_dispatch),
  );
  let result = if let Some(response) = response {
    let mut result = Response::text(
      200,
      "text/event-stream",
      format!("event: message\ndata: {response}\n\n").into_bytes(),
    );
    result
      .headers
      .insert("Mcp-Session-Id".into(), session.id.clone());
    result.headers.insert(
      "MCP-Protocol-Version".into(),
      session.protocol_version.lock().unwrap().clone(),
    );
    write_response(&mut stream, result, origin)
  } else {
    write_response(
      &mut stream,
      Response::text(202, "application/json", Vec::new()),
      origin,
    )
  };
  done.store(true, Ordering::SeqCst);
  if result.is_err() {
    cancel.cancel();
    let epoch = round.load(Ordering::SeqCst);
    if epoch != u64::MAX && state.mcp.owns_input(&session.id) {
      let _ = state.mcp.backend.stop_if_epoch(epoch);
    }
  }
  result
}

fn remote_socket(mut stream: TcpStream, request: &Request, state: &Arc<State>) -> Result<()> {
  if state.sockets.fetch_add(1, Ordering::SeqCst) >= 16 {
    state.sockets.fetch_sub(1, Ordering::SeqCst);
    return write_response(
      &mut stream,
      Response::json(403, json!({"error":"Too many input sockets."})),
      None,
    );
  }
  let result = (|| -> Result<()> {
    ensure!(
      request.method == "GET" && request.header("sec-websocket-version") == Some("13"),
      "Invalid WebSocket upgrade."
    );
    let key = request
      .header("sec-websocket-key")
      .ok_or_else(|| anyhow!("WebSocket key is required."))?;
    ensure!(STANDARD.decode(key)?.len() == 16, "Invalid WebSocket key.");
    let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
    write!(stream,"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n")?;
    stream.flush()?;
    stream.set_read_timeout(Some(Duration::from_millis(20)))?;
    stream.set_write_timeout(Some(Duration::from_millis(200)))?;
    let config = tungstenite::protocol::WebSocketConfig::default()
      .max_message_size(Some(2048))
      .max_frame_size(Some(2048))
      .write_buffer_size(0)
      .max_write_buffer_size(65536);
    let mut socket = tungstenite::WebSocket::from_raw_socket(stream, Role::Server, Some(config));
    let mut binding: Option<(String, String, u64, String)> = None;
    let mut next = 1u64;
    let mut pending: HashMap<u64, (Instant, Cancel)> = HashMap::new();
    let (tx, rx) = mpsc::channel();
    let connected = Instant::now();
    let mut failure: Option<String> = None;
    let loop_result = (|| -> Result<()> {
      while !state.shutdown.is_cancelled() {
        if binding.is_none() {
          ensure!(
            connected.elapsed() < Duration::from_secs(1),
            "Remote socket handshake timed out."
          );
        }
        if let Some((id, round, epoch, _)) = &binding {
          ensure!(
            remote_current(state, id, round, *epoch),
            "The remote control round has ended."
          );
        }
        ensure!(
          pending
            .values()
            .all(|(time, _)| time.elapsed() < Duration::from_millis(1500)),
          "Remote report acknowledgement timed out; input was not retried."
        );
        while let Ok((sequence, result)) = rx.try_recv() {
          pending.remove(&sequence);
          let value: Value = result?;
          socket.send(Message::Text(
            json!({"type":"ack","sequence":sequence,"state":value})
              .to_string()
              .into(),
          ))?;
        }
        let message = match socket.read() {
          Ok(value) => value,
          Err(tungstenite::Error::Io(error))
            if [std::io::ErrorKind::WouldBlock, std::io::ErrorKind::TimedOut]
              .contains(&error.kind()) =>
          {
            continue
          }
          Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
            return Ok(())
          }
          Err(error) => return Err(error.into()),
        };
        let message = match message {
          Message::Text(value) => value,
          Message::Ping(_) => {
            socket.flush()?;
            continue;
          }
          Message::Pong(_) => continue,
          Message::Close(_) => return Ok(()),
          _ => bail!("Remote socket accepts JSON text only."),
        };
        let data: Value = serde_json::from_str(message.as_str())?;
        if binding.is_none() {
          keys(&data, &["type", "sessionId", "round"])?;
          ensure!(
            data["type"] == "hello",
            "Connect the current operator round before sending input."
          );
          let id = mcp::text(&data, "sessionId")?;
          let round = mcp::text(&data, "round")?;
          ensure!(
            !id.is_empty() && id.len() <= 256 && !round.is_empty() && round.len() <= 128,
            "Invalid remote HELLO."
          );
          let epoch = state.mcp.backend.control_epoch();
          ensure!(
            remote_current(state, id, round, epoch),
            "Connect the current operator round first."
          );
          let owner_key = format!("{id}:{round}:{epoch}");
          {
            let mut remote = state.remote.lock().unwrap();
            ensure!(
              remote.sockets.insert(owner_key.clone()),
              "This remote round already has an input socket."
            );
          }
          binding = Some((id.into(), round.into(), epoch, owner_key));
          renew_remote(state, id, round, epoch)?;
          socket.send(Message::Text(
            json!({"type":"ready","round":round}).to_string().into(),
          ))?;
          continue;
        }
        let (id, round, epoch, _) = binding.as_ref().unwrap();
        match data["type"].as_str() {
          Some("ping") => {
            keys(&data, &["type"])?;
            renew_remote(state, id, round, *epoch)?;
            socket.send(Message::Text(json!({"type":"pong"}).to_string().into()))?;
          }
          Some("stop") => {
            keys(&data, &["type"])?;
            return Ok(());
          }
          Some("report") => {
            keys(&data, &["type", "sequence", "report"])?;
            let sequence = mcp::integer(&data, "sequence", None)?;
            ensure!(
              sequence > 0 && sequence as u64 == next && pending.len() < 4,
              "Remote report is outside its ordered four-report window."
            );
            validate_report(&data["report"], false)?;
            next += 1;
            let remote = state.remote.lock().unwrap();
            ensure!(
              remote.current(id, round, *epoch),
              "The remote control round has ended."
            );
            let cancel = remote.cancel.child_token();
            pending.insert(sequence as u64, (Instant::now(), cancel.clone()));
            let report = data["report"].clone();
            let waiter = state.mcp.backend.submit_remote(report, cancel.clone())?;
            drop(remote);
            let tx = tx.clone();
            thread::spawn(move || {
              let result = waiter();
              let _ = tx.send((sequence as u64, result));
            });
          }
          _ => bail!("Invalid remote socket request."),
        }
      }
      Ok(())
    })();
    if let Err(error) = loop_result {
      failure = Some(error.to_string());
    }
    for (_, cancel) in pending.values() {
      cancel.cancel();
    }
    if let Some((id, round, epoch, key)) = &binding {
      state.remote.lock().unwrap().sockets.remove(key);
      release_remote(state, id, round, *epoch);
    }
    if let Some(message) = failure {
      let _ = socket.send(Message::Text(
        json!({"type":"error","message":message}).to_string().into(),
      ));
    }
    let _ = socket.close(None);
    Ok(())
  })();
  state.sockets.fetch_sub(1, Ordering::SeqCst);
  result
}

fn keys(value: &Value, allowed: &[&str]) -> Result<()> {
  ensure!(
    value
      .as_object()
      .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str()))),
    "Invalid remote socket message fields."
  );
  Ok(())
}

fn watch_disconnect(stream: TcpStream, cancel: Cancel, done: Arc<AtomicBool>) {
  thread::spawn(move || {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(40)));
    let mut byte = [0; 1];
    while !done.load(Ordering::SeqCst) && !cancel.is_cancelled() {
      match stream.peek(&mut byte) {
        Ok(0) => {
          cancel.cancel();
          break;
        }
        Ok(_) => thread::sleep(Duration::from_millis(10)),
        Err(error)
          if [std::io::ErrorKind::WouldBlock, std::io::ErrorKind::TimedOut]
            .contains(&error.kind()) => {}
        Err(_) => {
          cancel.cancel();
          break;
        }
      }
    }
  });
}

pub(crate) fn read_request(stream: &mut TcpStream) -> Result<Request> {
  let mut bytes = Vec::new();
  let end;
  loop {
    ensure!(bytes.len() < 16384, "HTTP headers exceed their size limit.");
    let mut block = [0u8; 1024];
    let count = stream.read(&mut block)?;
    ensure!(count > 0, "HTTP connection closed.");
    bytes.extend_from_slice(&block[..count]);
    if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
      end = index + 4;
      break;
    }
  }
  let mut headers = [httparse::EMPTY_HEADER; 64];
  let mut parsed = httparse::Request::new(&mut headers);
  ensure!(
    parsed.parse(&bytes[..end])?.is_complete(),
    "Incomplete HTTP headers."
  );
  let method = parsed
    .method
    .ok_or_else(|| anyhow!("HTTP method required."))?
    .to_owned();
  let target = parsed
    .path
    .ok_or_else(|| anyhow!("HTTP path required."))?
    .to_owned();
  ensure!(
    target.starts_with('/') && !target.contains('#'),
    "Invalid HTTP target."
  );
  let mut headers = BTreeMap::new();
  for header in parsed.headers {
    let name = header.name.to_ascii_lowercase();
    let value = std::str::from_utf8(header.value)?.trim().to_owned();
    ensure!(
      headers.insert(name, value).is_none(),
      "Duplicate HTTP headers are not supported."
    );
  }
  let mut body = bytes[end..].to_vec();
  if let Some(encoding) = headers.get("transfer-encoding") {
    ensure!(
      encoding.eq_ignore_ascii_case("chunked") && !headers.contains_key("content-length"),
      "Unsupported HTTP transfer encoding."
    );
    body = read_chunks(stream, body, 1024 * 1024)?;
  } else {
    let length: usize = headers
      .get("content-length")
      .map(|value| value.parse())
      .transpose()?
      .unwrap_or(0);
    ensure!(
      length <= 1024 * 1024,
      "Request body exceeds its size limit."
    );
    ensure!(
      body.len() <= length,
      "Unexpected bytes after HTTP request body."
    );
    while body.len() < length {
      let remaining = (length - body.len()).min(8192);
      let mut chunk = vec![0; remaining];
      stream.read_exact(&mut chunk)?;
      body.extend(chunk);
    }
  }
  Ok(Request {
    method,
    target,
    headers,
    body,
    peer: stream.peer_addr()?,
  })
}

fn read_chunks(stream: &mut TcpStream, mut buffered: Vec<u8>, limit: usize) -> Result<Vec<u8>> {
  fn fill(stream: &mut TcpStream, bytes: &mut Vec<u8>, size: usize) -> Result<()> {
    while bytes.len() < size {
      let mut block = [0u8; 4096];
      let count = stream.read(&mut block)?;
      ensure!(count > 0, "Chunked body ended early.");
      bytes.extend_from_slice(&block[..count]);
    }
    Ok(())
  }
  let mut body = Vec::new();
  loop {
    while !buffered.windows(2).any(|w| w == b"\r\n") {
      ensure!(buffered.len() < 128, "HTTP chunk header is too long.");
      let size = buffered.len() + 1;
      fill(stream, &mut buffered, size)?;
    }
    let end = buffered.windows(2).position(|w| w == b"\r\n").unwrap();
    let line = std::str::from_utf8(&buffered[..end])?;
    let length = usize::from_str_radix(line.split(';').next().unwrap_or(""), 16)?;
    ensure!(
      body
        .len()
        .checked_add(length)
        .is_some_and(|size| size <= limit),
      "Request body exceeds its size limit."
    );
    buffered.drain(..end + 2);
    fill(stream, &mut buffered, length + 2)?;
    ensure!(
      &buffered[length..length + 2] == b"\r\n",
      "Invalid HTTP chunk terminator."
    );
    if length == 0 {
      ensure!(
        buffered.len() == 2,
        "HTTP chunk trailers are not supported."
      );
      return Ok(body);
    }
    body.extend_from_slice(&buffered[..length]);
    buffered.drain(..length + 2);
  }
}

pub(crate) fn write_response(
  stream: &mut TcpStream,
  mut response: Response,
  origin: Option<&str>,
) -> Result<()> {
  response
    .headers
    .insert("Content-Length".into(), response.body.len().to_string());
  response.headers.insert("Connection".into(), "close".into());
  cors(&mut response.headers, origin);
  write!(
    stream,
    "HTTP/1.1 {} {}\r\n",
    response.status,
    status_text(response.status)
  )?;
  for (name, value) in response.headers {
    ensure!(
      !name.contains(['\r', '\n']) && !value.contains(['\r', '\n']),
      "Invalid response header."
    );
    write!(stream, "{name}: {value}\r\n")?;
  }
  stream.write_all(b"\r\n")?;
  stream.write_all(&response.body)?;
  stream.flush()?;
  Ok(())
}
fn stream_header(
  stream: &mut TcpStream,
  mime: &str,
  origin: Option<&str>,
  extra: &[(&str, &str)],
) -> Result<()> {
  let mut headers = BTreeMap::from([
    ("Content-Type".into(), mime.into()),
    ("Cache-Control".into(), "no-store".into()),
    ("Connection".into(), "close".into()),
    ("X-Content-Type-Options".into(), "nosniff".into()),
  ]);
  cors(&mut headers, origin);
  for (name, value) in extra {
    headers.insert((*name).into(), (*value).into());
  }
  write!(stream, "HTTP/1.1 200 OK\r\n")?;
  for (name, value) in headers {
    write!(stream, "{name}: {value}\r\n")?;
  }
  stream.write_all(b"\r\n")?;
  stream.flush()?;
  Ok(())
}
fn cors(headers: &mut BTreeMap<String, String>, origin: Option<&str>) {
  if let Some(origin) = origin {
    headers.insert("Access-Control-Allow-Origin".into(), origin.into());
    headers.insert("Vary".into(), "Origin".into());
    headers.insert(
      "Access-Control-Expose-Headers".into(),
      "Mcp-Session-Id, MCP-Protocol-Version, X-Remote-Round".into(),
    );
  }
}
fn status_text(status: u16) -> &'static str {
  match status {
    200 => "OK",
    202 => "Accepted",
    204 => "No Content",
    400 => "Bad Request",
    403 => "Forbidden",
    404 => "Not Found",
    405 => "Method Not Allowed",
    406 => "Not Acceptable",
    409 => "Conflict",
    415 => "Unsupported Media Type",
    500 => "Internal Server Error",
    502 => "Bad Gateway",
    503 => "Service Unavailable",
    _ => "Response",
  }
}
pub fn private_address(address: IpAddr) -> bool {
  match address {
    IpAddr::V4(ip) => {
      let [a, b, _, _] = ip.octets();
      a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && (16..=31).contains(&b))
    }
    IpAddr::V6(ip) => {
      ip.is_loopback()
        || ip
          .to_ipv4_mapped()
          .is_some_and(|v4| private_address(IpAddr::V4(v4)))
    }
  }
}
pub fn private_authority(host: &str) -> bool {
  if host.is_empty() || host.contains(['@', '/', '?', '#', '\\', ' ', '\t']) {
    return false;
  }
  let (name, port) = if host.starts_with('[') {
    let Some(end) = host.find(']') else {
      return false;
    };
    let rest = &host[end + 1..];
    if rest.is_empty() {
      (&host[1..end], None)
    } else if let Some(port) = rest.strip_prefix(':') {
      (&host[1..end], Some(port))
    } else {
      return false;
    }
  } else if let Some((name, port)) = host.rsplit_once(':') {
    (name, Some(port))
  } else {
    (host, None)
  };
  if port.is_some_and(|value| {
    value.starts_with('0') || value.parse::<u16>().ok().is_none_or(|port| port == 0)
  }) {
    return false;
  }
  name.eq_ignore_ascii_case("localhost") || name.parse::<IpAddr>().ok().is_some_and(private_address)
}
fn private_origin(origin: Option<&str>) -> bool {
  let Some(origin) = origin else {
    return true;
  };
  let Some(rest) = origin
    .strip_prefix("http://")
    .or_else(|| origin.strip_prefix("https://"))
  else {
    return false;
  };
  let host = rest.strip_suffix('/').unwrap_or(rest);
  !host.contains('/') && private_authority(host)
}
pub(crate) fn private_request(request: &Request) -> bool {
  private_address(request.peer.ip())
    && request.header("host").is_some_and(private_authority)
    && private_origin(request.header("origin"))
}

/// Newline-delimited stdio MCP, with request threads so cancellation notifications
/// remain processable while a screenshot or an input acknowledgement is pending.
pub fn run_stdio(mcp: Arc<Mcp>, shutdown: Cancel) -> Result<()> {
  let input = stdio_reader(std::io::stdin());
  run_stdio_messages(
    mcp,
    shutdown,
    input,
    Arc::new(Mutex::new(Box::new(std::io::stdout()))),
  )
}

enum StdioInput {
  Line(Vec<u8>),
  TooLarge,
  Error(std::io::Error),
  Eof,
}
type StdioOutput = Arc<Mutex<Box<dyn Write + Send>>>;

/// Blocking stdin is isolated from the control lifetime. The detached reader
/// owns no device resources and buffers at most one complete 1 MiB line ahead.
fn stdio_reader(reader: impl Read + Send + 'static) -> mpsc::Receiver<StdioInput> {
  let (sender, receiver) = mpsc::sync_channel(1);
  thread::spawn(move || {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(reader);
    loop {
      let mut bytes = Vec::new();
      let message = match reader
        .by_ref()
        .take(1024 * 1024 + 1)
        .read_until(b'\n', &mut bytes)
      {
        Ok(0) => StdioInput::Eof,
        Ok(_) if bytes.len() > 1024 * 1024 => StdioInput::TooLarge,
        Ok(_) => StdioInput::Line(bytes),
        Err(error) => StdioInput::Error(error),
      };
      let terminal = !matches!(message, StdioInput::Line(_));
      if sender.send(message).is_err() || terminal {
        break;
      }
    }
  });
  receiver
}

fn run_stdio_messages(
  mcp: Arc<Mcp>,
  shutdown: Cancel,
  input: mpsc::Receiver<StdioInput>,
  output: StdioOutput,
) -> Result<()> {
  let session = mcp.create_session()?;
  let pending = Arc::new(AtomicUsize::new(0));
  let result = (|| -> Result<()> {
    loop {
      if shutdown.is_cancelled() {
        break;
      }
      let bytes = match input.recv_timeout(Duration::from_millis(40)) {
        Ok(StdioInput::Line(bytes)) => bytes,
        Ok(StdioInput::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
        Err(mpsc::RecvTimeoutError::Timeout) => continue,
        Ok(StdioInput::Error(error)) => return Err(error.into()),
        Ok(StdioInput::TooLarge) => {
          let error = mcp::rpc_error(Value::Null, -32700, "MCP line exceeds its size limit.");
          let mut output = output.lock().unwrap();
          writeln!(output, "{error}")?;
          output.flush()?;
          bail!("MCP line exceeds its size limit.");
        }
      };
      if shutdown.is_cancelled() {
        break;
      }
      let message: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
          let mut output = output.lock().unwrap();
          writeln!(
            output,
            "{}",
            mcp::rpc_error(Value::Null, -32700, "Invalid JSON.")
          )?;
          output.flush()?;
          continue;
        }
      };
      if message.get("id").is_none() {
        mcp.handle(&session, &message, &shutdown);
        continue;
      }
      if pending.fetch_add(1, Ordering::SeqCst) >= 32 {
        pending.fetch_sub(1, Ordering::SeqCst);
        let mut output = output.lock().unwrap();
        writeln!(
          output,
          "{}",
          mcp::rpc_error(
            message["id"].clone(),
            -32000,
            "Too many pending MCP requests. Maximum is 32."
          )
        )?;
        output.flush()?;
        continue;
      }
      let mcp = mcp.clone();
      let session = session.clone();
      let output = output.clone();
      let cancel = shutdown.clone();
      let pending = pending.clone();
      thread::spawn(move || {
        struct Pending(Arc<AtomicUsize>);
        impl Drop for Pending {
          fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
          }
        }
        let _pending = Pending(pending);
        if let Some(response) = mcp.handle(&session, &message, &cancel) {
          let mut output = output.lock().unwrap();
          let _ = writeln!(output, "{response}");
          let _ = output.flush();
        }
      });
    }
    Ok(())
  })();
  mcp.close_session(&session);
  result
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::mcp::tests::FakeBackend;
  use tungstenite::client::IntoClientRequest;

  fn fixture() -> (HttpServer, Arc<Mcp>, Arc<FakeBackend>) {
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let server = start(
      mcp.clone(),
      HttpOptions {
        port: 0,
        ..HttpOptions::default()
      },
    )
    .unwrap();
    (server, mcp, backend)
  }

  #[test]
  fn accepted_connection_waits_for_a_fragmented_request_body() {
    let (server, _, _) = fixture();
    let message = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fragmented-body","version":"1"}}}).to_string();
    let mut client = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    client
      .set_read_timeout(Some(Duration::from_secs(3)))
      .unwrap();
    write!(client,"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n",server.port,message.len()).unwrap();
    client.write_all(&message.as_bytes()[..1]).unwrap();
    thread::sleep(Duration::from_millis(75));
    client.write_all(&message.as_bytes()[1..]).unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("\"protocolVersion\":\"2025-11-25\""));
    server.close();
  }
  #[test]
  fn completed_request_id_retransmission_cannot_release_a_new_browser_owner() {
    let (server, mcp, backend) = fixture();
    let first = mcp.create_session().unwrap();
    let message = json!({"jsonrpc":"2.0","id":"old-input","method":"tools/call","params":{"name":"android_type","arguments":{"text":"x"}}});
    let response = mcp.handle(&first, &message, &Cancel::new()).unwrap();
    assert!(response["result"].get("isError").is_none());
    let browser = mcp.create_session().unwrap();
    let armed = mcp.call(&browser, "android_hid_arm", &json!({}), &Cancel::new());
    assert!(armed.get("isError").is_none());
    {
      let mut remote = server.state.remote.lock().unwrap();
      remote.owner = Some(browser.id.clone());
      remote.input_epoch = backend.epoch.load(Ordering::SeqCst);
      remote.expires = Some(Instant::now() + Duration::from_secs(10));
    }
    let stopped = backend.stops.load(Ordering::SeqCst);
    let (_, repeated) = rpc(server.port, Some(&first.id), message);
    assert_eq!(repeated["error"]["code"], -32600);
    assert_eq!(backend.stops.load(Ordering::SeqCst), stopped);
    assert!(mcp.owns_input(&browser.id));
    assert_eq!(
      server.state.remote.lock().unwrap().owner.as_deref(),
      Some(browser.id.as_str())
    );
    for (index, params) in [
      json!({"name":"android_hid_arm","arguments":{"unexpected":true}}),
      json!({"name":"android_key","arguments":{"combo":"unknown-key"}}),
      json!({"name":"android_control","arguments":{"action":"click","frameId":"stale-image"}}),
    ]
    .into_iter()
    .enumerate()
    {
      let (_, rejected) = rpc(
        server.port,
        Some(&first.id),
        json!({"jsonrpc":"2.0","id":format!("invalid-{index}"),"method":"tools/call","params":params}),
      );
      assert_eq!(rejected["result"]["isError"], true);
      assert_eq!(backend.stops.load(Ordering::SeqCst), stopped);
      assert!(mcp.owns_input(&browser.id));
      assert_eq!(
        server.state.remote.lock().unwrap().owner.as_deref(),
        Some(browser.id.as_str())
      );
    }
    server.close();
  }
  fn request(
    port: u16,
    method: &str,
    target: &str,
    headers: &[(&str, &str)],
    body: &[u8],
  ) -> String {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
      .set_read_timeout(Some(Duration::from_secs(4)))
      .unwrap();
    write!(
      socket,
      "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n",
      body.len()
    )
    .unwrap();
    for (name, value) in headers {
      write!(socket, "{name}: {value}\r\n").unwrap();
    }
    socket.write_all(b"\r\n").unwrap();
    socket.write_all(body).unwrap();
    let mut output = String::new();
    socket.read_to_string(&mut output).unwrap();
    output
  }
  fn rpc(port: u16, session: Option<&str>, message: Value) -> (String, Value) {
    let mut headers = vec![
      ("Content-Type", "application/json"),
      ("Accept", "application/json, text/event-stream"),
    ];
    if let Some(session) = session {
      headers.push(("Mcp-Session-Id", session));
    }
    let output = request(
      port,
      "POST",
      "/mcp",
      &headers,
      message.to_string().as_bytes(),
    );
    assert!(output.starts_with("HTTP/1.1 200"), "{output}");
    let id = output
      .lines()
      .find_map(|line| line.strip_prefix("Mcp-Session-Id: "))
      .unwrap_or("")
      .to_owned();
    let data = output
      .lines()
      .find_map(|line| line.strip_prefix("data: "))
      .unwrap();
    (id, serde_json::from_str(data).unwrap())
  }

  #[test]
  fn http_sdk_shape_static_assets_and_private_access_are_preserved() {
    let (server, _, backend) = fixture();
    let health = request(server.port, "GET", "/health", &[], b"");
    assert!(health.contains("\"status\":\"ok\""));
    for target in [
      "/",
      "/operator.js",
      "/operator.css",
      "/screen-channel.js",
      "/remote-channel.js",
    ] {
      let output = request(server.port, "GET", target, &[], b"");
      assert!(output.starts_with("HTTP/1.1 200"), "{output}");
      assert!(output.contains("Content-Security-Policy:"));
    }
    let public = request(
      server.port,
      "GET",
      "/health",
      &[("Origin", "https://example.com")],
      b"",
    );
    assert!(public.starts_with("HTTP/1.1 403"));
    assert!(private_authority("192.168.1.2:8790"));
    assert!(!private_authority("8.8.8.8:8790"));
    assert!(!private_authority("evil.example"));
    assert!(!private_authority("192.168.1.2:0"));
    assert_eq!(backend.actions.lock().unwrap().len(), 0);
    let (id, initialized) = rpc(
      server.port,
      None,
      json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}),
    );
    assert_eq!(initialized["result"]["protocolVersion"], "2025-03-26");
    let (_, listed) = rpc(
      server.port,
      Some(&id),
      json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    );
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 22);
    let (_, screenshot) = rpc(
      server.port,
      Some(&id),
      json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"android_screenshot"}}),
    );
    assert!(screenshot["result"]["structuredContent"]["frameId"].is_string());
    let unknown = request(server.port, "GET", "/missing", &[], b"");
    assert!(unknown.starts_with("HTTP/1.1 404"));
    server.close();
    let rebound = TcpListener::bind(("127.0.0.1", server.port));
    assert!(
      rebound.is_ok(),
      "listener must be released before desktop reload"
    );
  }

  #[test]
  fn persistent_sse_disconnect_stops_only_its_input_owner() {
    let (server, mcp, backend) = fixture();
    let session = mcp.create_session().unwrap();
    mcp.call(&session, "android_hid_arm", &json!({}), &Cancel::new());
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream
      .set_read_timeout(Some(Duration::from_secs(2)))
      .unwrap();
    write!(stream,"GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nMcp-Session-Id: {}\r\nAccept: text/event-stream\r\n\r\n",server.port,session.id).unwrap();
    let mut bytes = [0u8; 1024];
    let count = stream.read(&mut bytes).unwrap();
    assert!(String::from_utf8_lossy(&bytes[..count]).starts_with("HTTP/1.1 200"));
    drop(stream);
    let deadline = Instant::now() + Duration::from_secs(2);
    while (mcp.has_session(&session.id) || backend.stops.load(Ordering::SeqCst) == 0)
      && Instant::now() < deadline
    {
      thread::sleep(Duration::from_millis(10));
    }
    assert!(!mcp.has_session(&session.id));
    assert_eq!(backend.stops.load(Ordering::SeqCst), 1);
    server.close();
  }

  #[test]
  fn socket_preserves_report_reservations_and_rejects_duplicate_owner_without_releasing_it() {
    let (server, mcp, backend) = fixture();
    let session = mcp.create_session().unwrap();
    mcp.call(&session, "android_hid_arm", &json!({}), &Cancel::new());
    let lease = request(
      server.port,
      "POST",
      "/remote/lease",
      &[("Mcp-Session-Id", &session.id)],
      b"",
    );
    assert!(lease.starts_with("HTTP/1.1 204"));
    let round = lease
      .lines()
      .find_map(|line| line.strip_prefix("X-Remote-Round: "))
      .unwrap()
      .to_owned();
    let open = || {
      let mut req = format!("ws://127.0.0.1:{}/remote/socket", server.port)
        .into_client_request()
        .unwrap();
      req.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{}", server.port).parse().unwrap(),
      );
      let (mut socket, _) = tungstenite::connect(req).unwrap();
      socket
        .send(Message::Text(
          json!({"type":"hello","sessionId":session.id,"round":round})
            .to_string()
            .into(),
        ))
        .unwrap();
      let value: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
      (socket, value)
    };
    let (mut owner, ready) = open();
    assert_eq!(ready["type"], "ready");
    let (mut duplicate, error) = open();
    assert_eq!(error["type"], "error");
    let _ = duplicate.close(None);
    assert_eq!(backend.stops.load(Ordering::SeqCst), 0);
    for sequence in 1..=4 {
      owner.send(Message::Text(json!({"type":"report","sequence":sequence,"report":{"kind":"mouse","dx":sequence,"dy":0,"wheel":0,"buttons":0}}).to_string().into())).unwrap();
    }
    owner
      .send(Message::Text(json!({"type":"ping"}).to_string().into()))
      .unwrap();
    let mut acks = HashSet::new();
    let mut pong = false;
    while acks.len() < 4 || !pong {
      let value: Value = serde_json::from_str(owner.read().unwrap().to_text().unwrap()).unwrap();
      assert_ne!(value["type"], "error", "{value}");
      if value["type"] == "pong" {
        pong = true;
      }
      if value["type"] == "ack" {
        acks.insert(value["sequence"].as_u64().unwrap());
      }
    }
    let actions = backend.actions.lock().unwrap().clone();
    assert_eq!(actions.len(), 4);
    for (index, action) in actions.iter().enumerate() {
      let value: Value = serde_json::from_str(action).unwrap();
      assert_eq!(value["dx"], index + 1);
    }
    owner.close(None).unwrap();
    server.close();
  }

  #[test]
  fn parser_rejects_conflicting_framing_and_accepts_bounded_chunked_json() {
    let (server, _, _) = fixture();
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream.write_all(b"POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}").unwrap();
    let mut output = String::new();
    stream.read_to_string(&mut output).unwrap();
    assert!(output.starts_with("HTTP/1.1 400"));
    let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stream.write_all(b"POST /screen/profile HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n16\r\n{\"profile\":\"standard\"}\r\n0\r\n\r\n").unwrap();
    let mut output = String::new();
    stream.read_to_string(&mut output).unwrap();
    assert!(output.starts_with("HTTP/1.1 200"), "{output}");
    server.close();
  }

  #[test]
  fn stdio_shutdown_releases_armed_input_while_reader_waits_for_the_rest_of_a_line() {
    struct Pipe {
      input: mpsc::Receiver<Vec<u8>>,
      buffer: std::io::Cursor<Vec<u8>>,
    }
    impl Read for Pipe {
      fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        loop {
          let count = self.buffer.read(bytes)?;
          if count > 0 {
            return Ok(count);
          }
          match self.input.recv() {
            Ok(next) => self.buffer = std::io::Cursor::new(next),
            Err(_) => return Ok(0),
          }
        }
      }
    }
    let backend = Arc::new(FakeBackend::default());
    let mcp = Mcp::new(backend.clone());
    let shutdown = Cancel::new();
    let (sender, receiver) = mpsc::channel();
    let input = stdio_reader(Pipe {
      input: receiver,
      buffer: std::io::Cursor::new(Vec::new()),
    });
    let (output, completed) = mpsc::channel();
    let control = mcp.clone();
    let cancel = shutdown.clone();
    thread::spawn(move || {
      let result = run_stdio_messages(
        control,
        cancel,
        input,
        Arc::new(Mutex::new(Box::new(std::io::sink()))),
      );
      let _ = output.send(result);
    });
    sender.send(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"android_hid_arm\"}}\n{\"jsonrpc\":".to_vec()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !backend.armed.load(Ordering::SeqCst) && Instant::now() < deadline {
      thread::sleep(Duration::from_millis(5));
    }
    assert!(backend.armed.load(Ordering::SeqCst));
    shutdown.cancel();
    completed
      .recv_timeout(Duration::from_millis(500))
      .expect("Cancellation must not wait for newline or EOF")
      .unwrap();
    assert!(!backend.armed.load(Ordering::SeqCst));
    assert_eq!(backend.stops.load(Ordering::SeqCst), 1);
    drop(sender);
  }

  #[test]
  fn stdio_reader_rejects_a_line_over_one_mebibyte_without_waiting_for_newline() {
    let input = stdio_reader(std::io::Cursor::new(vec![b'x'; 1024 * 1024 + 1]));
    assert!(matches!(
      input.recv_timeout(Duration::from_secs(1)).unwrap(),
      StdioInput::TooLarge
    ));
  }

  #[test]
  fn stdio_caps_inflight_calls_at_thirty_two_and_keeps_shutdown_responsive() {
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
      fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
      }
      fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
      }
    }
    let backend = Arc::new(FakeBackend::default());
    // The read-only fake STATUS waits on this state lock, so all 32 admitted
    // requests stay pending while the 33rd must be rejected by the dispatcher.
    let hold = backend.geometry.lock().unwrap();
    let mcp = Mcp::new(backend.clone());
    let shutdown = Cancel::new();
    let (sender, input) = mpsc::sync_channel(40);
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let output: StdioOutput = Arc::new(Mutex::new(Box::new(Capture(bytes.clone()))));
    let (done, completed) = mpsc::channel();
    let cancel = shutdown.clone();
    thread::spawn(move || {
      let _ = done.send(run_stdio_messages(mcp, cancel, input, output));
    });
    for id in 1..=33 {
      sender.send(StdioInput::Line(json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"android_hid_status"}}).to_string().into_bytes())).unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
      if String::from_utf8_lossy(&bytes.lock().unwrap()).contains("Maximum is 32") {
        break;
      }
      assert!(
        Instant::now() < deadline,
        "The 33rd in-flight request was not rejected"
      );
      thread::sleep(Duration::from_millis(5));
    }
    let output = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
    let response: Value = serde_json::from_str(output.trim()).unwrap();
    assert_eq!(response["id"], 33);
    assert_eq!(response["error"]["code"], -32000);
    shutdown.cancel();
    completed
      .recv_timeout(Duration::from_millis(500))
      .expect("Shutdown must not wait for queued read-only calls")
      .unwrap();
    drop(hold);
    drop(sender);
  }
}
