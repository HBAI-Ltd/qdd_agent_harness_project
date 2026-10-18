package cn.qdd.screenbridge;

import android.os.SystemClock;
import java.awt.image.BufferedImage;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;

/** Real HTTP sockets with production FrameStore/FrameServer; no Android device or input. */
public final class StreamTransportTest {
  private static int checks;
  private static byte[] jpeg;

  private interface Checked { void run() throws Exception; }
  private static void test(String name, Checked action) throws Exception {
    action.run(); checks += 1; System.out.println("PASS " + name);
  }
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static final class Fixture implements AutoCloseable {
    final FrameStore frames = new FrameStore();
    final long owner = frames.begin();
    final FrameServer server = new FrameServer(new ScreenApplication(frames), frames, "127.0.0.1", 0);
    final int port;
    Fixture() throws Exception {
      Field field = FrameServer.class.getDeclaredField("listener"); field.setAccessible(true);
      port = ((ServerSocket) field.get(server)).getLocalPort();
    }
    FrameStore.Frame publish(String id, int rotation, int width, int height, byte[] bytes) {
      FrameStore.Frame frame = new FrameStore.Frame(bytes, "image/jpeg", width, height, rotation,
          SystemClock.elapsedRealtime(), Instant.now().toString(), id);
      frames.publish(owner, frame); return frame;
    }
    Client open(String path) throws Exception { return new Client(port, path, "127.0.0.1:" + port, null); }
    Client profile(String method, String body, String extra) throws Exception {
      byte[] payload = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
      return new Client(port, "/preview/profile", "127.0.0.1:" + port, null, method, payload,
          "Content-Type: application/json\r\nContent-Length: " + payload.length + "\r\n" + extra);
    }
    FutureTask<Void> nextOriginal(String id, byte[] bytes) {
      FutureTask<Void> task = new FutureTask<>(() -> {
        await(() -> check(frames.needsOriginal(owner, frames.captureEpoch(owner), SystemClock.elapsedRealtime()), "New original requested"), 2000);
        publish(id, 0, 8, 12, bytes); return null;
      });
      new Thread(task, "fixture-new-acquisition").start(); return task;
    }
    @Override public void close() { server.close(); }
  }

  private static final class Client implements AutoCloseable {
    final Socket socket;
    final InputStream input;
    final Map<String, String> headers;
    final int status;
    Client(int port, String path, String host, String origin) throws Exception {
      this(port, path, host, origin, "GET", new byte[0], "");
    }
    Client(int port, String path, String host, String origin, String method, byte[] body, String bodyHeaders) throws Exception {
      socket = new Socket(); socket.setReceiveBufferSize(4096); socket.connect(new java.net.InetSocketAddress("127.0.0.1", port), 1500);
      socket.setSoTimeout(3500); input = new BufferedInputStream(socket.getInputStream());
      socket.getOutputStream().write((method + " " + path + " HTTP/1.1\r\nHost: " + host
          + (origin == null ? "" : "\r\nOrigin: " + origin) + "\r\n" + bodyHeaders + "\r\n").getBytes(StandardCharsets.US_ASCII));
      socket.getOutputStream().write(body); socket.getOutputStream().flush();
      String statusLine = line(input); check(statusLine != null, "Missing response"); status = Integer.parseInt(statusLine.split(" ")[1]);
      headers = headers(input);
    }
    Part part() throws Exception {
      check("--qdd-frame".equals(line(input)), "Multipart boundary must match");
      Map<String, String> fields = headers(input);
      byte[] body = readExactly(input, Integer.parseInt(fields.get("Content-Length")));
      check("".equals(line(input)), "Frame requires trailing CRLF"); return new Part(fields, body);
    }
    byte[] body() throws Exception { return readExactly(input, Integer.parseInt(headers.get("Content-Length"))); }
    @Override public void close() throws IOException { socket.close(); }
  }

  private static final class Part {
    final Map<String, String> headers;
    final byte[] body;
    Part(Map<String, String> headers, byte[] body) { this.headers = headers; this.body = body; }
  }

  private static String line(InputStream input) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int previous = -1;
    while (bytes.size() <= 8192) {
      int next = input.read(); if (next < 0) { if (bytes.size() == 0) return null; throw new EOFException("Partial header"); }
      if (previous == '\r' && next == '\n') {
        byte[] raw = bytes.toByteArray(); return new String(raw, 0, raw.length - 1, StandardCharsets.US_ASCII);
      }
      bytes.write(next); previous = next;
    }
    throw new IOException("Header exceeded bound");
  }
  private static Map<String, String> headers(InputStream input) throws IOException {
    Map<String, String> result = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
    for (;;) {
      String value = line(input); if (value == null) throw new EOFException("Missing header terminator"); if (value.isEmpty()) return result;
      int colon = value.indexOf(':'); check(colon > 0, "Malformed header"); result.put(value.substring(0, colon), value.substring(colon + 1).trim());
    }
  }
  private static byte[] readExactly(InputStream input, int size) throws IOException {
    byte[] bytes = new byte[size]; int position = 0;
    while (position < size) { int count = input.read(bytes, position, size - position); if (count < 0) throw new EOFException("Truncated body"); position += count; }
    return bytes;
  }
  private static void await(Checked assertion, long timeoutMs) throws Exception {
    long limit = SystemClock.elapsedRealtime() + timeoutMs;
    for (;;) { try { assertion.run(); return; } catch (AssertionError pending) { if (SystemClock.elapsedRealtime() >= limit) throw pending; Thread.sleep(25); } }
  }
  private static void noBytes(Client client) throws Exception {
    client.socket.setSoTimeout(120);
    try { int value = client.input.read(); throw new AssertionError("Old frame repeated or stream closed: " + value); }
    catch (SocketTimeoutException expected) { /* A stream only sends genuinely new frames. */ }
    finally { client.socket.setSoTimeout(2000); }
  }

  public static void main(String[] args) throws Exception {
    ByteArrayOutputStream encoded = new ByteArrayOutputStream();
    ImageIO.write(new BufferedImage(8, 12, BufferedImage.TYPE_INT_RGB), "jpeg", encoded); jpeg = encoded.toByteArray();
    check(jpeg[0] == (byte) 0xff && jpeg[1] == (byte) 0xd8, "Fixture must be a genuine encoded JPEG");

    test("one HTTP connection receives distinct actual JPEG frames and original capture metadata", () -> {
      try (Fixture fixture = new Fixture()) {
        FrameStore.Frame original = fixture.publish("first", 0, 8, 12, jpeg);
        try (Client stream = fixture.open("/stream.mjpg")) {
          check(stream.status == 200, "Stream should open without authentication");
          check("multipart/x-mixed-replace; boundary=qdd-frame".equals(stream.headers.get("Content-Type")), "MIME boundary contract");
          check(!stream.headers.containsKey("Content-Length"), "Continuous response has no total content length");
          Part first = stream.part(); check(Arrays.equals(jpeg, first.body), "JPEG bytes must be exact");
          check(original.capturedAt.equals(first.headers.get("X-Captured-At")), "Acquisition UTC must be preserved");
          check("first".equals(first.headers.get("X-Frame-Id")), "Frame identity must be preserved");
          check(Long.parseLong(first.headers.get("X-Frame-Age-Ms")) < 1000, "Age uses monotonic acquisition time");
          noBytes(stream);
          fixture.publish("second", 0, 8, 12, jpeg);
          check("second".equals(stream.part().headers.get("X-Frame-Id")), "Second frame arrives without another HTTP request");
          noBytes(stream);
        }
      }
    });

    test("stream survives the short-request deadline and does not relabel stale images", () -> {
      try (Fixture fixture = new Fixture(); Client stream = fixture.open("/stream.mjpg")) {
        fixture.publish("before-idle", 0, 8, 12, jpeg); stream.part();
        Thread.sleep(3300); noBytes(stream);
        try (Client snapshot = fixture.open("/frame.jpg")) { check(snapshot.status == 503, "Expired cached image stays expired"); }
        fixture.publish("after-idle", 0, 8, 12, jpeg);
        Part fresh = stream.part(); check("after-idle".equals(fresh.headers.get("X-Frame-Id")), "Connection still delivers after 3 seconds");
      }
    });

    test("a burst selects the newest frame instead of creating a per-client backlog", () -> {
      try (Fixture fixture = new Fixture(); Client stream = fixture.open("/stream.mjpg")) {
        fixture.publish("initial", 0, 8, 12, jpeg); stream.part();
        synchronized (fixture.frames) {
          for (int index = 1; index <= 20; index += 1) fixture.publish("burst-" + index, 0, 8, 12, jpeg);
        }
        check("burst-20".equals(stream.part().headers.get("X-Frame-Id")), "Only the newest available frame is sent");
        noBytes(stream);
      }
    });

    test("rotation invalidates old geometry and streams the new geometry without reconnect", () -> {
      try (Fixture fixture = new Fixture()) {
        fixture.publish("portrait", 0, 8, 12, jpeg);
        FrameStore.Frame lease = fixture.frames.fresh();
        try (Client stream = fixture.open("/stream.mjpg")) {
          stream.part(); fixture.frames.invalidate(fixture.owner);
          check(!fixture.frames.currentGeometry(lease), "Previously acquired geometry becomes invalid"); noBytes(stream);
          fixture.publish("landscape", 1, 12, 8, jpeg);
          Part rotated = stream.part(); check("1".equals(rotated.headers.get("X-Display-Rotation")), "Rotation metadata");
          check("12".equals(rotated.headers.get("X-Frame-Width")) && "8".equals(rotated.headers.get("X-Frame-Height")), "New dimensions");
        }
      }
    });

    test("delayed JPEG completion retains acquisition time and cannot publish across rotation or new consent", () -> {
      try (Fixture fixture = new Fixture()) {
        long epoch = fixture.frames.captureEpoch(fixture.owner);
        long acquired = SystemClock.elapsedRealtime() - 200;
        FrameStore.Frame old = new FrameStore.Frame(jpeg, "image/jpeg", 8, 12, 0, acquired, "2026-10-17T00:00:00Z", "worker-old");
        check(fixture.frames.publish(fixture.owner, epoch, old), "Current worker may publish its actual acquisition");
        check(fixture.frames.fresh().age() >= 200 && fixture.frames.fresh().capturedAt.equals(old.capturedAt), "JPEG completion must not relabel source acquisition as now");
        fixture.frames.invalidate(fixture.owner);
        check(!fixture.frames.publish(fixture.owner, epoch, old) && fixture.frames.fresh() == null, "Old JPEG worker cannot repaint the new rotation");
        long currentEpoch = fixture.frames.captureEpoch(fixture.owner);
        check(fixture.frames.publish(fixture.owner, currentEpoch, old), "A frame acquired in the current geometry may publish");
        fixture.frames.begin();
        check(!fixture.frames.publish(fixture.owner, currentEpoch, old), "Old consent worker cannot publish after a new projection begins");
      }
    });

    test("healthy large-frame traffic keeps one connection and reports actual write bytes and duration", () -> {
      try (Fixture fixture = new Fixture(); Client stream = fixture.open("/stream.mjpg")) {
        byte[] large = new byte[512 * 1024];
        for (int index = 0; index < 8; index++) {
          fixture.publish("large-" + index, 0, 1080, 2400, large);
          check(Arrays.equals(large, stream.part().body), "Large transport payload remains exact");
        }
        await(() -> check(fixture.frames.health(fixture.port, "test", "test", 0).contains("\"streamWrittenFrames\":8"), "All completed writes are counted"), 1000);
        String health = fixture.frames.health(fixture.port, "test", "test", 0);
        check(health.contains("\"streamOpens\":1") && health.contains("\"streamWriteTimeouts\":0") && health.contains("\"streamWrittenBytes\":4194304"), "Ordinary large writes never look like disconnected slow readers");
      }
    });

    test("two stream limit reserves short-request workers for snapshot and health", () -> {
      try (Fixture fixture = new Fixture()) {
        fixture.publish("shared", 0, 8, 12, jpeg);
        try (Client first = fixture.open("/stream.mjpg"); Client second = fixture.open("/stream.mjpg"); Client third = fixture.open("/stream.mjpg")) {
          check(first.status == 200 && second.status == 200 && third.status == 503, "Only two streams are admitted");
          first.part(); second.part();
          FutureTask<Void> newCapture = fixture.nextOriginal("new-original", jpeg);
          try (Client health = fixture.open("/health"); Client snapshot = fixture.open("/frame.jpg")) {
            check(health.status == 200 && snapshot.status == 200, "Diagnostic endpoints remain responsive");
            String json = new String(health.body(), StandardCharsets.UTF_8);
            check(json.contains("\"streamClients\":2") && json.contains("\"maxFps\":30.3"), "Health advertises actual stream mode");
            check(Arrays.equals(jpeg, snapshot.body()), "Snapshot MIME and bytes remain JPEG");
          }
          newCapture.get(2, TimeUnit.SECONDS);
        }
      }
    });

    test("client disconnect during a quiet screen releases the stream and capture cadence", () -> {
      try (Fixture fixture = new Fixture()) {
        Client stream = fixture.open("/stream.mjpg");
        await(() -> check(fixture.frames.hasStreams(), "Stream starts"), 500); stream.close();
        await(() -> check(!fixture.frames.hasStreams(), "Disconnected stream must release ownership"), 1500);
        String health = fixture.frames.health(fixture.port, "test", "test", 0);
        check(health.contains("\"streamOpens\":1") && health.contains("\"streamCloses\":1")
            && health.contains("\"lastStreamClose\":\"client_disconnected\""), "Health records a quiet client disconnect, without request data");
      }
    });

    test("stopping projection closes a stream and a later consent generation cannot revive it", () -> {
      try (Fixture fixture = new Fixture(); Client stream = fixture.open("/stream.mjpg")) {
        fixture.publish("stopping", 0, 8, 12, jpeg); stream.part();
        fixture.frames.stop(fixture.owner, "Stopped");
        check("--qdd-frame--".equals(line(stream.input)), "Final multipart boundary on stop");
        check(stream.input.read() == -1, "Stopped stream closes");
        fixture.frames.finishStop(fixture.owner);
        long next = fixture.frames.begin();
        fixture.frames.publish(next, new FrameStore.Frame(jpeg, "image/jpeg", 8, 12, 0, SystemClock.elapsedRealtime(), Instant.now().toString(), "new-consent"));
        check(!fixture.frames.streaming(fixture.owner), "Old authorization generation cannot resume");
      }
    });

    test("non-reading clients are closed within bounded writes and do not starve health", () -> {
      try (Fixture fixture = new Fixture()) {
        // Transport stress payload only: actual JPEG validity is checked in the first test.
        byte[] large = new byte[8 * 1024 * 1024]; fixture.publish("slow-client", 0, 1080, 2400, large);
        try (Client first = fixture.open("/stream.mjpg"); Client second = fixture.open("/stream.mjpg")) {
          check(first.status == 200 && second.status == 200, "Slow streams open");
          long started = SystemClock.elapsedRealtime();
          try (Client health = fixture.open("/health")) { check(health.status == 200, "Health remains independent"); health.body(); }
          check(SystemClock.elapsedRealtime() - started < 1500, "Slow stream cannot monopolize diagnostic workers");
          await(() -> check(!fixture.frames.hasStreams(), "Both blocked writers must time out"), 3500);
          String health = fixture.frames.health(fixture.port, "test", "test", 0);
          check(health.contains("\"streamWriteTimeouts\":2") && health.contains("\"lastStreamClose\":\"write_timeout\""), "Bounded write timeouts must be distinguishable from stopped projection");
          fixture.publish("recovered", 0, 8, 12, jpeg);
          try (Client recovered = fixture.open("/stream.mjpg")) { check(recovered.status == 200, "Timed-out streams release permits"); recovered.part(); }
        }
      }
    });

    test("stream shares private host/origin checks and retains the diagnostic route contract", () -> {
      try (Fixture fixture = new Fixture()) {
        try (Client badHost = new Client(fixture.port, "/stream.mjpg", "example.com", null);
             Client badOrigin = new Client(fixture.port, "/stream.mjpg", "127.0.0.1", "https://example.com");
             Client old = fixture.open("/frame.png")) {
          check(badHost.status == 403 && badOrigin.status == 403, "Host and Origin boundary applies before streaming");
          check(old.status == 404, "Old PNG endpoint remains absent");
        }
        fixture.frames.stop(fixture.owner, "Stopped");
        try (Client inactive = fixture.open("/stream.mjpg")) { check(inactive.status == 503, "Projection is required"); }
      }
    });

    test("server shutdown disconnects waiting streams and releases their ownership", () -> {
      try (Fixture fixture = new Fixture(); Client stream = fixture.open("/stream.mjpg")) {
        await(() -> check(fixture.frames.hasStreams(), "Stream starts"), 500);
        fixture.server.close(); check(stream.input.read() == -1, "Server close disconnects socket");
        await(() -> check(!fixture.frames.hasStreams(), "Server close releases stream capture mode"), 1000);
      }
    });

    test("capture telemetry stays bounded, ignores old projection owners and never renews frame age", () -> {
      try (Fixture fixture = new Fixture()) {
        FrameStore.Frame frame = fixture.publish("source", 0, 8, 12, jpeg);
        fixture.frames.imageAvailable(fixture.owner); fixture.frames.imageAvailable(fixture.owner);
        fixture.frames.emptyAcquire(fixture.owner); fixture.frames.surfaceRefreshed(fixture.owner);
        long source = SystemClock.elapsedRealtime();
        for (int index = 0; index < 70; index += 1) fixture.frames.captureEncoded(fixture.owner, source + index * 33, 20, 17);
        fixture.frames.captureEncoded(fixture.owner - 1, source, 999, 999);
        String health = fixture.frames.health(fixture.port, "test", "test", 0);
        check(health.contains("\"captureFrames2s\":64") && health.contains("\"encodedFrames\":70"), "Recent capture history is bounded while counters retain total activity");
        check(health.contains("\"imageCallbacks\":2") && health.contains("\"emptyAcquires\":1")
            && health.contains("\"surfaceRefreshes\":1"), "Source callback and refresh counters are independent");
        check(health.contains("\"lastCaptureMs\":20") && health.contains("\"lastEncodeMs\":17")
            && health.contains("\"lastSourceIntervalMs\":33") && health.contains("\"maxCaptureMs\":20"), "Timing telemetry ignores old owners");
        check(fixture.frames.fresh().elapsed == frame.elapsed && fixture.frames.fresh().id.equals("source"), "Telemetry must not relabel or renew an old frame");
        fixture.frames.begin();
        health = fixture.frames.health(fixture.port, "test", "test", 0);
        check(health.contains("\"captureFrames2s\":0") && health.contains("\"encodedFrames\":0"), "A new projection resets capture counters");
      }
    });

    test("Wi-Fi optimization telemetry belongs only to the active projection", () -> {
      try (Fixture fixture = new Fixture()) {
        fixture.frames.wifiLock(fixture.owner, "high_performance", true);
        String health = fixture.frames.health(fixture.port, "test", "test", 0);
        check(health.contains("\"wifiLockHeld\":true") && health.contains("\"wifiLockRequestedMode\":\"high_performance\""), "Health distinguishes an API-held lock from a measured throughput promise");
        fixture.frames.stop(fixture.owner, "Stopped");
        fixture.frames.wifiLock(fixture.owner, "high_performance", true);
        health = fixture.frames.health(fixture.port, "test", "test", 0);
        check(health.contains("\"wifiLockHeld\":false") && health.contains("\"wifiLockRequestedMode\":\"none\""), "A late acquisition result cannot resurrect stopped health state");
        fixture.frames.finishStop(fixture.owner);
        long next = fixture.frames.begin(); fixture.frames.wifiLock(next, "low_latency", true);
        fixture.frames.wifiLock(fixture.owner, "none", false);
        health = fixture.frames.health(fixture.port, "test", "test", 0);
        check(health.contains("\"wifiLockHeld\":true") && health.contains("\"wifiLockRequestedMode\":\"low_latency\""), "An old release cannot overwrite new projection telemetry");
      }
    });

    test("preview presets use strict bounded private HTTP configuration without changing physical geometry", () -> {
      try (Fixture fixture = new Fixture()) {
        fixture.frames.dimensions(fixture.owner, 1080, 2400);
        try (Client current = fixture.open("/preview/profile")) {
          String body = new String(current.body(), StandardCharsets.UTF_8);
          check(current.status == 200 && body.contains("\"profile\":\"standard\"") && body.contains("\"deviceWidth\":1080"), "Default and physical dimensions are explicit");
        }
        long geometry = fixture.frames.captureEpoch(fixture.owner);
        for (PreviewProfile profile : PreviewProfile.values()) {
          try (Client saved = fixture.profile("POST", "{\"profile\":\"" + profile.id + "\"}", "")) {
            check(saved.status == 200 && new String(saved.body(), StandardCharsets.UTF_8).contains("\"profile\":\"" + profile.id + "\""), "POST acknowledges configured profile");
          }
          check(fixture.frames.captureEpoch(fixture.owner) == geometry, "A profile switch never changes the input coordinate geometry");
        }
        String[] bad = { "{}", "{\"profile\":\"unknown\"}", "{\"profile\":true}", "{\"profile\":\"fast\",\"extra\":1}" };
        for (String body : bad) try (Client invalid = fixture.profile("POST", body, "")) { check(invalid.status == 400, "Invalid enum/shape is rejected"); }
        try (Client large = fixture.profile("POST", new String(new char[257]).replace('\0', ' '), "")) { check(large.status == 413, "257-byte bodies are rejected before reading"); }
        try (Client transfer = fixture.profile("POST", "{\"profile\":\"fast\"}", "Transfer-Encoding: chunked\r\n")) { check(transfer.status == 400, "Ambiguous transfer framing is rejected"); }
        try (Client badHost = new Client(fixture.port, "/preview/profile", "example.com", null);
             Client badOrigin = new Client(fixture.port, "/preview/profile", "127.0.0.1", "https://example.com")) {
          check(badHost.status == 403 && badOrigin.status == 403, "Preset configuration shares the screen LAN boundary");
        }
        check(fixture.frames.previewSettings().profile == PreviewProfile.ORIGINAL, "Rejected requests cannot modify the profile");
      }
    });

    test("late preview workers cannot repaint an old preset and quality switches retain original demand", () -> {
      try (Fixture fixture = new Fixture()) {
        long geometry = fixture.frames.captureEpoch(fixture.owner);
        FrameStore.PreviewSettings before = fixture.frames.previewSettings();
        FrameStore.Frame old = new FrameStore.Frame(jpeg, "image/jpeg", 720, 1600, 0, 1080, 2400, "standard",
            SystemClock.elapsedRealtime(), Instant.now().toString(), "standard-worker");
        check(fixture.frames.publishPreview(fixture.owner, geometry, before.revision, old), "Current preset publishes");
        FrameStore.Frame observed = fixture.frames.fresh();
        FrameStore.OriginalRequest request = fixture.frames.requestOriginal();
        fixture.frames.configurePreview(PreviewProfile.TURBO);
        check(fixture.frames.currentGeometry(observed) && !fixture.frames.currentPreview(observed) && fixture.frames.fresh() == null,
            "Preview invalidation preserves physical geometry while removing old display bytes");
        check(!fixture.frames.publishPreview(fixture.owner, geometry, before.revision, old), "Old preset encoding cannot reappear after POST");
        check(fixture.frames.needsOriginal(fixture.owner, geometry, request.requestedAt + 1), "Switching quality cannot cancel a pending original");
        FrameStore.Frame full = new FrameStore.Frame(jpeg, "image/jpeg", 1080, 2400, 0, request.requestedAt + 1, Instant.now().toString(), "original-worker");
        check(fixture.frames.publishOriginal(fixture.owner, geometry, full), "Full pixels remain independent of preset revision");
        check(fixture.frames.awaitOriginal(request, 100).encodedBytes == full.encodedBytes, "Original response preserves encoded bytes and source time");
      }
    });

    test("MCP snapshot waits for a new full image after its request and cannot return preview or cached originals", () -> {
      try (Fixture fixture = new Fixture()) {
        fixture.publish("cached-original", 0, 8, 12, jpeg);
        fixture.frames.configurePreview(PreviewProfile.TURBO);
        FutureTask<Client> snapshotTask = new FutureTask<>(() -> fixture.open("/frame.jpg")); new Thread(snapshotTask).start();
        long geometry = fixture.frames.captureEpoch(fixture.owner);
        await(() -> check(fixture.frames.needsOriginal(fixture.owner, geometry, SystemClock.elapsedRealtime()), "Snapshot registers fresh original demand"), 1000);
        FrameStore.Frame preview = new FrameStore.Frame(new byte[] {1, 2}, "image/jpeg", 4, 6, 0, 8, 12, "turbo",
            SystemClock.elapsedRealtime(), Instant.now().toString(), "preview-only");
        fixture.frames.publishPreview(fixture.owner, geometry, fixture.frames.previewSettings().revision, preview);
        FrameStore.Frame stale = new FrameStore.Frame(jpeg, "image/jpeg", 8, 12, 0, SystemClock.elapsedRealtime() - 1000, Instant.now().toString(), "old-acquisition");
        fixture.frames.publishOriginal(fixture.owner, geometry, stale);
        Thread.sleep(50); check(!snapshotTask.isDone(), "Neither a small preview nor old full JPEG may satisfy the new request");
        fixture.publish("new-full-acquisition", 0, 8, 12, jpeg);
        try (Client snapshot = snapshotTask.get(2, TimeUnit.SECONDS)) {
          check(snapshot.status == 200 && Arrays.equals(jpeg, snapshot.body()), "Actual full JPEG is returned");
          check("new-full-acquisition".equals(snapshot.headers.get("X-Frame-Id")) && "original".equals(snapshot.headers.get("X-Preview-Profile")), "Source identity and original role are explicit");
          check("8".equals(snapshot.headers.get("X-Frame-Width")) && "8".equals(snapshot.headers.get("X-Device-Width"))
              && "12".equals(snapshot.headers.get("X-Frame-Height")) && "12".equals(snapshot.headers.get("X-Device-Height")), "Snapshot JPEG and physical dimensions match");
        }
        check(!fixture.frames.needsOriginal(fixture.owner, geometry, Long.MAX_VALUE), "Completed requests release original encoding demand");
      }
    });

    test("preview metadata carries actual JPEG dimensions separately from the phone input geometry", () -> {
      try (Fixture fixture = new Fixture(); Client stream = fixture.open("/stream.mjpg")) {
        ByteArrayOutputStream smallBytes = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(4, 6, BufferedImage.TYPE_INT_RGB), "jpeg", smallBytes);
        FrameStore.Frame preview = new FrameStore.Frame(smallBytes.toByteArray(), "image/jpeg", 4, 6, 0, 8, 12, "turbo",
            SystemClock.elapsedRealtime(), Instant.now().toString(), "small-real-jpeg");
        fixture.frames.configurePreview(PreviewProfile.TURBO);
        fixture.frames.publishPreview(fixture.owner, fixture.frames.captureEpoch(fixture.owner), fixture.frames.previewSettings().revision, preview);
        Part part = stream.part(); BufferedImage decoded = ImageIO.read(new java.io.ByteArrayInputStream(part.body));
        check(decoded.getWidth() == 4 && decoded.getHeight() == 6 && "4".equals(part.headers.get("X-Frame-Width")) && "6".equals(part.headers.get("X-Frame-Height")), "Metadata describes actual JPEG pixels");
        check("8".equals(part.headers.get("X-Device-Width")) && "12".equals(part.headers.get("X-Device-Height")) && "turbo".equals(part.headers.get("X-Preview-Profile")), "Input geometry stays original size");
      }
    });

    test("original requests terminate on rotation stop timeout and a new projection cannot revive an old worker", () -> {
      FrameStore frames = new FrameStore(); long owner = frames.begin(), geometry = frames.captureEpoch(owner);
      FrameStore.OriginalRequest rotating = frames.requestOriginal(); frames.invalidate(owner);
      check(frames.awaitOriginal(rotating, 100) == null, "Rotation rejects the old request geometry");
      check(!frames.publishOriginal(owner, geometry, new FrameStore.Frame(jpeg, "image/jpeg", 8, 12, 0, SystemClock.elapsedRealtime(), Instant.now().toString(), "old-rotation")), "An old rotation worker cannot publish full pixels");
      FrameStore.OriginalRequest timedOut = frames.requestOriginal(); check(frames.awaitOriginal(timedOut, 10) == null, "Missing real images time out");
      check(!frames.hasCaptureDemand(), "Timeout releases sparse full encoding demand");
      FrameStore.OriginalRequest stopping = frames.requestOriginal(); frames.stop(owner, "Stopped");
      check(frames.awaitOriginal(stopping, 100) == null, "Stop unblocks original requests");
      frames.finishStop(owner);
      frames.begin(); check(!frames.publishOriginal(owner, geometry, new FrameStore.Frame(jpeg, "image/jpeg", 8, 12, 0, SystemClock.elapsedRealtime(), Instant.now().toString(), "old-consent")), "Old grant cannot paint a new projection");
    });

    test("diagnostic animation stays local and does not contain input or external resource hooks", () -> {
      try (Fixture fixture = new Fixture(); Client page = fixture.open("/diagnostic")) {
        check(page.status == 200 && "text/html; charset=utf-8".equals(page.headers.get("Content-Type")), "Diagnostic page is an explicit read-only route");
        String html = new String(page.body(), StandardCharsets.UTF_8);
        check(html.contains("@keyframes sweep") && html.contains("投屏性能测试"), "Page supplies a visible moving test target");
        check(!html.contains("<script") && !html.contains("http:") && !html.contains("https:") && !html.contains("<form"), "Animation has no remote services or input hooks");
        check(page.headers.get("Content-Security-Policy").contains("default-src 'none'"), "Only inline diagnostic CSS is enabled");
      }
    });
    System.out.println("Stream socket tests: " + checks + " passed; no phone/ADB/BLE access.");
  }
}
