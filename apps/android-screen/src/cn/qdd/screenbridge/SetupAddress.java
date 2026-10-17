package cn.qdd.screenbridge;

import java.net.URI;
import java.util.Map;

/** QR/discovery addresses are numeric private IPv4, never arbitrary web URLs. */
final class SetupAddress {
  static String normalize(String value) {
    try {
      URI uri = new URI(value == null ? "" : value.trim());
      String host = uri.getHost();
      if (!"http".equals(uri.getScheme()) || !privateIpv4(host) || uri.getUserInfo() != null
          || uri.getQuery() != null || uri.getFragment() != null
          || !(uri.getPath().isEmpty() || "/".equals(uri.getPath()))
          || uri.getPort() != 3334) throw new IllegalArgumentException();
      return "http://" + host + ":" + uri.getPort();
    } catch (Exception invalid) { throw new IllegalArgumentException("请扫描控制板上的局域网二维码"); }
  }

  static boolean validBoardName(String name) {
    return name != null && name.matches("QDD-Passport-[0-9A-Fa-f]{4,12}");
  }

  /** Auto-discovery chooses a unique board, or the unique previously selected identity. */
  static String selectDiscovered(Map<String, String> candidates, String selectedName) {
    String selected = null;
    for (Map.Entry<String, String> candidate : candidates.entrySet()) {
      if (!validBoardName(candidate.getValue()) ||
          (selectedName != null && !selectedName.equals(candidate.getValue()))) continue;
      String address = normalize(candidate.getKey());
      if (selected != null && !selected.equals(address)) {
        throw new IllegalArgumentException("发现多块控制板，请扫描目标控制板上的二维码");
      }
      selected = address;
    }
    if (selected == null) throw new IllegalArgumentException(selectedName == null
        ? "未找到控制板，请确认控制板和手机连接同一 Wi-Fi"
        : "暂时未找到已选控制板，请确认网络或重新扫描板上二维码");
    return selected;
  }

  static boolean privateIpv4(String host) {
    if (host == null || !host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
    String[] parts = host.split("\\."); int[] octets = new int[4];
    for (int index = 0; index < 4; index++) {
      if (parts[index].length() > 3 || (parts[index].length() > 1 && parts[index].startsWith("0"))) return false;
      octets[index] = Integer.parseInt(parts[index]); if (octets[index] > 255) return false;
    }
    return octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] == 192 && octets[1] == 168);
  }
}
