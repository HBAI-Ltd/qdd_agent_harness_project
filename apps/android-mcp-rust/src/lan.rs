use crate::Result;
use anyhow::{bail, Context};
use socket2::{Domain, Protocol, Socket, TcpKeepalive, Type};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

pub fn private_ipv4(ip: Ipv4Addr) -> bool {
  let [a, b, _, _] = ip.octets();
  a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && (16..=31).contains(&b))
}

pub fn private_address(address: &str) -> bool {
  match address.trim_matches(['[', ']']).parse::<IpAddr>() {
    Ok(IpAddr::V4(ip)) => private_ipv4(ip),
    Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(private_ipv4),
    _ => false,
  }
}

pub fn validate_host(host: &str) -> Result<()> {
  if let Ok(ip) = host.parse::<Ipv4Addr>() {
    if private_ipv4(ip) {
      return Ok(());
    }
    bail!("ESP_HOST must be a private LAN IPv4 address.");
  }
  if host.is_empty()
    || host.len() > 253
    || host.chars().all(|c| c.is_ascii_digit() || c == '.')
    || host.split('.').any(|part| {
      part.is_empty()
        || part.len() > 63
        || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        || part.starts_with('-')
        || part.ends_with('-')
    })
  {
    bail!("ESP_HOST must be a LAN hostname or private IPv4 address.");
  }
  Ok(())
}

pub fn private_authority(value: &str) -> bool {
  let host = if value.starts_with('[') {
    let Some(end) = value.find(']') else {
      return false;
    };
    if end + 1 < value.len() && !valid_port_suffix(&value[end + 1..]) {
      return false;
    }
    &value[..=end]
  } else {
    let mut parts = value.split(':');
    let host = parts.next().unwrap_or("");
    if let Some(port) = parts.next() {
      if parts.next().is_some() || !valid_port_suffix(&format!(":{port}")) {
        return false;
      }
    }
    host
  };
  host.eq_ignore_ascii_case("localhost") || private_address(host)
}

fn valid_port_suffix(value: &str) -> bool {
  value.strip_prefix(':').is_some_and(|p| {
    !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|v| v > 0)
  })
}

pub fn private_origin(origin: Option<&str>) -> bool {
  let Some(origin) = origin else {
    return true;
  };
  let Some(authority) = origin
    .strip_prefix("http://")
    .or_else(|| origin.strip_prefix("https://"))
  else {
    return false;
  };
  let authority = authority.strip_suffix('/').unwrap_or(authority);
  !authority.contains(['/', '?', '#', '@']) && private_authority(authority)
}

fn score(name: &str) -> u8 {
  let name = name.to_lowercase();
  let virtual_interface = [
    "virtual",
    "vethernet",
    "hyper-v",
    "docker",
    "wsl",
    "tun",
    "tap",
    "vmware",
    "virtualbox",
    "vgate",
    "mihomo",
  ]
  .iter()
  .any(|value| name.contains(value));
  let kind = if name.contains("wi-fi")
    || name.contains("wifi")
    || name.contains("wlan")
    || name.contains("无线")
  {
    0
  } else if name.contains("ethernet") || name.contains("以太网") {
    1
  } else {
    2
  };
  kind + if virtual_interface { 10 } else { 0 }
}

pub fn matching_lan_address(target: Ipv4Addr) -> Option<Ipv4Addr> {
  if target.is_loopback() || !private_ipv4(target) {
    return None;
  }
  let mut candidates = Vec::new();
  for interface in if_addrs::get_if_addrs().unwrap_or_default() {
    let if_addrs::IfAddr::V4(v4) = interface.addr else {
      continue;
    };
    if v4.ip.is_loopback() || !private_ipv4(v4.ip) {
      continue;
    }
    let mask = u32::from(v4.netmask);
    let inverse = !mask;
    if mask == 0 || inverse & inverse.wrapping_add(1) != 0 {
      continue;
    }
    if u32::from(v4.ip) & mask == u32::from(target) & mask {
      candidates.push((
        std::cmp::Reverse(mask.count_ones()),
        score(&interface.name),
        v4.ip,
      ));
    }
  }
  candidates.sort();
  candidates.first().map(|item| item.2)
}

pub fn connect_tcp(host: &str, port: u16, timeout: Duration) -> Result<TcpStream> {
  validate_host(host)?;
  if port == 0 {
    bail!("Port must be between 1 and 65535.");
  }
  // Resolve once, validate every destination, then connect the selected literal address.
  let addresses = (host, port)
    .to_socket_addrs()
    .context("Cannot resolve ESP LAN host")?
    .filter_map(|address| match address.ip() {
      IpAddr::V4(ip) => Some(ip),
      _ => None,
    })
    .collect::<Vec<_>>();
  if addresses.is_empty() || addresses.iter().any(|ip| !private_ipv4(*ip)) {
    bail!("ESP host resolved outside the private IPv4 LAN.");
  }
  let ip = addresses[0];
  let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
  if let Some(source) = matching_lan_address(ip) {
    socket.bind(&SocketAddr::from((source, 0)).into())?;
  }
  socket.connect_timeout(&SocketAddr::from((ip, port)).into(), timeout)?;
  socket.set_nodelay(true)?;
  socket.set_tcp_keepalive(&TcpKeepalive::new().with_time(Duration::from_secs(1)))?;
  Ok(socket.into())
}

pub fn lan_urls(port: u16) -> Vec<String> {
  let mut addresses = Vec::new();
  for interface in if_addrs::get_if_addrs().unwrap_or_default() {
    if let if_addrs::IfAddr::V4(v4) = interface.addr {
      if private_ipv4(v4.ip) && !v4.ip.is_loopback() {
        addresses.push((score(&interface.name), v4.ip));
      }
    }
  }
  addresses.sort();
  addresses.dedup_by_key(|item| item.1);
  let urls = addresses
    .iter()
    .map(|(_, ip)| format!("http://{ip}:{port}/"))
    .collect::<Vec<_>>();
  if urls.is_empty() {
    vec![format!("http://localhost:{port}/")]
  } else {
    urls
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn restricts_private_origins_and_hosts() {
    for host in [
      "192.168.1.2:8790",
      "127.0.0.1",
      "localhost:80",
      "[::1]:8790",
    ] {
      assert!(private_authority(host));
    }
    for host in [
      "evil.example",
      "8.8.8.8",
      "192.168.1.1@evil",
      "127.0.0.1:0",
      "localhost:99999",
    ] {
      assert!(!private_authority(host));
    }
    assert!(!private_origin(Some("http://127.0.0.1/path")));
    assert!(!private_origin(Some("null")));
    assert!(private_origin(Some("http://192.168.1.2:8790")));
    assert!(validate_host("printer.local").is_ok());
    assert!(validate_host("8.8.8.8").is_err());
    assert!(validate_host("123.999.1.1").is_err());
  }
}
