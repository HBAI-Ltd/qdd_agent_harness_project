//! Explicit, single-submission UTF-8 channel. A queued COMMIT is never success.
use crate::Result;
use anyhow::{bail, ensure, Context};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_TEXT_BYTES: usize = 512;
pub const TEXT_CHUNK_BYTES: usize = 24;
static LAST_TRANSFER_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct TextTransferError {
  pub transfer_id: u64,
  pub uncertain: bool,
  pub message: String,
}
impl std::fmt::Display for TextTransferError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(
      f,
      "{} Transfer {:016x}; {}. Text/COMMIT was not retried.",
      self.message,
      self.transfer_id,
      if self.uncertain {
        "delivery is uncertain: observe the phone and never blindly resubmit"
      } else {
        "text was not accepted by the phone"
      }
    )
  }
}
impl std::error::Error for TextTransferError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextPhase {
  Idle,
  Receiving,
  Queued,
  Sending,
  AwaitingAck,
  Accepted,
  Rejected,
  Uncertain,
  Cancelled,
  ClipboardDispatched,
  ClipboardVerified,
  PastePending,
  PasteSent,
  PasteUncertain,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextMode {
  #[default]
  Ime,
  Clipboard,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStatus {
  pub id: String,
  pub status: TextPhase,
  pub editor_epoch: u32,
  pub ready: bool,
  pub received: usize,
  pub bytes: usize,
  #[serde(default)]
  pub mode: TextMode,
  #[serde(default)]
  pub clipboard_verified: bool,
  #[serde(default)]
  pub paste_sent: bool,
  #[serde(default)]
  pub insertion_verified: bool,
}
impl TextStatus {
  pub fn validate(&self) -> Result<()> {
    parse_transfer_id(&self.id)?;
    ensure!(
      !self.insertion_verified,
      "Text protocol cannot verify target App insertion."
    );
    let clipboard_phase = matches!(
      self.status,
      TextPhase::ClipboardDispatched
        | TextPhase::ClipboardVerified
        | TextPhase::PastePending
        | TextPhase::PasteSent
        | TextPhase::PasteUncertain
    );
    ensure!(
      !clipboard_phase || self.mode == TextMode::Clipboard,
      "Clipboard state has the wrong receiver mode."
    );
    ensure!(
      self.status != TextPhase::Accepted || self.mode == TextMode::Ime,
      "Legacy IME acceptance cannot confirm a clipboard transfer."
    );
    ensure!(
      !self.clipboard_verified
        || (self.mode == TextMode::Clipboard
          && matches!(
            self.status,
            TextPhase::ClipboardVerified
              | TextPhase::PastePending
              | TextPhase::PasteSent
              | TextPhase::PasteUncertain
              | TextPhase::Cancelled
          )),
      "Clipboard verification is inconsistent with its transfer state."
    );
    ensure!(
      self.status != TextPhase::ClipboardVerified || self.clipboard_verified,
      "Verified clipboard state lacks confirmation."
    );
    ensure!(
      self.paste_sent == (self.status == TextPhase::PasteSent),
      "Paste confirmation is inconsistent with its state."
    );
    ensure!(
      self.bytes <= MAX_TEXT_BYTES && self.received <= self.bytes,
      "Invalid text transfer byte counts."
    );
    ensure!(
      !self.ready || self.editor_epoch != 0,
      "Ready text editor has no epoch."
    );
    ensure!(
      self.status == TextPhase::Idle || (self.id != "0000000000000000" && self.editor_epoch != 0),
      "Active text transfer has no identity or editor epoch."
    );
    if matches!(
      self.status,
      TextPhase::Queued | TextPhase::Sending | TextPhase::AwaitingAck
    ) {
      ensure!(
        self.bytes > 0 && self.received == self.bytes,
        "Committed text transfer is incomplete."
      );
    }
    if matches!(
      self.status,
      TextPhase::Accepted
        | TextPhase::Rejected
        | TextPhase::Uncertain
        | TextPhase::Cancelled
        | TextPhase::ClipboardDispatched
        | TextPhase::ClipboardVerified
        | TextPhase::PastePending
        | TextPhase::PasteSent
        | TextPhase::PasteUncertain
    ) {
      ensure!(
        self.received == self.bytes,
        "Terminal text byte counts are inconsistent."
      );
    }
    Ok(())
  }
}

pub enum TextCommand<'a> {
  Begin {
    transfer: u64,
    editor_epoch: u32,
    bytes: usize,
  },
  ClipBegin {
    transfer: u64,
    editor_epoch: u32,
    bytes: usize,
  },
  Data {
    transfer: u64,
    offset: usize,
    bytes: &'a [u8],
  },
  Commit(u64),
  Status(u64),
  Cancel(u64),
  Paste(u64),
}
impl TextCommand<'_> {
  pub fn name(&self) -> &'static str {
    match self {
      Self::Begin { .. } => "BEGIN",
      Self::ClipBegin { .. } => "CLIP_BEGIN",
      Self::Data { .. } => "DATA",
      Self::Commit(_) => "COMMIT",
      Self::Status(_) => "STATUS",
      Self::Cancel(_) => "CANCEL",
      Self::Paste(_) => "PASTE",
    }
  }
  pub fn encode(&self, request_id: u32) -> Result<String> {
    ensure!(
      (1..=crate::protocol::MAX_REQUEST_ID).contains(&request_id),
      "Invalid text request id."
    );
    let arguments = match self {
      Self::Begin {
        transfer,
        editor_epoch,
        bytes,
      }
      | Self::ClipBegin {
        transfer,
        editor_epoch,
        bytes,
      } => {
        ensure!(
          *transfer != 0 && *editor_epoch != 0 && (1..=MAX_TEXT_BYTES).contains(bytes),
          "Invalid text BEGIN."
        );
        format!("{transfer:016x} {editor_epoch} {bytes}")
      }
      Self::Data {
        transfer,
        offset,
        bytes,
      } => {
        ensure!(
          *transfer != 0
            && !bytes.is_empty()
            && bytes.len() <= TEXT_CHUNK_BYTES
            && *offset < MAX_TEXT_BYTES
            && offset + bytes.len() <= MAX_TEXT_BYTES,
          "Invalid text DATA."
        );
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("{transfer:016x} {offset} {hex}")
      }
      Self::Commit(transfer) | Self::Cancel(transfer) | Self::Paste(transfer) => {
        ensure!(*transfer != 0, "Invalid text transfer id.");
        format!("{transfer:016x}")
      }
      Self::Status(transfer) => format!("{transfer:016x}"),
    };
    let line = format!("QDDTXT/1 {request_id} {} {arguments}\n", self.name());
    ensure!(
      line.len() <= crate::protocol::MAX_HID_LINE_BYTES,
      "Text command exceeds 128 bytes."
    );
    Ok(line)
  }
}

pub enum TextReply {
  Ok { id: u32, status: TextStatus },
  Err { id: u32, code: String },
}
pub fn decode_reply(raw: &str) -> Result<Option<TextReply>> {
  let line = raw.trim();
  if !line.starts_with("QDDTXT/1") {
    return Ok(None);
  }
  let (id, remainder) = line
    .strip_prefix("QDDTXT/1 ")
    .context("Malformed text reply.")?
    .split_once(' ')
    .context("Malformed text reply.")?;
  ensure!(
    !id.is_empty() && !id.starts_with('0') && id.bytes().all(|byte| byte.is_ascii_digit()),
    "Invalid text reply id."
  );
  let id: u32 = id.parse().context("Invalid text reply id.")?;
  ensure!(
    (1..=crate::protocol::MAX_REQUEST_ID).contains(&id),
    "Invalid text reply id."
  );
  let (kind, body) = remainder.split_once(' ').unwrap_or((remainder, ""));
  match kind {
    "OK" => {
      let status: TextStatus = serde_json::from_str(body)
        .context("Invalid QDDTXT/1 status; update matching ESP firmware.")?;
      status.validate()?;
      Ok(Some(TextReply::Ok { id, status }))
    }
    "ERR" => {
      ensure!(
        body.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
          && body
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
        "Malformed text error code."
      );
      Ok(Some(TextReply::Err {
        id,
        code: body.into(),
      }))
    }
    _ => bail!("Malformed text reply."),
  }
}

pub fn validate_text(text: &str) -> Result<()> {
  ensure!(!text.as_bytes().contains(&0), "Text must not contain NUL.");
  if !text.is_ascii() {
    ensure!(
      (1..=MAX_TEXT_BYTES).contains(&text.len()),
      "Unicode text must contain 1..512 UTF-8 bytes; split it into intentional separate calls."
    );
  }
  Ok(())
}
pub fn parse_transfer_id(value: &str) -> Result<u64> {
  ensure!(
    value.len() == 16
      && value
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
    "Text transfer identity must be exactly 16 lowercase hexadecimal characters."
  );
  Ok(u64::from_str_radix(value, 16)?)
}
pub fn next_transfer_id(previous: u64) -> Result<u64> {
  let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_micros();
  ensure!(
    now <= u128::from(u64::MAX),
    "Text transfer timestamp overflow."
  );
  let minimum = previous
    .checked_add(1)
    .context("Text transfer identity exhausted.")?
    .max(now as u64)
    .max(1);
  let mut last = LAST_TRANSFER_ID.load(Ordering::SeqCst);
  loop {
    let next = last
      .checked_add(1)
      .context("Text transfer identity exhausted.")?
      .max(minimum);
    match LAST_TRANSFER_ID.compare_exchange(last, next, Ordering::SeqCst, Ordering::SeqCst) {
      Ok(_) => return Ok(next),
      Err(changed) => last = changed,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn text_wire_is_bounded_hex_and_utf8_is_validated_before_begin() {
    validate_text("中文🙂").unwrap();
    assert!(validate_text("中\0文").is_err());
    assert!(validate_text(&"中".repeat(171)).is_err());
    let line = TextCommand::Data {
      transfer: 1,
      offset: 0,
      bytes: "中".as_bytes(),
    }
    .encode(2)
    .unwrap();
    assert_eq!(line, "QDDTXT/1 2 DATA 0000000000000001 0 e4b8ad\n");
    assert!(TextCommand::Data {
      transfer: 1,
      offset: 0,
      bytes: &[0; 25]
    }
    .encode(1)
    .is_err());
    assert!(TextCommand::Begin {
      transfer: 1,
      editor_epoch: 0,
      bytes: 3
    }
    .encode(1)
    .is_err());
    assert!(
      TextCommand::Data {
        transfer: u64::MAX,
        offset: 488,
        bytes: &[255; 24]
      }
      .encode(crate::protocol::MAX_REQUEST_ID)
      .unwrap()
      .len()
        <= 128
    );
  }
  #[test]
  fn text_reply_does_not_confuse_queued_with_accepted_and_checks_identity() {
    let raw = "QDDTXT/1 1 OK {\"id\":\"0000000000000001\",\"status\":\"queued\",\"editorEpoch\":3,\"ready\":true,\"received\":6,\"bytes\":6}";
    let Some(TextReply::Ok { status, .. }) = decode_reply(raw).unwrap() else {
      panic!()
    };
    assert_eq!(status.status, TextPhase::Queued);
    assert_eq!(status.mode, TextMode::Ime);
    assert!(decode_reply(&raw.replace("0000000000000001", "1")).is_err());
    assert!(decode_reply(&raw.replace("\"bytes\":6", "\"bytes\":513")).is_err());
    assert!(decode_reply("QDDHID/1 1 ERR NOT_ARMED").unwrap().is_none());
  }
  #[test]
  fn ime_acceptance_never_claims_clipboard_paste_or_verified_target_insertion() {
    let base = serde_json::json!({"id":"0000000000000001","status":"accepted","editorEpoch":7,
      "ready":true,"received":0,"bytes":0,"mode":"ime","clipboardVerified":false,"pasteSent":false});
    let Some(TextReply::Ok { status, .. }) =
      decode_reply(&format!("QDDTXT/1 1 OK {base}")).unwrap()
    else {
      panic!()
    };
    assert_eq!(status.mode, TextMode::Ime);
    assert_eq!(status.status, TextPhase::Accepted);
    assert!(!status.clipboard_verified && !status.paste_sent && !status.insertion_verified);
    for (key, value) in [
      ("mode", serde_json::json!("clipboard")),
      ("status", serde_json::json!("clipboard_dispatched")),
      ("status", serde_json::json!("clipboard_verified")),
      ("status", serde_json::json!("paste_sent")),
      ("clipboardVerified", serde_json::json!(true)),
      ("pasteSent", serde_json::json!(true)),
      ("insertionVerified", serde_json::json!(true)),
    ] {
      let mut body = base.clone();
      body[key] = value;
      assert!(
        decode_reply(&format!("QDDTXT/1 1 OK {body}")).is_err(),
        "{body}"
      );
    }
  }
  #[test]
  fn clipboard_commands_are_distinct_bounded_and_never_allow_anonymous_paste() {
    assert_eq!(
      TextCommand::ClipBegin {
        transfer: 1,
        editor_epoch: 7,
        bytes: 6
      }
      .encode(2)
      .unwrap(),
      "QDDTXT/1 2 CLIP_BEGIN 0000000000000001 7 6\n"
    );
    assert_eq!(
      TextCommand::Paste(1).encode(3).unwrap(),
      "QDDTXT/1 3 PASTE 0000000000000001\n"
    );
    assert!(TextCommand::Paste(0).encode(3).is_err());
    assert!(TextCommand::ClipBegin {
      transfer: 1,
      editor_epoch: 0,
      bytes: 6
    }
    .encode(2)
    .is_err());
    assert!(TextCommand::ClipBegin {
      transfer: 1,
      editor_epoch: 7,
      bytes: MAX_TEXT_BYTES + 1
    }
    .encode(2)
    .is_err());
    assert!(
      TextCommand::ClipBegin {
        transfer: u64::MAX,
        editor_epoch: u32::MAX,
        bytes: MAX_TEXT_BYTES
      }
      .encode(crate::protocol::MAX_REQUEST_ID)
      .unwrap()
      .len()
        <= crate::protocol::MAX_HID_LINE_BYTES
    );
  }
  #[test]
  fn clipboard_reply_preserves_dispatch_verification_and_paste_as_separate_facts() {
    for (phase, verified, sent) in [
      ("clipboard_dispatched", false, false),
      ("clipboard_verified", true, false),
      ("paste_pending", false, false),
      ("paste_pending", true, false),
      ("paste_sent", false, true),
      ("paste_sent", true, true),
      ("paste_uncertain", true, false),
      ("cancelled", true, false),
    ] {
      let body = serde_json::json!({"id":"ffffffffffffffff","status":phase,"editorEpoch":u32::MAX,
        "ready":true,"received":0,"bytes":0,"mode":"clipboard","clipboardVerified":verified,"pasteSent":sent});
      let Some(TextReply::Ok { status, .. }) =
        decode_reply(&format!("QDDTXT/1 2147483647 OK {body}")).unwrap()
      else {
        panic!()
      };
      let result = serde_json::to_value(status).unwrap();
      assert_eq!(result["mode"], "clipboard");
      assert_eq!(result["clipboardVerified"], verified);
      assert_eq!(result["pasteSent"], sent);
      assert_eq!(result["insertionVerified"], false);
    }
  }
  #[test]
  fn clipboard_reply_rejects_legacy_acceptance_false_confirmation_and_unknown_mode() {
    let base = serde_json::json!({"id":"0000000000000001","status":"clipboard_dispatched","editorEpoch":7,
      "ready":true,"received":0,"bytes":0,"mode":"clipboard","clipboardVerified":false,"pasteSent":false});
    for (key, value) in [
      ("status", serde_json::json!("accepted")),
      ("status", serde_json::json!("clipboard_verified")),
      ("status", serde_json::json!("paste_sent")),
      ("mode", serde_json::json!("ime")),
      ("mode", serde_json::json!("future")),
      ("clipboardVerified", serde_json::json!(true)),
      ("pasteSent", serde_json::json!(true)),
      ("insertionVerified", serde_json::json!(true)),
      ("editorEpoch", serde_json::json!(0)),
      ("id", serde_json::json!("0000000000000000")),
    ] {
      let mut body = base.clone();
      body[key] = value;
      assert!(
        decode_reply(&format!("QDDTXT/1 1 OK {body}")).is_err(),
        "{body}"
      );
    }
  }
  #[test]
  fn transfer_id_is_newer_than_board_state_and_local_concurrent_calls() {
    let first = next_transfer_id(0).unwrap();
    let resumed = next_transfer_id(first + 1000).unwrap();
    assert!(resumed > first + 1000);
    assert!(next_transfer_id(0).unwrap() > resumed);
    assert!(next_transfer_id(u64::MAX).is_err());
  }
}
