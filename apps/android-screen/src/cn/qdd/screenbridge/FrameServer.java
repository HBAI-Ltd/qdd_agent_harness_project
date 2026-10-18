package cn.qdd.screenbridge;

import android.os.SystemClock;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Screen endpoint bound only to the current private Wi-Fi IPv4 address. */
final class FrameServer implements AutoCloseable {
  private final ScreenApplication app;
  private final FrameStore frames;
  private final String bindAddress;
  private final ServerSocket listener;
  private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
  private final Set<Socket> streamSockets = ConcurrentHashMap.newKeySet();
  private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4));
  private final ThreadPoolExecutor streamWorkers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(2));
  private final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1);
  private final Semaphore slots = new Semaphore(6);
  private final Semaphore streamSlots = new Semaphore(2);
  private static final String BOUNDARY = "qdd-frame";
  private static final byte[] DIAGNOSTIC_HTML = ("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">"
      + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>投屏性能测试</title><style>"
      + "*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#101b2e;color:white;font:18px sans-serif}"
      + "h1{margin:7vh 7vw 2vh;font-size:28px}p{margin:0 7vw;line-height:1.7;color:#b6c8e5}"
      + ".track{position:relative;overflow:hidden;height:13vh;margin:3vh 0;background:repeating-linear-gradient(90deg,#162a47 0 9vw,#294263 9vw 10vw)}"
      + ".bar{position:absolute;left:0;top:0;width:10vw;height:100%;background:#38d9a9;animation:sweep 2s linear infinite alternate;will-change:transform}"
      + ".track:nth-of-type(2) .bar{background:#ffca55;animation-duration:1.3s;animation-direction:alternate-reverse}"
      + ".track:nth-of-type(3) .bar{background:#ff6b91;animation-duration:2.7s}"
      + "@keyframes sweep{from{transform:translateX(0)}to{transform:translateX(90vw)}}"
      + "</style><h1>投屏性能测试</h1><p>纯本地动画，用于检查真实投屏帧率。<br>不读取文件、不发送输入、不访问外部服务。</p>"
      + "<div class=\"track\"><div class=\"bar\"></div></div><div class=\"track\"><div class=\"bar\"></div></div>"
      + "<div class=\"track\"><div class=\"bar\"></div></div></html>").getBytes(StandardCharsets.UTF_8);
  private volatile boolean closed;

  FrameServer(ScreenApplication app, FrameStore frames, String bindAddress, int port) throws IOException {
    this.app = app; this.frames = frames; this.bindAddress = bindAddress;
    deadlines.setRemoveOnCancelPolicy(true);
    listener = new ServerSocket();
    listener.setReuseAddress(true);
    try { listener.bind(new InetSocketAddress(InetAddress.getByName(bindAddress), port), 6); }
    catch (IOException error) { listener.close(); workers.shutdownNow(); streamWorkers.shutdownNow(); deadlines.shutdownNow(); throw error; }
    Thread acceptor = new Thread(this::accept, "qdd-screen-http");
    acceptor.setDaemon(true); acceptor.start();
  }

  private void accept() {
    while (!closed) {
      try {
        Socket socket = listener.accept();
        if (closed) { closeSocket(socket); return; }
        if (!slots.tryAcquire()) { closeSocket(socket); continue; }
        sockets.add(socket);
        try { socket.setSoTimeout(1500); }
        catch (IOException disconnected) { closeSocket(socket); continue; }
        // Closing the socket bounds writes as well as reads, including non-reading clients.
        ScheduledFuture<?> timeout;
        try { timeout = deadlines.schedule(() -> closeSocket(socket), 3, TimeUnit.SECONDS); }
        catch (RejectedExecutionException shuttingDown) { closeSocket(socket); continue; }
        try { workers.execute(() -> {
          try { serve(socket, timeout); }
          finally { timeout.cancel(false); if (!streamSockets.contains(socket)) closeSocket(socket); }
        }); }
        catch (RejectedExecutionException full) { timeout.cancel(false); closeSocket(socket); }
      } catch (IOException | RejectedExecutionException error) {
        if (!closed) { /* A single failed connection must not expose or stop screen capture. */ }
      }
    }
  }

  private void serve(Socket socket, ScheduledFuture<?> requestDeadline) {
    try {
      if (!privatePeer(socket.getInetAddress())) return;
      InputStream input = socket.getInputStream();
      ByteArrayOutputStream header = new ByteArrayOutputStream();
      int end = 0;
      while (header.size() < 8192 && end != 4) {
        int next = input.read();
        if (next < 0) return;
        header.write(next);
        if ((end == 0 || end == 2) && next == '\r') end += 1;
        else if ((end == 1 || end == 3) && next == '\n') end += 1;
        else end = next == '\r' ? 1 : 0;
      }
      if (end != 4) { respond(socket, 431, "Request Header Fields Too Large", "Request headers exceed 8 KiB."); return; }
      String[] lines = header.toString("ISO-8859-1").split("\r\n");
      String[] request = lines[0].split(" ");
      if (request.length != 3 || request[1].length() > 256 || !(request[2].equals("HTTP/1.1") || request[2].equals("HTTP/1.0"))) {
        respond(socket, 400, "Bad Request", "Invalid request line."); return;
      }
      Map<String, String> fields = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
      if (lines.length > 35) { respond(socket, 431, "Request Header Fields Too Large", "Too many headers."); return; }
      for (int index = 1; index < lines.length; index += 1) {
        int colon = lines[index].indexOf(':');
        if (colon < 1) { respond(socket, 400, "Bad Request", "Invalid header."); return; }
        String key = lines[index].substring(0, colon).trim();
        if (fields.put(key, lines[index].substring(colon + 1).trim()) != null) {
          respond(socket, 400, "Bad Request", "Duplicate header."); return;
        }
      }
      if (!localHost(fields.get("Host")) || !localOrigin(fields.get("Origin"))) { respond(socket, 403, "Forbidden", "Private LAN requests only."); return; }
      if (request[1].equals("/preview/profile")) { previewProfile(socket, input, request[0], fields); return; }
      if (!request[0].equals("GET")) { respond(socket, 405, "Method Not Allowed", "Use GET."); return; }
      if (fields.containsKey("Transfer-Encoding") || (fields.containsKey("Content-Length") && !fields.get("Content-Length").equals("0"))) {
        respond(socket, 400, "Bad Request", "Request bodies are not supported."); return;
      }
      if (request[1].equals("/health")) {
        send(socket, 200, "OK", "application/json; charset=utf-8", app.health().getBytes(StandardCharsets.UTF_8), ""); return;
      }
      if (request[1].equals("/pointer/calibration")) {
        send(socket, 200, "OK", "application/json; charset=utf-8",
            app.pointerCalibration.status(app.deviceId(), SystemClock.elapsedRealtime()).getBytes(StandardCharsets.UTF_8), ""); return;
      }
      if (request[1].equals("/diagnostic")) {
        send(socket, 200, "OK", "text/html; charset=utf-8", DIAGNOSTIC_HTML,
            "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\r\n"); return;
      }
      if (request[1].equals("/stream.mjpg")) { startStream(socket, requestDeadline); return; }
      if (!request[1].equals("/frame.jpg")) { respond(socket, 404, "Not Found", "Not found."); return; }
      FrameStore.OriginalRequest originalRequest = frames.requestOriginal();
      FrameStore.Frame frame = originalRequest == null ? null : frames.awaitOriginal(originalRequest, 2000);
      if (frame == null) { respond(socket, 503, "Service Unavailable", "No fresh screen frame. Start screen sharing on the phone."); return; }
      long age = frame.age();
      if (age > FrameStore.MAX_AGE_MS || !frames.currentGeometry(frame)) { respond(socket, 503, "Service Unavailable", "No fresh screen frame."); return; }
      send(socket, 200, "OK", frame.mimeType, frame.encodedBytes, metadata(frame, age));
    } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    catch (IOException | RuntimeException error) { /* Socket deadline/disconnect: do not log request contents. */ }
  }

  private void previewProfile(Socket socket, InputStream input, String method, Map<String, String> fields) throws IOException {
    if (!(method.equals("GET") || method.equals("POST"))) { respond(socket, 405, "Method Not Allowed", "Use GET or POST."); return; }
    if (fields.containsKey("Transfer-Encoding")) { respond(socket, 400, "Bad Request", "Transfer encoding is not supported."); return; }
    String lengthField = fields.get("Content-Length");
    int length;
    try {
      if (lengthField == null) length = method.equals("GET") ? 0 : -1;
      else if (!lengthField.matches("[0-9]{1,3}")) length = -1;
      else length = Integer.parseInt(lengthField);
    } catch (NumberFormatException invalid) { length = -1; }
    if (length > 256) { respond(socket, 413, "Payload Too Large", "Profile body limit is 256 bytes."); return; }
    if (length < 0 || method.equals("GET") && length != 0) { respond(socket, 400, "Bad Request", "Invalid profile body length."); return; }
    if (method.equals("POST")) {
      String type = fields.get("Content-Type");
      if (type == null || !type.split(";", 2)[0].trim().equalsIgnoreCase("application/json")) {
        respond(socket, 415, "Unsupported Media Type", "Use application/json."); return;
      }
      byte[] body = new byte[length]; int position = 0;
      while (position < body.length) { int count = input.read(body, position, body.length - position); if (count < 0) return; position += count; }
      PreviewProfile profile;
      try { profile = PreviewProfile.fromRequest(new String(body, StandardCharsets.UTF_8)); }
      catch (IllegalArgumentException invalid) { respond(socket, 400, "Bad Request", "Unknown or invalid preview profile."); return; }
      try { app.configurePreview(profile); }
      catch (RuntimeException failedSave) { respond(socket, 503, "Service Unavailable", "Preview setting could not be saved."); return; }
    }
    send(socket, 200, "OK", "application/json; charset=utf-8", frames.previewStatus().getBytes(StandardCharsets.UTF_8), "");
  }

  private void startStream(Socket socket, ScheduledFuture<?> requestDeadline) throws IOException {
    long owner = frames.streamGeneration();
    if (owner < 0) { respond(socket, 503, "Service Unavailable", "请先在手机上点“开始投屏”。"); return; }
    if (!streamSlots.tryAcquire()) { respond(socket, 503, "Service Unavailable", "已有两路画面连接，请先关掉一个再连接。"); return; }
    streamSockets.add(socket);
    try {
      streamWorkers.execute(() -> {
        frames.openStream();
        String closeReason = "server_closed";
        try { closeReason = stream(socket, owner); }
        finally {
          frames.closeStream(closeReason); streamSockets.remove(socket); streamSlots.release(); closeSocket(socket);
        }
      });
      // Streaming has bounded writes of its own, with no total connection timeout.
      requestDeadline.cancel(false);
    } catch (RejectedExecutionException shuttingDown) {
      streamSockets.remove(socket); streamSlots.release();
      respond(socket, 503, "Service Unavailable", "画面连接暂时忙，请稍后再试。");
    }
  }

  private String stream(Socket socket, long owner) {
    try {
      if (!frames.streaming(owner)) { respond(socket, 503, "Service Unavailable", "手机投屏已停止。"); return "projection_stopped"; }
      socket.setTcpNoDelay(true);
      socket.setSendBufferSize(128 * 1024);
      socket.setSoTimeout(1);
      writeBounded(socket, (output) -> output.write(("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=" + BOUNDARY
          + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nX-Device-Id: " + app.deviceId() + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII)));
      String previousId = null;
      while (!closed && !socket.isClosed() && frames.streaming(owner)) {
        FrameStore.Frame frame = frames.awaitNext(owner, previousId, 500);
        if (frame == null) {
          // EOF detects a client that leaves while no frames are arriving.
          try { socket.getInputStream().read(); return "client_disconnected"; }
          catch (SocketTimeoutException noInput) { /* One-way stream; continue waiting for a real new frame. */ }
          continue;
        }
        long age = frame.age();
        if (age > FrameStore.MAX_AGE_MS || !frames.currentPreview(frame)) continue;
        long writeStarted = SystemClock.elapsedRealtime();
        writeBounded(socket, (output) -> {
          output.write(("--" + BOUNDARY + "\r\nContent-Type: " + frame.mimeType + "\r\nContent-Length: " + frame.encodedBytes.length
              + "\r\n" + metadata(frame, age) + "\r\n").getBytes(StandardCharsets.US_ASCII));
          output.write(frame.encodedBytes); output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
        });
        frames.streamWritten(frame.encodedBytes.length, SystemClock.elapsedRealtime() - writeStarted);
        previousId = frame.id;
        // No per-client frame queue: after a slow write, select the newest frame.
      }
      if (!closed && !socket.isClosed()) writeBounded(socket, (output) -> output.write(("--" + BOUNDARY + "--\r\n").getBytes(StandardCharsets.US_ASCII)));
      return closed ? "server_closed" : "projection_stopped";
    } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    catch (StreamWriteTimeout timedOut) { return "write_timeout"; }
    catch (IOException | RuntimeException disconnected) { return closed ? "server_closed" : "connection_error"; }
    return "server_closed";
  }

  private String metadata(FrameStore.Frame frame, long age) {
    return "X-Device-Id: " + app.deviceId() + "\r\nX-Frame-Id: " + frame.id + "\r\nX-Frame-Age-Ms: " + age
        + "\r\nX-Captured-At: " + frame.capturedAt + "\r\nX-Frame-Width: " + frame.width
        + "\r\nX-Frame-Height: " + frame.height + "\r\nX-Device-Width: " + frame.deviceWidth
        + "\r\nX-Device-Height: " + frame.deviceHeight + "\r\nX-Preview-Profile: " + frame.previewProfile
        + "\r\nX-Display-Rotation: " + frame.rotation + "\r\n";
  }

  private interface SocketWrite { void write(OutputStream output) throws IOException; }
  private static final class StreamWriteTimeout extends IOException {
    StreamWriteTimeout(IOException cause) { super("Screen stream write timed out", cause); }
  }

  private void writeBounded(Socket socket, SocketWrite action) throws IOException {
    AtomicBoolean expired = new AtomicBoolean();
    AtomicBoolean active = new AtomicBoolean(true);
    ScheduledFuture<?> deadline = deadlines.schedule(() -> {
      if (active.compareAndSet(true, false)) { expired.set(true); closeSocket(socket); }
    }, 2, TimeUnit.SECONDS);
    try { OutputStream output = socket.getOutputStream(); action.write(output); output.flush(); }
    catch (IOException error) {
      frames.streamWriteFailed(expired.get());
      if (expired.get()) throw new StreamWriteTimeout(error);
      throw error;
    }
    finally { active.set(false); deadline.cancel(false); }
  }

  private boolean localHost(String host) {
    if (host == null) return true;
    try { String name = new URI("http://" + host).getHost(); return bindAddress.equals(name) || "127.0.0.1".equals(name) || "localhost".equals(name) || "[::1]".equals(name); }
    catch (Exception invalid) { return false; }
  }

  private static boolean localOrigin(String origin) {
    if (origin == null) return true;
    try {
      URI uri = new URI(origin); String host = uri.getHost();
      if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || host == null || uri.getUserInfo() != null) return false;
      if ("localhost".equals(host) || "[::1]".equals(host)) return true;
      return numericPrivateHost(host);
    }
    catch (Exception invalid) { return false; }
  }

  private static boolean numericPrivateHost(String host) {
    if (!host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
    try { return privatePeer(InetAddress.getByName(host)); } catch (IOException invalid) { return false; }
  }

  static boolean privatePeer(InetAddress address) {
    if (address.isLoopbackAddress()) return true;
    byte[] bytes = address.getAddress();
    if (bytes.length != 4) return false;
    int first = bytes[0] & 255, second = bytes[1] & 255;
    return first == 10 || (first == 172 && second >= 16 && second <= 31) || (first == 192 && second == 168);
  }

  private static void respond(Socket socket, int status, String reason, String message) throws IOException {
    send(socket, status, reason, "text/plain; charset=utf-8", message.getBytes(StandardCharsets.UTF_8), "");
  }

  private static void send(Socket socket, int status, String reason, String mime, byte[] body, String extra) throws IOException {
    OutputStream output = socket.getOutputStream();
    output.write(("HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + mime + "\r\nContent-Length: " + body.length
        + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n" + extra + "\r\n").getBytes(StandardCharsets.US_ASCII));
    output.write(body); output.flush();
  }

  private void closeSocket(Socket socket) {
    if (sockets.remove(socket)) slots.release();
    try { socket.close(); } catch (IOException ignored) {}
  }

  @Override public void close() {
    closed = true;
    try { listener.close(); } catch (IOException ignored) {}
    for (Socket socket : sockets) closeSocket(socket);
    workers.shutdownNow(); streamWorkers.shutdownNow(); deadlines.shutdownNow();
  }
}
