package cn.qdd.screenbridge;

/** UI permission admission only; never stores or reuses a system capture grant. */
final class CaptureConsent {
  enum Step { NONE, NOTIFICATIONS, CAPTURE }
  private boolean waiting;
  private boolean notificationPrompted;
  private long startingUntil;
  private static final long STARTUP_MS = 3000;

  CaptureConsent(boolean waiting, boolean notificationPrompted) {
    this(waiting, notificationPrompted, 0);
  }

  CaptureConsent(boolean waiting, boolean notificationPrompted, long startingUntil) {
    this.waiting = waiting; this.notificationPrompted = notificationPrompted;
    this.startingUntil = waiting ? 0 : startingUntil;
  }

  Step request(boolean active, boolean stopping, boolean endpointReady, boolean notificationsMissing, long now) {
    if (active || stopping || isBusy(now) || !endpointReady) return Step.NONE;
    waiting = true;
    if (notificationsMissing && !notificationPrompted) {
      notificationPrompted = true; return Step.NOTIFICATIONS;
    }
    return Step.CAPTURE;
  }

  boolean isWaiting() { return waiting; }
  boolean isStarting(long now) {
    // The bound also drops a saved deadline belonging to a previous boot.
    if (startingUntil != 0 && (now >= startingUntil || startingUntil - now > STARTUP_MS)) startingUntil = 0;
    return startingUntil != 0;
  }
  boolean isBusy(long now) { return waiting || isStarting(now); }
  long startingDeadline() { return startingUntil; }
  void serviceRequested(long now) { waiting = false; startingUntil = now + STARTUP_MS; }
  boolean notificationPrompted() { return notificationPrompted; }
  void finished() { waiting = false; startingUntil = 0; }
}
