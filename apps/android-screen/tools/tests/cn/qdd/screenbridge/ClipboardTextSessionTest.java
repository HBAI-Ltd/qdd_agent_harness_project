package cn.qdd.screenbridge;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class ClipboardTextSessionTest {
  private static int checks;
  private static final byte[] TEXT = "中文🙂 mixed\n下一行".getBytes(StandardCharsets.UTF_8);
  private static final class Store implements ClipboardTextSession.Clipboard {
    boolean allowed = true, focused, mismatch, writeThrows, readThrows, queryThrows;
    int writes, reads; String token, value; Runnable duringWrite;
    @Override public boolean writeAllowed() { if (queryThrows) throw new IllegalStateException("synthetic AppOps query unavailable"); return allowed; }
    @Override public void write(String nextToken, String text) {
      writes++; token = nextToken; value = text;
      if (duringWrite != null) duringWrite.run();
      if (writeThrows) throw new IllegalStateException("synthetic write failure");
    }
    @Override public boolean canVerify() { return focused; }
    @Override public boolean matches(String expectedToken, String text) {
      reads++;
      if (readThrows) throw new IllegalStateException("synthetic read denial");
      return !mismatch && expectedToken.equals(token) && text.equals(value);
    }
  }
  private static void check(boolean pass, String message) { checks++; if (!pass) throw new AssertionError(message); }
  private static byte[] frame(int version, int type, long id, int length) { byte[] out = new byte[length]; out[0] = (byte)version; out[1] = (byte)type; Utf8ImeProtocol.put(out, 2, id, 8); return out; }
  private static byte[] begin(long id, long epoch, int length) { byte[] out = frame(2,1,id,16); Utf8ImeProtocol.put(out,10,epoch,4); Utf8ImeProtocol.put(out,14,length,2); return out; }
  private static byte[] data(long id, byte[] bytes) { byte[] out = frame(2,2,id,bytes.length+12); System.arraycopy(bytes,0,out,12,bytes.length); return out; }
  private static byte[] commit(long id, long epoch) { byte[] out = frame(2,3,id,14); Utf8ImeProtocol.put(out,10,epoch,4); return out; }
  private static void ack(byte[] out, int status, long epoch) { check(out != null && out.length == 15 && out[0] == 2 && out[1] == (byte)0x82 && out[10] == status && Utf8ImeProtocol.read(out,11,4) == epoch,"version-2 ACK/status/epoch"); }
  private static ClipboardTextSession active(Store store) { ClipboardTextSession session = new ClipboardTextSession(store); session.lifecycle(7,true); session.link(true); return session; }
  private static void prepare(ClipboardTextSession session, long id, long epoch, byte[] bytes) { check(session.receive(begin(id,epoch,bytes.length)) == null,"begin accepted"); check(session.receive(data(id,bytes)) == null,"data accepted"); }
  public static void main(String[] args) {
    Store store = new Store(); ClipboardTextSession session = active(store);
    check(session.state()[0] == 2 && session.state()[1] == (byte)0x81,"clipboard READY must be v2, never legacy IME v1");
    prepare(session,1,7,TEXT); ack(session.receive(commit(1,7)),0,7);
    check(store.writes == 1 && store.reads == 0 && Arrays.equals(store.value.getBytes(StandardCharsets.UTF_8),TEXT),"background dispatch writes once without reading old/current clipboard");
    ack(session.receive(commit(1,7)),0,7); check(store.writes == 1,"duplicate commit never writes twice");
    store.focused = true; prepare(session,2,7,TEXT); ack(session.receive(commit(2,7)),3,7);
    check(store.writes == 2 && store.reads == 1,"verified only after real matching token and text readback");
    ack(session.receive(commit(2,7)),3,7); check(store.writes == 2 && store.reads == 1,"verified duplicate has no side effect");
    store.mismatch = true; prepare(session,3,7,TEXT); ack(session.receive(commit(3,7)),2,7);
    store.mismatch = false; store.readThrows = true; prepare(session,4,7,TEXT); ack(session.receive(commit(4,7)),2,7);
    store.allowed = false; prepare(session,5,7,TEXT); ack(session.receive(commit(5,7)),1,7); check(store.writes == 4,"AppOps denial performs no write");
    store.allowed = true; store.writeThrows = true; prepare(session,6,7,TEXT); ack(session.receive(commit(6,7)),2,7); ack(session.receive(commit(6,7)),2,7); check(store.writes == 5,"write exception is uncertain and never repeated");
    store = new Store(); session = active(store); prepare(session,1,7,TEXT); session.lifecycle(8,false);
    check(!session.ready() && session.pendingBytes() == 0 && session.state()[1] == (byte)0x83,"stop/lock/change revokes readiness and buffered text");
    ack(session.receive(commit(1,7)),1,8); check(store.writes == 0,"old lifecycle never publishes");
    session.lifecycle(9,true); prepare(session,1,9,TEXT); session.link(false); session.link(true); ack(session.receive(commit(1,9)),1,9); check(store.writes == 0,"disconnect cancels in-flight text");
    store = new Store(); session = active(store); prepare(session,1,7,TEXT); byte[] legacy = commit(1,7); legacy[0] = 1; ack(session.receive(legacy),1,7); check(store.writes == 0 && session.pendingBytes() == 0,"v1 cannot enter clipboard commit");
    Utf8ImeProtocol ime = new Utf8ImeProtocol(); ime.editor(7,true); ime.link(true); check(ime.receive(begin(1,7,TEXT.length), text -> { throw new AssertionError("v2 reached v1 IME"); }) == null,"v2 cannot enter v1 IME");
    store = new Store(); session = active(store); final ClipboardTextSession reentrant = session; final Store reentrantStore = store;
    store.duringWrite = () -> { ack(reentrant.receive(commit(1,7)),2,7); reentrant.lifecycle(8,false); };
    prepare(session,1,7,TEXT); ack(session.receive(commit(1,7)),2,7); ack(session.receive(commit(1,7)),2,7);
    check(reentrantStore.writes == 1 && !session.ready(),"reentrant lifecycle change never replays a write");
    store = new Store(); store.focused = true; session = active(store); final ClipboardTextSession switched = session;
    store.duringWrite = () -> switched.lifecycle(8,true);
    prepare(session,1,7,TEXT); ack(session.receive(commit(1,7)),2,7); ack(session.receive(commit(1,7)),2,7);
    check(store.writes == 1 && store.reads == 0 && session.ready(),"even an enabled new epoch cannot verify or dispatch the old transfer");
    store = new Store(); store.queryThrows = true; session = active(store); prepare(session,1,7,TEXT);
    ack(session.receive(commit(1,7)),1,7); check(store.writes == 0 && store.reads == 0,"unavailable AppOps query rejects without clipboard access");
    store = new Store(); session = active(store); final Store revoked = store; store.duringWrite = () -> revoked.allowed = false;
    prepare(session,1,7,TEXT); ack(session.receive(commit(1,7)),2,7); ack(session.receive(commit(1,7)),2,7);
    check(store.writes == 1 && store.reads == 0,"write grant revoked during call cannot authorize paste");
    for (byte[] invalid : new byte[][]{new byte[]{65,0,66}, new byte[]{(byte)0xc0,(byte)0x80}}) {
      store = new Store(); session = active(store); prepare(session,1,7,invalid); ack(session.receive(commit(1,7)),1,7); check(store.writes == 0,"invalid UTF-8/NUL does not write");
    }
    store = new Store(); session = active(store); ack(session.receive(begin(1,7,513)),1,7); check(session.pendingBytes() == 0 && store.writes == 0,"512-byte limit retained");
    System.out.println("PASS clipboard session: " + checks + " checks; no Android/ADB/BLE use");
  }
}
