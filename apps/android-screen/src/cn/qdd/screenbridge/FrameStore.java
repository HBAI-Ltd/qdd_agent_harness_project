package cn.qdd.screenbridge;

import android.os.SystemClock;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

final class FrameStore {
  static final long MAX_AGE_MS = 3000;
  static final long STREAM_FRAME_GAP_MS = CaptureCadence.STREAM_GAP_MS;
  static final String FORMAT = "jpeg";
  static final String MIME_TYPE = "image/jpeg";

  static final class Frame {
    final byte[] encodedBytes;
    final String mimeType;
    final int width;
    final int height;
    final int rotation;
    final int deviceWidth, deviceHeight;
    final String previewProfile;
    final long elapsed;
    final String capturedAt;
    final String id;
    final long geometryEpoch;
    final long profileRevision;

    Frame(byte[] encodedBytes, String mimeType, int width, int height, int rotation, long elapsed, String capturedAt, String id) {
      this(encodedBytes, mimeType, width, height, rotation, width, height, "original", elapsed, capturedAt, id);
    }

    Frame(byte[] encodedBytes, String mimeType, int width, int height, int rotation, int deviceWidth, int deviceHeight,
        String previewProfile, long elapsed, String capturedAt, String id) {
      this(encodedBytes, mimeType, width, height, rotation, deviceWidth, deviceHeight, previewProfile, elapsed, capturedAt, id, 0, 0);
    }

    private Frame(byte[] encodedBytes, String mimeType, int width, int height, int rotation, int deviceWidth, int deviceHeight,
        String previewProfile, long elapsed, String capturedAt, String id, long geometryEpoch, long profileRevision) {
      this.encodedBytes = encodedBytes; this.mimeType = mimeType; this.width = width; this.height = height; this.rotation = rotation;
      this.elapsed = elapsed; this.capturedAt = capturedAt; this.id = id; this.geometryEpoch = geometryEpoch;
      this.deviceWidth = deviceWidth; this.deviceHeight = deviceHeight; this.previewProfile = previewProfile; this.profileRevision = profileRevision;
    }

    Frame owned(long geometry, long profile) { return new Frame(encodedBytes, mimeType, width, height, rotation,
        deviceWidth, deviceHeight, previewProfile, elapsed, capturedAt, id, geometry, profile); }

    long age() { return Math.max(0, SystemClock.elapsedRealtime() - elapsed); }
  }

  private long generation;
  private long geometryEpoch;
  private boolean active;
  private boolean wifiLockHeld;
  private String wifiLockRequestedMode = "none";
  private Frame latest;
  private Frame original;
  private PreviewProfile previewProfile = PreviewProfile.STANDARD;
  private long profileRevision = 1;
  private int deviceWidth, deviceHeight;
  private long originalSequence;
  private final Map<Long, OriginalRequest> originalRequests = new LinkedHashMap<>();

  static final class PreviewSettings {
    final PreviewProfile profile;
    final long revision;
    PreviewSettings(PreviewProfile profile, long revision) { this.profile = profile; this.revision = revision; }
  }

  static final class OriginalRequest {
    final long owner, geometry, requestedAt, sequence;
    OriginalRequest(long owner, long geometry, long requestedAt, long sequence) {
      this.owner = owner; this.geometry = geometry; this.requestedAt = requestedAt; this.sequence = sequence;
    }
  }
  private int streamClients;
  private String status = "尚未开始投屏";
  private long imageCallbacks;
  private long emptyAcquires;
  private long encodedFrames;
  private long surfaceRefreshes;
  private long lastCaptureMs;
  private long lastEncodeMs;
  private long maxCaptureMs;
  private long lastSourceIntervalMs;
  private long previousSourceMs;
  private long streamOpens;
  private long streamCloses;
  private long streamWriteTimeouts;
  private long streamWriteFailures;
  private long streamWrittenFrames;
  private long streamWrittenBytes;
  private long lastStreamWriteMs;
  private long maxStreamWriteMs;
  private long droppedEncodeFrames;
  private String lastStreamClose = "none";
  private final long[] recentFrames = new long[64];
  private int recentFrameCount;
  private int recentFrameIndex;

  synchronized long begin() {
    generation += 1; geometryEpoch += 1; active = true; latest = null; status = "正在启动投屏";
    original = null; originalRequests.clear(); deviceWidth = deviceHeight = 0;
    wifiLockHeld = false; wifiLockRequestedMode = "none";
    imageCallbacks = emptyAcquires = encodedFrames = surfaceRefreshes = droppedEncodeFrames = 0;
    lastCaptureMs = lastEncodeMs = maxCaptureMs = lastSourceIntervalMs = previousSourceMs = 0;
    recentFrameCount = recentFrameIndex = 0;
    notifyAll();
    return generation;
  }

  synchronized void stop(long owner, String message) {
    if (owner != generation) return;
    if (!active && latest == null && !status.equals("尚未开始投屏")) return;
    active = false; latest = null; status = message;
    original = null; originalRequests.clear();
    wifiLockHeld = false; wifiLockRequestedMode = "none";
    notifyAll();
  }

  synchronized void invalidate(long owner) {
    if (owner == generation) { geometryEpoch += 1; latest = original = null; originalRequests.clear(); status = "屏幕转向了，正在更新画面"; notifyAll(); }
  }

  synchronized void publish(long owner, Frame frame) {
    publish(owner, geometryEpoch, frame);
  }

  synchronized long captureEpoch(long owner) { return owner == generation && active ? geometryEpoch : -1; }

  synchronized boolean publish(long owner, long capturedEpoch, Frame frame) {
    boolean published = publishPreview(owner, capturedEpoch, profileRevision, frame);
    if (published && frame.width == frame.deviceWidth && frame.height == frame.deviceHeight) publishOriginal(owner, capturedEpoch, frame);
    return published;
  }

  synchronized boolean publishPreview(long owner, long capturedEpoch, long capturedProfile, Frame frame) {
    if (owner == generation && active && capturedEpoch == geometryEpoch && capturedProfile == profileRevision) {
      latest = frame.owned(geometryEpoch, profileRevision);
      deviceWidth = frame.deviceWidth; deviceHeight = frame.deviceHeight;
      status = "正在分享手机画面";
      notifyAll();
      return true;
    }
    return false;
  }

  synchronized PreviewSettings previewSettings() { return new PreviewSettings(previewProfile, profileRevision); }
  synchronized void configurePreview(PreviewProfile profile) {
    if (previewProfile == profile) return;
    previewProfile = profile; profileRevision += 1; latest = null;
    notifyAll();
  }
  synchronized void dimensions(long owner, int width, int height) {
    if (owner == generation && active) { deviceWidth = width; deviceHeight = height; }
  }
  synchronized String previewStatus() {
    try {
      JSONObject json = new JSONObject().put("profile", previewProfile.id);
      if (deviceWidth > 0 && deviceHeight > 0) { json.put("deviceWidth", deviceWidth); json.put("deviceHeight", deviceHeight); }
      return json.toString();
    } catch (JSONException impossible) { return "{}"; }
  }

  synchronized OriginalRequest requestOriginal() {
    if (!active || originalRequests.size() >= 4) return null;
    OriginalRequest request = new OriginalRequest(generation, geometryEpoch, SystemClock.elapsedRealtime(), ++originalSequence);
    originalRequests.put(request.sequence, request); notifyAll(); return request;
  }
  synchronized boolean hasCaptureDemand() { return streamClients > 0 || !originalRequests.isEmpty(); }
  synchronized boolean needsOriginal(long owner, long geometry, long acquiredAt) {
    if (!active || owner != generation || geometry != geometryEpoch) return false;
    for (OriginalRequest request : originalRequests.values()) if (acquiredAt > request.requestedAt) return true;
    return false;
  }
  synchronized boolean publishOriginal(long owner, long geometry, Frame frame) {
    if (!active || owner != generation || geometry != geometryEpoch || frame.width != frame.deviceWidth
        || frame.height != frame.deviceHeight || !"original".equals(frame.previewProfile)) return false;
    original = frame.owned(geometryEpoch, profileRevision); notifyAll(); return true;
  }
  synchronized Frame awaitOriginal(OriginalRequest request, long timeoutMs) throws InterruptedException {
    long deadline = SystemClock.elapsedRealtime() + timeoutMs;
    try {
      while (active && request.owner == generation && request.geometry == geometryEpoch) {
        if (original != null && original.elapsed > request.requestedAt && original.age() <= MAX_AGE_MS) return original;
        long remaining = deadline - SystemClock.elapsedRealtime(); if (remaining <= 0) return null;
        wait(remaining);
      }
      return null;
    } finally { originalRequests.remove(request.sequence); }
  }

  synchronized boolean isActive() { return active; }
  synchronized void wifiLock(long owner, String mode, boolean held) {
    if (owner != generation || !active) return;
    wifiLockRequestedMode = mode; wifiLockHeld = held;
  }
  synchronized String status() { return status; }
  synchronized Frame fresh() { return active && latest != null && latest.age() <= MAX_AGE_MS ? latest : null; }
  synchronized boolean currentGeometry(Frame frame) { return active && frame.geometryEpoch == geometryEpoch; }
  synchronized boolean currentPreview(Frame frame) { return currentGeometry(frame) && frame.profileRevision == profileRevision; }
  synchronized long streamGeneration() { return active ? generation : -1; }
  synchronized boolean streaming(long owner) { return active && owner == generation; }
  synchronized void openStream() { streamClients += 1; streamOpens += 1; }
  synchronized void closeStream() { closeStream("closed"); }
  synchronized void closeStream(String reason) {
    streamClients = Math.max(0, streamClients - 1); streamCloses += 1;
    lastStreamClose = reason;
  }
  synchronized boolean hasStreams() { return streamClients > 0; }

  synchronized void imageAvailable(long owner) { if (active && owner == generation) imageCallbacks += 1; }
  synchronized void emptyAcquire(long owner) { if (active && owner == generation) emptyAcquires += 1; }
  synchronized void surfaceRefreshed(long owner) { if (active && owner == generation) surfaceRefreshes += 1; }
  synchronized void captureEncoded(long owner, long sourceMs, long captureMs, long encodeMs) {
    if (!active || owner != generation) return;
    encodedFrames += 1;
    lastCaptureMs = Math.max(0, captureMs); lastEncodeMs = Math.max(0, encodeMs);
    maxCaptureMs = Math.max(maxCaptureMs, lastCaptureMs);
    if (previousSourceMs != 0) lastSourceIntervalMs = Math.max(0, sourceMs - previousSourceMs);
    previousSourceMs = sourceMs;
    recentFrames[recentFrameIndex] = SystemClock.elapsedRealtime();
    recentFrameIndex = (recentFrameIndex + 1) % recentFrames.length;
    recentFrameCount = Math.min(recentFrames.length, recentFrameCount + 1);
  }
  synchronized void streamWriteFailed(boolean timeout) {
    if (timeout) streamWriteTimeouts += 1; else streamWriteFailures += 1;
  }
  synchronized void streamWritten(long bytes, long elapsed) {
    streamWrittenFrames += 1; streamWrittenBytes += Math.max(0, bytes);
    lastStreamWriteMs = Math.max(0, elapsed); maxStreamWriteMs = Math.max(maxStreamWriteMs, lastStreamWriteMs);
  }
  synchronized void encodeDropped(long owner) { if (active && owner == generation) droppedEncodeFrames += 1; }

  synchronized Frame awaitNext(long owner, String previousId, long timeoutMs) throws InterruptedException {
    long deadline = SystemClock.elapsedRealtime() + timeoutMs;
    while (active && owner == generation) {
      Frame frame = fresh();
      if (frame != null && !frame.id.equals(previousId)) return frame;
      long remaining = deadline - SystemClock.elapsedRealtime();
      if (remaining <= 0) return null;
      wait(remaining);
    }
    return null;
  }

  synchronized String health(int port, String deviceId, String model, int rotation) {
    try {
      JSONObject json = new JSONObject();
      json.put("status", "ok"); json.put("service", "qdd-android-screen");
      json.put("format", FORMAT); json.put("mimeType", MIME_TYPE);
      json.put("streamPath", "/stream.mjpg"); json.put("streamClients", streamClients);
      json.put("maxFps", streamClients > 0 ? Math.round(10000.0 / STREAM_FRAME_GAP_MS) / 10.0 : 5.0);
      json.put("deviceId", deviceId); json.put("model", model); json.put("rotation", rotation);
      json.put("projecting", active);
      json.put("previewProfile", previewProfile.id); json.put("deviceWidth", deviceWidth); json.put("deviceHeight", deviceHeight);
      json.put("wifiLockRequestedMode", wifiLockRequestedMode); json.put("wifiLockHeld", wifiLockHeld);
      json.put("active", active); json.put("port", port); json.put("message", status);
      int recent = 0;
      long now = SystemClock.elapsedRealtime();
      for (int index = 0; index < recentFrameCount; index += 1) {
        if (now - recentFrames[index] <= 2000) recent += 1;
      }
      json.put("captureFrames2s", recent); json.put("captureFps2s", recent / 2.0);
      json.put("imageCallbacks", imageCallbacks); json.put("emptyAcquires", emptyAcquires);
      json.put("encodedFrames", encodedFrames); json.put("surfaceRefreshes", surfaceRefreshes);
      json.put("lastCaptureMs", lastCaptureMs); json.put("lastEncodeMs", lastEncodeMs);
      json.put("maxCaptureMs", maxCaptureMs); json.put("lastSourceIntervalMs", lastSourceIntervalMs);
      json.put("streamOpens", streamOpens); json.put("streamCloses", streamCloses);
      json.put("streamWriteTimeouts", streamWriteTimeouts); json.put("streamWriteFailures", streamWriteFailures);
      json.put("lastStreamClose", lastStreamClose);
      json.put("streamWrittenFrames", streamWrittenFrames); json.put("streamWrittenBytes", streamWrittenBytes);
      json.put("lastStreamWriteMs", lastStreamWriteMs); json.put("maxStreamWriteMs", maxStreamWriteMs);
      json.put("droppedEncodeFrames", droppedEncodeFrames);
      json.put("frameReady", active && latest != null && latest.age() <= MAX_AGE_MS);
      if (latest != null) {
        json.put("width", latest.width); json.put("height", latest.height);
        json.put("frameAgeMs", latest.age());
        json.put("frameBytes", latest.encodedBytes.length);
      }
      return json.toString();
    } catch (JSONException impossible) { return "{\"status\":\"error\"}"; }
  }
}
