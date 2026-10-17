package cn.qdd.screenbridge;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

enum PreviewProfile {
  TURBO("turbo", 360, 45, true),
  FAST("fast", 540, 60, false),
  STANDARD("standard", 720, 70, false),
  ORIGINAL("original", 0, 75, false);

  private static final String WS = "[ \\t\\r\\n]*";
  private static final Pattern REQUEST = Pattern.compile(WS + "\\{" + WS + "\"profile\"" + WS + ":" + WS
      + "\"(turbo|fast|standard|original)\"" + WS + "\\}" + WS);
  final String id;
  final int shortSide, quality;
  final boolean grayscale;

  PreviewProfile(String id, int shortSide, int quality, boolean grayscale) {
    this.id = id; this.shortSide = shortSide; this.quality = quality; this.grayscale = grayscale;
  }

  static PreviewProfile fromId(String id) {
    for (PreviewProfile profile : values()) if (profile.id.equals(id)) return profile;
    throw new IllegalArgumentException("Unknown preview profile");
  }

  static PreviewProfile fromRequest(String json) {
    Matcher match = REQUEST.matcher(json);
    if (!match.matches()) throw new IllegalArgumentException("Use {\"profile\":\"turbo|fast|standard|original\"}");
    return fromId(match.group(1));
  }

  int[] dimensions(int width, int height) {
    if (width < 1 || height < 1) throw new IllegalArgumentException("Invalid display dimensions");
    int shortest = Math.min(width, height);
    if (shortSide == 0 || shortest <= shortSide) return new int[] { width, height };
    double scale = (double) shortSide / shortest;
    return new int[] { Math.max(1, (int)Math.round(width * scale)), Math.max(1, (int)Math.round(height * scale)) };
  }
}
