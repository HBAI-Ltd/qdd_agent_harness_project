package cn.qdd.screenbridge;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.net.SocketFactory;

/** Tests production HTTP framing against local sockets; no real LAN or phone. */
public final class BoardClientTest {
  private static String exchange(String response, String body, boolean holdOpen, boolean drip) throws Exception {
    try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
      CountDownLatch completed = new CountDownLatch(1);
      CompletableFuture<Void> serving = CompletableFuture.runAsync(() -> {
        try (Socket peer = server.accept()) {
          peer.setSoTimeout(2000);
          ByteArrayOutputStream request = new ByteArrayOutputStream();
          int tail = 0;
          while (tail != 4 && request.size() < 8192) {
            int next = peer.getInputStream().read(); if (next < 0) throw new IOException("Missing request"); request.write(next);
            if ((tail == 0 || tail == 2) && next == '\r') tail++;
            else if ((tail == 1 || tail == 3) && next == '\n') tail++;
            else tail = next == '\r' ? 1 : 0;
          }
          String headers = request.toString("US-ASCII");
          String expectedMethod = body == null ? "GET /api/status" : "POST /api/phone";
          if (!headers.startsWith(expectedMethod + " HTTP/1.1\r\n") || !headers.contains("Host: 192.168.1.4:3334\r\n")) throw new AssertionError(headers);
          byte[] expected = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
          if (!headers.contains("Content-Length: " + expected.length + "\r\n")) throw new AssertionError(headers);
          for (byte value : expected) if (peer.getInputStream().read() != (value & 255)) throw new AssertionError("POST UTF-8 body mismatch");
          if (drip) {
            for (byte value : response.getBytes(StandardCharsets.UTF_8)) {
              peer.getOutputStream().write(value); peer.getOutputStream().flush(); Thread.sleep(150);
            }
          } else { peer.getOutputStream().write(response.getBytes(StandardCharsets.UTF_8)); peer.getOutputStream().flush(); }
          if (holdOpen) completed.await(2, TimeUnit.SECONDS);
        } catch (IOException expectedClose) { if (!drip) throw new RuntimeException(expectedClose); }
        catch (InterruptedException interrupted) { throw new RuntimeException(interrupted); }
      });
      SocketFactory factory = new SocketFactory() {
        @Override public Socket createSocket() {
          return new Socket() {
            @Override public void connect(SocketAddress ignored, int timeout) throws IOException {
              if (!"192.168.1.4".equals(((InetSocketAddress)ignored).getHostString())) throw new AssertionError();
              super.connect(new InetSocketAddress("127.0.0.1", server.getLocalPort()), timeout);
            }
          };
        }
        @Override public Socket createSocket(String host, int port) throws IOException { throw new IOException("Unexpected factory overload"); }
        @Override public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException { throw new IOException("Unexpected factory overload"); }
        @Override public Socket createSocket(InetAddress host, int port) throws IOException { throw new IOException("Unexpected factory overload"); }
        @Override public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) throws IOException { throw new IOException("Unexpected factory overload"); }
      };
      try { return BoardClient.request(factory, "http://192.168.1.4:3334", body == null ? "GET" : "POST", body == null ? "/api/status" : "/api/phone", body); }
      finally { completed.countDown(); serving.get(2, TimeUnit.SECONDS); }
    }
  }

  private static void reject(String response) throws Exception {
    try { exchange(response, null, false, false); throw new AssertionError("Malformed response accepted"); }
    catch (IOException expected) { }
  }

  public static void main(String[] arguments) throws Exception {
    String good = "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}";
    if (!"{}".equals(exchange(good, null, true, false))) throw new AssertionError();
    if (!"{}".equals(exchange(good, "{\"text\":\"中文\"}", false, false))) throw new AssertionError();
    reject("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: -1\r\nContent-Length: 2\r\n\r\n{}");
    reject(good.replace("Content-Length: 2", "Content-Length: 2\r\nContent-Length: 2"));
    reject(good.replace("Content-Length: 2", "Content-Length: +2"));
    reject(good.replace("Content-Length: 2", "Content-Length: -2"));
    reject(good.replace("Content-Length: 2", "Content-Length: 2049"));
    reject(good.replace("Content-Length: 2", "Content-Length: 999999999999999999999999"));
    reject(good.replace("Content-Length: 2", "Transfer-Encoding: chunked\r\nContent-Length: 2"));
    reject(good.replace("Content-Type: application/json; charset=utf-8\r\n", ""));
    reject(good.replace("application/json", "text/html"));
    reject(good.replace("Content-Length: 2\r\n", ""));
    reject(good.substring(0, good.length() - 1));
    reject(good.replace("200 OK", "302 Found"));
    long start = System.nanoTime();
    try { exchange(good, null, false, true); throw new AssertionError("Unbounded drip accepted"); }
    catch (IOException expected) { }
    if (TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) > 5500) throw new AssertionError("Overall deadline was not enforced");
    System.out.println("Board HTTP framing, JSON type, UTF-8 length, keep-alive and overall deadline tests: PASS (15 cases)");
  }
}
