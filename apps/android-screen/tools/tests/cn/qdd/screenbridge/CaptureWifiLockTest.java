package cn.qdd.screenbridge;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class CaptureWifiLockTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static class Radio implements CaptureWifiLock.Lock {
    int acquired, released;
    boolean held, fail;
    @Override public void acquire() { acquired += 1; held = true; if (fail) throw new IllegalStateException("vendor failure"); }
    @Override public boolean isHeld() { return held; }
    @Override public void release() { released += 1; held = false; }
  }

  public static void main(String[] args) throws Exception {
    CaptureWifiLock lock = new CaptureWifiLock(); Radio first = new Radio(), unused = new Radio();
    check(lock.acquire(1, first, () -> true), "A live projection owns its radio lock");
    check(lock.acquire(1, unused, () -> true) && first.acquired == 1 && unused.acquired == 0, "Repeated acquisition is idempotent");
    lock.release(0); check(first.held, "An old projection cannot release the current lock");
    Radio next = new Radio(); lock.acquire(2, next, () -> true);
    check(first.released == 1 && next.held, "Replacement releases the previous lock before acquiring the new one");
    lock.release(1); check(next.held, "A late old stop leaves the replacement lock held");
    lock.close(); lock.close(); check(next.released == 1, "Repeated service teardown releases exactly once");
    System.out.println("PASS projection ownership, idempotent start/stop and stale callback cleanup");

    Radio rejected = new Radio(); check(!lock.acquire(3, rejected, () -> false) && rejected.acquired == 0, "A stopped projection must never acquire");
    Radio failed = new Radio(); failed.fail = true;
    try { lock.acquire(3, failed, () -> true); throw new AssertionError("An acquisition failure must propagate to the optional optimizer guard"); }
    catch (IllegalStateException expected) { check(failed.released == 1 && !failed.held, "A partial vendor acquisition failure still releases its radio lock"); }
    lock.close(); check(failed.released == 1, "Failed startup leaves no retained lock");
    AtomicBoolean active = new AtomicBoolean(true);
    Radio stopsDuringAcquire = new Radio() { @Override public void acquire() { super.acquire(); active.set(false); } };
    check(!lock.acquire(4, stopsDuringAcquire, active::get) && stopsDuringAcquire.released == 1, "Cancellation during acquire releases before returning");
    System.out.println("PASS failed startup, inactive session and cancellation during acquisition leave no radio lock");

    CountDownLatch acquiring = new CountDownLatch(1), proceed = new CountDownLatch(1);
    active.set(true);
    Radio blocked = new Radio() {
      @Override public void acquire() {
        acquiring.countDown();
        try { if (!proceed.await(2, TimeUnit.SECONDS)) throw new AssertionError("Acquire test timed out"); }
        catch (InterruptedException error) { throw new AssertionError(error); }
        super.acquire();
      }
    };
    AtomicBoolean workerFailed = new AtomicBoolean();
    Thread starter = new Thread(() -> {
      try { check(!lock.acquire(5, blocked, active::get), "A concurrently stopped projection must not retain its lock"); }
      catch (Throwable failure) { workerFailed.set(true); }
    });
    starter.start(); check(acquiring.await(2, TimeUnit.SECONDS), "Start enters the vendor call");
    active.set(false);
    Thread stopper = new Thread(() -> lock.release(5)); stopper.start();
    proceed.countDown(); starter.join(2000); stopper.join(2000);
    check(!starter.isAlive() && !stopper.isAlive() && !workerFailed.get() && blocked.released == 1 && !blocked.held,
        "Stop racing a blocked acquire has bounded completion and exactly one release");
    System.out.println("PASS concurrent stop while vendor acquisition is in flight cannot leak a radio lock");
  }
}
