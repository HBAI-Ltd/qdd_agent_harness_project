package cn.qdd.screenbridge;

import java.util.UUID;

/** Actual mouse events received only by the foreground calibration surface. */
final class PointerCalibration {
  private String sessionId;
  private int width, height, rotation;
  private long sequence, receivedAt;
  private double x, y;
  private boolean hasPoint;

  synchronized String begin(int width, int height, int rotation) {
    if (width < 1 || height < 1 || rotation < 0 || rotation > 3) throw new IllegalArgumentException("Invalid display geometry");
    sessionId = UUID.randomUUID().toString(); this.width = width; this.height = height; this.rotation = rotation;
    sequence = 0; hasPoint = false; return sessionId;
  }

  synchronized void end(String owner) {
    if (sessionId != null && sessionId.equals(owner)) { sessionId = null; hasPoint = false; }
  }

  synchronized boolean record(String owner, double x, double y, long now) {
    if (sessionId == null || !sessionId.equals(owner) || !Double.isFinite(x) || !Double.isFinite(y)
        || x < 0 || y < 0 || x >= width || y >= height || now < 0 || hasPoint && now < receivedAt) return false;
    this.x = x; this.y = y; receivedAt = now; sequence += 1; hasPoint = true; return true;
  }

  synchronized String status(String deviceId, long now) {
    return "{\"active\":" + (sessionId != null) + ",\"deviceId\":\"" + deviceId + "\",\"sessionId\":"
        + (sessionId == null ? "null" : "\"" + sessionId + "\"") + ",\"width\":" + width + ",\"height\":" + height
        + ",\"rotation\":" + rotation + ",\"point\":" + (!hasPoint || sessionId == null || now < receivedAt ? "null"
        : "{\"x\":" + x + ",\"y\":" + y + ",\"sequence\":" + sequence + ",\"ageMs\":" + (now - receivedAt) + "}") + "}";
  }
}
