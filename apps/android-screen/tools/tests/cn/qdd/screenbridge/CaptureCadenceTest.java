package cn.qdd.screenbridge;

public final class CaptureCadenceTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    long now = 500, lastSource = 0, previousRefresh = -1;
    int refreshes = 0;
    while (refreshes < 8) {
      long remaining = CaptureCadence.idleDelay(now, lastSource, 500);
      if (remaining == 0) {
        if (previousRefresh >= 0) check(now - previousRefresh == 540, "A 40 ms composition offset must not double the idle refresh interval");
        previousRefresh = now; refreshes += 1;
        // Android supplies the new producer image after asynchronous traversal.
        lastSource = now + 40;
        now += 500;
      } else {
        check(remaining == 40, "Use the remaining idle budget, not another full polling interval");
        now += remaining;
      }
    }
    System.out.println("PASS delayed composition keeps a 500 ms idle budget instead of a one-second polling phase");

    check(CaptureCadence.idleDelay(1000, 980, 500) == 480, "Moving content defers refresh until actually idle");
    check(CaptureCadence.idleDelay(1499, 1000, 500) == 1, "The last millisecond is retained");
    check(CaptureCadence.idleDelay(1500, 1000, 500) == 0, "An expired source refreshes now");
    check(CaptureCadence.idleDelay(1000, 1040, 500) == 500, "Future samples cannot spin the handler");
    System.out.println("PASS active content, exact boundaries and future samples have bounded timer delays");

    CaptureCadence cadence = new CaptureCadence(); cadence.reset(0);
    check(cadence.refreshDelay(33, true) == 0, "A static continuous preview refreshes at the 33ms target, not 500ms");
    cadence.refreshed(33);
    check(cadence.refreshPending() && cadence.refreshDelay(66, true) > 0, "A 40ms compositor must not be replaced by another 33ms surface switch");
    cadence.acquired(73);
    check(!cadence.refreshPending() && cadence.refreshDelay(73, true) == 0, "A late real frame immediately continues the fixed target rather than adding an idle gap");
    cadence.refreshed(74); cadence.acquired(114);
    check(cadence.refreshDelay(114, true) == 0, "Static preview does not fall back to a 500ms idle cadence");
    check(cadence.refreshDelay(114, false) == 500, "No continuous viewer retains bounded idle work");
    cadence.reset(1000); cadence.acquired(1020);
    check(cadence.refreshDelay(1040, true) == 13, "Naturally arriving screen updates defer forced refresh only within the stream target");
    cadence.refreshed(1053); check(!cadence.stalled(2052) && cadence.stalled(2053), "Only a stalled producer allows a bounded retry");
    System.out.println("PASS fixed preview cadence, nonoverlapping composition, immediate continuation and stalled producer recovery");
  }
}
