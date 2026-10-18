use crate::{Cancel, Result};
use anyhow::{bail, ensure, Context};
use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Endpoint {
  pub secure: bool,
  pub host: String,
  pub port: u16,
  pub path: String,
}

impl Endpoint {
  pub fn parse(url: &str) -> Result<Self> {
    let (secure, rest) = if let Some(v) = url.strip_prefix("http://") {
      (false, v)
    } else if let Some(v) = url.strip_prefix("https://") {
      (true, v)
    } else {
      bail!("LAN endpoint must use http:// or https://.");
    };
    if rest.contains(['@', '#', '\r', '\n', '\\']) {
      bail!("Invalid LAN endpoint.");
    }
    let (authority, path) = rest
      .split_once('/')
      .map_or((rest, "/".to_string()), |(a, p)| (a, format!("/{p}")));
    let (host, port) = authority
      .split_once(':')
      .map_or((authority, if secure { "443" } else { "80" }), |v| v);
    let ip: Ipv4Addr = host
      .parse()
      .context("LAN endpoint must use a literal private IPv4 address")?;
    if !crate::lan::private_ipv4(ip) {
      bail!("Public LAN endpoint is forbidden.");
    }
    let port: u16 = port.parse().context("Invalid LAN port")?;
    if port == 0 {
      bail!("Invalid LAN port.");
    }
    Ok(Self {
      secure,
      host: host.to_string(),
      port,
      path,
    })
  }
  pub fn origin(&self) -> String {
    let scheme = if self.secure { "https" } else { "http" };
    let default = if self.secure { 443 } else { 80 };
    format!(
      "{scheme}://{}{}",
      self.host,
      if self.port == default {
        String::new()
      } else {
        format!(":{}", self.port)
      }
    )
  }
}

pub struct Response {
  pub status: u16,
  pub headers: BTreeMap<String, String>,
  pub body: Vec<u8>,
  pub received_at: Instant,
}
pub struct OpenResponse {
  pub status: u16,
  pub headers: BTreeMap<String, String>,
  pub body: BodyReader,
  pub received_at: Instant,
}

struct PollingSocket {
  socket: TcpStream,
  cancel: Cancel,
}
impl Read for PollingSocket {
  fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
    check_io_cancel(&self.cancel)?;
    match self.socket.read(bytes) {
      Err(error)
        if matches!(
          error.kind(),
          io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ) =>
      {
        check_io_cancel(&self.cancel)?;
        // native-tls resumes a partial handshake on WouldBlock. Windows socket
        // timeouts use TimedOut, so normalize that result before the TLS layer.
        Err(io::Error::new(
          io::ErrorKind::WouldBlock,
          "LAN socket polling timeout",
        ))
      }
      result => result,
    }
  }
}
impl Write for PollingSocket {
  fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
    check_io_cancel(&self.cancel)?;
    match self.socket.write(bytes) {
      Err(error)
        if matches!(
          error.kind(),
          io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ) =>
      {
        check_io_cancel(&self.cancel)?;
        Err(io::Error::new(
          io::ErrorKind::WouldBlock,
          "LAN socket polling timeout",
        ))
      }
      result => result,
    }
  }
  fn flush(&mut self) -> io::Result<()> {
    self.socket.flush()
  }
}
fn check_io_cancel(cancel: &Cancel) -> io::Result<()> {
  if cancel.is_cancelled() {
    Err(io::Error::new(
      io::ErrorKind::ConnectionAborted,
      "Request cancelled",
    ))
  } else {
    Ok(())
  }
}
enum Transport {
  Plain(PollingSocket),
  Tls(native_tls::TlsStream<PollingSocket>),
}
impl Read for Transport {
  fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
    match self {
      Self::Plain(s) => s.read(bytes),
      Self::Tls(s) => s.read(bytes),
    }
  }
}
impl Write for Transport {
  fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
    match self {
      Self::Plain(s) => s.write(bytes),
      Self::Tls(s) => s.write(bytes),
    }
  }
  fn flush(&mut self) -> io::Result<()> {
    match self {
      Self::Plain(s) => s.flush(),
      Self::Tls(s) => s.flush(),
    }
  }
}

struct TcpReader {
  socket: Transport,
  cancel: Cancel,
  last_progress: Instant,
}
impl Read for TcpReader {
  fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
    loop {
      if self.cancel.is_cancelled() {
        return Err(io::Error::new(
          io::ErrorKind::ConnectionAborted,
          "Request cancelled",
        ));
      }
      match self.socket.read(bytes) {
        Ok(n) => {
          self.last_progress = Instant::now();
          return Ok(n);
        }
        Err(e)
          if matches!(
            e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
          ) =>
        {
          if self.last_progress.elapsed() > Duration::from_secs(10) {
            return Err(io::Error::new(
              io::ErrorKind::TimedOut,
              "LAN request timed out",
            ));
          }
        }
        Err(e) => return Err(e),
      }
    }
  }
}

enum Framing {
  Length(u64),
  Chunked {
    remaining: usize,
    need_crlf: bool,
    finished: bool,
  },
  Eof,
}
pub struct BodyReader {
  reader: BufReader<Box<dyn Read + Send>>,
  framing: Framing,
  cancel: Cancel,
}
impl Read for BodyReader {
  fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
    if output.is_empty() {
      return Ok(0);
    }
    if self.cancel.is_cancelled() {
      return Err(io::Error::new(
        io::ErrorKind::ConnectionAborted,
        "Request cancelled",
      ));
    }
    match &mut self.framing {
      Framing::Eof => self.reader.read(output),
      Framing::Length(remaining) => {
        if *remaining == 0 {
          return Ok(0);
        }
        let size = output.len().min(*remaining as usize);
        let n = self.reader.read(&mut output[..size])?;
        if n == 0 {
          return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Incomplete HTTP body",
          ));
        }
        *remaining -= n as u64;
        Ok(n)
      }
      Framing::Chunked {
        remaining,
        need_crlf,
        finished,
      } => {
        if *finished {
          return Ok(0);
        }
        if *remaining == 0 {
          if *need_crlf {
            let mut crlf = [0; 2];
            self.reader.read_exact(&mut crlf)?;
            if crlf != *b"\r\n" {
              return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid chunk terminator",
              ));
            }
          }
          let line = bounded_line(&mut self.reader, 1024)?;
          let size = line.split(';').next().unwrap_or("").trim();
          *remaining = usize::from_str_radix(size, 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid HTTP chunk size"))?;
          if *remaining == 0 {
            let mut total = 0;
            loop {
              let trailer = bounded_line(&mut self.reader, 8192)?;
              total += trailer.len();
              if total > 16384 {
                return Err(io::Error::new(
                  io::ErrorKind::InvalidData,
                  "Too many HTTP trailers",
                ));
              }
              if trailer == "\r\n" {
                break;
              }
            }
            *finished = true;
            return Ok(0);
          }
          *need_crlf = true;
        }
        let size = output.len().min(*remaining);
        let n = self.reader.read(&mut output[..size])?;
        if n == 0 {
          return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Incomplete HTTP chunk",
          ));
        }
        *remaining -= n;
        Ok(n)
      }
    }
  }
}

fn bounded_line(reader: &mut impl BufRead, max: usize) -> io::Result<String> {
  let mut bytes = Vec::new();
  loop {
    let available = reader.fill_buf()?;
    if available.is_empty() {
      return Err(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "Incomplete HTTP header",
      ));
    }
    let size = available
      .iter()
      .position(|b| *b == b'\n')
      .map_or(available.len(), |i| i + 1);
    if bytes.len() + size > max {
      return Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "HTTP header too large",
      ));
    }
    let complete = available[size - 1] == b'\n';
    bytes.extend_from_slice(&available[..size]);
    reader.consume(size);
    if complete {
      return String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid HTTP text"));
    }
  }
}

pub fn open(
  method: &str,
  url: &str,
  headers: &[(String, String)],
  body: &[u8],
  cancel: &Cancel,
) -> Result<OpenResponse> {
  open_with_connector(method, url, headers, body, cancel, None)
}

fn open_with_connector(
  method: &str,
  url: &str,
  headers: &[(String, String)],
  body: &[u8],
  cancel: &Cancel,
  connector: Option<&native_tls::TlsConnector>,
) -> Result<OpenResponse> {
  if cancel.is_cancelled() {
    bail!("Request cancelled.");
  }
  let endpoint = Endpoint::parse(url)?;
  if method != "GET" && method != "POST" && method != "DELETE" {
    bail!("Unsupported HTTP method.");
  }
  let socket = crate::lan::connect_tcp(&endpoint.host, endpoint.port, Duration::from_secs(3))?;
  socket.set_read_timeout(Some(Duration::from_millis(100)))?;
  socket.set_write_timeout(Some(Duration::from_millis(100)))?;
  let socket = PollingSocket {
    socket,
    cancel: cancel.clone(),
  };
  let mut socket = if endpoint.secure {
    // Windows native-tls uses Schannel. Certificate and hostname validation stay
    // enabled; only unit fixtures supply an explicit extra trusted certificate.
    let default_connector;
    let connector = match connector {
      Some(connector) => connector,
      None => {
        default_connector = native_tls::TlsConnector::new()?;
        &default_connector
      }
    };
    Transport::Tls(tls_connect(connector, &endpoint.host, socket, cancel)?)
  } else {
    Transport::Plain(socket)
  };
  let mut request = format!("{method} {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: {}\r\n", endpoint.path, endpoint.host, endpoint.port, body.len());
  for (key, value) in headers {
    if key.contains(['\r', '\n', ':']) || value.contains(['\r', '\n']) {
      bail!("Invalid HTTP header.");
    }
    request.push_str(&format!("{key}: {value}\r\n"));
  }
  request.push_str("\r\n");
  write_cancellable(&mut socket, request.as_bytes(), cancel)?;
  write_cancellable(&mut socket, body, cancel)?;
  let reader: Box<dyn Read + Send> = Box::new(TcpReader {
    socket,
    cancel: cancel.clone(),
    last_progress: Instant::now(),
  });
  let mut reader = BufReader::new(reader);
  let mut header = bounded_line(&mut reader, 16384)?;
  let status = header
    .split_whitespace()
    .nth(1)
    .context("Invalid HTTP status")?
    .parse::<u16>()?;
  let mut response_headers = BTreeMap::<String, String>::new();
  loop {
    let line = bounded_line(&mut reader, 16384)?;
    header.push_str(&line);
    if header.len() > 16384 {
      bail!("HTTP headers exceed 16 KiB.");
    }
    if line == "\r\n" {
      break;
    }
    let (key, value) = line.split_once(':').context("Invalid HTTP header")?;
    insert_response_header(&mut response_headers, key, value.trim())?;
  }
  let framing = if let Some(encoding) = response_headers.get("transfer-encoding") {
    if !encoding.eq_ignore_ascii_case("chunked") || response_headers.contains_key("content-length")
    {
      bail!("Unsupported HTTP transfer encoding.");
    }
    Framing::Chunked {
      remaining: 0,
      need_crlf: false,
      finished: false,
    }
  } else if let Some(length) = response_headers.get("content-length") {
    ensure!(
      !length.is_empty() && length.bytes().all(|b| b.is_ascii_digit()),
      "Invalid HTTP content length."
    );
    Framing::Length(length.parse()?)
  } else {
    Framing::Eof
  };
  Ok(OpenResponse {
    status,
    headers: response_headers,
    body: BodyReader {
      reader,
      framing,
      cancel: cancel.clone(),
    },
    received_at: Instant::now(),
  })
}

pub fn request(
  method: &str,
  url: &str,
  headers: &[(String, String)],
  body: &[u8],
  cancel: &Cancel,
  limit: usize,
) -> Result<Response> {
  let mut response = open(method, url, headers, body, cancel)?;
  read_response(&mut response, limit)
}

fn read_response(response: &mut OpenResponse, limit: usize) -> Result<Response> {
  if let Some(length) = response.headers.get("content-length") {
    ensure!(
      length.parse::<u64>()? <= limit as u64,
      "LAN response exceeds {limit} bytes."
    );
  }
  let mut bytes = Vec::new();
  response
    .body
    .by_ref()
    .take(limit as u64 + 1)
    .read_to_end(&mut bytes)?;
  if bytes.len() > limit {
    bail!("LAN response exceeds {limit} bytes.");
  }
  Ok(Response {
    status: response.status,
    headers: std::mem::take(&mut response.headers),
    body: bytes,
    received_at: response.received_at,
  })
}

fn tls_connect(
  connector: &native_tls::TlsConnector,
  host: &str,
  socket: PollingSocket,
  cancel: &Cancel,
) -> Result<native_tls::TlsStream<PollingSocket>> {
  let started = Instant::now();
  let mut result = connector.connect(host, socket);
  loop {
    check_io_cancel(cancel)?;
    ensure!(
      started.elapsed() < Duration::from_secs(3),
      "TLS handshake timed out."
    );
    match result {
      Ok(stream) => return Ok(stream),
      Err(native_tls::HandshakeError::Failure(error)) => return Err(error.into()),
      Err(native_tls::HandshakeError::WouldBlock(handshake)) => result = handshake.handshake(),
    }
  }
}

fn write_cancellable(output: &mut impl Write, mut bytes: &[u8], cancel: &Cancel) -> io::Result<()> {
  let started = Instant::now();
  while !bytes.is_empty() {
    check_io_cancel(cancel)?;
    if started.elapsed() > Duration::from_secs(3) {
      return Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "LAN request write timed out",
      ));
    }
    match output.write(bytes) {
      Ok(0) => {
        return Err(io::Error::new(
          io::ErrorKind::WriteZero,
          "LAN connection stopped accepting data",
        ))
      }
      Ok(n) => bytes = &bytes[n..],
      Err(error)
        if matches!(
          error.kind(),
          io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ) => {}
      Err(error) => return Err(error),
    }
  }
  Ok(())
}

fn insert_response_header(
  headers: &mut BTreeMap<String, String>,
  name: &str,
  value: &str,
) -> Result<()> {
  ensure!(
    !name.is_empty()
      && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
      && !value.contains(['\r', '\n', '\0']),
    "Invalid HTTP response header."
  );
  let name = name.to_ascii_lowercase();
  if let Some(previous) = headers.get_mut(&name) {
    ensure!(
      !matches!(
        name.as_str(),
        "content-length" | "transfer-encoding" | "content-type"
      ) && !name.starts_with("x-"),
      "Ambiguous HTTP framing or frame metadata: duplicate {name}."
    );
    previous.push_str(", ");
    previous.push_str(value);
  } else {
    headers.insert(name, value.into());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{net::TcpListener, sync::mpsc, thread};

  fn trusted_connector() -> native_tls::TlsConnector {
    let certificate =
      native_tls::Certificate::from_pem(include_bytes!("../tests/fixtures/loopback-test-only.pem"))
        .unwrap();
    native_tls::TlsConnector::builder()
      .disable_built_in_roots(true)
      .add_root_certificate(certificate)
      .build()
      .unwrap()
  }

  fn tls_fixture<F>(handle: F) -> (String, thread::JoinHandle<()>)
  where
    F: FnOnce(native_tls::TlsStream<TcpStream>) + Send + 'static,
  {
    let acceptor = {
      let identity = native_tls::Identity::from_pkcs12(
        include_bytes!("../tests/fixtures/loopback-test-only.pfx"),
        "qdd-test-only",
      )
      .unwrap();
      native_tls::TlsAcceptor::new(identity).unwrap()
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
      let (stream, _) = listener.accept().unwrap();
      stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
      stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
      let accepted = acceptor.accept(stream);
      if let Ok(stream) = accepted {
        handle(stream);
      }
    });
    (url, task)
  }

  fn consume_request(stream: &mut impl Read) {
    let mut bytes = vec![];
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
      stream.read_exact(&mut byte).unwrap();
      bytes.push(byte[0]);
      assert!(bytes.len() < 16384);
    }
  }
  #[test]
  fn endpoint_rejects_credentials_and_public_addresses() {
    assert!(Endpoint::parse("http://127.0.0.1:8791/frame.jpg").is_ok());
    assert!(Endpoint::parse("https://192.168.1.2").unwrap().secure);
    for url in [
      "http://8.8.8.8",
      "http://example.com",
      "http://user@127.0.0.1",
      "file:///tmp/a",
    ] {
      assert!(Endpoint::parse(url).is_err());
    }
  }
  #[test]
  fn chunk_parser_is_bounded_and_detects_truncation() {
    let cancel = Cancel::new();
    let input: Box<dyn Read + Send> =
      Box::new(io::Cursor::new(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"));
    let mut body = BodyReader {
      reader: BufReader::new(input),
      framing: Framing::Chunked {
        remaining: 0,
        need_crlf: false,
        finished: false,
      },
      cancel,
    };
    let mut bytes = Vec::new();
    body.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"abcde");
  }

  #[test]
  fn tls_original_jpeg_preserves_identity_and_uses_normal_frame_validation() {
    use base64::Engine;
    let fixture = include_str!("../tests/fixtures/jpeg.mjs");
    let text = fixture.split('"').find(|v| v.starts_with("/9j/")).unwrap();
    let jpeg = base64::engine::general_purpose::STANDARD
      .decode(text)
      .unwrap();
    let expected = jpeg.clone();
    let (url, server) = tls_fixture(move |mut stream| {
      consume_request(&mut stream);
      let header = format!("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nX-Device-Id: 00112233-4455-6677-8899-aabbccddeeff\r\nX-Frame-Id: tls-original\r\nX-Frame-Age-Ms: 0\r\nX-Captured-At: 2026-10-18T01:02:03.123Z\r\nX-Device-Width: 2\r\nX-Device-Height: 3\r\nX-Preview-Profile: original\r\nConnection: close\r\n\r\n", jpeg.len());
      stream.write_all(header.as_bytes()).unwrap();
      stream.write_all(&jpeg).unwrap();
      stream.flush().unwrap();
    });
    let connector = trusted_connector();
    let cancel = Cancel::new();
    let mut response = open_with_connector(
      "GET",
      &format!("{url}/frame.jpg"),
      &[],
      &[],
      &cancel,
      Some(&connector),
    )
    .unwrap();
    let response = read_response(&mut response, 1024 * 1024).unwrap();
    assert_eq!(response.body, expected);
    let phone = crate::screen::ScreenClient::new(url, None).unwrap();
    let frame = phone
      .frame_from_parts(&response.headers, response.body, response.received_at, None)
      .unwrap();
    assert_eq!(
      (
        frame.width,
        frame.height,
        frame.device_width,
        frame.device_height
      ),
      (2, 3, 2, 3)
    );
    assert_eq!(frame.source_frame_id, "tls-original");
    assert_eq!(frame.preview_profile, "original");
    server.join().unwrap();
  }

  #[test]
  fn tls_does_not_follow_redirects_and_rejects_duplicate_phone_metadata() {
    let (url, server) = tls_fixture(|mut stream| {
      consume_request(&mut stream);
      stream
        .write_all(
          b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: http://8.8.8.8/forbidden\r\n\r\n",
        )
        .unwrap();
      stream.flush().unwrap();
    });
    let connector = trusted_connector();
    let cancel = Cancel::new();
    let response = open_with_connector("GET", &url, &[], &[], &cancel, Some(&connector)).unwrap();
    assert_eq!(response.status, 302);
    server.join().unwrap();
    let (url, server) = tls_fixture(|mut stream| {
      consume_request(&mut stream);
      stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Device-Id: first\r\nX-Device-Id: second\r\n\r\n").unwrap();
      stream.flush().unwrap();
    });
    let error = open_with_connector("GET", &url, &[], &[], &cancel, Some(&connector))
      .err()
      .expect("duplicate device metadata must fail");
    assert!(error.to_string().contains("duplicate x-device-id"));
    server.join().unwrap();
  }

  #[test]
  fn production_tls_connector_rejects_untrusted_fixture_certificate() {
    let (url, server) = tls_fixture(|_| {});
    assert!(open("GET", &url, &[], &[], &Cancel::new()).is_err());
    server.join().unwrap();
  }

  #[test]
  fn cancellation_interrupts_a_slow_tls_handshake() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    let (accepted, received) = mpsc::channel();
    let server = thread::spawn(move || {
      let (stream, _) = listener.accept().unwrap();
      accepted.send(()).unwrap();
      thread::sleep(Duration::from_millis(600));
      drop(stream);
    });
    let cancel = Cancel::new();
    let cancelled = cancel.clone();
    let timer = thread::spawn(move || {
      received.recv().unwrap();
      thread::sleep(Duration::from_millis(50));
      cancelled.cancel();
    });
    let started = Instant::now();
    assert!(
      open_with_connector("GET", &url, &[], &[], &cancel, Some(&trusted_connector())).is_err()
    );
    assert!(
      started.elapsed() < Duration::from_millis(500),
      "handshake cancellation took {:?}",
      started.elapsed()
    );
    timer.join().unwrap();
    server.join().unwrap();
  }

  #[test]
  fn cancellation_interrupts_tls_body_without_waiting_for_peer_eof() {
    let (ready, waiting) = mpsc::channel();
    let (url, server) = tls_fixture(move |mut stream| {
      consume_request(&mut stream);
      stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 10\r\n\r\nx").unwrap();
      stream.flush().unwrap();
      ready.send(()).unwrap();
      thread::sleep(Duration::from_secs(2));
    });
    let cancel = Cancel::new();
    let cancelled = cancel.clone();
    let timer = thread::spawn(move || {
      waiting.recv().unwrap();
      thread::sleep(Duration::from_millis(50));
      cancelled.cancel();
    });
    let started = Instant::now();
    let connector = trusted_connector();
    let mut response =
      open_with_connector("GET", &url, &[], &[], &cancel, Some(&connector)).unwrap();
    assert!(read_response(&mut response, 1024).is_err());
    assert!(
      started.elapsed() < Duration::from_millis(700),
      "body cancellation took {:?}",
      started.elapsed()
    );
    timer.join().unwrap();
    server.join().unwrap();
  }

  #[test]
  fn response_metadata_and_framing_duplicates_are_rejected() {
    for name in [
      "content-type",
      "content-length",
      "transfer-encoding",
      "x-frame-age-ms",
      "x-device-id",
    ] {
      let mut headers = BTreeMap::new();
      insert_response_header(&mut headers, name, "first").unwrap();
      assert!(insert_response_header(&mut headers, name, "second").is_err());
    }
  }
}
