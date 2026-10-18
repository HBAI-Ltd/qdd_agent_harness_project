package cn.qdd.screenbridge;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Main-thread-only bounded protocol. No text is logged or persisted. */
final class Utf8ImeProtocol {
  static final int LIMIT = 512;
  interface Committer { boolean commit(String text) throws Exception; }
  interface ResultCommitter { int commit(String text) throws Exception; }
  private final int version;
  private long epoch, highestId, terminalId, terminalEpoch, pendingId;
  private int terminalStatus = 1, used;
  private boolean editor, subscribed;
  private byte[] pending;

  Utf8ImeProtocol() { this(1); }
  Utf8ImeProtocol(int version) {
    if (version != 1 && version != 2) throw new IllegalArgumentException("Unsupported text protocol version");
    this.version = version;
  }

  void editor(long value, boolean active) {
    if (value < 1 || value > 0xffffffffL) throw new IllegalArgumentException("Invalid editor epoch");
    if (value != epoch) { clear(); highestId = 0; }
    epoch = value; editor = active;
    if (!active) clear();
  }
  void link(boolean active) {
    subscribed = active;
    if (!active && pending != null) reject(pendingId);
  }
  boolean ready() { return subscribed && editor && epoch != 0; }
  long epoch() { return epoch; }
  int pendingBytes() { return pending == null ? 0 : pending.length; }
  byte[] state() { byte[] out = new byte[6]; out[0] = (byte)version; out[1] = (byte)(ready() ? 0x81 : 0x83); put(out, 2, epoch, 4); return out; }
  private void clear() { if (pending != null) Arrays.fill(pending, (byte)0); pending = null; pendingId = 0; used = 0; }
  private void terminal(long id, int result) { clear(); terminalId = id; terminalEpoch = epoch; terminalStatus = result; }
  private byte[] reject(long id) {
    if (id != 0 && (id == pendingId || Long.compareUnsigned(id, highestId) > 0)) {
      if (Long.compareUnsigned(id, highestId) > 0) highestId = id;
      terminal(id, 1);
    }
    return id == 0 ? null : ack(id, 1);
  }
  private byte[] ack(long id, int result) {
    return ack(id, result, epoch);
  }
  private byte[] ack(long id, int result, long transferEpoch) {
    byte[] out = new byte[15]; out[0] = (byte)version; out[1] = (byte)0x82; put(out, 2, id, 8); out[10] = (byte)result; put(out, 11, transferEpoch, 4); return out;
  }
  static long read(byte[] input, int offset, int count) {
    long value = 0; for (int i = 0; i < count; i++) value |= (long)(input[offset + i] & 255) << (i * 8); return value;
  }
  static void put(byte[] output, int offset, long value, int count) {
    for (int i = 0; i < count; i++) output[offset + i] = (byte)(value >>> (i * 8));
  }

  byte[] receive(byte[] frame, Committer committer) {
    return receiveResult(frame, text -> committer.commit(text) ? 0 : 1);
  }
  byte[] receiveResult(byte[] frame, ResultCommitter committer) {
    if (frame == null || frame.length < 10 || frame[0] != version || frame[1] < 1 || frame[1] > 4) {
      return pending == null ? null : reject(pendingId);
    }
    final int type = frame[1]; final long id = read(frame, 2, 8);
    if (id == 0) { if (pending != null) return reject(pendingId); return null; }
    if (type == 1) {
      if (frame.length != 16) return reject(id);
      final long requestedEpoch = read(frame, 10, 4); final int size = (int)read(frame, 14, 2);
      if (requestedEpoch != epoch) return ack(id, 1);
      if (id == pendingId && pending != null && size == pending.length && ready()) return null;
      if (Long.compareUnsigned(id, highestId) <= 0 || !ready() || size < 1 || size > LIMIT || pending != null) return reject(id);
      highestId = pendingId = id; used = 0; pending = new byte[size]; return null;
    }
    if (type == 2) {
      if (frame.length < 13 || frame.length > LIMIT + 12 || id != pendingId || pending == null || !ready()) return reject(id);
      final int offset = (int)read(frame, 10, 2), size = frame.length - 12;
      if (offset > used || offset > pending.length || size > pending.length - offset) return reject(id);
      if (offset < used) {
        if (size > used - offset) return reject(id);
        for (int i = 0; i < size; i++) if (pending[offset + i] != frame[12 + i]) return reject(id);
        return null;
      }
      System.arraycopy(frame, 12, pending, used, size); used += size; return null;
    }
    if (type == 4) {
      if (frame.length != 10) return reject(id);
      if (id == terminalId && id != pendingId) return ack(id, terminalStatus, terminalEpoch);
      return reject(id);
    }
    if (frame.length != 14) return reject(id);
    final long transferEpoch = read(frame, 10, 4);
    if (id == terminalId && transferEpoch == terminalEpoch) return ack(id, terminalStatus, terminalEpoch);
    if (transferEpoch != epoch) return id == pendingId ? reject(id) : ack(id, 1);
    if (!ready() || pending == null || id != pendingId || used != pending.length) return reject(id);
    final String text;
    try {
      text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(pending)).toString();
      if (text.indexOf('\0') >= 0) return reject(id);
    } catch (CharacterCodingException invalid) { return reject(id); }
    // Record uncertain before entering external editor code: re-entrancy or an
    // exception must never make this transfer eligible for a second commit.
    terminal(id, 2);
    int result = 2;
    try { result = committer.commit(text); if (result < 0 || result > (version == 2 ? 3 : 2)) result = 2; }
    catch (Exception unavailable) { result = 2; }
    if (terminalId == id && terminalEpoch == transferEpoch) terminalStatus = result;
    return ack(id, result, transferEpoch);
  }
}
