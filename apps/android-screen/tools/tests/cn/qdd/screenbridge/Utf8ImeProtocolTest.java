package cn.qdd.screenbridge;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class Utf8ImeProtocolTest {
  private static int commits, checks;
  private static String received;
  private static byte[] packet(int type, long id, int size) { byte[] out = new byte[size]; out[0] = 1; out[1] = (byte)type; Utf8ImeProtocol.put(out, 2, id, 8); return out; }
  private static byte[] begin(long id, long epoch, int length) { byte[] out = packet(1, id, 16); Utf8ImeProtocol.put(out, 10, epoch, 4); Utf8ImeProtocol.put(out, 14, length, 2); return out; }
  private static byte[] data(long id, int offset, byte[] bytes) { byte[] out = packet(2, id, bytes.length + 12); Utf8ImeProtocol.put(out, 10, offset, 2); System.arraycopy(bytes, 0, out, 12, bytes.length); return out; }
  private static byte[] commit(long id, long epoch) { byte[] out = packet(3, id, 14); Utf8ImeProtocol.put(out, 10, epoch, 4); return out; }
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Protocol check " + checks); }
  private static Utf8ImeProtocol active() { commits = 0; received = null; Utf8ImeProtocol model = new Utf8ImeProtocol(); model.editor(7, true); model.link(true); return model; }
  private static byte[] send(Utf8ImeProtocol model, byte[] frame) { return model.receive(frame, text -> { commits++; received = text; return true; }); }
  private static void ack(byte[] value, long id, int status, long epoch) { check(value != null && value.length == 15 && value[0] == 1 && (value[1] & 255) == 0x82 && Utf8ImeProtocol.read(value, 2, 8) == id && (value[10] & 255) == status && Utf8ImeProtocol.read(value, 11, 4) == epoch); }
  private static void prepare(Utf8ImeProtocol model, long id, byte[] bytes) { check(send(model, begin(id, 7, bytes.length)) == null); check(send(model, data(id, 0, bytes)) == null); }

  public static void main(String[] args) {
    Utf8ImeProtocol model = active(); byte[] unicode = "中文混合 ABC🙂\n下一行".getBytes(StandardCharsets.UTF_8);
    check(model.ready() && model.state()[1] == (byte)0x81); prepare(model, 1, unicode);
    ack(send(model, commit(1, 7)), 1, 0, 7); check(commits == 1 && "中文混合 ABC🙂\n下一行".equals(received) && model.pendingBytes() == 0);
    ack(send(model, commit(1, 7)), 1, 0, 7); check(commits == 1);
    ack(send(model, begin(1, 7, unicode.length)), 1, 1, 7); ack(send(model, commit(1, 7)), 1, 0, 7); check(commits == 1);
    prepare(model, 2, unicode); ack(model.receive(commit(2, 7), text -> { commits++; throw new IllegalStateException("synthetic editor failure"); }), 2, 2, 7);
    ack(send(model, commit(2, 7)), 2, 2, 7); check(commits == 2 && model.pendingBytes() == 0);
    prepare(model, 3, unicode); model.editor(8, true); ack(send(model, commit(3, 7)), 3, 1, 8); check(commits == 2 && model.pendingBytes() == 0);

    model = active(); check(send(model, begin(5, 7, unicode.length)) == null);
    byte[] first = Arrays.copyOf(unicode, 4), second = Arrays.copyOfRange(unicode, 4, unicode.length);
    check(send(model, data(5, 0, first)) == null); check(send(model, data(5, 0, first)) == null);
    check(send(model, begin(5, 7, unicode.length)) == null); check(send(model, data(5, 4, second)) == null);
    ack(send(model, commit(5, 7)), 5, 0, 7); check(commits == 1 && Arrays.equals(received.getBytes(StandardCharsets.UTF_8), unicode));
    model = active(); prepare(model, Long.MIN_VALUE, unicode); ack(send(model, commit(Long.MIN_VALUE, 7)), Long.MIN_VALUE, 0, 7);
    ack(send(model, begin(1, 7, unicode.length)), 1, 1, 7); prepare(model, -1, unicode); ack(send(model, commit(-1, 7)), -1, 0, 7); check(commits == 2);

    byte[][] invalid = { {(byte)0xc0,(byte)0x80}, {(byte)0xed,(byte)0xa0,(byte)0x80}, {(byte)0xf4,(byte)0x90,(byte)0x80,(byte)0x80}, {(byte)0xe4,(byte)0xb8}, {65,0,66} };
    for (byte[] bytes : invalid) { model = active(); prepare(model, 1, bytes); ack(send(model, commit(1, 7)), 1, 1, 7); check(commits == 0 && model.pendingBytes() == 0); }
    model = active(); ack(send(model, begin(1, 7, 513)), 1, 1, 7); check(model.pendingBytes() == 0);
    ack(send(model, begin(2, 7, 0)), 2, 1, 7); check(model.pendingBytes() == 0);
    model = active(); check(send(model, begin(1, 7, unicode.length)) == null); ack(send(model, data(1, 1, unicode)), 1, 1, 7); check(model.pendingBytes() == 0);
    model = active(); prepare(model, 1, unicode); ack(send(model, packet(4, 1, 10)), 1, 1, 7); ack(send(model, commit(1, 7)), 1, 1, 7); check(commits == 0);
    model = active(); prepare(model, 1, unicode); model.link(false); check(!model.ready() && model.pendingBytes() == 0); model.link(true); ack(send(model, commit(1, 7)), 1, 1, 7); check(commits == 0);
    model = active(); prepare(model, 1, unicode); model.editor(9, false); check(!model.ready() && model.state()[1] == (byte)0x83 && model.pendingBytes() == 0); ack(send(model, commit(1, 7)), 1, 1, 9); check(commits == 0);

    for (int type : new int[]{1,3,4}) { model = active(); byte[] frame = type == 1 ? begin(1,7,3) : type == 3 ? commit(1,7) : packet(4,1,10); frame = Arrays.copyOf(frame, frame.length + 1); ack(send(model, frame), 1, 1, 7); check(commits == 0); }
    model = active(); prepare(model, 1, unicode); ack(send(model, Arrays.copyOf(commit(1,7),15)),1,1,7); ack(send(model,commit(1,7)),1,1,7); check(commits == 0 && model.pendingBytes() == 0);
    model = active(); byte[] maximum = new byte[512]; Arrays.fill(maximum,(byte)'A'); prepare(model,1,maximum); ack(send(model,commit(1,7)),1,0,7); check(commits == 1 && received.length() == 512);
    model = active(); prepare(model, 1, unicode); byte[] bad = commit(1,7); bad[0] = 2; ack(send(model,bad),1,1,7); check(commits == 0 && model.pendingBytes() == 0);
    model = active(); prepare(model, 1, unicode); ack(model.receive(commit(1,7), text -> false),1,1,7); ack(send(model,commit(1,7)),1,1,7); check(commits == 0);
    // InputConnection.commitText may synchronously switch focus. Its result and
    // duplicate COMMIT still belong to the transfer's original editor epoch.
    model = active(); prepare(model, 1, unicode); final Utf8ImeProtocol focus = model;
    ack(model.receive(commit(1,7), text -> { commits++; received = text; focus.editor(8,true); return true; }),1,0,7);
    check(commits == 1 && focus.epoch() == 8 && focus.ready() && focus.pendingBytes() == 0);
    ack(send(model,commit(1,7)),1,0,7); check(commits == 1);
    // Reusing an id in the new editor epoch is distinct from the old terminal.
    check(send(model,begin(1,8,unicode.length)) == null); check(send(model,data(1,0,unicode)) == null);
    ack(send(model,commit(1,7)),1,0,7); check(commits == 1 && model.pendingBytes() == unicode.length);
    ack(send(model,commit(1,8)),1,0,8); check(commits == 2);
    ack(send(model,commit(1,7)),1,1,8); check(commits == 2);
    model = active(); prepare(model, 2, unicode); final Utf8ImeProtocol uncertainFocus = model;
    ack(model.receive(commit(2,7), text -> { commits++; uncertainFocus.editor(9,false); throw new IllegalStateException("synthetic focus loss"); }),2,2,7);
    ack(send(model,commit(2,7)),2,2,7); check(commits == 1 && model.pendingBytes() == 0);
    model = active(); prepare(model,3,unicode); final Utf8ImeProtocol reentrant = model;
    ack(model.receive(commit(3,7), text -> { commits++; ack(send(reentrant,commit(3,7)),3,2,7); return true; }),3,0,7);
    ack(send(model,commit(3,7)),3,0,7); check(commits == 1);
    System.out.println("PASS UTF-8 IME protocol: " + checks + " checks; no Android/ADB/BLE use");
  }
}
