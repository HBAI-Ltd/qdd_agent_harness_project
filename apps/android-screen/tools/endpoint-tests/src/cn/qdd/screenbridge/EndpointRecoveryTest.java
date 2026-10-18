package cn.qdd.screenbridge;

import android.app.Application;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.os.Handler;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/** Production application and HTTP server, deterministic Android callbacks, real loopback sockets. */
public final class EndpointRecoveryTest {
  private static int checks;
  private static void check(boolean value, String message) {
    checks++;
    if (!value) throw new AssertionError(message);
  }
  private static Field field(String name) throws Exception {
    Field result = ScreenApplication.class.getDeclaredField(name);
    result.setAccessible(true); return result;
  }
  private static FrameServer server(ScreenApplication app) throws Exception { return (FrameServer) field("server").get(app); }
  private static boolean retry(ScreenApplication app) throws Exception {
    Method method = ScreenApplication.class.getDeclaredMethod("retryServer");
    method.setAccessible(true); return (boolean) method.invoke(app);
  }
  private static boolean connects(int port) throws Exception {
    try (Socket socket = new Socket()) {
      socket.connect(new InetSocketAddress("127.0.0.1", port), 300); return true;
    } catch (ConnectException refused) { return false; }
  }
  private static void health(int port) throws Exception {
    try (Socket socket = new Socket("127.0.0.1", port)) { health(socket, port); }
  }
  private static void health(Socket socket, int port) throws Exception {
    socket.setSoTimeout(1500);
    socket.getOutputStream().write(("GET /health HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
    String status = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8)).readLine();
    check(status != null && status.contains("200"), "production HTTP health returns 200");
  }
  private static final class Fixture implements AutoCloseable {
    final ScreenApplication app = new ScreenApplication();
    final Network wifi = new Network(1);
    final LinkProperties properties = new LinkProperties("127.0.0.1");
    final ConnectivityManager connectivity = ConnectivityManager.INSTANCE;
    final ConnectivityManager.NetworkCallback callback;
    final ServerSocket occupied = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
    final int port = occupied.getLocalPort();
    Fixture() throws Exception {
      Handler.reset(); connectivity.networks.clear(); Application.preferences.clear();
      field("port").set(app, port); field("deviceId").set(app, "00000000-0000-4000-8000-000000000001");
      callback = (ConnectivityManager.NetworkCallback) field("networkCallback").get(app);
      connectivity.networks.put(wifi, properties);
      app.frames.begin();
    }
    void available() { callback.onAvailable(wifi); }
    void same() { callback.onLinkPropertiesChanged(wifi, properties); }
    @Override public void close() throws Exception {
      callback.onLost(wifi);
      FrameServer current = server(app); if (current != null) current.close();
      occupied.close(); Handler.reset(); connectivity.networks.clear(); Application.preferences.clear();
    }
  }

  private static void transientBindFailure() throws Exception {
    try (Fixture f = new Fixture()) {
      f.available();
      check(server(f.app) == null && f.app.serverError() != null, "occupied bind fails explicitly");
      f.occupied.close(); f.same(); Handler.advance(1000);
      // This assertion fails against the captured pre-fix production classes.
      check(connects(f.port), "same-IP transient bind failure must recover after the bounded retry");
      health(f.port);
      check(f.app.frames.isActive(), "listener recovery keeps projection lifecycle active");
      check(f.app.serverError() == null && Handler.pending() == 0, "successful retry clears error and scheduled task");
    }
  }
  private static void boundedBudgetAndManualRetry() throws Exception {
    try (Fixture f = new Fixture()) {
      f.available(); Runnable first = Handler.next();
      check(first != null && Handler.pending() == 1, "one initial retry is scheduled");
      for (int i = 0; i < 10; i++) f.same();
      check(Handler.next() == first && Handler.pending() == 1, "same-IP events cannot reset or multiply retry budget");
      Handler.advance(999); check(Handler.next() == first, "first retry does not run early");
      Handler.advance(1); Runnable second = Handler.next();
      check(second != first && second != null && Handler.pending() == 1, "first retry advances once");
      Handler.advance(2999); check(Handler.next() == second, "second retry waits three seconds");
      Handler.advance(1); Runnable third = Handler.next();
      check(third != second && third != null && Handler.pending() == 1, "second retry advances once");
      Handler.advance(9999); check(Handler.next() == third, "final retry waits ten seconds");
      Handler.advance(1); check(Handler.pending() == 0, "three failed retries exhaust budget");
      f.occupied.close();
      for (int i = 0; i < 10; i++) f.same();
      Handler.advance(60000);
      check(Handler.pending() == 0 && !connects(f.port), "exhausted budget cannot silently restart indefinitely");
      check(retry(f.app), "explicit user retry restores same-IP endpoint after exhausted budget");
      health(f.port);
    }
  }
  private static void healthyListenerIsPreserved() throws Exception {
    try (Fixture f = new Fixture()) {
      f.occupied.close(); f.available(); FrameServer original = server(f.app);
      try (Socket held = new Socket("127.0.0.1", f.port)) {
        f.same(); check(retry(f.app), "manual retry reports already healthy");
        check(server(f.app) == original && Handler.pending() == 0, "healthy listener is not closed or rebuilt");
        health(held, f.port);
      }
    }
  }
  private static void lostNetworkRetiresCallbacks() throws Exception {
    try (Fixture f = new Fixture()) {
      f.available(); Runnable stale = Handler.next(); f.occupied.close();
      f.connectivity.networks.remove(f.wifi); f.callback.onLost(f.wifi);
      check(f.app.wifiAddress() == null && Handler.pending() == 0, "Wi-Fi loss clears address and retry");
      stale.run(); f.same(); Handler.advance(60000);
      check(server(f.app) == null && !connects(f.port) && Handler.pending() == 0,
          "late retry and link-properties callback cannot revive a lost network");
    }
  }
  private static void changedNetworkRetiresCallbacks() throws Exception {
    try (Fixture f = new Fixture()) {
      f.available(); Runnable stale = Handler.next(); f.occupied.close();
      Network next = new Network(2); f.connectivity.networks.put(next, f.properties);
      f.callback.onAvailable(next); FrameServer current = server(f.app);
      check(current != null && next.equals(f.app.wifiNetwork()), "same IP on new Network starts a new generation");
      f.callback.onLost(f.wifi); stale.run(); f.same(); Handler.advance(60000);
      check(server(f.app) == current && next.equals(f.app.wifiNetwork()) && Handler.pending() == 0,
          "old network loss, link properties and retry do not replace the new listener");
      health(f.port); f.callback.onLost(next);
    }
  }
  private static void changedAddressRetiresCallbacks() throws Exception {
    try (Fixture f = new Fixture()) {
      f.available(); Runnable stale = Handler.next(); f.occupied.close();
      f.callback.onLinkPropertiesChanged(f.wifi, null);
      check(f.app.wifiAddress() == null && Handler.pending() == 0, "address loss retires pending retry");
      stale.run(); check(server(f.app) == null, "old address retry cannot resurrect listener");
      f.same(); health(f.port);
      check(Handler.pending() == 0, "restored address binds without old retry");
    }
  }
  private static void startupDoesNotDoubleRetryBudget() throws Exception {
    try (Fixture f = new Fixture()) {
      Application.preferences.put("port", f.port);
      Application.preferences.put("deviceId", "00000000-0000-4000-8000-000000000001");
      f.app.onCreate();
      check(Handler.pending() == 1 && field("endpointGeneration").getLong(f.app) == 1,
          "startup enumeration must not restart the already attempted network a second time");
      Runnable initial = Handler.next(); f.available();
      check(Handler.next() == initial, "initial available callback does not reset startup retry");
      f.occupied.close(); Handler.advance(1000); health(f.port);
    }
  }
  private static void closedListenerHasExplicitRecovery() throws Exception {
    try (Fixture f = new Fixture()) {
      f.occupied.close(); f.available(); FrameServer before = server(f.app);
      Field listener = FrameServer.class.getDeclaredField("listener"); listener.setAccessible(true);
      ((ServerSocket) listener.get(before)).close();
      check(f.app.serverError() != null && !connects(f.port), "closed listener is reported separately from active projection");
      check(f.app.frames.isActive(), "injected listener failure does not invent projection failure");
      check(retry(f.app) && server(f.app) != before, "explicit retry replaces only failed listener");
      health(f.port);
    }
  }
  public static void main(String[] args) throws Exception {
    transientBindFailure(); boundedBudgetAndManualRetry(); healthyListenerIsPreserved();
    lostNetworkRetiresCallbacks(); changedNetworkRetiresCallbacks(); changedAddressRetiresCallbacks();
    startupDoesNotDoubleRetryBudget(); closedListenerHasExplicitRecovery();
    System.out.println("Endpoint recovery: " + checks + " checks PASS (production application/server, Android event fixtures, real loopback TCP; no device)");
  }
}
