package cn.qdd.screenbridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.UUID;

public final class ScreenService extends Service {
  static final String START = "cn.qdd.screenbridge.START";
  static final String STOP = "cn.qdd.screenbridge.STOP";
  private static final String CHANNEL = "screen-sharing";
  private static final int NOTIFICATION = 8791;
  private static final long SNAPSHOT_FRAME_GAP_MS = 200;
  private ScreenApplication app;
  private HandlerThread captureThread;
  private Handler capture;
  private HandlerThread encodeThread;
  private Handler encoder;
  private final Handler main = new Handler(android.os.Looper.getMainLooper());
  private MediaProjection projection;
  private VirtualDisplay display;
  private ImageReader reader;
  private ImageReader standbyReader;
  private final CaptureCadence cadence = new CaptureCadence();
  private final CaptureWifiLock wifiLock = new CaptureWifiLock();
  private final Object encodeLock = new Object();
  private final ArrayDeque<Bitmap> freeBitmaps = new ArrayDeque<>(2);
  private CapturedFrame pendingFrame;
  private boolean encoding;
  private volatile long layoutRevision;
  private ByteBuffer packed;
  private final ByteArrayOutputStream encoded = new ByteArrayOutputStream(256 * 1024);
  // Only the JPEG worker touches this bounded reusable preview buffer.
  private Bitmap previewBitmap;
  private Canvas previewCanvas;
  private final Paint previewPaint = new Paint(Paint.FILTER_BITMAP_FLAG);
  private final ColorMatrixColorFilter grayscale = new ColorMatrixColorFilter(new ColorMatrix(new float[] {
      .213f, .715f, .072f, 0, 0, .213f, .715f, .072f, 0, 0, .213f, .715f, .072f, 0, 0, 0, 0, 0, 1, 0 }));
  private int width;
  private int height;
  private int rotation;
  private int density;
  private volatile long generation;
  private long lastAcquired;
  private volatile boolean stopRequested;
  private boolean displayListenerRegistered;
  private boolean encodePending;
  private final Runnable encodeLatest = new Runnable() {
    @Override public void run() { encodePending = false; captureLatest(); }
  };
  private final Runnable refreshProjection = new Runnable() {
    @Override public void run() {
      if (stopRequested || display == null || reader == null) return;
      try {
        long now = SystemClock.elapsedRealtime();
        if (cadence.refreshPending() && !cadence.stalled(now)) { scheduleRefresh(); return; }
        // Consume a naturally queued image before forcing a surface traversal.
        captureLatest();
        now = SystemClock.elapsedRealtime();
        if (cadence.stalled(now) || cadence.refreshDelay(now, app.frames.hasCaptureDemand()) == 0) refreshCaptureSurface();
        scheduleRefresh();
      } catch (RuntimeException | OutOfMemoryError error) { requestStop("画面刷新失败，请重新开始投屏"); }
    }
  };

  private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
    @Override public void onStop() { requestStop("系统已结束投屏"); }
    @Override public void onCapturedContentResize(int nextWidth, int nextHeight) {
      if (projection != null && !stopRequested && nextWidth > 0 && nextHeight > 0) {
        try { resize(nextWidth, nextHeight, currentRotation()); }
        catch (RuntimeException | OutOfMemoryError error) { requestStop("屏幕尺寸变化失败，请重新开始投屏"); }
      }
    }
  };

  private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
    @Override public void onDisplayAdded(int id) {}
    @Override public void onDisplayRemoved(int id) { if (id == Display.DEFAULT_DISPLAY) requestStop("屏幕已不可用"); }
    @Override public void onDisplayChanged(int id) {
      if (id != Display.DEFAULT_DISPLAY || projection == null || stopRequested) return;
      try { DisplayMetrics metrics = metrics(); resize(metrics.widthPixels, metrics.heightPixels, currentRotation()); }
      catch (RuntimeException | OutOfMemoryError error) { requestStop("屏幕方向变化失败，请重新开始投屏"); }
    }
  };

  @Override public void onCreate() {
    super.onCreate(); app = (ScreenApplication) getApplication();
    captureThread = new HandlerThread("qdd-screen-capture"); captureThread.start();
    capture = new Handler(captureThread.getLooper());
    encodeThread = new HandlerThread("qdd-screen-jpeg"); encodeThread.start();
    encoder = new Handler(encodeThread.getLooper());
    NotificationChannel channel = new NotificationChannel(CHANNEL, "内网投屏", NotificationManager.IMPORTANCE_LOW);
    channel.setDescription("投屏运行状态和停止控制");
    getSystemService(NotificationManager.class).createNotificationChannel(channel);
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent == null || STOP.equals(intent.getAction())) { requestStop("投屏已停止"); return START_NOT_STICKY; }
    if (!START.equals(intent.getAction()) || app.frames.isActive()) return START_NOT_STICKY;
    // onDestroy releases two worker queues asynchronously. Never consume a
    // second grant in this stopping instance or overlap its old pixel buffers.
    if (stopRequested || app.frames.isStopping()) { stopSelfResult(startId); return START_NOT_STICKY; }
    Intent permission = intent.getParcelableExtra("projectionData");
    int resultCode = intent.getIntExtra("projectionResult", 0);
    if (permission == null || resultCode != android.app.Activity.RESULT_OK) { requestStop("未获得系统录屏授权"); return START_NOT_STICKY; }
    try {
      generation = app.frames.begin();
      if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
      else startForeground(NOTIFICATION, notification());
    } catch (RuntimeException error) { requestStop("无法启动前台投屏服务，请检查系统授权"); return START_NOT_STICKY; }
    capture.post(() -> startCapture(resultCode, permission));
    return START_NOT_STICKY;
  }

  private Notification notification() {
    PendingIntent open = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop = PendingIntent.getService(this, 2, new Intent(this, ScreenService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_screen)
        .setContentTitle("设备投屏运行中").setContentText("正在通过当前 Wi-Fi 内网投屏")
        .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
        .addAction(new Notification.Action.Builder(null, "停止投屏", stop).build()).build();
  }

  private void startCapture(int resultCode, Intent permission) {
    if (stopRequested) return;
    try {
      if (app.serverError() != null) throw new IllegalStateException("HTTP endpoint unavailable");
      projection = getSystemService(MediaProjectionManager.class).getMediaProjection(resultCode, permission);
      if (projection == null) throw new IllegalStateException("MediaProjection unavailable");
      projection.registerCallback(projectionCallback, capture);
      DisplayMetrics metrics = metrics();
      width = metrics.widthPixels; height = metrics.heightPixels;
      rotation = currentRotation(); density = metrics.densityDpi;
      allocateReader(width, height);
      display = projection.createVirtualDisplay("QDD LAN Screen", width, height, density,
          DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, capture);
      if (display == null) throw new IllegalStateException("Virtual display unavailable");
      acquireWifiLock(generation);
      getSystemService(DisplayManager.class).registerDisplayListener(displayListener, capture);
      displayListenerRegistered = true;
      scheduleRefresh();
      if (stopRequested) releaseProjection();
    } catch (RuntimeException | OutOfMemoryError error) { requestStop("投屏启动失败，请重新授权后再试"); }
  }

  private DisplayMetrics metrics() {
    Display screen = getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
    if (screen == null) throw new IllegalStateException("Display unavailable");
    DisplayMetrics result = new DisplayMetrics(); screen.getRealMetrics(result);
    return result;
  }

  private void acquireWifiLock(long owner) {
    // On Android 13 HIGH_PERF also works while controlling other apps. Android
    // 14 replaces that mode with LOW_LATENCY, which has screen/foreground limits.
    boolean legacy = Build.VERSION.SDK_INT < 34;
    String mode = legacy ? "high_performance" : "low_latency";
    try {
      WifiManager manager = getApplicationContext().getSystemService(WifiManager.class);
      if (manager == null) return;
      WifiManager.WifiLock radio = manager.createWifiLock(legacy ? WifiManager.WIFI_MODE_FULL_HIGH_PERF : WifiManager.WIFI_MODE_FULL_LOW_LATENCY,
          "QDD:screen-projection");
      radio.setReferenceCounted(false);
      boolean acquired = wifiLock.acquire(owner, new CaptureWifiLock.Lock() {
        @Override public void acquire() { radio.acquire(); }
        @Override public boolean isHeld() { return radio.isHeld(); }
        @Override public void release() { radio.release(); }
      }, () -> !stopRequested && owner == generation);
      app.frames.wifiLock(owner, mode, acquired);
    } catch (RuntimeException error) {
      // A device without this optional radio optimization can still project.
      app.frames.wifiLock(owner, mode, false);
    }
  }

  private void releaseWifiLock() {
    try { wifiLock.close(); }
    catch (RuntimeException ignored) { /* Stop capture even if a vendor radio service has gone away. */ }
    finally { app.frames.wifiLock(generation, "none", false); }
  }

  private int currentRotation() {
    Display screen = getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
    return screen == null ? 0 : screen.getRotation();
  }

  private void allocateReader(int nextWidth, int nextHeight) {
    if (nextWidth < 1 || nextHeight < 1 || (long) nextWidth * nextHeight > 16L * 1024 * 1024) throw new IllegalArgumentException("Unsupported screen dimensions");
    reader = createReader(nextWidth, nextHeight);
    standbyReader = createReader(nextWidth, nextHeight);
    synchronized (encodeLock) {
      freeBitmaps.add(Bitmap.createBitmap(nextWidth, nextHeight, Bitmap.Config.ARGB_8888));
      freeBitmaps.add(Bitmap.createBitmap(nextWidth, nextHeight, Bitmap.Config.ARGB_8888));
    }
    packed = ByteBuffer.allocateDirect(nextWidth * nextHeight * 4);
    app.frames.dimensions(generation, nextWidth, nextHeight);
    lastAcquired = 0;
    cadence.reset(SystemClock.elapsedRealtime());
  }

  private ImageReader createReader(int nextWidth, int nextHeight) {
    ImageReader next = ImageReader.newInstance(nextWidth, nextHeight, PixelFormat.RGBA_8888, 2);
    try { next.setOnImageAvailableListener(this::imageAvailable, capture); return next; }
    catch (RuntimeException | OutOfMemoryError error) { closeImageReader(next); throw error; }
  }

  private void refreshCaptureSurface() {
    // Alternate two stable producers. Replacing a reader every timer tick can
    // cancel the compositor before it supplies a real image, and allocates huge
    // buffers repeatedly. Only one surface traversal may be outstanding.
    capture.removeCallbacks(encodeLatest); encodePending = false;
    ImageReader previous = reader;
    ImageReader next = standbyReader;
    Image stale = next.acquireLatestImage(); if (stale != null) stale.close();
    if (stopRequested) return;
    display.setSurface(next.getSurface()); reader = next; standbyReader = previous;
    cadence.refreshed(SystemClock.elapsedRealtime());
    app.frames.surfaceRefreshed(generation);
  }

  private void scheduleRefresh() {
    if (stopRequested || display == null || reader == null) return;
    capture.removeCallbacks(refreshProjection);
    // Recheck stream admission promptly; source acquisition chooses the next
    // deadline. Never add another 33ms after a delayed compositor image arrives.
    capture.postDelayed(refreshProjection, Math.max(1, Math.min(CaptureCadence.STREAM_GAP_MS,
        cadence.refreshDelay(SystemClock.elapsedRealtime(), app.frames.hasCaptureDemand()))));
  }

  private void resize(int nextWidth, int nextHeight, int nextRotation) {
    if (nextWidth == width && nextHeight == height && nextRotation == rotation) return;
    app.frames.invalidate(generation);
    if (display == null) return;
    display.setSurface(null);
    closeReader();
    width = nextWidth; height = nextHeight; rotation = nextRotation;
    density = metrics().densityDpi;
    allocateReader(width, height);
    // Reuse the single VirtualDisplay for this Android screen-sharing grant.
    display.resize(width, height, density);
    display.setSurface(reader.getSurface());
  }

  private void imageAvailable(ImageReader available) {
    if (available != reader || stopRequested) return;
    app.frames.imageAvailable(generation);
    long gap = app.frames.hasCaptureDemand() ? FrameStore.STREAM_FRAME_GAP_MS : SNAPSHOT_FRAME_GAP_MS;
    long delay = gap - (SystemClock.elapsedRealtime() - lastAcquired);
    if (delay > 0) {
      // Leave the latest buffer queued until the rate limit expires. Acquiring and
      // closing here would permanently lose the final screen update before idle.
      if (!encodePending) { encodePending = true; capture.postDelayed(encodeLatest, delay); }
      return;
    }
    capture.removeCallbacks(encodeLatest); encodePending = false;
    captureLatest();
  }

  private void captureLatest() {
    if (reader == null || stopRequested) return;
    Image image = null;
    Bitmap pixels = null;
    try {
      long gap = app.frames.hasCaptureDemand() ? FrameStore.STREAM_FRAME_GAP_MS : SNAPSHOT_FRAME_GAP_MS;
      long wait = gap - (SystemClock.elapsedRealtime() - lastAcquired);
      if (wait > 0) {
        if (!encodePending) { encodePending = true; capture.postDelayed(encodeLatest, wait); }
        return;
      }
      image = reader.acquireLatestImage();
      if (image == null) { app.frames.emptyAcquire(generation); return; }
      long elapsed = SystemClock.elapsedRealtime();
      cadence.acquired(elapsed);
      String capturedAt = Instant.now().toString();
      lastAcquired = elapsed;
      Image.Plane plane = image.getPlanes()[0];
      if (image.getWidth() != width || image.getHeight() != height || plane.getPixelStride() != 4) throw new IllegalStateException("Unexpected image layout");
      synchronized (encodeLock) {
        pixels = freeBitmaps.pollFirst();
        if (pixels == null && pendingFrame != null) {
          pixels = pendingFrame.bitmap; pendingFrame = null; app.frames.encodeDropped(generation);
        }
      }
      if (pixels == null) { app.frames.encodeDropped(generation); return; }
      pixels.copyPixelsFromBuffer(FramePixels.rgba(plane.getBuffer(), width, height, plane.getRowStride(), packed));
      // Pixels are now owned by the bitmap; release the producer buffer before encoding.
      image.close(); image = null;
      CapturedFrame frame = new CapturedFrame(pixels, width, height, rotation, generation, layoutRevision,
          app.frames.captureEpoch(generation), app.frames.previewSettings(), elapsed, capturedAt);
      pixels = null;
      synchronized (encodeLock) {
        if (pendingFrame != null) { releaseBitmap(pendingFrame); app.frames.encodeDropped(generation); }
        pendingFrame = frame;
        if (!encoding) { encoding = true; encoder.post(this::encodeFrames); }
      }
    } catch (RuntimeException | OutOfMemoryError error) { requestStop("画面采集失败，请重新开始投屏"); }
    finally {
      if (image != null) image.close();
      if (pixels != null) { synchronized (encodeLock) { freeBitmaps.addLast(pixels); } }
      scheduleRefresh();
    }
  }

  private static final class CapturedFrame {
    final Bitmap bitmap;
    final int width, height, rotation;
    final long generation, revision, geometry, elapsed;
    final FrameStore.PreviewSettings preview;
    final String capturedAt, id = UUID.randomUUID().toString();
    CapturedFrame(Bitmap bitmap, int width, int height, int rotation, long generation, long revision, long geometry,
        FrameStore.PreviewSettings preview, long elapsed, String capturedAt) {
      this.bitmap = bitmap; this.width = width; this.height = height; this.rotation = rotation; this.generation = generation;
      this.revision = revision; this.geometry = geometry; this.elapsed = elapsed; this.capturedAt = capturedAt;
      this.preview = preview;
    }
  }

  private void releaseBitmap(CapturedFrame frame) {
    synchronized (encodeLock) {
      if (!stopRequested && frame.revision == layoutRevision) freeBitmaps.addLast(frame.bitmap);
      else frame.bitmap.recycle();
    }
  }

  private void encodeFrames() {
    for (;;) {
      CapturedFrame frame;
      synchronized (encodeLock) {
        frame = pendingFrame; pendingFrame = null;
        if (frame == null) { encoding = false; return; }
      }
      try {
        if (stopRequested || frame.revision != layoutRevision) continue;
        long started = SystemClock.elapsedRealtime();
        PreviewProfile profile = frame.preview.profile;
        int[] dimensions = profile.dimensions(frame.width, frame.height);
        Bitmap preview = previewPixels(frame.bitmap, dimensions[0], dimensions[1], profile);
        byte[] previewBytes = encodeJpeg(preview, profile.quality);
        long completed = SystemClock.elapsedRealtime();
        if (!stopRequested && app.frames.publishPreview(frame.generation, frame.geometry, frame.preview.revision,
            new FrameStore.Frame(previewBytes, FrameStore.MIME_TYPE, dimensions[0], dimensions[1], frame.rotation,
                frame.width, frame.height, profile.id, frame.elapsed, frame.capturedAt, frame.id))) {
          app.frames.captureEncoded(frame.generation, frame.elapsed, completed - frame.elapsed, completed - started);
        }
        if (!stopRequested && (profile == PreviewProfile.ORIGINAL || app.frames.needsOriginal(frame.generation, frame.geometry, frame.elapsed))) {
          byte[] originalBytes = profile == PreviewProfile.ORIGINAL ? previewBytes : encodeJpeg(frame.bitmap, PreviewProfile.ORIGINAL.quality);
          app.frames.publishOriginal(frame.generation, frame.geometry,
              new FrameStore.Frame(originalBytes, FrameStore.MIME_TYPE, frame.width, frame.height, frame.rotation,
                  frame.elapsed, frame.capturedAt, frame.id));
        }
      } catch (RuntimeException | OutOfMemoryError error) {
        if (!stopRequested && frame.generation == generation && frame.revision == layoutRevision) requestStop("画面编码失败，请重新开始投屏");
      }
      finally { releaseBitmap(frame); }
    }
  }

  private Bitmap previewPixels(Bitmap source, int nextWidth, int nextHeight, PreviewProfile profile) {
    if (profile == PreviewProfile.ORIGINAL) return source;
    if (previewBitmap == null || previewBitmap.getWidth() != nextWidth || previewBitmap.getHeight() != nextHeight) {
      closePreviewBitmap(); previewBitmap = Bitmap.createBitmap(nextWidth, nextHeight, Bitmap.Config.ARGB_8888);
      previewCanvas = new Canvas(previewBitmap);
    }
    previewPaint.setColorFilter(profile.grayscale ? grayscale : null);
    previewCanvas.drawBitmap(source, null, new Rect(0, 0, nextWidth, nextHeight), previewPaint);
    return previewBitmap;
  }

  private byte[] encodeJpeg(Bitmap pixels, int quality) {
    encoded.reset();
    if (!pixels.compress(Bitmap.CompressFormat.JPEG, quality, encoded) || encoded.size() > 32 * 1024 * 1024) throw new IllegalStateException("JPEG encoding failed");
    return encoded.toByteArray();
  }

  private void closePreviewBitmap() {
    previewCanvas = null;
    if (previewBitmap != null) { previewBitmap.recycle(); previewBitmap = null; }
  }

  private void closeReader() {
    capture.removeCallbacks(encodeLatest); encodePending = false;
    ImageReader previous = reader, standby = standbyReader;
    reader = standbyReader = null;
    try { closeImageReader(previous); } catch (RuntimeException ignored) { /* Release the other producer as well. */ }
    try { closeImageReader(standby); } catch (RuntimeException ignored) { /* Continue bitmap cleanup. */ }
    synchronized (encodeLock) {
      layoutRevision += 1;
      if (pendingFrame != null) { pendingFrame.bitmap.recycle(); pendingFrame = null; }
      for (Bitmap available : freeBitmaps) available.recycle(); freeBitmaps.clear();
    }
    packed = null;
  }

  private void closeImageReader(ImageReader closing) {
    if (closing == null) return;
    try { closing.setOnImageAvailableListener(null, null); }
    finally { closing.close(); }
  }

  private void releaseProjection() {
    capture.removeCallbacks(refreshProjection);
    if (displayListenerRegistered) {
      displayListenerRegistered = false;
      try { getSystemService(DisplayManager.class).unregisterDisplayListener(displayListener); }
      catch (RuntimeException ignored) { /* Vendor display service may already be gone. */ }
    }
    VirtualDisplay previousDisplay = display; display = null;
    if (previousDisplay != null) {
      try { previousDisplay.release(); } catch (RuntimeException ignored) { /* Still release readers and grant. */ }
    }
    closeReader();
    if (projection != null) {
      MediaProjection previous = projection; projection = null;
      try { previous.unregisterCallback(projectionCallback); } catch (RuntimeException ignored) { /* Grant may already be invalid. */ }
      try { previous.stop(); } catch (RuntimeException ignored) { /* Cleanup is idempotent after a system stop. */ }
    }
  }

  private void requestStop(String message) {
    stopRequested = true;
    releaseWifiLock();
    app.frames.stop(generation, message);
    main.post(() -> { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); });
  }

  @Override public void onDestroy() {
    stopRequested = true;
    releaseWifiLock();
    app.frames.stop(generation, "投屏已停止"); stopForeground(STOP_FOREGROUND_REMOVE);
    capture.post(() -> {
      try { releaseProjection(); }
      finally {
        captureThread.quitSafely();
        encoder.post(() -> {
          try { closePreviewBitmap(); }
          finally { app.frames.finishStop(generation); encodeThread.quitSafely(); }
        });
      }
    });
    super.onDestroy();
  }

  @Override public IBinder onBind(Intent intent) { return null; }
}
