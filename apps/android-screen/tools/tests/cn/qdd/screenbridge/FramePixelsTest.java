package cn.qdd.screenbridge;

import java.nio.ByteBuffer;
import java.util.Arrays;

public final class FramePixelsTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static byte[] bytes(ByteBuffer source) {
    byte[] bytes = new byte[source.remaining()]; source.duplicate().get(bytes); return bytes;
  }

  private static void rejects(Runnable action) {
    try { action.run(); throw new AssertionError("Expected invalid pixel layout to fail"); }
    catch (IllegalArgumentException expected) {}
  }

  public static void main(String[] args) {
    ByteBuffer packed = ByteBuffer.allocateDirect(22);
    for (int index = 0; index < packed.capacity(); index += 1) packed.put(index, (byte) index);
    packed.position(3); packed.limit(19);
    ByteBuffer pixels = FramePixels.rgba(packed, 2, 2, 8, ByteBuffer.allocateDirect(0));
    check(Arrays.equals(bytes(pixels), new byte[] { 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 }), "Packed pixels must preserve all RGBA bytes");
    check(packed.position() == 3 && packed.limit() == 19, "Packing must not consume the producer buffer");
    packed.put(3, (byte) 42);
    check(pixels.get(3) == 42, "A contiguous frame must share producer bytes, without a scratch copy");
    System.out.println("PASS packed RGBA excludes prefix and reuses producer bytes");

    ByteBuffer padded = ByteBuffer.wrap(new byte[] { 99, 1, 2, 3, 4, 90, 91, 5, 6, 7, 8, 92, 93, 9, 10, 11, 12, 98 });
    padded.position(1); padded.limit(17);
    ByteBuffer scratch = ByteBuffer.allocateDirect(12);
    check(Arrays.equals(bytes(FramePixels.rgba(padded, 1, 3, 6, scratch)), new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 }), "Padding must never reach the JPEG bitmap");
    check(padded.position() == 1 && padded.limit() == 17, "Padded frames must preserve producer bounds");
    System.out.println("PASS padded RGBA keeps pixel rows and excludes padding");

    rejects(() -> FramePixels.rgba(ByteBuffer.allocate(7), 1, 2, 4, scratch));
    rejects(() -> FramePixels.rgba(ByteBuffer.allocate(16), 2, 2, 7, scratch));
    rejects(() -> FramePixels.rgba(ByteBuffer.allocate(16), 1, 3, 6, ByteBuffer.allocate(8)));
    rejects(() -> FramePixels.rgba(ByteBuffer.allocate(16), Integer.MAX_VALUE, 1, 4, scratch));
    rejects(() -> FramePixels.rgba(ByteBuffer.allocate(16), 1, 0, 4, scratch));
    System.out.println("PASS invalid pixel layouts and insufficient buffers are rejected");
  }
}
