package cn.qdd.screenbridge;

import android.app.Application;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.display.DisplayManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Display;
import java.io.IOException;
import java.net.Inet4Address;
import java.util.UUID;
import java.util.HashSet;
import java.util.Set;

public final class ScreenApplication extends Application {
  final FrameStore frames = new FrameStore();
  volatile String imeStatus = "点击目标文本框后，设备中文输入会连接所选控制器";
  volatile boolean clipboardWindowFocused;
  final PointerCalibration pointerCalibration = new PointerCalibration();
  private int port;
  private FrameServer server;
  private String serverError;
  private String deviceId;
  private String wifiAddress;
  private Network wifiNetwork;
  private BoardSetup boardSetup;
  private final Handler endpointHandler = new Handler(Looper.getMainLooper());
  private static final long[] ENDPOINT_RETRY_DELAYS = {1000, 3000, 10000};
  private final Set<Network> availableNetworks = new HashSet<>();
  private long endpointGeneration;
  private int endpointRetries;
  private Runnable endpointRetry;
  private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
    @Override public void onAvailable(Network network) {
      synchronized (ScreenApplication.this) { availableNetworks.add(network); updateNetwork(network, getSystemService(ConnectivityManager.class).getLinkProperties(network)); }
    }
    @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
      synchronized (ScreenApplication.this) { if (availableNetworks.contains(network)) updateNetwork(network, properties); }
    }
    @Override public void onLost(Network network) {
      synchronized (ScreenApplication.this) {
        availableNetworks.remove(network);
        if (network.equals(wifiNetwork)) { wifiNetwork = null; wifiAddress = null; restartServer(); }
      }
    }
  };

  @Override public void onCreate() {
    super.onCreate();
    SharedPreferences settings = getSharedPreferences("screen-source", MODE_PRIVATE);
    settings.edit().remove("screenToken").apply();
    port = settings.getInt("port", 8791);
    try { frames.configurePreview(PreviewProfile.fromId(settings.getString("previewProfile", "standard"))); }
    catch (IllegalArgumentException invalidSavedProfile) { frames.configurePreview(PreviewProfile.STANDARD); }
    deviceId = settings.getString("deviceId", null);
    if (deviceId == null) { deviceId = UUID.randomUUID().toString(); settings.edit().putString("deviceId", deviceId).apply(); }
    ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
    for (Network network : connectivity.getAllNetworks()) {
      NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
      if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
          && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
        availableNetworks.add(network);
        updateNetwork(network, connectivity.getLinkProperties(network));
      }
    }
    if (wifiAddress == null) restartServer();
    connectivity.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), networkCallback);
    boardSetup = new BoardSetup(this, settings);
  }

  private synchronized void updateNetwork(Network network, LinkProperties properties) {
    String nextAddress = null;
    if (properties != null) {
      for (LinkAddress link : properties.getLinkAddresses()) {
        if (link.getAddress() instanceof Inet4Address && FrameServer.privatePeer(link.getAddress())) {
          nextAddress = link.getAddress().getHostAddress(); break;
        }
      }
    }
    if (nextAddress == null) {
      if (network.equals(wifiNetwork) && wifiAddress != null) { wifiAddress = null; restartServer(); }
      return;
    }
    boolean changed = !network.equals(wifiNetwork) || !nextAddress.equals(wifiAddress);
    wifiNetwork = network;
    if (changed) { wifiAddress = nextAddress; restartServer(); }
    else if (server == null && endpointRetry == null && endpointRetries == 0) startServerAttempt();
  }

  synchronized void configure(Intent intent) {
    if (intent == null || !intent.hasExtra("port")) return;
    if (frames.isActive()) throw new IllegalStateException("请先停止投屏再修改连接配置");
    int nextPort = intent.hasExtra("port") ? intent.getIntExtra("port", 8791) : port;
    if (nextPort < 1024 || nextPort > 65535) throw new IllegalArgumentException("端口需为 1024..65535");
    if (nextPort == port) return;
    port = nextPort;
    getSharedPreferences("screen-source", MODE_PRIVATE).edit().putInt("port", port).apply();
    restartServer();
  }

  private synchronized void restartServer() {
    resetEndpointRetries();
    if (server != null) server.close();
    server = null; serverError = null;
    if (wifiAddress == null) { serverError = "请让手机和电脑连接同一 Wi-Fi 内网（私有 IPv4）"; return; }
    startServerAttempt();
  }

  private void resetEndpointRetries() {
    endpointGeneration++;
    if (endpointRetry != null) endpointHandler.removeCallbacks(endpointRetry);
    endpointRetry = null; endpointRetries = 0;
  }

  private void startServerAttempt() {
    if (wifiAddress == null || wifiNetwork == null) return;
    if (server != null && server.isListening()) return;
    if (server != null) server.close();
    server = null;
    try { server = new FrameServer(this, frames, wifiAddress, port); }
    catch (IOException error) {
      serverError = "内网连接暂不可用，请稍候或点“重试内网连接”";
      if (endpointRetries >= ENDPOINT_RETRY_DELAYS.length) return;
      final long generation = endpointGeneration;
      long delay = ENDPOINT_RETRY_DELAYS[endpointRetries++];
      endpointRetry = new Runnable() {
        @Override public void run() {
          synchronized (ScreenApplication.this) {
            if (endpointRetry != this || generation != endpointGeneration) return;
            endpointRetry = null; startServerAttempt();
          }
        }
      };
      endpointHandler.postDelayed(endpointRetry, delay);
      return;
    }
    serverError = null;
  }

  /** Explicit user retry. A healthy listener and its streams remain untouched. */
  synchronized boolean retryServer() {
    if (server != null && server.isListening()) return true;
    resetEndpointRetries();
    startServerAttempt();
    return server != null && server.isListening();
  }

  synchronized int port() { return port; }
  synchronized void configurePreview(PreviewProfile profile) {
    // Persist before acknowledging HTTP so an immediately restarted app keeps it.
    if (!getSharedPreferences("screen-source", MODE_PRIVATE).edit().putString("previewProfile", profile.id).commit()) {
      throw new IllegalStateException("Preview setting could not be saved");
    }
    frames.configurePreview(profile);
  }
  synchronized String serverError() {
    return server != null && !server.isListening() ? "内网连接服务已中断，请点“重试内网连接”" : serverError;
  }
  synchronized String wifiAddress() { return wifiAddress; }
  synchronized String deviceId() { return deviceId; }
  synchronized Network wifiNetwork() { return wifiNetwork; }
  BoardSetup boardSetup() { return boardSetup; }
  synchronized String health() {
    Display screen = getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
    return frames.health(port, deviceId, Build.MANUFACTURER + " " + Build.MODEL, screen == null ? 0 : screen.getRotation());
  }
}
