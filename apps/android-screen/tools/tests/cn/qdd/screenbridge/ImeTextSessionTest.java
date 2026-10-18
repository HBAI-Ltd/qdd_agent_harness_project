package cn.qdd.screenbridge;

import java.nio.charset.StandardCharsets;

public final class ImeTextSessionTest {
  private static int checks;
  private static final byte[] TEXT = "中文🙂 mixed\n下一行".getBytes(StandardCharsets.UTF_8);
  private static final class Editor implements ImeTextSession.Editor {
    boolean valid = true, accepted = true, throwsAfterCommit;
    int calls; String text; Runnable duringCommit;
    @Override public boolean valid() { return valid; }
    @Override public boolean commit(String next) {
      calls++; text = next;
      if (duringCommit != null) duringCommit.run();
      if (throwsAfterCommit) throw new IllegalStateException("synthetic editor dispatch failure");
      return accepted;
    }
  }
  private static void check(boolean pass, String message) { checks++; if (!pass) throw new AssertionError(message); }
  private static byte[] frame(int type, long id, int length) { byte[] out = new byte[length]; out[0] = 1; out[1] = (byte)type; Utf8ImeProtocol.put(out,2,id,8); return out; }
  private static byte[] begin(long id, long epoch) { byte[] out = frame(1,id,16); Utf8ImeProtocol.put(out,10,epoch,4); Utf8ImeProtocol.put(out,14,TEXT.length,2); return out; }
  private static byte[] data(long id) { byte[] out = frame(2,id,TEXT.length+12); System.arraycopy(TEXT,0,out,12,TEXT.length); return out; }
  private static byte[] commit(long id, long epoch) { byte[] out = frame(3,id,14); Utf8ImeProtocol.put(out,10,epoch,4); return out; }
  private static void ack(byte[] out, int status, long epoch) { check(out != null && out.length == 15 && out[0] == 1 && out[1] == (byte)0x82 && out[10] == status && Utf8ImeProtocol.read(out,11,4) == epoch,"v1 ACK/status/epoch"); }
  private static void rejected(byte[] out) { check(out != null && out.length == 15 && out[0] == 1 && out[1] == (byte)0x82 && out[10] == 1,"revoked transaction must be rejected"); }
  private static ImeTextSession active(Editor editor) {
    ImeTextSession session = new ImeTextSession(7); session.editor(editor); session.environment("board-a",true); session.link(true); return session;
  }
  private static long prepare(ImeTextSession session, long id) {
    long epoch = session.epoch(); check(session.receive(begin(id,epoch)) == null,"begin accepted"); check(session.receive(data(id)) == null,"data accepted"); return epoch;
  }
  public static void main(String[] args) {
    ImeTextSession session = new ImeTextSession(0xffffffffL);
    check(session.epoch() == 1 && !session.ready(),"nonzero epoch wraps safely, initial session not ready");
    session.environment("board-a",true); session.link(true); check(!session.ready(),"selected controller and BLE alone cannot accept text without editor");
    Editor editor = new Editor(); session.editor(editor); check(session.ready() && session.state()[0] == 1 && session.state()[1] == (byte)0x81,"current editor advertises only IME v1");
    long epoch = prepare(session,1); ack(session.receive(commit(1,epoch)),0,epoch); ack(session.receive(commit(1,epoch)),0,epoch);
    check(editor.calls == 1 && editor.text.equals(new String(TEXT,StandardCharsets.UTF_8)),"Chinese/emoji submitted intact exactly once");
    epoch = prepare(session,2); session.receive(frame(4,2,10)); ack(session.receive(commit(2,epoch)),1,epoch); check(editor.calls == 1,"cancel never commits");
    editor.accepted = false; epoch = prepare(session,3); ack(session.receive(commit(3,epoch)),1,epoch); ack(session.receive(commit(3,epoch)),1,epoch); check(editor.calls == 2,"editor rejection is terminal, no retry");
    editor.accepted = true; editor.throwsAfterCommit = true; epoch = prepare(session,4); ack(session.receive(commit(4,epoch)),2,epoch); ack(session.receive(commit(4,epoch)),2,epoch); check(editor.calls == 3,"dispatch exception is uncertain, no retry");
    for (String event : new String[]{"finish", "restart", "lock", "controller", "disconnect", "close"}) {
      editor = new Editor(); session = active(editor); epoch = prepare(session,1);
      if (event.equals("finish")) session.editor(null);
      if (event.equals("restart")) session.editor(new Editor());
      if (event.equals("lock")) session.environment("board-a",false);
      if (event.equals("controller")) session.environment("board-b",true);
      if (event.equals("disconnect")) session.link(false);
      if (event.equals("close")) session.close();
      check(session.epoch() != epoch && session.pendingBytes() == 0,"lifecycle invalidates pending payload: " + event);
      rejected(session.receive(commit(1,epoch))); check(editor.calls == 0,"late commit blocked after " + event);
      if (!event.equals("restart")) check(!session.ready(),"lifecycle revokes readiness: " + event);
    }
    editor = new Editor(); session = active(editor); epoch = prepare(session,1); session.environment("board-b",true);
    check(!session.ready(),"new controller cannot inherit old BLE link"); session.link(true);
    rejected(session.receive(commit(1,epoch))); long current = prepare(session,1); ack(session.receive(commit(1,current)),0,current); check(editor.calls == 1,"new controller needs new epoch-bound begin");
    editor = new Editor(); session = active(editor); epoch = prepare(session,1); editor.valid = false;
    ack(session.receive(commit(1,epoch)),1,epoch); check(editor.calls == 0,"stale InputConnection checked immediately before commit");
    editor = new Editor(); session = active(editor); final ImeTextSession reentrant = session; final long original = prepare(session,1);
    editor.duringCommit = () -> { ack(reentrant.receive(commit(1,original)),2,original); reentrant.editor(new Editor()); };
    ack(session.receive(commit(1,original)),2,original); ack(session.receive(commit(1,original)),2,original); check(editor.calls == 1,"reentrant new editor makes result uncertain and never commits twice");
    editor = new Editor(); session = active(editor); final Editor stale = editor; editor.duringCommit = () -> stale.valid = false;
    epoch = prepare(session,1); ack(session.receive(commit(1,epoch)),2,epoch); check(editor.calls == 1,"connection invalidated during call is uncertain");
    editor = new Editor(); session = active(editor); epoch = prepare(session,1); byte[] clipboard = commit(1,epoch); clipboard[0] = 2;
    ack(session.receive(clipboard),1,epoch); check(editor.calls == 0 && session.pendingBytes() == 0,"clipboard protocol never reaches IME commit");
    ImeSetupState state = ImeSetupState.of(false,false,false,""); check(state.step == ImeSetupState.Step.CONTROLLER && !state.enableAction && !state.selectAction,"select actual controller first");
    state = ImeSetupState.of(true,false,false,""); check(state.step == ImeSetupState.Step.ENABLE && state.enableAction && !state.selectAction,"first-use enable step");
    state = ImeSetupState.of(true,true,false,""); check(state.step == ImeSetupState.Step.SELECT && !state.enableAction && state.selectAction,"enabled IME only asks for selection");
    state = ImeSetupState.of(true,true,true,"请点击目标文本框"); check(state.step == ImeSetupState.Step.INPUT && !state.enableAction && !state.selectAction && state.message.contains("请点击目标文本框"),"already selected does not repeat setup and shows focus guidance");
    state = ImeSetupState.of(true,true,true,"设备中文输入已就绪"); check(state.message.contains("已就绪") && !state.selectAction,"ready state keeps selected IME");
    System.out.println("PASS IME lifecycle and preparation: " + checks + " checks; no Android/ADB/BLE use");
  }
}
