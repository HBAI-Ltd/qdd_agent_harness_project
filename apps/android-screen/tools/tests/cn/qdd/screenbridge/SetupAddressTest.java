package cn.qdd.screenbridge;

import java.util.LinkedHashMap;
import java.util.Map;

/** Pure selection policy: no Android network, preferences, or device is used. */
public final class SetupAddressTest {
  private static void reject(Runnable operation) {
    try { operation.run(); throw new AssertionError("Invalid or ambiguous board must be rejected"); }
    catch (IllegalArgumentException expected) { }
  }

  public static void main(String[] arguments) {
    if (!"http://192.168.1.4:3334".equals(SetupAddress.normalize(" http://192.168.1.4:3334/ "))) throw new AssertionError();
    for (String address : new String[] {"http://10.0.0.1:3334", "http://172.16.0.1:3334", "http://172.31.255.254:3334"}) {
      if (!address.equals(SetupAddress.normalize(address))) throw new AssertionError();
    }
    for (String address : new String[] {"http://127.0.0.1:3334", "http://8.8.8.8:3334", "http://localhost:3334",
        "https://192.168.1.4:3334", "http://192.168.1.4", "http://192.168.1.4:3333", "http://192.168.1.4:1",
        "http://192.168.1.4:3334/api/status", "http://192.168.1.4:3334/?x=1", "http://192.168.1.4:3334/#x",
        "http://a:b@192.168.1.4:3334", "http://192.168.001.4:3334", "http://172.15.0.1:3334",
        "http://172.32.0.1:3334", "http://192.168.1.256:3334", "http://[::1]:3334"}) reject(() -> SetupAddress.normalize(address));
    reject(() -> SetupAddress.normalize(null));
    Map<String, String> boards = new LinkedHashMap<>();
    boards.put("http://192.168.1.4:3334", "QDD-Passport-A1BA");
    if (!"http://192.168.1.4:3334".equals(SetupAddress.selectDiscovered(boards, null))) throw new AssertionError();
    boards.put("http://192.168.1.5:3334", "QDD-Passport-1234");
    reject(() -> SetupAddress.selectDiscovered(boards, null));
    if (!"http://192.168.1.4:3334".equals(SetupAddress.selectDiscovered(boards, "QDD-Passport-A1BA"))) throw new AssertionError();
    // DHCP recovery follows the selected stable identity, never another board.
    boards.remove("http://192.168.1.4:3334");
    reject(() -> SetupAddress.selectDiscovered(boards, "QDD-Passport-A1BA"));
    boards.put("http://192.168.1.46:3334", "QDD-Passport-A1BA");
    if (!"http://192.168.1.46:3334".equals(SetupAddress.selectDiscovered(boards, "QDD-Passport-A1BA"))) throw new AssertionError();
    boards.put("http://192.168.1.47:3334", "QDD-Passport-A1BA");
    reject(() -> SetupAddress.selectDiscovered(boards, "QDD-Passport-A1BA"));
    boards.clear(); boards.put("http://192.168.1.4:3334", "Unknown board");
    reject(() -> SetupAddress.selectDiscovered(boards, null));
    if (SetupAddress.validBoardName("QDD-Passport") || SetupAddress.validBoardName("QDD-Passport-0000\n")) throw new AssertionError();
    System.out.println("Setup private URL, multi-board ambiguity and selected-identity DHCP recovery tests: PASS");
  }
}
