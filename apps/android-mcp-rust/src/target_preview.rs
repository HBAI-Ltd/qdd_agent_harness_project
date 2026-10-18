use crate::{
  screen::{
    cancellable_lock, check_cancel, read_jpeg_dimensions, read_png_dimensions,
    MAX_SCREEN_FRAME_BYTES,
  },
  Cancel, Result,
};
use anyhow::{anyhow, bail, ensure, Context};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::{
  io::{BufRead, BufReader, Cursor, Read, Write},
  process::{Child, Command, Stdio},
  sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Mutex,
  },
  thread,
  time::{Duration, Instant},
};

pub const MAX_TARGET_PREVIEW_DIMENSION: u32 = 8192;
pub const MAX_TARGET_PREVIEW_PIXELS: u64 = 16 * 1024 * 1024;
const RENDER_TIMEOUT: Duration = Duration::from_secs(5);
static JOBS: AtomicUsize = AtomicUsize::new(0);
static RENDER_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Crop {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
  pub scale: u32,
}
#[derive(Clone, Debug)]
pub struct TargetPreview {
  pub png: Vec<u8>,
  pub zoom_png: Vec<u8>,
  pub crop: Crop,
  pub simulated_target: bool,
  pub annotation: PreviewAnnotation,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rect {
  pub x: u32,
  pub y: u32,
  pub width: u32,
  pub height: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotatedImage {
  pub width: u32,
  pub height: u32,
  pub source_rect: Rect,
  pub legend: Rect,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAnnotation {
  pub coordinate_space: String,
  pub label: String,
  pub original: AnnotatedImage,
  pub zoom: AnnotatedImage,
}

#[derive(Serialize, Deserialize)]
struct WorkerJob {
  mime_type: String,
  width: u32,
  height: u32,
  x: u32,
  y: u32,
  bytes: usize,
}
#[derive(Serialize, Deserialize)]
struct WorkerReply {
  ok: bool,
  message: Option<String>,
  png_bytes: usize,
  zoom_bytes: usize,
  crop: Option<Crop>,
  annotation: Option<PreviewAnnotation>,
}

/// A bounded child process lets cancellation actually stop a decoder or encoder.
/// The same executable supplies the worker; no extra runtime or file is shipped.
pub fn render_target_preview(
  bytes: &[u8],
  mime_type: &str,
  width: u32,
  height: u32,
  x: u32,
  y: u32,
  cancel: &Cancel,
) -> Result<TargetPreview> {
  check_cancel(cancel)?;
  valid_geometry(width, height, x, y)?;
  ensure!(
    !bytes.is_empty() && bytes.len() <= MAX_SCREEN_FRAME_BYTES,
    "Target preview input must contain 1 to 32 MiB."
  );
  let _slot = JobSlot::acquire()?;
  let _serial = cancellable_lock(&RENDER_LOCK, cancel)?;
  check_cancel(cancel)?;
  // A libtest executable has its own main and cannot dispatch our worker flag.
  // Production child-process cancellation is exercised by the EXE integration checks.
  if cfg!(test) {
    return render_local(bytes, mime_type, width, height, x, y, cancel);
  }
  let job = WorkerJob {
    mime_type: mime_type.into(),
    width,
    height,
    x,
    y,
    bytes: bytes.len(),
  };
  let mut command = Command::new(std::env::current_exe()?);
  command
    .arg("--target-preview-worker")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
  }
  let mut child = ChildGuard(
    command
      .spawn()
      .context("Cannot start target preview worker")?,
  );
  let mut input = child.0.stdin.take().unwrap();
  let mut output = child.0.stdout.take().unwrap();
  let encoded = bytes.to_vec();
  let writer = thread::spawn(move || -> Result<()> {
    serde_json::to_writer(&mut input, &job)?;
    input.write_all(b"\n")?;
    input.write_all(&encoded)?;
    input.flush()?;
    Ok(())
  });
  let (sender, receiver) = mpsc::sync_channel(1);
  let reader = thread::spawn(move || {
    let mut bytes = Vec::new();
    let result = output
      .by_ref()
      .take((MAX_SCREEN_FRAME_BYTES * 2 + 4097) as u64)
      .read_to_end(&mut bytes)
      .map(|_| bytes);
    let _ = sender.send(result);
  });
  let started = Instant::now();
  let status = loop {
    if cancel.is_cancelled() || started.elapsed() >= RENDER_TIMEOUT {
      let _ = child.0.kill();
      let _ = child.0.wait();
      let _ = writer.join();
      let _ = reader.join();
      if cancel.is_cancelled() {
        bail!("Target preview cancelled; no phone input was sent.");
      }
      bail!("Target preview rendering timed out; no phone input was sent.");
    }
    if let Some(status) = child.0.try_wait()? {
      break status;
    }
    thread::sleep(Duration::from_millis(5));
  };
  let writer_result = writer
    .join()
    .map_err(|_| anyhow!("Target preview writer failed"))?;
  let bytes = receiver
    .recv_timeout(Duration::from_secs(1))
    .context("Target preview worker returned no output")??;
  let _ = reader.join();
  ensure!(
    status.success(),
    "Target preview worker exited before returning an image ({status})."
  );
  writer_result?;
  check_cancel(cancel)?;
  let end = bytes
    .iter()
    .position(|b| *b == b'\n')
    .ok_or_else(|| anyhow!("Target preview worker returned invalid output"))?;
  ensure!(
    end <= 4096,
    "Target preview worker response header too large"
  );
  let reply: WorkerReply = serde_json::from_slice(&bytes[..end])?;
  ensure!(
    reply.ok,
    "Cannot render target preview: {}",
    reply.message.unwrap_or_else(|| "worker failed".into())
  );
  ensure!(
    reply.png_bytes <= MAX_SCREEN_FRAME_BYTES
      && reply.zoom_bytes <= MAX_SCREEN_FRAME_BYTES
      && reply
        .png_bytes
        .checked_add(reply.zoom_bytes)
        .and_then(|n| n.checked_add(end + 1))
        == Some(bytes.len()),
    "Target preview worker image sizes are invalid"
  );
  let split = end + 1 + reply.png_bytes;
  Ok(TargetPreview {
    png: bytes[end + 1..split].to_vec(),
    zoom_png: bytes[split..].to_vec(),
    crop: reply
      .crop
      .ok_or_else(|| anyhow!("Target preview worker omitted crop geometry"))?,
    simulated_target: true,
    annotation: reply.annotation.context("Target preview worker omitted annotation geometry")?,
  })
}

/// Called before the service is configured; this path never opens phone/HID I/O.
pub fn run_worker() -> Result<()> {
  let result = (|| -> Result<TargetPreview> {
    let mut input = BufReader::new(std::io::stdin().lock());
    let header = bounded_line(&mut input, 2048)?;
    let job: WorkerJob = serde_json::from_slice(&header)?;
    valid_geometry(job.width, job.height, job.x, job.y)?;
    ensure!(
      job.bytes > 0 && job.bytes <= MAX_SCREEN_FRAME_BYTES,
      "Target preview encoded image size is invalid"
    );
    let mut bytes = vec![0; job.bytes];
    input.read_exact(&mut bytes)?;
    let mut trailing = [0];
    ensure!(
      input.read(&mut trailing)? == 0,
      "Unexpected bytes after image"
    );
    render_local(
      &bytes,
      &job.mime_type,
      job.width,
      job.height,
      job.x,
      job.y,
      &Cancel::new(),
    )
  })();
  let mut output = std::io::stdout().lock();
  match result {
    Ok(rendered) => {
      let reply = WorkerReply {
        ok: true,
        message: None,
        png_bytes: rendered.png.len(),
        zoom_bytes: rendered.zoom_png.len(),
        crop: Some(rendered.crop),
        annotation: Some(rendered.annotation),
      };
      serde_json::to_writer(&mut output, &reply)?;
      output.write_all(b"\n")?;
      output.write_all(&rendered.png)?;
      output.write_all(&rendered.zoom_png)?;
    }
    Err(error) => {
      let reply = WorkerReply {
        ok: false,
        message: Some(error.to_string()),
        png_bytes: 0,
        zoom_bytes: 0,
        crop: None,
        annotation: None,
      };
      serde_json::to_writer(&mut output, &reply)?;
      output.write_all(b"\n")?;
    }
  }
  output.flush()?;
  Ok(())
}

fn bounded_line<R: BufRead>(input: &mut R, max: usize) -> Result<Vec<u8>> {
  let mut bytes = vec![];
  loop {
    let available = input.fill_buf()?;
    ensure!(!available.is_empty(), "Missing target preview job header");
    let end = available.iter().position(|b| *b == b'\n');
    let count = end.map_or(available.len(), |n| n + 1);
    ensure!(
      bytes.len() + count <= max,
      "Target preview job header too large"
    );
    bytes.extend_from_slice(&available[..count]);
    input.consume(count);
    if end.is_some() {
      bytes.pop();
      return Ok(bytes);
    }
  }
}

struct JobSlot;
impl JobSlot {
  fn acquire() -> Result<Self> {
    JOBS
      .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
        (n < 2).then_some(n + 1)
      })
      .map_err(|_| anyhow!("Target preview renderer is busy; wait for the current preview."))?;
    Ok(Self)
  }
}
impl Drop for JobSlot {
  fn drop(&mut self) {
    JOBS.fetch_sub(1, Ordering::AcqRel);
  }
}
struct ChildGuard(Child);
impl Drop for ChildGuard {
  fn drop(&mut self) {
    let _ = self.0.kill();
    let _ = self.0.wait();
  }
}

fn valid_geometry(width: u32, height: u32, x: u32, y: u32) -> Result<()> {
  ensure!(
    width > 0
      && height > 0
      && width <= MAX_TARGET_PREVIEW_DIMENSION
      && height <= MAX_TARGET_PREVIEW_DIMENSION
      && u64::from(width) * u64::from(height) <= MAX_TARGET_PREVIEW_PIXELS,
    "Target preview dimensions must be at most 8192 per side and 16777216 pixels."
  );
  ensure!(
    x < width && y < height,
    "Target coordinates must be inside the original image."
  );
  Ok(())
}

fn render_local(
  bytes: &[u8],
  mime_type: &str,
  width: u32,
  height: u32,
  x: u32,
  y: u32,
  cancel: &Cancel,
) -> Result<TargetPreview> {
  valid_geometry(width, height, x, y)?;
  check_cancel(cancel)?;
  ensure!(
    !bytes.is_empty() && bytes.len() <= MAX_SCREEN_FRAME_BYTES,
    "Target preview input exceeds the image byte limit"
  );
  let (format, dimensions) = match mime_type {
    "image/jpeg" => (ImageFormat::Jpeg, read_jpeg_dimensions(bytes)?),
    "image/png" => (ImageFormat::Png, read_png_dimensions(bytes)?),
    _ => bail!("Target preview supports only JPEG and PNG images"),
  };
  ensure!(
    dimensions == (width, height),
    "Declared dimensions do not match the encoded image"
  );
  if format == ImageFormat::Png {
    validate_png_inflation(bytes, width, height)?;
  }
  let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
  let mut limits = image::Limits::default();
  limits.max_image_width = Some(MAX_TARGET_PREVIEW_DIMENSION);
  limits.max_image_height = Some(MAX_TARGET_PREVIEW_DIMENSION);
  limits.max_alloc = Some(192 * 1024 * 1024);
  reader.limits(limits);
  let mut data = reader
    .decode()
    .context("Image validation or decoding failed")?
    .into_rgba8();
  ensure!(
    data.dimensions() == (width, height) && data.len() == width as usize * height as usize * 4,
    "Decoded image dimensions do not match original image"
  );
  check_cancel(cancel)?;
  paint_target(&mut data, x, y);
  let (cw, ch) = (width.min(160), height.min(160));
  let (cx, cy) = (
    x.saturating_sub(cw / 2).min(width - cw),
    y.saturating_sub(ch / 2).min(height - ch),
  );
  let crop = image::imageops::crop_imm(&data, cx, cy, cw, ch).to_image();
  let zoom = image::imageops::resize(&crop, cw * 2, ch * 2, image::imageops::FilterType::Nearest);
  // Crop before adding captions. Their pixels are never phone pixels, and the
  // original image/zoom both retain source content and target centers at (0,0).
  let label = format!("PHONE PX: X={x} Y={y}");
  let (data, original_annotation) = paint_caption(data, &label);
  let (zoom, zoom_annotation) = paint_caption(zoom, &label);
  check_cancel(cancel)?;
  let png = encode_png(data)?;
  check_cancel(cancel)?;
  let zoom_png = encode_png(zoom)?;
  check_cancel(cancel)?;
  Ok(TargetPreview {
    png,
    zoom_png,
    crop: Crop {
      x: cx,
      y: cy,
      width: cw,
      height: ch,
      scale: 2,
    },
    simulated_target: true,
    annotation: PreviewAnnotation {
      coordinate_space: "originalPhonePixels".into(),
      label,
      original: original_annotation,
      zoom: zoom_annotation,
    },
  })
}

fn paint_caption(source: RgbaImage, label: &str) -> (RgbaImage, AnnotatedImage) {
  const LEGEND_HEIGHT: u32 = 52;
  const SECOND_LINE: &str = "SIMULATED TARGET";
  let (source_width, source_height) = source.dimensions();
  // 5x7 glyphs at 2x, with one glyph-column spacing and eight-pixel margins.
  let text_width = label.len().max(SECOND_LINE.len()) as u32 * 12 - 2;
  let width = source_width.max(text_width + 16);
  let height = source_height + LEGEND_HEIGHT;
  let mut canvas = RgbaImage::from_pixel(width, height, Rgba([16, 20, 28, 255]));
  image::imageops::replace(&mut canvas, &source, 0, 0);
  for x in 0..width {
    canvas.put_pixel(x, source_height, Rgba([0, 255, 255, 255]));
    canvas.put_pixel(x, source_height + 1, Rgba([0, 255, 255, 255]));
  }
  paint_caption_text(&mut canvas, 8, source_height + 8, label, [255, 255, 255, 255]);
  paint_caption_text(&mut canvas, 8, source_height + 30, SECOND_LINE, [255, 0, 255, 255]);
  (canvas, AnnotatedImage {
    width,
    height,
    source_rect: Rect { x: 0, y: 0, width: source_width, height: source_height },
    legend: Rect { x: 0, y: source_height, width, height: LEGEND_HEIGHT },
  })
}

fn paint_caption_text(data: &mut RgbaImage, x: u32, y: u32, text: &str, color: [u8; 4]) {
  for (index, character) in text.bytes().enumerate() {
    let rows: [u8; 7] = match character {
      b'0' => [14, 17, 19, 21, 25, 17, 14],
      b'1' => [4, 12, 4, 4, 4, 4, 14],
      b'2' => [14, 17, 1, 2, 4, 8, 31],
      b'3' => [30, 1, 1, 14, 1, 1, 30],
      b'4' => [2, 6, 10, 18, 31, 2, 2],
      b'5' => [31, 16, 16, 30, 1, 1, 30],
      b'6' => [14, 16, 16, 30, 17, 17, 14],
      b'7' => [31, 1, 2, 4, 8, 8, 8],
      b'8' => [14, 17, 17, 14, 17, 17, 14],
      b'9' => [14, 17, 17, 15, 1, 1, 14],
      b'A' => [14, 17, 17, 31, 17, 17, 17],
      b'D' => [30, 17, 17, 17, 17, 17, 30],
      b'E' => [31, 16, 16, 30, 16, 16, 31],
      b'G' => [14, 17, 16, 23, 17, 17, 14],
      b'H' => [17, 17, 17, 31, 17, 17, 17],
      b'I' => [14, 4, 4, 4, 4, 4, 14],
      b'L' => [16, 16, 16, 16, 16, 16, 31],
      b'M' => [17, 27, 21, 21, 17, 17, 17],
      b'N' => [17, 25, 21, 19, 17, 17, 17],
      b'O' => [14, 17, 17, 17, 17, 17, 14],
      b'P' => [30, 17, 17, 30, 16, 16, 16],
      b'R' => [30, 17, 17, 30, 20, 18, 17],
      b'S' => [15, 16, 16, 14, 1, 1, 30],
      b'T' => [31, 4, 4, 4, 4, 4, 4],
      b'U' => [17, 17, 17, 17, 17, 17, 14],
      b'X' => [17, 17, 10, 4, 10, 17, 17],
      b'Y' => [17, 17, 10, 4, 4, 4, 4],
      b':' => [0, 4, 4, 0, 4, 4, 0],
      b'=' => [0, 0, 31, 0, 31, 0, 0],
      b' ' => [0; 7],
      _ => unreachable!("Only bounded numeric coordinate captions are painted"),
    };
    for (row, bits) in rows.into_iter().enumerate() {
      for column in 0..5 {
        if bits & (1 << (4 - column)) == 0 { continue; }
        for dy in 0..2 {
          for dx in 0..2 {
            data.put_pixel(x + index as u32 * 12 + column * 2 + dx,
              y + row as u32 * 2 + dy, Rgba(color));
          }
        }
      }
    }
  }
}

fn encode_png(data: RgbaImage) -> Result<Vec<u8>> {
  let mut output = Cursor::new(Vec::new());
  DynamicImage::ImageRgba8(data).write_to(&mut output, ImageFormat::Png)?;
  let bytes = output.into_inner();
  ensure!(
    bytes.len() <= MAX_SCREEN_FRAME_BYTES,
    "Rendered target preview exceeds 32 MiB"
  );
  Ok(bytes)
}

fn paint_target(data: &mut RgbaImage, x: u32, y: u32) {
  let (width, height) = data.dimensions();
  for py in y.saturating_sub(25)..=(y + 25).min(height - 1) {
    for px in x.saturating_sub(25)..=(x + 25).min(width - 1) {
      let (dx, dy) = (i64::from(px) - i64::from(x), i64::from(py) - i64::from(y));
      let distance = ((dx * dx + dy * dy) as f64).sqrt();
      if distance <= 3.0 {
        continue;
      }
      let (horizontal, vertical) = ((6..=24).contains(&dx.abs()), (6..=24).contains(&dy.abs()));
      let (outer, inner) = ((distance - 18.0).abs(), (distance - 13.0).abs());
      let mut color = None;
      if outer <= 2.5
        || inner <= 2.5
        || (horizontal && dy.abs() <= 2)
        || (vertical && dx.abs() <= 2)
      {
        color = Some([0, 0, 0, 255]);
      }
      if outer <= 1.5 {
        color = Some([255, 0, 255, 255]);
      }
      if inner <= 1.5 || (horizontal && dy == 0) || (vertical && dx == 0) {
        color = Some([0, 255, 255, 255]);
      }
      if let Some(color) = color {
        data.put_pixel(px, py, Rgba(color));
      }
    }
  }
}

fn validate_png_inflation(bytes: &[u8], width: u32, height: u32) -> Result<()> {
  let depth = u64::from(bytes[24]);
  let channels = match bytes[25] {
    0 | 3 => 1,
    2 => 3,
    4 => 2,
    6 => 4,
    _ => unreachable!(),
  };
  let row_bytes = |w: u64, h: u64| {
    if w == 0 || h == 0 {
      0
    } else {
      ((w * channels * depth).div_ceil(8) + 1) * h
    }
  };
  let mut expected = row_bytes(u64::from(width), u64::from(height));
  if bytes[28] == 1 {
    expected = 0;
    for (sx, sy, dx, dy) in [
      (0u64, 0u64, 8u64, 8u64),
      (4, 0, 8, 8),
      (0, 4, 4, 8),
      (2, 0, 4, 4),
      (0, 2, 2, 4),
      (1, 0, 2, 2),
      (0, 1, 1, 2),
    ] {
      expected += row_bytes(
        u64::from(width).saturating_sub(sx).div_ceil(dx),
        u64::from(height).saturating_sub(sy).div_ceil(dy),
      );
    }
  }
  let mut compressed = Vec::new();
  let mut offset = 8;
  while offset < bytes.len() {
    let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
    if &bytes[offset + 4..offset + 8] == b"IDAT" {
      compressed.extend_from_slice(&bytes[offset + 8..offset + 8 + length]);
    }
    offset += length + 12;
  }
  let mut decoder = flate2::read::ZlibDecoder::new(compressed.as_slice());
  let mut count = 0u64;
  let mut chunk = [0u8; 16 * 1024];
  loop {
    let maximum =
      (expected.saturating_add(1).saturating_sub(count)).min(chunk.len() as u64) as usize;
    ensure!(maximum > 0, "PNG inflation exceeds declared geometry");
    let read = decoder
      .read(&mut chunk[..maximum])
      .context("Invalid PNG compressed image data")?;
    if read == 0 {
      break;
    }
    count += read as u64;
    ensure!(count <= expected, "PNG inflation exceeds declared geometry");
  }
  ensure!(
    count == expected,
    "PNG filtered pixel data length does not match dimensions"
  );
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  fn fixture(width: u32, height: u32) -> (Vec<u8>, RgbaImage) {
    let image = RgbaImage::from_fn(width, height, |x, y| {
      Rgba([(x % 255) as u8, (y % 255) as u8, ((x + y) % 255) as u8, 255])
    });
    (encode_png(image.clone()).unwrap(), image)
  }
  fn assert_caption_digits(image: &RgbaImage, source_height: u32, text_column: u32, digits: &str) {
    // Independently decode the visible 5x7 numeral cells, not result metadata.
    for (index, digit) in digits.chars().enumerate() {
      let rows: [u8; 7] = match digit {
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '3' => [30, 1, 1, 14, 1, 1, 30],
        '5' => [31, 16, 16, 30, 1, 1, 30],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '9' => [14, 17, 17, 15, 1, 1, 14],
        _ => panic!("Missing test numeral"),
      };
      for (row, bits) in rows.into_iter().enumerate() {
        for column in 0..5 {
          let pixel = image.get_pixel(
            8 + (text_column + index as u32) * 12 + column * 2,
            source_height + 8 + row as u32 * 2,
          );
          assert_eq!(*pixel == Rgba([255, 255, 255, 255]), bits & (1 << (4 - column)) != 0,
            "Caption digit {digit}, row {row}, column {column}");
        }
      }
    }
  }
  #[test]
  fn coordinate_captions_are_pixels_on_both_images_not_zoom_coordinates() {
    let (bytes, source) = fixture(260, 320);
    let result = render_local(&bytes, "image/png", 260, 320, 137, 157, &Cancel::new()).unwrap();
    let full = image::load_from_memory(&result.png).unwrap().into_rgba8();
    let zoom = image::load_from_memory(&result.zoom_png).unwrap().into_rgba8();
    assert_eq!(full.dimensions(), (266, 372));
    assert_eq!(zoom.dimensions(), (320, 372));
    for image in [&full, &zoom] {
      assert_caption_digits(image, 320, 12, "137");
      assert_caption_digits(image, 320, 18, "157");
    }
    assert_eq!(full.get_pixel(137, 157), source.get_pixel(137, 157));
    assert_eq!(zoom.get_pixel(160, 160), source.get_pixel(137, 157));
    assert_eq!(result.annotation.label, "PHONE PX: X=137 Y=157");
    assert_eq!(result.annotation.coordinate_space, "originalPhonePixels");
    assert_eq!(result.annotation.original.source_rect, Rect { x: 0, y: 0, width: 260, height: 320 });
    assert_eq!(result.annotation.zoom.source_rect, Rect { x: 0, y: 0, width: 320, height: 320 });
  }
  #[test]
  fn captions_fit_edge_and_tiny_images_without_clipping_source_or_marker() {
    for (w, h, x, y) in [(200, 300, 0, 0), (200, 300, 199, 299), (1, 1, 0, 0), (8192, 1, 8191, 0)] {
      let (bytes, source) = fixture(w, h);
      let result = render_local(&bytes, "image/png", w, h, x, y, &Cancel::new()).unwrap();
      for (encoded, annotation, source_w, source_h) in [
        (&result.png, &result.annotation.original, w, h),
        (&result.zoom_png, &result.annotation.zoom, result.crop.width * 2, result.crop.height * 2),
      ] {
        let image = image::load_from_memory(encoded).unwrap().into_rgba8();
        let label = format!("PHONE PX: X={x} Y={y}");
        assert_eq!(annotation.width, source_w.max(label.len() as u32 * 12 + 14));
        assert_eq!(annotation.height, source_h + 52);
        assert_eq!(image.dimensions(), (annotation.width, annotation.height));
        assert_eq!(annotation.source_rect, Rect { x: 0, y: 0, width: source_w, height: source_h });
        assert_eq!(annotation.legend, Rect { x: 0, y: source_h, width: annotation.width, height: 52 });
        assert_eq!(*image.get_pixel(0, source_h), Rgba([0, 255, 255, 255]));
        // The last glyph's 2x cells and both margins are inside the canvas.
        assert!(8 + (label.len() as u32 - 1) * 12 + 10 <= image.width() - 8);
      }
      let full = image::load_from_memory(&result.png).unwrap().into_rgba8();
      let zoom = image::load_from_memory(&result.zoom_png).unwrap().into_rgba8();
      assert_eq!(full.get_pixel(x, y), source.get_pixel(x, y));
      assert_eq!(zoom.get_pixel((x - result.crop.x) * 2, (y - result.crop.y) * 2), source.get_pixel(x, y));
      assert_eq!(bytes, encode_png(source).unwrap());
    }
  }
  #[test]
  fn marker_preserves_center_and_zoom_matches_marked_pixels() {
    let (bytes, source) = fixture(260, 320);
    let result = render_local(&bytes, "image/png", 260, 320, 137, 157, &Cancel::new()).unwrap();
    let full = image::load_from_memory(&result.png).unwrap().into_rgba8();
    let zoom = image::load_from_memory(&result.zoom_png)
      .unwrap()
      .into_rgba8();
    assert_eq!(full.get_pixel(137, 157), source.get_pixel(137, 157));
    assert_eq!(full.get_pixel(155, 158), &Rgba([255, 0, 255, 255]));
    assert_eq!(
      result.crop,
      Crop {
        x: 57,
        y: 77,
        width: 160,
        height: 160,
        scale: 2
      }
    );
    for y in 0..320 {
      for x in 0..320 {
        assert_eq!(zoom.get_pixel(x, y), full.get_pixel(57 + x / 2, 77 + y / 2));
      }
    }
    assert_eq!(bytes, encode_png(source).unwrap());
  }
  #[test]
  fn corners_and_narrow_images_clip_crop_without_moving_center() {
    for (w, h, x, y) in [
      (200, 300, 0, 0),
      (200, 300, 199, 299),
      (1, 1, 0, 0),
      (20, 300, 19, 299),
    ] {
      let (bytes, source) = fixture(w, h);
      let result = render_local(&bytes, "image/png", w, h, x, y, &Cancel::new()).unwrap();
      let full = image::load_from_memory(&result.png).unwrap().into_rgba8();
      assert_eq!(full.get_pixel(x, y), source.get_pixel(x, y));
      assert_eq!(result.crop.width, w.min(160));
      assert_eq!(result.crop.height, h.min(160));
      assert!(result.crop.x + result.crop.width <= w && result.crop.y + result.crop.height <= h);
    }
  }
  #[test]
  fn decoder_rejects_mime_geometry_corruption_and_cancel_before_work() {
    let (bytes, _) = fixture(20, 30);
    let cancel = Cancel::new();
    for (mime, w, h, x, y) in [
      ("image/jpeg", 20, 30, 1, 1),
      ("image/gif", 20, 30, 1, 1),
      ("image/png", 30, 20, 1, 1),
      ("image/png", 20, 30, 20, 0),
    ] {
      assert!(render_local(&bytes, mime, w, h, x, y, &cancel).is_err());
    }
    assert!(render_local(
      &bytes[..bytes.len() - 1],
      "image/png",
      20,
      30,
      0,
      0,
      &cancel
    )
    .is_err());
    assert!(valid_geometry(8192, 8192, 0, 0).is_err());
    cancel.cancel();
    assert!(render_target_preview(&bytes, "image/png", 20, 30, 1, 1, &cancel).is_err());
  }
  #[test]
  fn jpeg_is_decoded_into_two_pngs() {
    use base64::Engine;
    let fixture = include_str!("../../android-mcp/src/fixtures/jpeg.ts");
    let text = fixture
      .split('"')
      .find(|text| text.starts_with("/9j/"))
      .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
      .decode(text)
      .unwrap();
    assert_eq!(read_jpeg_dimensions(&bytes).unwrap(), (2, 3));
    let result = render_local(&bytes, "image/jpeg", 2, 3, 1, 2, &Cancel::new()).unwrap();
    assert_eq!(read_png_dimensions(&result.png).unwrap(), (218, 55));
    assert_eq!(read_png_dimensions(&result.zoom_png).unwrap(), (218, 58));
  }
}
