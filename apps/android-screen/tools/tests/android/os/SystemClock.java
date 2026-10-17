package android.os;

/** Monotonic host clock for socket tests; never packaged in the APK. */
public final class SystemClock {
  private SystemClock() {}
  public static long elapsedRealtime() { return System.nanoTime() / 1000000; }
}
