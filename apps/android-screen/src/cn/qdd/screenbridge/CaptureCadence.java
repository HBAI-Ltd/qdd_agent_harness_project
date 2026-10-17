package cn.qdd.screenbridge;

final class CaptureCadence {
  static final long STREAM_GAP_MS = 33;
  private static final long PENDING_LIMIT_MS = 1000;
  private long lastSourceMs;
  private long lastRefreshMs;
  private boolean pending;
  private boolean forcedSource;

  void reset(long nowMs) { lastSourceMs = nowMs; lastRefreshMs = nowMs; pending = forcedSource = false; }
  void refreshed(long nowMs) { lastRefreshMs = nowMs; pending = true; forcedSource = false; }
  void acquired(long nowMs) { lastSourceMs = nowMs; forcedSource = pending; pending = false; }
  long refreshDelay(long nowMs, boolean streaming) {
    if (pending) return Math.max(1, PENDING_LIMIT_MS - Math.max(0, nowMs - lastRefreshMs));
    if (streaming && forcedSource) return idleDelay(nowMs, lastRefreshMs, STREAM_GAP_MS);
    return idleDelay(nowMs, lastSourceMs, streaming ? STREAM_GAP_MS : 500);
  }
  boolean refreshPending() { return pending; }
  boolean stalled(long nowMs) { return pending && nowMs - lastRefreshMs >= PENDING_LIMIT_MS; }

  /** Zero means refresh now; otherwise schedule exactly the remaining idle budget. */
  static long idleDelay(long nowMs, long lastSourceMs, long idleBudgetMs) {
    if (idleBudgetMs < 1) throw new IllegalArgumentException("Idle budget must be positive");
    if (nowMs < lastSourceMs) return idleBudgetMs;
    long elapsed = nowMs - lastSourceMs;
    return elapsed >= idleBudgetMs ? 0 : idleBudgetMs - elapsed;
  }
}
