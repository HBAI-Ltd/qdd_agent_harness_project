package cn.qdd.screenbridge;

/** Main-thread v1 IME session. An editor/board/lock/link change revokes pending text. */
final class ImeTextSession {
  interface Editor {
    boolean valid();
    boolean commit(String text) throws Exception;
  }
  private final Utf8ImeProtocol protocol = new Utf8ImeProtocol();
  private long epoch;
  private Editor editor;
  private String controller = "";
  private boolean allowed, linked;

  ImeTextSession(long initialEpoch) {
    epoch = initialEpoch & 0xffffffffL;
    advance();
  }
  private void advance() {
    epoch = epoch == 0xffffffffL ? 1 : epoch + 1;
    protocol.editor(epoch, editor != null && allowed && !controller.isEmpty());
  }
  void editor(Editor next) { editor = next; advance(); }
  void environment(String nextController, boolean nextAllowed) {
    if (nextController == null) nextController = "";
    if (controller.equals(nextController) && allowed == nextAllowed) return;
    if (!controller.equals(nextController) || !nextAllowed) { linked = false; protocol.link(false); }
    controller = nextController; allowed = nextAllowed; advance();
  }
  void link(boolean active) {
    if (linked && !active) advance();
    linked = active; protocol.link(active);
  }
  void close() { editor = null; allowed = false; advance(); link(false); }
  boolean ready() { return protocol.ready(); }
  long epoch() { return epoch; }
  int pendingBytes() { return protocol.pendingBytes(); }
  byte[] state() { return protocol.state(); }
  byte[] receive(byte[] frame) {
    return protocol.receiveResult(frame, text -> {
      final Editor target = editor;
      final long round = epoch;
      if (!ready() || target == null || !target.valid()) return 1;
      boolean accepted = target.commit(text);
      // A successful API dispatch is never permission to retry into a new editor.
      if (!ready() || epoch != round || editor != target || !target.valid()) return 2;
      return accepted ? 0 : 1;
    });
  }
}
