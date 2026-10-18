pub const OPERATOR_HTML: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/assets/operator.html"));
pub const OPERATOR_CSS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/assets/operator.css"));
pub const OPERATOR_JS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/assets/operator.js"));
pub const REMOTE_CHANNEL_JS: &[u8] =
  include_bytes!(concat!(env!("OUT_DIR"), "/assets/remote-channel.js"));
pub const SCREEN_CHANNEL_JS: &[u8] =
  include_bytes!(concat!(env!("OUT_DIR"), "/assets/screen-channel.js"));
pub const SETTINGS_HTML: &str = include_str!(concat!(env!("OUT_DIR"), "/assets/settings.html"));
pub const TOOLS_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/assets/tools.json"));
