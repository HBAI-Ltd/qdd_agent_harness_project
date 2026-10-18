package cn.qdd.screenbridge;

public final class PointerCalibrationTest {
  private static void check(boolean value) { if (!value) throw new AssertionError(); }
  public static void main(String[] args) {
    PointerCalibration state = new PointerCalibration(); String device = "00000000-0000-4000-8000-000000000001";
    check(state.status(device, 0).contains("\"active\":false"));
    String first = state.begin(1080, 2400, 0);
    check(state.status(device, 10).contains("\"point\":null"));
    check(!state.record(first, Double.NaN, 50, 10)); check(!state.record(first, 1080, 50, 10));
    check(!state.record("wrong", 50, 50, 10)); check(state.record(first, 52.5, 80.25, 20));
    check(state.status(device, 27).contains("\"x\":52.5,\"y\":80.25,\"sequence\":1,\"ageMs\":7"));
    check(state.status(device, 19).contains("\"point\":null")); check(!state.record(first, 60, 60, 19));
    check(state.record(first, 100, 120, 30)); check(state.status(device, 40).contains("\"sequence\":2"));
    String second = state.begin(2400, 1080, 1); state.end(first);
    check(state.status(device, 40).contains("\"active\":true")); check(!state.record(first, 60, 60, 40));
    check(state.status(device, 40).contains("\"point\":null")); state.end(second);
    check(!state.record(second, 60, 60, 40)); check(state.status(device, 40).contains("\"active\":false"));
    System.out.println("PASS actual pointer coordinates, geometry, session isolation, invalid samples and foreground lifecycle");
  }
}
