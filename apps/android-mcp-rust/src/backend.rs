use crate::bridge::{Bridge, BridgeOptions};
use crate::config::Config;
use crate::input::{InputController, RemoteReport, ScreenGeometry};
use crate::live::LiveScreenSource;
use crate::mcp::{self, Backend, Guard};
use crate::screen::{ScreenCapture, ScreenClient};
use crate::{Cancel, Result};
use anyhow::{bail, Context};
use serde_json::{json, Value};
use std::sync::Arc;

pub struct DeviceBackend {
  pub input: InputController,
  pub bridge: Bridge,
  pub screen: Arc<ScreenClient>,
  pub live: Arc<LiveScreenSource>,
  pub runtime: Arc<tokio::runtime::Runtime>,
}

impl DeviceBackend {
  pub fn new(config: &Config) -> Result<Arc<Self>> {
    let runtime = Arc::new(
      tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?,
    );
    let _entered = runtime.enter();
    let options = if config.esp_host.is_empty() {
      BridgeOptions::serial(&config.esp_port, 115200)
    } else {
      BridgeOptions::tcp(&config.esp_host, config.tcp_port())
    };
    let bridge = Bridge::new(options)?;
    let input = InputController::new(
      bridge.clone(),
      ScreenGeometry {
        width: 1,
        height: 1,
        rotation: 0,
      },
    )?;
    let screen = Arc::new(ScreenClient::new(
      config.screen_url.clone(),
      if config.device_id.is_empty() {
        None
      } else {
        Some(config.device_id.clone())
      },
    )?);
    let live = Arc::new(LiveScreenSource::new(screen.clone()));
    drop(_entered);
    Ok(Arc::new(Self {
      input,
      bridge,
      screen,
      live,
      runtime,
    }))
  }
  pub fn close(&self) {
    let _ = self.runtime.block_on(self.input.stop());
    self.live.close();
    self.screen.close();
    let _ = self.runtime.block_on(self.bridge.close());
  }
}

fn int(args: &Value, key: &str, fallback: Option<i64>) -> Result<i64> {
  mcp::integer(args, key, fallback)
}
fn small(args: &Value, key: &str, fallback: Option<i64>) -> Result<i32> {
  i32::try_from(int(args, key, fallback)?).context("HID integer is out of range")
}
fn byte(args: &Value, key: &str, fallback: Option<i64>) -> Result<u8> {
  u8::try_from(int(args, key, fallback)?).context("HID byte is out of range")
}
fn text<'a>(args: &'a Value, key: &str, default: &'a str) -> &'a str {
  args[key].as_str().unwrap_or(default)
}

impl Backend for DeviceBackend {
  fn pointer_calibration(
    &self,
    serial: &str,
    cancel: &Cancel,
  ) -> Result<crate::screen::PointerCalibrationState> {
    self.screen.pointer_calibration(serial, cancel)
  }
  fn capture(&self, serial: Option<&str>, preview: bool, cancel: &Cancel) -> Result<ScreenCapture> {
    if preview {
      self.live.preview(serial, cancel)
    } else {
      self.live.capture(serial, cancel)
    }
  }
  fn input(
    &self,
    name: &str,
    args: &Value,
    cancel: &Cancel,
    guard: Option<Guard>,
  ) -> Result<Value> {
    mcp::check(cancel)?;
    let token = Some(cancel);
    match name {
      "android_hid_status" => Ok(serde_json::to_value(
        self.runtime.block_on(self.input.status(token))?,
      )?),
      "android_hid_arm" => Ok(self.arm(cancel)?.0),
      "android_hid_pause" => Ok(serde_json::to_value(
        self.runtime.block_on(self.input.pause())?,
      )?),
      "android_release" => Ok(serde_json::to_value(
        self.runtime.block_on(self.input.release_all())?,
      )?),
      "android_calibrate_pointer" => {
        if let Some(rotation) = args["rotation"].as_u64() {
          let old = self.input.state().screen;
          self.input.set_screen(ScreenGeometry {
            rotation: u8::try_from(rotation)?,
            ..old
          })?;
        }
        Ok(serde_json::to_value(self.input.set_calibration(
          mcp::number(args, "scaleX")?,
          mcp::number(args, "scaleY")?,
        )?)?)
      }
      "android_mouse_move" => Ok(serde_json::to_value(self.runtime.block_on(
        self.input.move_delta(
          int(args, "dx", None)?,
          int(args, "dy", None)?,
          int(args, "wheel", Some(0))?,
          byte(args, "buttons", Some(0))?,
          token,
          guard,
        ),
      )?)?),
      "android_mouse_click" => Ok(serde_json::to_value(self.runtime.block_on(
        self.input.click(
          text(args, "button", "left"),
          byte(args, "count", Some(1))?,
          token,
        ),
      )?)?),
      "android_mouse_button" => Ok(serde_json::to_value(
        self.runtime.block_on(
          self.input.mouse_button(
            text(args, "button", "left"),
            args["pressed"]
              .as_bool()
              .context("pressed must be boolean")?,
            token,
          ),
        )?,
      )?),
      "android_pointer_home" => Ok(serde_json::to_value(
        self
          .runtime
          .block_on(self.input.home_pointer(token, guard))?,
      )?),
      "android_pointer_to" => Ok(serde_json::to_value(self.runtime.block_on(
        self.input.pointer_to(
          mcp::number(args, "x")?,
          mcp::number(args, "y")?,
          byte(args, "buttons", Some(0))?,
          small(args, "wheel", Some(0))?,
          token,
          guard,
        ),
      )?)?),
      "android_hover" => Ok(serde_json::to_value(self.runtime.block_on(
        self.input.hover(
          mcp::number(args, "x")?,
          mcp::number(args, "y")?,
          token,
          guard,
        ),
      )?)?),
      "android_tap" => Ok(serde_json::to_value(self.runtime.block_on(
        self.input.tap(
          mcp::number(args, "x")?,
          mcp::number(args, "y")?,
          token,
          guard,
        ),
      )?)?),
      "android_swipe" => self.runtime.block_on(self.input.swipe(
        mcp::number(args, "x1")?,
        mcp::number(args, "y1")?,
        mcp::number(args, "x2")?,
        mcp::number(args, "y2")?,
        u64::try_from(int(args, "durationMs", Some(400))?)?,
        token,
        guard,
      )),
      "android_scroll" => {
        Ok(serde_json::to_value(self.runtime.block_on(
          self.input.scroll(int(args, "amount", None)?, token),
        )?)?)
      }
      "android_type" => {
        Ok(serde_json::to_value(self.runtime.block_on(
          self.input.type_text(mcp::text(args, "text")?, token),
        )?)?)
      }
      "android_key" => {
        Ok(serde_json::to_value(self.runtime.block_on(
          self.input.key(mcp::text(args, "combo")?, token),
        )?)?)
      }
      "android_key_report" => Ok(serde_json::to_value(self.runtime.block_on(
        self.input.key_report(
          small(args, "modifier", None)?,
          small(args, "keycode", None)?,
          token,
        ),
      )?)?),
      "android_consumer_report" => Ok(serde_json::to_value(
        self.runtime.block_on(
          self
            .input
            .consumer_report(small(args, "usage", None)?, token),
        )?,
      )?),
      "android_home" => Ok(serde_json::to_value(
        self.runtime.block_on(self.input.home(token))?,
      )?),
      "android_back" => Ok(serde_json::to_value(
        self.runtime.block_on(self.input.back(token))?,
      )?),
      "android_remote_report" => Ok(serde_json::to_value(
        self.runtime.block_on(
          self
            .input
            .remote_report(serde_json::from_value(args.clone())?, token),
        )?,
      )?),
      _ => bail!("Unknown input operation: {name}"),
    }
  }
  fn submit_remote(
    &self,
    report: Value,
    cancel: Cancel,
  ) -> Result<Box<dyn FnOnce() -> Result<Value> + Send>> {
    let report: RemoteReport = serde_json::from_value(report)?;
    let _entered = self.runtime.enter();
    let pending = self.input.submit_remote(report, cancel)?;
    let runtime = self.runtime.clone();
    Ok(Box::new(move || {
      Ok(serde_json::to_value(runtime.block_on(pending)?)?)
    }))
  }
  fn arm(&self, cancel: &Cancel) -> Result<(Value, u64)> {
    let _entered = self.runtime.enter();
    let (epoch, pending) = self.input.begin_arm(Some(cancel));
    let value = self.runtime.block_on(pending)?;
    Ok((serde_json::to_value(value)?, epoch))
  }
  fn release(&self, cancel: &Cancel) -> Result<(Value, u64)> {
    mcp::check(cancel)?;
    let _entered = self.runtime.enter();
    let (epoch, pending) = self.input.begin_release();
    let value = self.runtime.block_on(pending)?;
    Ok((serde_json::to_value(value)?, epoch))
  }
  fn state(&self) -> Value {
    serde_json::to_value(self.input.state()).expect("input state JSON")
  }
  fn control_epoch(&self) -> u64 {
    self.input.control_epoch()
  }
  fn input_revision(&self) -> u64 {
    self.input.input_revision()
  }
  fn observe(&self, frame: &ScreenCapture) -> Result<()> {
    self.input.set_screen(ScreenGeometry {
      width: frame.device_width,
      height: frame.device_height,
      rotation: frame.rotation.unwrap_or(0),
    })?;
    Ok(())
  }
  fn reset_calibration(&self) {
    self.input.reset_calibration();
  }
  fn stop(&self) -> Result<()> {
    self.runtime.block_on(self.input.stop())?;
    Ok(())
  }
  fn stop_if_epoch(&self, expected: u64) -> Result<bool> {
    self.runtime.block_on(self.input.stop_if_epoch(expected))
  }
  fn devices(&self) -> Result<Value> {
    let ports = serialport::available_ports()?
      .into_iter()
      .map(|p| json!({"path":p.port_name}))
      .collect::<Vec<_>>();
    let (android, errors) = match self.screen.list_devices() {
      Ok(devices) => (devices, Vec::<String>::new()),
      Err(error) => (json!([]), vec![error.to_string()]),
    };
    Ok(json!({"android":android,"serialPorts":ports,"errors":errors}))
  }
  fn profile(&self, selected: Option<&str>, cancel: &Cancel) -> Result<Value> {
    mcp::check(cancel)?;
    let value = if let Some(profile) = selected {
      self.live.set_preview_profile(profile)?
    } else {
      self.live.get_preview_profile()?
    };
    mcp::check(cancel)?;
    Ok(value)
  }
}
