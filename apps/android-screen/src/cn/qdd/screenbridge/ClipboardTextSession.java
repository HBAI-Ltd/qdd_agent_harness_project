package cn.qdd.screenbridge;

import java.util.UUID;

/** Bounded version-2 publication, independent of Android UI and clipboard APIs. */
final class ClipboardTextSession {
  interface Clipboard {
    boolean writeAllowed();
    void write(String token, String text) throws Exception;
    boolean canVerify();
    boolean matches(String token, String text) throws Exception;
  }
  private final Utf8ImeProtocol protocol = new Utf8ImeProtocol(2);
  private final Clipboard clipboard;

  ClipboardTextSession(Clipboard clipboard) { this.clipboard = clipboard; }
  void lifecycle(long epoch, boolean enabled) { protocol.editor(epoch, enabled); }
  void link(boolean connected) { protocol.link(connected); }
  boolean ready() { return protocol.ready(); }
  long epoch() { return protocol.epoch(); }
  int pendingBytes() { return protocol.pendingBytes(); }
  byte[] state() { return protocol.state(); }
  byte[] receive(byte[] frame) {
    return protocol.receiveResult(frame, text -> {
      // No write without an explicit current AppOps grant. An unavailable query
      // must be represented by false, not an optimistic default.
      try { if (!protocol.ready() || !clipboard.writeAllowed()) return 1; }
      catch (RuntimeException unavailable) { return 1; }
      final long transferEpoch = protocol.epoch();
      final String token = "QDD:" + UUID.randomUUID().toString();
      clipboard.write(token, text);
      // Stop/lock/selection changes during the system call make a subsequent
      // paste unsafe, even when this write may already have taken effect.
      if (!protocol.ready() || protocol.epoch() != transferEpoch || !clipboard.writeAllowed()) return 2;
      // The foreground service is not permission to read a background clipboard.
      // Read only our just-written value, when a window is actually focused.
      try {
        if (clipboard.canVerify()) return clipboard.matches(token, text) && protocol.ready() && protocol.epoch() == transferEpoch ? 3 : 2;
      } catch (Exception unreadable) { return 2; }
      return 0;
    });
  }
}
