package cn.qdd.screenbridge;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import javax.net.SocketFactory;

/** Small private-LAN control-plane HTTP client; screen transport remains separate. */
final class BoardClient {
  static String request(SocketFactory factory, String board, String method, String path, String body) throws IOException {
    URI uri = URI.create(SetupAddress.normalize(board));
    byte[] payload = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
    if (payload.length > 256 || !("GET".equals(method) && "/api/status".equals(path) && body == null
        || "POST".equals(method) && "/api/phone".equals(path) && body != null)) throw new IOException("Invalid setup request");
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
    try (Socket socket = factory.createSocket()) {
      socket.connect(new InetSocketAddress(uri.getHost(), uri.getPort()), 1200);
      socket.setSoTimeout(1200);
      String headers = method + " " + path + " HTTP/1.1\r\nHost: " + uri.getHost() + ":" + uri.getPort()
          + "\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " + payload.length + "\r\n\r\n";
      socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
      socket.getOutputStream().write(payload); socket.getOutputStream().flush();
      InputStream input = socket.getInputStream(); ByteArrayOutputStream header = new ByteArrayOutputStream();
      int tail = 0;
      while (header.size() < 8192 && tail != 4) {
        remainingTimeout(socket, deadline);
        int next = input.read(); if (next < 0) throw new IOException("Incomplete setup response"); header.write(next);
        if ((tail == 0 || tail == 2) && next == '\r') tail++;
        else if ((tail == 1 || tail == 3) && next == '\n') tail++;
        else tail = next == '\r' ? 1 : 0;
      }
      if (tail != 4) throw new IOException("Setup response headers too large");
      String[] lines = header.toString("ISO-8859-1").split("\r\n");
      if (!lines[0].matches("HTTP/1\\.[01] 2[0-9][0-9](?: .*)?")) throw new IOException("Control board unavailable");
      int length = -1;
      boolean hasLength = false, json = false;
      for (int index = 1; index < lines.length; index++) {
        int colon = lines[index].indexOf(':');
        if (colon < 1) throw new IOException("Invalid setup response header");
        String key = lines[index].substring(0, colon).toLowerCase(java.util.Locale.ROOT);
        String value = lines[index].substring(colon + 1).trim();
        if ("transfer-encoding".equals(key)) throw new IOException("Unexpected setup response transfer encoding");
        if ("content-type".equals(key)) {
          if (json || !"application/json".equalsIgnoreCase(value.split(";", 2)[0].trim())) throw new IOException("Setup response must be JSON");
          json = true;
        }
        if ("content-length".equals(key)) {
          if (hasLength) throw new IOException("Duplicate setup response length");
          hasLength = true;
          if (!value.matches("[0-9]+")) throw new IOException("Invalid setup response length");
          try { length = Integer.parseInt(value); }
          catch (NumberFormatException invalid) { throw new IOException("Invalid setup response length"); }
        }
      }
      if (!json || !hasLength || length < 0 || length > 2048) throw new IOException("Setup response type or length is outside its limit");
      byte[] response = new byte[length]; int read = 0;
      while (read < length) {
        remainingTimeout(socket, deadline);
        int next = input.read(response, read, length - read); if (next < 0) throw new IOException("Truncated setup response"); read += next;
      }
      return new String(response, StandardCharsets.UTF_8);
    }
  }

  private static void remainingTimeout(Socket socket, long deadline) throws IOException {
    long remaining = deadline - System.nanoTime();
    if (remaining <= 0) throw new IOException("Control board response timed out");
    socket.setSoTimeout((int)Math.max(1, Math.min(1200, TimeUnit.NANOSECONDS.toMillis(remaining))));
  }
}
