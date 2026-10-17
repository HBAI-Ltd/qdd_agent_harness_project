package cn.qdd.screenbridge;

import java.util.Arrays;

public final class PreviewProfileTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    int[][] portrait = { { 360, 800 }, { 540, 1200 }, { 720, 1600 }, { 1080, 2400 } };
    int[] quality = { 45, 60, 70, 75 }; int index = 0;
    for (PreviewProfile profile : PreviewProfile.values()) {
      check(Arrays.equals(profile.dimensions(1080, 2400), portrait[index]), "Actual portrait JPEG dimensions: " + profile.id);
      check(Arrays.equals(profile.dimensions(2400, 1080), new int[] { portrait[index][1], portrait[index][0] }), "Rotation preserves aspect ratio: " + profile.id);
      check(Arrays.equals(profile.dimensions(320, 240), new int[] { 320, 240 }), "Small screens are never upscaled");
      check(profile.quality == quality[index] && profile.grayscale == (index == 0), "Quality and grayscale match the requested preset");
      check(PreviewProfile.fromId(profile.id) == profile && PreviewProfile.fromRequest(" { \"profile\" : \"" + profile.id + "\" } ") == profile, "Preset request roundtrip");
      index += 1;
    }
    String[] invalid = { "{}", "{\"profile\":\"unknown\"}", "{\"profile\":null}", "{\"profile\":1}", "{\"profile\":\"fast\",\"other\":true}",
        "{\"profile\":\"fast\",\"profile\":\"turbo\"}", "[\"fast\"]", "{profile:\"fast\"}", "{\"profile\":\"standard\"} trailing", "\f{\"profile\":\"fast\"}" };
    for (String json : invalid) {
      try { PreviewProfile.fromRequest(json); throw new AssertionError("Invalid preset body accepted: " + json); }
      catch (IllegalArgumentException expected) { /* Strict one-property enum contract. */ }
    }
    System.out.println("Preview profile dimensions, quality, grayscale, exact enum and strict JSON tests: PASS");
  }
}
