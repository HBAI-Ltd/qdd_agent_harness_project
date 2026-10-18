package cn.qdd.screenbridge;

/** No Android application or hardware is created by these host tests. */
final class ScreenApplication {
  final PointerCalibration pointerCalibration = new PointerCalibration();
  private final FrameStore frames;
  ScreenApplication(FrameStore frames) { this.frames = frames; }
  String deviceId() { return "00000000-0000-4000-8000-000000000001"; }
  String health() { return frames.health(8791, deviceId(), "Host fixture", 0); }
  void configurePreview(PreviewProfile profile) { frames.configurePreview(profile); }
}
