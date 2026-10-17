package cn.qdd.screenbridge;

import java.nio.ByteBuffer;

/** Excludes producer row padding while avoiding a second copy for packed RGBA. */
final class FramePixels {
  private FramePixels() {}

  static ByteBuffer rgba(ByteBuffer source, int width, int height, int rowStride, ByteBuffer scratch) {
    if (width < 1 || height < 1 || width > Integer.MAX_VALUE / 4) throw new IllegalArgumentException("Invalid image dimensions");
    int rowBytes = width * 4;
    long imageBytes = (long) rowBytes * height;
    long sourceBytes = (long) rowStride * (height - 1) + rowBytes;
    if (rowStride < rowBytes || imageBytes > Integer.MAX_VALUE || source.remaining() < sourceBytes) {
      throw new IllegalArgumentException("Truncated image buffer");
    }
    int base = source.position();
    ByteBuffer pixels = source.duplicate();
    if (rowStride == rowBytes) {
      pixels.limit(base + (int) imageBytes);
      return pixels;
    }
    if (scratch.capacity() < imageBytes) throw new IllegalArgumentException("Pixel scratch buffer is too small");
    scratch.clear();
    for (int row = 0; row < height; row += 1) {
      pixels.limit(base + row * rowStride + rowBytes);
      pixels.position(base + row * rowStride);
      scratch.put(pixels);
    }
    scratch.flip();
    return scratch;
  }
}
