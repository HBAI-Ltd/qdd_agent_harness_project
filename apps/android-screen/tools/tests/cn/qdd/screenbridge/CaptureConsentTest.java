package cn.qdd.screenbridge;

public final class CaptureConsentTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] arguments) {
    CaptureConsent consent = new CaptureConsent(false, false);
    check(consent.request(false, false, true, true, 1000) == CaptureConsent.Step.NOTIFICATIONS, "First sharing action can request optional notifications");
    check(consent.request(false, false, true, true, 1000) == CaptureConsent.Step.NONE, "Repeated clicks cannot open parallel system prompts");
    CaptureConsent restored = new CaptureConsent(consent.isWaiting(), consent.notificationPrompted());
    check(restored.request(false, false, true, true, 1000) == CaptureConsent.Step.NONE, "Activity recreation preserves an in-flight authorization prompt");
    restored.finished();
    check(restored.request(false, false, true, true, 1000) == CaptureConsent.Step.CAPTURE, "Notification denial still requires a separate screen-sharing consent");
    restored.finished();
    check(restored.request(false, false, true, true, 1000) == CaptureConsent.Step.CAPTURE, "Cancelling capture never loops the denied notification permission");
    restored.finished();
    check(restored.request(false, true, true, false, 1000) == CaptureConsent.Step.NONE && !restored.isWaiting(), "Closing old projection resources prevents a second grant");
    check(restored.request(true, false, true, false, 1000) == CaptureConsent.Step.NONE, "An active projection is not granted twice");
    check(restored.request(false, false, false, false, 1000) == CaptureConsent.Step.NONE && !restored.isWaiting(), "No Wi-Fi endpoint leaves the start action available for later recovery");
    check(restored.request(false, false, true, false, 1000) == CaptureConsent.Step.CAPTURE, "Network recovery admits a new explicit system prompt");
    restored.finished();
    check(!restored.isWaiting(), "Completion or cancellation releases UI admission");
    restored.serviceRequested(1000);
    check(!restored.isWaiting() && restored.isStarting(1500), "A returned grant waits for service startup, not another system authorization");
    CaptureConsent startup = new CaptureConsent(restored.isWaiting(), restored.notificationPrompted(), restored.startingDeadline());
    check(startup.request(false, false, true, false, 2000) == CaptureConsent.Step.NONE, "Activity recreation keeps the remaining startup admission bound");
    check(startup.request(false, false, true, false, 4000) == CaptureConsent.Step.CAPTURE, "Missing service startup unblocks on the original monotonic deadline after recreation");
    check(startup.isBusy(10000) && startup.isWaiting(), "An expired old startup cannot clear a later live system authorization prompt");
    startup.finished(); startup.serviceRequested(10000); startup.finished();
    check(startup.request(false, false, true, false, 10001) == CaptureConsent.Step.CAPTURE, "Immediate service failure allows a new explicit authorization without a stale delayed cleanup");
    CaptureConsent rebooted = new CaptureConsent(false, true, 100000);
    check(rebooted.request(false, false, true, false, 1) == CaptureConsent.Step.CAPTURE, "A saved deadline from another boot cannot block capture");
    System.out.println("PASS optional notification denial, prompt recreation, startup deadline and cleanup/network admission (16 checks)");
  }
}
