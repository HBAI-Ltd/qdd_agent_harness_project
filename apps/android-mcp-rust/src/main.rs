use anyhow::{bail, Context};
use qdd_android_mcp_rust::{
  backend::DeviceBackend,
  config::{self, Config},
  desktop::{self, Command},
  http::{self, HttpOptions, Response},
  mcp::Mcp,
  Cancel, Result, BUILD_ID,
};
use serde_json::{json, Value};
use std::{
  collections::{BTreeMap, HashSet},
  path::PathBuf,
  sync::{mpsc, Arc},
  thread,
  time::Duration,
};

fn local_request(
  method: &str,
  port: u16,
  route: &str,
) -> Result<qdd_android_mcp_rust::net::Response> {
  let cancel = Cancel::new();
  let timeout = cancel.clone();
  thread::spawn(move || {
    thread::sleep(Duration::from_millis(600));
    timeout.cancel();
  });
  qdd_android_mcp_rust::net::request(
    method,
    &format!("http://127.0.0.1:{port}{route}"),
    &[],
    &[],
    &cancel,
    16384,
  )
}

fn reuse_or_retire(config: &Config, no_browser: bool) -> Result<bool> {
  let existing = local_request("GET", config.port(), "/health")
    .ok()
    .and_then(|r| serde_json::from_slice::<Value>(&r.body).ok());
  let Some(existing) =
    existing.filter(|value| value["status"] == "ok" && value["name"] == "qdd-android-hid")
  else {
    return Ok(false);
  };
  if existing["desktopBuildId"] == BUILD_ID && existing["desktopConfigHash"] == config.hash() {
    desktop::finish_configuration(config, None);
    desktop::open_browser(
      &qdd_android_mcp_rust::lan::lan_urls(config.port())[0],
      no_browser,
    )?;
    return Ok(true);
  }
  if !existing["desktopBuildId"].is_string() {
    bail!("另一个版本的设备操作台仍在运行，请关闭其服务窗口后重试。");
  }
  let stopped = local_request("POST", config.port(), "/desktop/quit")?;
  if stopped.status != 204 {
    bail!("旧版设备操作台未能退出，请关闭旧窗口后重试。");
  }
  for _ in 0..50 {
    if local_request("GET", config.port(), "/health").is_err() {
      return Ok(false);
    }
    thread::sleep(Duration::from_millis(100));
  }
  bail!("旧版设备操作台仍在关闭，请稍后重试。")
}

fn arguments() -> Result<(BTreeMap<String, String>, HashSet<String>)> {
  let mut values = BTreeMap::new();
  let mut flags = HashSet::new();
  let mut args = std::env::args().skip(1);
  while let Some(arg) = args.next() {
    let arg = if arg == "-h" {
      "--help".to_string()
    } else {
      arg
    };
    if [
      "--help",
      "--stdio",
      "--no-browser",
      "--configure",
      "--self-test",
    ]
    .contains(&arg.as_str())
    {
      flags.insert(arg);
    } else if [
      "--config",
      "--transport",
      "--port",
      "--screen-url",
      "--device",
      "--esp-host",
      "--esp-port",
      "--esp-tcp-port",
      "--esp-setup-url",
    ]
    .contains(&arg.as_str())
    {
      let value = args
        .next()
        .with_context(|| format!("Missing value for {arg}"))?;
      values.insert(arg, value);
    } else {
      bail!("Unknown argument: {arg}");
    }
  }
  Ok((values, flags))
}

fn run() -> Result<()> {
  if std::env::args().any(|arg| arg == "--target-preview-worker") {
    return qdd_android_mcp_rust::target_preview::run_worker();
  }
  let (values, flags) = arguments()?;
  if flags.contains("--help") {
    println!("设备操作台\n双击启动。--configure 连接设置；--stdio 供 MCP 客户端启动；--no-browser 不打开浏览器；--self-test 检查内置资源。\n--config PATH --screen-url http://PHONE_IP:8791 --esp-host ESP_IP --esp-tcp-port 3333 --esp-port COM5 --port 8790");
    return Ok(());
  }
  if flags.contains("--self-test") {
    let ports = serialport::available_ports()?
      .into_iter()
      .map(|p| p.port_name)
      .collect::<Vec<_>>();
    println!(
      "{}",
      json!({"status":"ok","buildId":BUILD_ID,"runtime":"rust","arch":std::env::consts::ARCH,"embeddedAssets":["operator.html","operator.css","operator.js","remote-channel.js","screen-channel.js","settings.html","tools.json"],"serialPorts":ports})
    );
    return Ok(());
  }
  let stdio = flags.contains("--stdio") || values.get("--transport").is_some_and(|v| v == "stdio");
  if values
    .get("--transport")
    .is_some_and(|v| v != "stdio" && v != "http")
  {
    bail!("transport must be stdio or http.");
  }
  let shutdown = Cancel::new();
  let stop = shutdown.clone();
  ctrlc::set_handler(move || stop.cancel())?;
  let path = if let Some(path) = values.get("--config") {
    PathBuf::from(path)
  } else {
    config::default_path()?
  };
  let mut defaults: Value = if path.is_file() {
    serde_json::from_slice(&std::fs::read(&path)?).unwrap_or(json!({}))
  } else {
    config::environment_defaults()
  };
  if !defaults.is_object() {
    defaults = json!({});
  }
  for (flag, field) in [
    ("--screen-url", "ANDROID_SCREEN_URL"),
    ("--device", "ANDROID_DEVICE_ID"),
    ("--esp-host", "ESP_HOST"),
    ("--esp-port", "ESP_PORT"),
    ("--esp-tcp-port", "ESP_TCP_PORT"),
    ("--esp-setup-url", "ESP_SETUP_URL"),
    ("--port", "ANDROID_MCP_PORT"),
  ] {
    if let Some(value) = values.get(flag) {
      defaults[field] = json!(value);
    }
  }
  let mut setup_shown = false;
  let mut config = match Config::normalize(&defaults) {
    Ok(config) if !flags.contains("--configure") => config,
    result => {
      if stdio {
        bail!("请先双击 EXE 设置手机和控制板连接，再使用 --stdio。");
      }
      let problem = result.err().map(|e| e.to_string()).unwrap_or_default();
      setup_shown = true;
      desktop::configure_with_cancel(
        &path,
        defaults,
        flags.contains("--no-browser"),
        &problem,
        &shutdown,
      )?
    }
  };
  if !stdio && reuse_or_retire(&config, flags.contains("--no-browser"))? {
    return Ok(());
  }
  let (commands, events) = mpsc::channel();
  let mut show_browser = !flags.contains("--no-browser") && !setup_shown;
  loop {
    if shutdown.is_cancelled() {
      break;
    }
    let backend = match DeviceBackend::new(&config) {
      Ok(backend) => backend,
      Err(error) => {
        desktop::finish_configuration(&config, Some(&error.to_string()));
        return Err(error);
      }
    };
    let mcp = Mcp::new(backend.clone());
    let service_stop = shutdown.child_token();
    let loss_stop = service_stop.clone();
    let loss_mcp = mcp.clone();
    let mut subscription = backend.live.subscribe()?;
    let observer = thread::spawn(move || {
      let mut had_frame = false;
      while !loss_stop.is_cancelled() {
        match subscription.next(&loss_stop, Duration::from_millis(3500)) {
          Ok(frame) => {
            had_frame = true;
            let _ = loss_mcp.observe(&frame);
          }
          Err(_) => {
            if had_frame {
              loss_mcp.visual_lost();
              had_frame = false;
            }
            thread::sleep(Duration::from_millis(100));
          }
        }
      }
    });
    let registration = if !config.setup_url.is_empty() && !stdio {
      Some(desktop::registration(config.clone(), service_stop.clone()))
    } else {
      None
    };
    if stdio {
      let result = http::run_stdio(mcp.clone(), shutdown.clone());
      service_stop.cancel();
      mcp.close();
      backend.close();
      let _ = observer.join();
      if let Some(task) = registration {
        let _ = task.join();
      }
      return result;
    }
    let hook = desktop::make_hook(
      path.clone(),
      config.clone(),
      commands.clone(),
      service_stop.clone(),
    );
    let health_config = config.clone();
    let health_urls = qdd_android_mcp_rust::lan::lan_urls(health_config.port());
    let hook = Arc::new(move |request: &http::Request| {
      if request.target == "/health" && request.method == "GET" {
        return Some(Response::json(
          200,
          json!({"status":"ok","name":"qdd-android-hid","desktopBuildId":BUILD_ID,"desktopConfigHash":health_config.hash(),"desktopPid":std::process::id(),"runtimeVersion":9,"runtime":"rust","operatorUrl":format!("http://localhost:{}/",health_config.port()),"mcpUrl":format!("http://localhost:{}/mcp",health_config.port()),"lanUrls":health_urls}),
        ));
      }
      hook(request)
    });
    let server = match http::start(
      mcp.clone(),
      HttpOptions {
        port: config.port(),
        shutdown: service_stop.clone(),
        hook: Some(hook),
      },
    ) {
      Ok(server) => server,
      Err(error) => {
        service_stop.cancel();
        mcp.close();
        backend.close();
        let _ = observer.join();
        if let Some(task) = registration {
          let _ = task.join();
        }
        if error.to_string().contains("EADDRINUSE") || error.to_string().contains("10048") {
          let problem = format!("端口 {} 已占用，请换一个端口。", config.port());
          desktop::finish_configuration(&config, Some(&problem));
          config = desktop::configure_with_cancel(
            &path,
            config.value(),
            flags.contains("--no-browser"),
            &problem,
            &shutdown,
          )?;
          continue;
        }
        desktop::finish_configuration(&config, Some(&error.to_string()));
        return Err(error);
      }
    };
    desktop::finish_configuration(&config, None);
    eprintln!(
      "操作台：{}\nMCP：{}\n保持本窗口打开。按 Ctrl+C 关闭并释放键鼠。",
      server.url.trim_end_matches("mcp"),
      server.url
    );
    desktop::open_browser(&server.url.trim_end_matches("mcp"), !show_browser)?;
    show_browser = false;
    let mut next = None;
    while !shutdown.is_cancelled() {
      match events.recv_timeout(Duration::from_millis(100)) {
        Ok(Command::Quit) => {
          shutdown.cancel();
          break;
        }
        Ok(Command::Reload(value)) => {
          next = Some(value);
          thread::sleep(Duration::from_millis(100));
          break;
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        Err(mpsc::RecvTimeoutError::Disconnected) => {
          shutdown.cancel();
          break;
        }
      }
    }
    service_stop.cancel();
    server.close();
    backend.close();
    let _ = observer.join();
    if let Some(task) = registration {
      let _ = task.join();
    }
    if let Some(value) = next {
      config = value;
    } else {
      break;
    }
  }
  Ok(())
}

fn main() {
  if let Err(error) = run() {
    eprintln!("{error:#}");
    std::process::exit(1);
  }
}
