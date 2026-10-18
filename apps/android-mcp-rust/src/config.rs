use crate::{net::Endpoint, Result};
use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
  #[serde(rename = "ANDROID_SCREEN_URL")]
  pub screen_url: String,
  #[serde(rename = "ANDROID_DEVICE_ID")]
  pub device_id: String,
  #[serde(rename = "ESP_HOST")]
  pub esp_host: String,
  #[serde(rename = "ESP_PORT")]
  pub esp_port: String,
  #[serde(rename = "ESP_TCP_PORT")]
  pub esp_tcp_port: String,
  #[serde(rename = "ANDROID_MCP_PORT")]
  pub port: String,
  #[serde(rename = "ESP_SETUP_URL")]
  pub setup_url: String,
}

fn field(value: &Value, key: &str, default: &str) -> String {
  match &value[key] {
    Value::String(text) => text.trim().to_string(),
    Value::Number(number) => number.to_string(),
    Value::Null => default.to_string(),
    _ => String::new(),
  }
}

fn port(value: &str) -> Result<u16> {
  if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
    bail!("端口应为 1 到 65535 的整数。");
  }
  let port: u16 = value.parse().context("端口应为 1 到 65535 的整数")?;
  if port == 0 {
    bail!("端口应为 1 到 65535 的整数。");
  }
  Ok(port)
}

pub fn normalize_controller(value: &str, default_port: &str) -> Result<(String, u16)> {
  let address = value.trim().replace('：', ":");
  let mut host = address.clone();
  let mut selected = None;
  if address.contains([':', '/']) {
    let rest = address
      .strip_prefix("http://")
      .unwrap_or(&address)
      .trim_end_matches('/');
    if rest.contains('/') {
      bail!("设备控制器地址不应包含页面路径。");
    }
    if let Some((h, p)) = rest.split_once(':') {
      host = h.to_string();
      selected = Some(port(p)?);
    } else {
      host = rest.to_string();
    }
    let ip = host
      .parse::<std::net::Ipv4Addr>()
      .context("设备控制器地址应为内网 IPv4 地址")?;
    if !crate::lan::private_ipv4(ip) {
      bail!("设备控制器必须在私有局域网内。");
    }
  } else if !host.is_empty() {
    crate::lan::validate_host(&host)?;
  }
  let mut selected = match selected {
    Some(value) => value,
    None => port(default_port)?,
  };
  if selected == 3334 {
    selected = 3333;
  }
  Ok((host, selected))
}

impl Config {
  pub fn normalize(value: &Value) -> Result<Self> {
    if !value.is_object() {
      bail!("连接配置格式不正确。");
    }
    let mut screen = field(value, "ANDROID_SCREEN_URL", "").replace('：', ":");
    // Bare IP input uses the phone app's port. Full URLs also represent saved
    // configurations, so retain HTTP/HTTPS defaults and explicit custom ports.
    let implicit_screen_port = !screen.contains("://")
      && !screen.split('/').next().unwrap_or_default().contains(':');
    if !screen.contains("://") {
      screen = format!("http://{screen}");
    }
    let mut endpoint = Endpoint::parse(&screen).context("请填写手机投屏 App 显示的内网地址")?;
    if endpoint.path != "/" {
      bail!("手机投屏地址不应包含页面路径或查询参数。");
    }
    if implicit_screen_port {
      endpoint.port = 8791;
    }
    let (esp_host, esp_tcp_port) = normalize_controller(
      &field(value, "ESP_HOST", ""),
      &field(value, "ESP_TCP_PORT", "3333"),
    )?;
    let esp_port = field(value, "ESP_PORT", "COM5").to_uppercase();
    if esp_host.is_empty() {
      #[cfg(windows)]
      if esp_port.strip_prefix("COM").is_none_or(|v| {
        v.is_empty() || v.len() > 5 || v.starts_with('0') || !v.bytes().all(|c| c.is_ascii_digit())
      }) {
        bail!("请选择设备控制器 USB 串口，例如 COM5。");
      }
      #[cfg(not(windows))]
      if esp_port.is_empty() {
        bail!("An explicit serial port is required.");
      }
    }
    let local_port = port(&field(value, "ANDROID_MCP_PORT", "8790"))?;
    let device_id = field(value, "ANDROID_DEVICE_ID", "");
    if !device_id.is_empty() && !crate::screen::valid_device_id(&device_id) {
      bail!("手机设备 ID 格式不正确。");
    }
    let setup = field(value, "ESP_SETUP_URL", "");
    let setup_url = if setup.is_empty() {
      String::new()
    } else {
      let endpoint = Endpoint::parse(&setup)?;
      if endpoint.secure || endpoint.path != "/" {
        bail!("设备引导地址应为内网 HTTP 原点。");
      }
      endpoint.origin()
    };
    Ok(Self {
      screen_url: endpoint.origin(),
      device_id,
      esp_host,
      esp_port,
      esp_tcp_port: esp_tcp_port.to_string(),
      port: local_port.to_string(),
      setup_url,
    })
  }
  pub fn port(&self) -> u16 {
    self.port.parse().expect("normalized port")
  }
  pub fn tcp_port(&self) -> u16 {
    self.esp_tcp_port.parse().expect("normalized TCP port")
  }
  pub fn hash(&self) -> String {
    format!(
      "{:x}",
      Sha256::digest(serde_json::to_vec(self).expect("config JSON"))
    )
  }
  pub fn value(&self) -> Value {
    serde_json::to_value(self).expect("config JSON")
  }
  pub fn save(&self, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(
      &temporary,
      format!("{}\n", serde_json::to_string_pretty(self)?),
    )?;
    // Windows rename does not replace an existing file. MoveFileExW provides
    // an atomic replace, so a crash cannot leave a truncated configuration.
    #[cfg(windows)]
    {
      use std::os::windows::ffi::OsStrExt;
      #[link(name = "kernel32")]
      extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
      }
      let from = temporary
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
      let to = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
      if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
        return Err(std::io::Error::last_os_error().into());
      }
    }
    #[cfg(not(windows))]
    std::fs::rename(&temporary, path)?;
    Ok(())
  }
}

pub fn default_path() -> Result<PathBuf> {
  let exe = std::env::current_exe()?;
  let sidecar = exe
    .parent()
    .context("Executable directory missing")?
    .join("qdd-android.json");
  if sidecar.is_file() {
    return Ok(sidecar);
  }
  let local = std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
    .context("Cannot locate local configuration directory")?;
  // Both implementations deliberately use the same saved connection settings.
  Ok(local.join("QDDAndroid").join("config.json"))
}

pub fn environment_defaults() -> Value {
  let mut value = json!({});
  for key in [
    "ANDROID_SCREEN_URL",
    "ANDROID_DEVICE_ID",
    "ESP_HOST",
    "ESP_PORT",
    "ESP_TCP_PORT",
    "ANDROID_MCP_PORT",
    "ESP_SETUP_URL",
  ] {
    if let Ok(text) = std::env::var(key) {
      value[key] = Value::String(text);
    }
  }
  value
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn phone_address_defaults_only_bare_addresses_and_roundtrips() {
    for (address, expected, expected_port) in [
      ("192.168.1.2", "http://192.168.1.2:8791", 8791),
      (" 192.168.1.2/ ", "http://192.168.1.2:8791", 8791),
      ("192.168.1.2:8792", "http://192.168.1.2:8792", 8792),
      ("192.168.1.2：8791/", "http://192.168.1.2:8791", 8791),
      ("192.168.1.2:80", "http://192.168.1.2", 80),
      ("http://192.168.1.2", "http://192.168.1.2", 80),
      ("http://192.168.1.2/", "http://192.168.1.2", 80),
      ("http://192.168.1.2:80/", "http://192.168.1.2", 80),
      ("http://192.168.1.2:8791/", "http://192.168.1.2:8791", 8791),
      ("https://192.168.1.2", "https://192.168.1.2", 443),
      ("https://192.168.1.2:443/", "https://192.168.1.2", 443),
      ("https://192.168.1.2:9443/", "https://192.168.1.2:9443", 9443),
    ] {
      let config = Config::normalize(&json!({
        "ANDROID_SCREEN_URL": address,
        "ESP_HOST": "192.168.1.3"
      })).unwrap();
      assert_eq!(config.screen_url, expected, "input {address:?}");
      assert_eq!(Endpoint::parse(&config.screen_url).unwrap().port, expected_port);
      let saved = serde_json::to_vec(&config.value()).unwrap();
      let loaded = Config::normalize(&serde_json::from_slice(&saved).unwrap()).unwrap();
      assert_eq!(loaded.value(), config.value(), "saved input {address:?}");
    }
    for address in ["", "8.8.8.8", "192.168.1.2:0", "192.168.1.2:",
      "192.168.1.2/path", "http://192.168.1.2/?q=1", "192.168.1.2/#fragment"] {
      assert!(Config::normalize(&json!({"ANDROID_SCREEN_URL":address,"ESP_HOST":"192.168.1.3"})).is_err(), "input {address:?}");
    }
  }
  #[test]
  fn settings_normalize_pasted_board_page_and_reject_public_phone() {
    let value = json!({"ANDROID_SCREEN_URL":"192.168.1.2:8791","ESP_HOST":"http://192.168.1.3:3334/","unknown":"ignored"});
    let config = Config::normalize(&value).unwrap();
    assert_eq!(config.esp_host, "192.168.1.3");
    assert_eq!(config.tcp_port(), 3333);
    assert_eq!(config.screen_url, "http://192.168.1.2:8791");
    assert!(config.value().get("unknown").is_none());
    assert!(
      Config::normalize(&json!({"ANDROID_SCREEN_URL":"8.8.8.8","ESP_HOST":"192.168.1.3"})).is_err()
    );
    assert_eq!(
      normalize_controller("192.168.1.3:3333", "invalid")
        .unwrap()
        .1,
      3333
    );
    assert!(Config::normalize(&json!({"ANDROID_SCREEN_URL":"127.0.0.1:8791","ESP_HOST":"127.0.0.1","ANDROID_DEVICE_ID":"11111111111141118111111111111111"})).is_err());
    #[cfg(windows)]
    assert!(Config::normalize(
      &json!({"ANDROID_SCREEN_URL":"127.0.0.1:8791","ESP_PORT":"COM0001"})
    )
    .is_err());
  }
}
