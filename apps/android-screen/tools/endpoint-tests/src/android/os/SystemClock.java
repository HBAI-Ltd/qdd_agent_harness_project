package android.os;
/** Deterministic endpoint-retry clock; this fixture is never packaged. */
public final class SystemClock { public static long now; public static long elapsedRealtime(){return now;} }
