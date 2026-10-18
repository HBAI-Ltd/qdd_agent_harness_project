use crate::{
  config::Config,
  http::{self, Hook, Request, Response},
  lan, net,
  screen::valid_device_id,
  Cancel, Result,
};
use anyhow::{anyhow, ensure, Context};
use serde_json::{json, Value};
use std::{
  collections::{BTreeMap, BTreeSet},
  net::{Ipv4Addr, TcpListener, UdpSocket},
  path::{Path, PathBuf},
  process::Command as ProcessCommand,
  sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
  },
  thread::{self, JoinHandle},
  time::{Duration, Instant},
};

pub enum Command {
  Reload(Config),
  Quit,
}

struct PendingSetup {
  id: String,
  hash: String,
  reply: mpsc::Sender<Option<String>>,
  flushed: mpsc::Receiver<()>,
}
static PENDING_SETUP: Mutex<Vec<PendingSetup>> = Mutex::new(Vec::new());

/// Finish the accepted setup POST only after the requested service has started.
/// Waiting for its flush also permits a reused-service launcher to exit safely.
pub fn finish_configuration(config: &Config, error: Option<&str>) {
  let hash = config.hash();
  let mut selected = vec![];
  if let Ok(mut pending) = PENDING_SETUP.lock() {
    let mut index = 0;
    while index < pending.len() {
      if pending[index].hash == hash {
        selected.push(pending.swap_remove(index));
      } else {
        index += 1;
      }
    }
  }
  for pending in selected {
    let _ = pending.reply.send(error.map(str::to_owned));
    let _ = pending.flushed.recv_timeout(Duration::from_secs(1));
  }
}

pub fn open_browser(url: &str, disabled: bool) -> Result<()> {
  if disabled {
    return Ok(());
  }
  #[cfg(windows)]
  let mut command = {
    use std::os::windows::process::CommandExt;
    let root = std::env::var_os("SystemRoot")
      .map(PathBuf::from)
      .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    let mut command = ProcessCommand::new(root.join("System32/rundll32.exe"));
    command
      .args(["url.dll,FileProtocolHandler", url])
      .creation_flags(0x08000000);
    command
  };
  #[cfg(not(windows))]
  let mut command = {
    let mut command = ProcessCommand::new("xdg-open");
    command.arg(url);
    command
  };
  if let Err(error) = command
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
  {
    eprintln!("请在浏览器打开 {url}（{error}）");
  }
  Ok(())
}

pub fn configure(path: &Path, defaults: Value, no_browser: bool, problem: &str) -> Result<Config> {
  configure_with_cancel(path, defaults, no_browser, problem, &Cancel::new())
}

pub fn configure_with_cancel(
  path: &Path,
  defaults: Value,
  no_browser: bool,
  problem: &str,
  shutdown: &Cancel,
) -> Result<Config> {
  let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))?;
  listener.set_nonblocking(true)?;
  let port = listener.local_addr()?.port();
  let url = base_url(port);
  let html = settings_page(&defaults, &serial_names(), "/config", problem, "/discover");
  eprintln!("连接设置：{url}");
  open_browser(&url, no_browser)?;
  let (selected, config_receiver) = mpsc::sync_channel(1);
  let busy = Arc::new(AtomicBool::new(false));
  let stopped = shutdown.child_token();
  let mut connections = vec![];
  let result = loop {
    if stopped.is_cancelled() {
      break Err(anyhow!("Connection setup cancelled."));
    }
    if let Ok(config) = config_receiver.try_recv() {
      break Ok(config);
    }
    match listener.accept() {
      Ok((mut stream, _)) => {
        let (path, defaults, html, selected, busy, stopped, startup_cancel) = (
          path.to_path_buf(),
          defaults.clone(),
          html.clone(),
          selected.clone(),
          busy.clone(),
          stopped.clone(),
          shutdown.clone(),
        );
        connections.push(thread::spawn(move || {
          if stream.set_nonblocking(false).is_err() {
            return;
          }
          let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
          let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
          let request = match http::read_request(&mut stream) {
            Ok(request) => request,
            Err(_) => return,
          };
          let mut saved = None;
          let response = if !http::private_request(&request) {
            Response::json(403, json!({ "error": "Private LAN access only." }))
          } else if request.target == "/discover" {
            discovery_response(&request, &defaults, &stopped)
          } else if request.target == "/" && request.method == "GET" {
            Response::text(200, "text/html; charset=utf-8", html)
          } else if request.target == "/config" && request.method == "POST" {
            if busy
              .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
              .is_err()
            {
              Response::json(409, json!({ "error": "正在启动，请稍候。" }))
            } else {
              match read_configuration(&request).and_then(|config| {
                config.save(&path)?;
                Ok(config)
              }) {
                Ok(config) => {
                  let url = base_url(config.port());
                  saved = Some(config);
                  Response::json(200, json!({ "url": url }))
                }
                Err(error) => {
                  busy.store(false, Ordering::Release);
                  Response::json(400, json!({ "error": error.to_string() }))
                }
              }
            }
          } else {
            Response::text(404, "text/plain", b"Not found".to_vec())
          };
          if let Some(config) = saved {
            let (reply, receiver) = mpsc::channel();
            let (flushed, flush_receiver) = mpsc::channel();
            let id = uuid::Uuid::new_v4().to_string();
            if let Ok(mut pending) = PENDING_SETUP.lock() {
              pending.push(PendingSetup {
                id: id.clone(),
                hash: config.hash(),
                reply,
                flushed: flush_receiver,
              });
            }
            let _ = selected.send(config.clone());
            let started = Instant::now();
            let result = loop {
              match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(None) => break Ok(()),
                Ok(Some(error)) => break Err(error),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                  break Err("操作台启动连接已关闭。".into())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
              }
              if startup_cancel.is_cancelled() {
                break Err("操作台启动已取消。".into());
              }
              if started.elapsed() >= Duration::from_secs(10) {
                break Err("操作台未能启动，请重新打开 EXE 或更换端口。".into());
              }
            };
            let response = match result {
              Ok(()) => response,
              Err(error) => Response::json(500, json!({ "error": error })),
            };
            let _ = http::write_response(&mut stream, response, request.header("origin"));
            if let Ok(mut pending) = PENDING_SETUP.lock() {
              pending.retain(|entry| entry.id != id);
            }
            let _ = flushed.send(());
          } else {
            let _ = http::write_response(&mut stream, response, request.header("origin"));
          }
        }));
      }
      Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
        thread::sleep(Duration::from_millis(10))
      }
      Err(error) => break Err(error.into()),
    }
    // Finished request threads are joined promptly rather than accumulating handles.
    let mut index = 0;
    while index < connections.len() {
      if connections[index].is_finished() {
        let _ = connections.swap_remove(index).join();
      } else {
        index += 1;
      }
    }
  };
  stopped.cancel();
  drop(listener);
  // The winning request owns its response until main reports service readiness.
  // Waiting for it here would prevent main from starting that very service.
  drop(connections);
  result
}

pub fn make_hook(
  path: PathBuf,
  current: Config,
  commands: mpsc::Sender<Command>,
  shutdown: Cancel,
) -> Hook {
  let restarting = AtomicBool::new(false);
  let hash = current.hash();
  Arc::new(move |request: &Request| -> Option<Response> {
    match request.target.as_str() {
      "/desktop/status" => Some(if request.method == "GET" {
        Response::json(200, json!({ "desktopConfigHash": hash }))
      } else {
        method_not_allowed()
      }),
      "/desktop/quit" => {
        if request.method != "POST" {
          return Some(method_not_allowed());
        }
        send_after_response(commands.clone(), Command::Quit);
        Some(Response::text(204, "text/plain", Vec::new()))
      }
      "/desktop/discover" => Some(discovery_response(request, &current.value(), &shutdown)),
      "/desktop/settings" if request.method == "GET" => Some(Response::text(
        200,
        "text/html; charset=utf-8",
        settings_page(
          &current.value(),
          &serial_names(),
          "/desktop/settings",
          "",
          "/desktop/discover",
        ),
      )),
      "/desktop/settings" if request.method == "POST" => {
        if restarting
          .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
          .is_err()
        {
          return Some(Response::json(
            400,
            json!({ "error": "连接设置正在应用，请稍候。" }),
          ));
        }
        let result = read_configuration(request).and_then(|config| {
          config.save(&path)?;
          Ok(config)
        });
        Some(match result {
          Ok(config) => {
            let next_hash = config.hash();
            let changed = next_hash != hash;
            let url = base_url(config.port());
            if changed {
              send_after_response(commands.clone(), Command::Reload(config));
            } else {
              restarting.store(false, Ordering::Release);
            }
            Response::json(
              200,
              json!({ "url": url, "restart": changed, "configHash": next_hash }),
            )
          }
          Err(error) => {
            restarting.store(false, Ordering::Release);
            Response::json(400, json!({ "error": error.to_string() }))
          }
        })
      }
      "/desktop/settings" => Some(method_not_allowed()),
      _ => None,
    }
  })
}

fn send_after_response(sender: mpsc::Sender<Command>, command: Command) {
  thread::spawn(move || {
    thread::sleep(Duration::from_millis(100));
    let _ = sender.send(command);
  });
}
fn method_not_allowed() -> Response {
  Response::text(405, "text/plain", b"Method not allowed".to_vec())
}
fn read_configuration(request: &Request) -> Result<Config> {
  ensure!(request.body.len() <= 8192, "配置内容过长。");
  Config::normalize(&serde_json::from_slice(&request.body).context("配置不是有效 JSON")?)
}
fn serial_names() -> Vec<String> {
  serialport::available_ports()
    .unwrap_or_default()
    .into_iter()
    .map(|port| port.port_name)
    .collect()
}
fn base_url(port: u16) -> String {
  lan::lan_urls(port)
    .into_iter()
    .next()
    .unwrap_or_else(|| format!("http://localhost:{port}/"))
}

fn settings_page(
  defaults: &Value,
  ports: &[String],
  save: &str,
  problem: &str,
  discover: &str,
) -> String {
  let port = defaults["ANDROID_MCP_PORT"]
    .as_str()
    .and_then(|s| s.parse::<u16>().ok())
    .or_else(|| {
      defaults["ANDROID_MCP_PORT"]
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
    })
    .filter(|p| *p > 0)
    .unwrap_or(8790);
  let payload = json!({ "defaults": defaults, "ports": ports, "problem": problem, "mcpUrl": format!("{}mcp", base_url(port)) }).to_string().replace('<', "\\u003c");
  crate::assets::SETTINGS_HTML
    .replace("__QDD_SAVE_PATH__", save)
    .replace("__QDD_DISCOVER_PATH__", discover)
    .replacen("__QDD_SETTINGS_DATA__", &payload, 1)
}

fn discovery_response(request: &Request, defaults: &Value, shutdown: &Cancel) -> Response {
  if request.method != "GET" {
    return method_not_allowed();
  }
  let mut hints = vec![];
  if let Some(url) = defaults["ESP_SETUP_URL"].as_str().filter(|s| !s.is_empty()) {
    hints.push(url.into());
  }
  if let Some(host) = defaults["ESP_HOST"].as_str().filter(|s| !s.is_empty()) {
    hints.push(format!("http://{host}:3334"));
  }
  let options = DiscoveryOptions {
    hints,
    cancel: shutdown.child_token(),
    ..DiscoveryOptions::default()
  };
  match discover(options) {
    Ok(boards) => Response::json(200, json!({ "boards": boards })),
    Err(error) => Response::json(500, json!({ "error": error.to_string() })),
  }
}

pub struct DiscoveryOptions {
  pub broadcasts: Vec<Ipv4Addr>,
  pub udp_port: u16,
  pub timeout: Duration,
  pub hints: Vec<String>,
  pub cancel: Cancel,
}
impl Default for DiscoveryOptions {
  fn default() -> Self {
    Self {
      broadcasts: broadcast_addresses(),
      udp_port: 3335,
      timeout: Duration::from_millis(1400),
      hints: vec![],
      cancel: Cancel::new(),
    }
  }
}
fn broadcast_addresses() -> Vec<Ipv4Addr> {
  let mut addresses = BTreeSet::from([Ipv4Addr::BROADCAST]);
  for interface in if_addrs::get_if_addrs().unwrap_or_default() {
    if let if_addrs::IfAddr::V4(v4) = interface.addr {
      if lan::private_ipv4(v4.ip) && !v4.ip.is_loopback() {
        addresses.insert(Ipv4Addr::from(u32::from(v4.ip) | !u32::from(v4.netmask)));
      }
    }
  }
  addresses.into_iter().take(16).collect()
}

/// A single bounded read-only scan. No serial port, phone image or HID is opened.
pub fn discover(options: DiscoveryOptions) -> Result<Vec<Value>> {
  let timeout = options
    .timeout
    .clamp(Duration::from_millis(100), Duration::from_secs(5));
  let deadline = Instant::now() + timeout;
  let active = options.cancel.child_token();
  let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
  socket.set_broadcast(true)?;
  socket.set_read_timeout(Some(Duration::from_millis(25)))?;
  let (sender, receiver) = mpsc::channel();
  let mut probes = vec![];
  let mut probed = BTreeSet::new();
  for hint in options.hints.iter().take(8) {
    let Ok(endpoint) = board_origin(hint) else {
      continue;
    };
    if !probed.insert(endpoint.clone()) {
      continue;
    }
    let (sender, cancel) = (sender.clone(), active.clone());
    probes.push(thread::spawn(move || {
      if let Ok(response) = net::request(
        "GET",
        &format!("{endpoint}/api/status"),
        &[],
        &[],
        &cancel,
        8192,
      ) {
        if response.status == 200 {
          if let Ok(value) = serde_json::from_slice(&response.body) {
            if let Ok(board) = board_status(&value, &endpoint) {
              let _ = sender.send(board);
            }
          }
        }
      }
    }));
  }
  drop(sender);
  let mut found = BTreeMap::new();
  let mut round = 0;
  while !options.cancel.is_cancelled() && Instant::now() < deadline {
    if round < 3 && Instant::now() + timeout - deadline >= timeout * round / 3 {
      for address in options.broadcasts.iter().take(16) {
        let _ = socket.send_to(b"QDD-DISCOVER/1", (*address, options.udp_port));
      }
      round += 1;
    }
    for board in receiver.try_iter() {
      insert_board(&mut found, board);
    }
    let mut bytes = [0u8; 2049];
    match socket.recv_from(&mut bytes) {
      Ok((count, peer)) if count <= 2048 => {
        let std::net::IpAddr::V4(peer) = peer.ip() else {
          continue;
        };
        if !lan::private_ipv4(peer) {
          continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes[..count]) {
          if let Some(url) = value["boardUrl"].as_str() {
            if let Ok(board) = board_status(&value, url) {
              if board["ip"] == peer.to_string() {
                insert_board(&mut found, board);
              }
            }
          }
        }
      }
      Ok(_) => {}
      Err(error)
        if matches!(
          error.kind(),
          std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) => {}
      Err(_) => break,
    }
  }
  active.cancel();
  // Polling socket reads unblock immediately; HTTP probes share the cancelled token.
  for probe in probes {
    let _ = probe.join();
  }
  for board in receiver.try_iter() {
    insert_board(&mut found, board);
  }
  let mut boards: Vec<_> = found.into_values().collect();
  boards.sort_by(|left, right| {
    right["phone"]["projecting"]
      .as_bool()
      .unwrap_or(false)
      .cmp(&left["phone"]["projecting"].as_bool().unwrap_or(false))
      .then_with(|| left["ip"].as_str().cmp(&right["ip"].as_str()))
  });
  Ok(boards)
}
fn insert_board(found: &mut BTreeMap<String, Value>, board: Value) {
  let key = board["boardUrl"].as_str().unwrap_or_default().to_owned();
  if found.contains_key(&key) || found.len() < 8 {
    found.insert(key, board);
  }
}
fn board_origin(url: &str) -> Result<String> {
  let endpoint = net::Endpoint::parse(url)?;
  ensure!(
    !endpoint.secure && endpoint.path == "/",
    "设备引导地址应为内网 HTTP 原点。"
  );
  Ok(endpoint.origin())
}
fn port(value: &Value) -> Option<u16> {
  value
    .as_u64()
    .filter(|n| (1..=65535).contains(n))
    .map(|n| n as u16)
}
pub fn board_status(value: &Value, url: &str) -> Result<Value> {
  let origin = board_origin(url)?;
  let endpoint = net::Endpoint::parse(&origin)?;
  ensure!(
    value["service"] == "qdd-esp-onboarding"
      && value["version"] == 1
      && value["ip"] == endpoint.host
      && port(&value["tcpPort"]).is_some(),
    "控制板返回的连接信息不完整。"
  );
  let candidate = &value["phone"];
  let phone = if candidate["fresh"] == true
    && candidate["ip"]
      .as_str()
      .and_then(|v| v.parse::<Ipv4Addr>().ok())
      .is_some_and(lan::private_ipv4)
    && port(&candidate["port"]).is_some()
    && candidate["deviceId"].as_str().is_some_and(valid_device_id)
    && candidate["projecting"].is_boolean()
  {
    json!({ "ip": candidate["ip"], "port": candidate["port"], "deviceId": candidate["deviceId"], "projecting": candidate["projecting"],
      "screenUrl": format!("http://{}:{}", candidate["ip"].as_str().unwrap(), port(&candidate["port"]).unwrap()) })
  } else {
    Value::Null
  };
  let name = value["deviceName"]
    .as_str()
    .unwrap_or("设备控制器")
    .chars()
    .take(100)
    .collect::<String>();
  Ok(
    json!({ "boardUrl": origin, "ip": value["ip"], "tcpPort": value["tcpPort"], "phone": phone, "name": name,
    "bluetooth": { "connected": value["bluetooth"]["connected"] == true, "ready": value["bluetooth"]["ready"] == true } }),
  )
}

pub fn registration(config: Config, shutdown: Cancel) -> JoinHandle<()> {
  thread::spawn(move || {
    if config.setup_url.is_empty() {
      return;
    }
    let Ok(origin) = board_origin(&config.setup_url) else {
      return;
    };
    while !shutdown.is_cancelled() {
      let active = shutdown.child_token();
      let finished = Cancel::new();
      let (timeout, done) = (active.clone(), finished.clone());
      let watcher = thread::spawn(move || {
        let started = Instant::now();
        while !done.is_cancelled() && started.elapsed() < Duration::from_millis(1200) {
          thread::sleep(Duration::from_millis(10));
        }
        if !done.is_cancelled() {
          timeout.cancel();
        }
      });
      let body = json!({ "port": config.port() }).to_string().into_bytes();
      let _ = net::open(
        "POST",
        &format!("{origin}/api/pc"),
        &[("Content-Type".into(), "application/json".into())],
        &body,
        &active,
      );
      finished.cancel();
      active.cancel();
      let _ = watcher.join();
      let started = Instant::now();
      while !shutdown.is_cancelled() && started.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(25));
      }
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  fn board() -> Value {
    json!({ "service": "qdd-esp-onboarding", "version": 1, "ip": "127.0.0.1", "tcpPort": 3333,
    "boardUrl": "http://127.0.0.1:3334", "deviceName": "fixture", "phone": { "fresh": true, "ip": "127.0.0.1", "port": 8791,
    "deviceId": "00112233-4455-6677-8899-aabbccddeeff", "projecting": true } })
  }
  #[test]
  fn board_identity_and_phone_registration_are_validated() {
    let value = board();
    let status = board_status(&value, "http://127.0.0.1:3334").unwrap();
    assert_eq!(status["phone"]["screenUrl"], "http://127.0.0.1:8791");
    assert!(board_status(&value, "http://127.0.0.2:3334").is_err());
    let mut stale = value;
    stale["phone"]["fresh"] = false.into();
    assert!(board_status(&stale, "http://127.0.0.1:3334").unwrap()["phone"].is_null());
  }
  #[test]
  fn discovery_is_bounded_read_only_and_accepts_udp_without_http_probe() {
    let fixture = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    fixture
      .set_read_timeout(Some(Duration::from_secs(2)))
      .unwrap();
    let port = fixture.local_addr().unwrap().port();
    let task = thread::spawn(move || {
      let mut bytes = [0; 64];
      let (n, peer) = fixture.recv_from(&mut bytes).unwrap();
      assert_eq!(&bytes[..n], b"QDD-DISCOVER/1");
      fixture
        .send_to(board().to_string().as_bytes(), peer)
        .unwrap();
    });
    let started = Instant::now();
    let boards = discover(DiscoveryOptions {
      broadcasts: vec![Ipv4Addr::LOCALHOST],
      udp_port: port,
      timeout: Duration::from_millis(150),
      hints: vec![],
      cancel: Cancel::new(),
    })
    .unwrap();
    task.join().unwrap();
    assert_eq!(boards.len(), 1);
    assert!(started.elapsed() < Duration::from_secs(1));
  }
  #[test]
  fn page_preserves_ui_routes_and_escapes_user_supplied_script_data() {
    let html = settings_page(
      &json!({ "ANDROID_SCREEN_URL": "</script><script>bad()" }),
      &["COM7".into()],
      "/save",
      "problem",
      "/find",
    );
    assert!(html.contains("自动查找手机与设备控制器"));
    assert!(html.contains("/save"));
    assert!(html.contains("/find"));
    assert!(html.contains("\\u003c/script>"));
    assert!(!html.contains("__QDD_SAVE_PATH__"));
    assert!(html.contains("COM7"));
  }
  #[test]
  fn compressed_settings_injects_json_last_without_rewriting_user_tokens() {
    let hostile = "</script><img src=x onerror=bad()> &amp; __QDD_SAVE_PATH__ __QDD_DISCOVER_PATH__ __QDD_SETTINGS_DATA__";
    let html = settings_page(
      &json!({ "ANDROID_SCREEN_URL": hostile, "ANDROID_MCP_PORT": "8971" }),
      &["COM6".into()],
      "/safe-save",
      hostile,
      "/safe-discover",
    );
    assert_eq!(html.matches("</script>").count(), 1);
    assert!(!html.contains("<img src=x"));
    assert!(html.contains("\\u003c/script>\\u003cimg"));
    assert!(html.contains("&amp; __QDD_SAVE_PATH__ __QDD_DISCOVER_PATH__ __QDD_SETTINGS_DATA__"));
    assert!(html.contains("/safe-save") && html.contains("/safe-discover"));
    assert!(html.contains(":8971/mcp"));
  }
}
