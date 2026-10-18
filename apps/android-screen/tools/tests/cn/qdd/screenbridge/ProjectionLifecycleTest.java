package cn.qdd.screenbridge;

public final class ProjectionLifecycleTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] arguments) throws Exception {
    FrameStore frames = new FrameStore();
    long owner = frames.begin();
    FrameStore.OriginalRequest oldRequest = frames.requestOriginal();
    frames.stop(owner, "System stopped sharing");
    check(!frames.isActive() && frames.isStopping(), "Stop immediately revokes capture while resource cleanup is pending");
    check(frames.awaitOriginal(oldRequest, 100) == null, "A pending snapshot must unblock during cleanup");
    boolean blocked = false;
    try { frames.begin(); } catch (IllegalStateException expected) { blocked = true; }
    check(blocked, "A second grant cannot overlap the previous display and pixel buffers");
    frames.finishStop(owner - 1);
    check(frames.isStopping(), "An unrelated completion cannot unlock the current cleanup");
    frames.finishStop(owner);
    check(!frames.isStopping(), "Cleanup completion allows another explicit grant");
    frames.stop(owner, "Late old callback");
    check(!frames.isStopping() && frames.status().equals("System stopped sharing"), "A duplicate late callback cannot restart cleanup or replace the stop reason");
    long next = frames.begin();
    frames.stop(owner, "Old grant callback");
    check(frames.isActive() && !frames.isStopping(), "Old callbacks cannot stop the next sharing session");
    frames.stop(next, "Next session stopped");
    frames.finishStop(owner);
    check(frames.isStopping(), "Old completion cannot unlock the next session's cleanup");
    frames.finishStop(next);
    check(!frames.isStopping(), "The next session owns its own cleanup completion");
    System.out.println("PASS projection stop/restart admission, pending snapshot release and stale callback isolation (9 checks)");
  }
}
