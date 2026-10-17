package cn.qdd.screenbridge;

import java.util.function.BooleanSupplier;

/** One radio lock owned by the current projection, never by an old callback. */
final class CaptureWifiLock {
  interface Lock {
    void acquire();
    boolean isHeld();
    void release();
  }

  private long owner = -1;
  private Lock held;

  synchronized boolean acquire(long nextOwner, Lock next, BooleanSupplier active) {
    if (!active.getAsBoolean()) return false;
    if (owner == nextOwner && held != null && held.isHeld()) return true;
    close();
    owner = nextOwner; held = next;
    try {
      next.acquire();
      if (!active.getAsBoolean()) { close(); return false; }
      return next.isHeld();
    } catch (RuntimeException error) {
      close();
      throw error;
    }
  }

  synchronized void release(long endingOwner) { if (endingOwner == owner) close(); }

  synchronized void close() {
    Lock previous = held;
    held = null; owner = -1;
    if (previous != null && previous.isHeld()) previous.release();
  }
}
