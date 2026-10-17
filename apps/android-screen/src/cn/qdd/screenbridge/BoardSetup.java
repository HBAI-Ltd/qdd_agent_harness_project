package cn.qdd.screenbridge;

import android.content.SharedPreferences;
import android.net.Network;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Discovery/installation guidance never sends HID and never requests Bluetooth access. */
final class BoardSetup {
  private final ScreenApplication app;
  private final SharedPreferences preferences;
  private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
  private volatile String board;
  private volatile String selectedName;
  private volatile String name = "QDD-Passport";
  private volatile String guide = "正在查找同一 Wi-Fi 的设备控制器…";
  private volatile boolean bluetoothReady;
  private long generation;
  private long nextDiscovery;
  private Network lastNetwork;
  private String lastWifiAddress;

  BoardSetup(ScreenApplication app, SharedPreferences preferences) {
    this.app = app; this.preferences = preferences;
    String saved = preferences.getString("boardUrl", "");
    if (!saved.isEmpty()) { try { board = SetupAddress.normalize(saved); } catch (IllegalArgumentException invalid) { /* Ignore a stale local address. */ } }
    String savedName = preferences.getString("boardName", "");
    if (board != null && SetupAddress.validBoardName(savedName)) { selectedName = savedName; name = savedName; }
    worker.scheduleWithFixedDelay(this::refresh, 0, 3, TimeUnit.SECONDS);
  }

  synchronized void configure(String value) {
    String normalized = SetupAddress.normalize(value);
    generation++;
    board = normalized; selectedName = null; name = "QDD-Passport"; bluetoothReady = false;
    preferences.edit().putString("boardUrl", normalized).remove("boardName").apply();
    worker.execute(this::refresh);
  }

  String guide() { return guide; }
  String deviceName() { return name; }
  boolean bluetoothReady() { return bluetoothReady; }

  private String discover(Network network, String identity) throws Exception {
    byte[] request = "QDD-DISCOVER/1".getBytes(StandardCharsets.US_ASCII);
    Map<String, String> candidates = new LinkedHashMap<>();
    try (DatagramSocket socket = new DatagramSocket()) {
      network.bindSocket(socket); socket.setBroadcast(true);
      socket.send(new DatagramPacket(request, request.length, InetAddress.getByName("255.255.255.255"), 3335));
      long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(800);
      for (int received = 0; received < 64; received++) {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) break;
        socket.setSoTimeout((int)Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining)));
        DatagramPacket packet = new DatagramPacket(new byte[2048], 2048);
        try { socket.receive(packet); } catch (SocketTimeoutException complete) { break; }
        try {
          JSONObject data = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
          if (packet.getPort() != 3335 || !"qdd-esp-onboarding".equals(data.optString("service")) || data.optInt("version") != 1) continue;
          String found = SetupAddress.normalize(data.getString("boardUrl"));
          String foundName = data.optString("deviceName");
          if (!URI.create(found).getHost().equals(packet.getAddress().getHostAddress()) || !SetupAddress.validBoardName(foundName)) continue;
          candidates.put(found, foundName);
        } catch (Exception malformed) { /* One malformed reply must not hide valid boards. */ }
      }
    }
    return SetupAddress.selectDiscovered(candidates, identity);
  }

  private synchronized boolean current(long round, Network network, String wifiAddress) {
    return generation == round && network.equals(app.wifiNetwork()) && wifiAddress.equals(app.wifiAddress());
  }

  private void connect(Network network, String wifiAddress, String endpoint, String identity, long round) throws Exception {
    JSONObject status = new JSONObject(BoardClient.request(network.getSocketFactory(), endpoint, "GET", "/api/status", null));
    String foundName = status.optString("deviceName");
    if (!"qdd-esp-onboarding".equals(status.optString("service")) || status.optInt("version") != 1
        || !SetupAddress.validBoardName(foundName) || (identity != null && !identity.equals(foundName))
        || !endpoint.equals(SetupAddress.normalize(status.optString("boardUrl")))
        || !URI.create(endpoint).getHost().equals(status.optString("ip"))) throw new IllegalArgumentException("设备控制器身份不匹配，请重新扫描目标板二维码");
    synchronized (this) {
      if (!current(round, network, wifiAddress)) return;
      board = endpoint; selectedName = foundName; name = foundName;
      preferences.edit().putString("boardUrl", endpoint).putString("boardName", foundName).apply();
    }
    if (!current(round, network, wifiAddress)) return;
    JSONObject registration = new JSONObject().put("deviceId", app.deviceId()).put("port", app.port()).put("projecting", app.frames.isActive());
    JSONObject accepted = new JSONObject(BoardClient.request(network.getSocketFactory(), endpoint, "POST", "/api/phone", registration.toString()));
    if (!accepted.optBoolean("ok")) throw new IllegalArgumentException("设备控制器暂时未接受手机连接");
    synchronized (this) {
      if (!current(round, network, wifiAddress)) return;
      JSONObject bluetooth = status.optJSONObject("bluetooth");
      bluetoothReady = bluetooth != null && bluetooth.optBoolean("connected") && bluetooth.optBoolean("encrypted")
          && bluetooth.optBoolean("authenticated") && bluetooth.optBoolean("bonded") && bluetooth.optBoolean("ready");
      guide = !bluetoothReady ? "下一步：打开蓝牙设置，连接 " + name + "。需要配对码时，输入设备控制器显示的数字。"
          : "蓝牙已连接。手机开始投屏并允许共享屏幕，再在同一 Wi-Fi 的电脑打开设备操作台.exe。点击电脑画面即可操作，按 Esc 退出。";
    }
  }

  private void refresh() {
    Network network = app.wifiNetwork();
    String wifiAddress = app.wifiAddress();
    if (network == null || wifiAddress == null) { bluetoothReady = false; guide = "先让手机和电脑连接设备控制器所在的 Wi-Fi"; return; }
    if (!network.equals(lastNetwork) || !wifiAddress.equals(lastWifiAddress)) {
      lastNetwork = network; lastWifiAddress = wifiAddress; nextDiscovery = 0; bluetoothReady = false;
    }
    final String endpoint, identity;
    final long round;
    synchronized (this) { endpoint = board; identity = selectedName; round = generation; }
    try {
      if (endpoint != null) {
        try { connect(network, wifiAddress, endpoint, identity, round); return; }
        catch (Exception oldAddress) {
          // A saved URL without a known identity cannot safely switch boards.
          if (identity == null) throw oldAddress;
        }
      }
      long now = android.os.SystemClock.elapsedRealtime();
      if (now < nextDiscovery) throw new IllegalArgumentException("设备控制器暂时不可达，请确认 Wi-Fi 或重新扫描板上二维码");
      nextDiscovery = now + 10000;
      String found = discover(network, identity);
      connect(network, wifiAddress, found, identity, round);
    } catch (Exception unavailable) {
      synchronized (this) {
        if (!current(round, network, wifiAddress)) return;
        bluetoothReady = false;
        guide = unavailable instanceof IllegalArgumentException ? unavailable.getMessage()
            : "设备控制器暂时不可达，请确认手机与设备控制器连接同一 Wi-Fi；也可重新扫描板上的二维码。";
      }
    }
  }
}
