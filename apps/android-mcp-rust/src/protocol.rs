use crate::Result;
use anyhow::{bail, ensure, Context};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;

pub const HID_PROTOCOL: &str = "QDDHID/1";
pub const MAX_HID_LINE_BYTES: usize = 128;
pub const MAX_REQUEST_ID: u32 = 2_147_483_647;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HidOperation {
  Ping,
  Status,
  Arm,
  Pause,
  Release,
  Pair,
  PairStatus,
  Move,
  Key,
  Consumer,
}

impl HidOperation {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Ping => "PING",
      Self::Status => "STATUS",
      Self::Arm => "ARM",
      Self::Pause => "PAUSE",
      Self::Release => "RELEASE",
      Self::Pair => "PAIR",
      Self::PairStatus => "PAIR_STATUS",
      Self::Move => "MOVE",
      Self::Key => "KEY",
      Self::Consumer => "CONSUMER",
    }
  }
  pub fn starts_round(self) -> bool {
    matches!(self, Self::Arm | Self::Pause | Self::Release)
  }
  pub fn is_input(self) -> bool {
    matches!(self, Self::Move | Self::Key | Self::Consumer)
  }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HidStatus {
  pub v: u8,
  pub connected: bool,
  pub encrypted: bool,
  pub armed: bool,
  pub locked: bool,
  pub bonded: bool,
  pub name: String,
  #[serde(flatten)]
  pub extra: Map<String, Value>,
}

impl HidStatus {
  pub fn input_ready(&self) -> bool {
    self.connected && self.encrypted && self.bonded && self.armed && !self.locked
  }
}

#[derive(Debug)]
pub enum HidReply {
  Ok { id: u32, status: HidStatus },
  Err { id: u32, code: String },
}

#[derive(Debug)]
pub struct HidProtocolError {
  pub code: String,
  pub message: String,
}
impl fmt::Display for HidProtocolError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(&self.message)
  }
}
impl std::error::Error for HidProtocolError {}

#[derive(Debug)]
pub struct HidCancelled;
impl fmt::Display for HidCancelled {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("HID operation cancelled.")
  }
}
impl std::error::Error for HidCancelled {}

#[derive(Debug)]
pub struct AckTimeoutError(pub HidOperation);
impl fmt::Display for AckTimeoutError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(
      f,
      "ESP32 {} acknowledgement timed out; action was not retried.",
      self.0.as_str()
    )
  }
}
impl std::error::Error for AckTimeoutError {}

pub fn encode_command(id: u32, op: HidOperation, args: &[i32]) -> Result<String> {
  ensure!(
    (1..=MAX_REQUEST_ID).contains(&id),
    "Request id must be an integer between 1 and 2147483647."
  );
  let ranges: &[(i32, i32)] = match op {
    HidOperation::Move => &[(-127, 127), (-127, 127), (-127, 127), (0, 7)],
    HidOperation::Key => &[(0, 255), (0, 255)],
    HidOperation::Consumer => &[(0, 65535)],
    _ => &[],
  };
  ensure!(
    args.len() == ranges.len(),
    "Invalid arguments for {}.",
    op.as_str()
  );
  for (i, (&value, &(min, max))) in args.iter().zip(ranges).enumerate() {
    ensure!(
      (min..=max).contains(&value),
      "Argument {} for {} must be an integer from {} to {}.",
      i + 1,
      op.as_str(),
      min,
      max
    );
  }
  let mut line = format!("{HID_PROTOCOL} {id} {}", op.as_str());
  for arg in args {
    line.push(' ');
    line.push_str(&arg.to_string());
  }
  line.push('\n');
  ensure!(
    line.len() <= MAX_HID_LINE_BYTES,
    "HID command exceeds the 128 byte line limit."
  );
  Ok(line)
}

pub fn decode_reply(raw: &str) -> Result<Option<HidReply>> {
  let line = raw.trim();
  if !line.starts_with(HID_PROTOCOL) {
    return Ok(None);
  }
  let rest = line
    .strip_prefix("QDDHID/1 ")
    .context("Malformed HID reply.")?;
  let (id, rest) = rest.split_once(' ').context("Malformed HID reply.")?;
  ensure!(
    !id.is_empty() && !id.starts_with('0') && id.bytes().all(|c| c.is_ascii_digit()),
    "Invalid HID reply id."
  );
  let id: u32 = id.parse().context("Invalid HID reply id.")?;
  ensure!((1..=MAX_REQUEST_ID).contains(&id), "Invalid HID reply id.");
  let (kind, payload) = rest.split_once(' ').unwrap_or((rest, ""));
  match kind {
    "ERR" => {
      ensure!(
        payload
          .as_bytes()
          .first()
          .is_some_and(u8::is_ascii_uppercase)
          && payload
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_'),
        "Malformed HID error code."
      );
      Ok(Some(HidReply::Err {
        id,
        code: payload.to_owned(),
      }))
    }
    "OK" => {
      let status: HidStatus = serde_json::from_str(payload)
        .context("Incomplete QDDHID/1 status. Check that the board runs matching firmware.")?;
      ensure!(
        status.v == 1,
        "Incomplete QDDHID/1 status. Check that the board runs matching firmware."
      );
      Ok(Some(HidReply::Ok { id, status }))
    }
    _ => bail!("Malformed HID reply."),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn boundaries_and_injection_are_rejected() {
    assert_eq!(
      encode_command(1, HidOperation::Move, &[-127, 127, 0, 7]).unwrap(),
      "QDDHID/1 1 MOVE -127 127 0 7\n"
    );
    assert!(encode_command(0, HidOperation::Ping, &[]).is_err());
    assert!(encode_command(MAX_REQUEST_ID + 1, HidOperation::Ping, &[]).is_err());
    assert!(encode_command(1, HidOperation::Move, &[128, 0, 0, 0]).is_err());
    assert!(encode_command(1, HidOperation::Consumer, &[65536]).is_err());
    assert!(decode_reply("QDDHID/1 1 ERR CONTROL_BUSY\nARM").is_err());
  }
  #[test]
  fn status_is_complete_and_preserves_extensions() {
    assert!(decode_reply("I (0) boot: ready").unwrap().is_none());
    let line = r#"QDDHID/1 2 OK {"v":1,"connected":true,"encrypted":true,"armed":false,"locked":false,"bonded":true,"name":"控制板","pairing":true}"#;
    let Some(HidReply::Ok { status, .. }) = decode_reply(line).unwrap() else {
      panic!()
    };
    assert_eq!(status.extra["pairing"], true);
    assert!(decode_reply("QDDHID/1 1 OK {}").is_err());
    assert!(decode_reply("QDDHID/1 01 ERR BUSY").is_err());
  }
}
