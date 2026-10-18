package cn.qdd.screenbridge;

import org.json.JSONObject;

/** Readiness policy only: no Android Bluetooth, pairing or phone is used. */
public final class BoardBluetoothTest {
  private static final String[] REQUIRED = {"connected", "encrypted", "bonded", "ready"};

  private static JSONObject status(String missing) throws Exception {
    JSONObject value = new JSONObject();
    for (String field : REQUIRED) if (!field.equals(missing)) value.put(field, true);
    return value;
  }

  public static void main(String[] arguments) throws Exception {
    JSONObject justWorks = status(null).put("authenticated", false);
    if (!BoardBluetooth.ready(justWorks)) throw new AssertionError("Encrypted bonded Just Works connection must be ready without MITM authentication");
    if (!BoardBluetooth.ready(status(null))) throw new AssertionError("MITM field is optional and must not gate readiness");
    if (!BoardBluetooth.ready(status(null).put("authenticated", true))) throw new AssertionError("Existing authenticated bond must remain ready");
    if (BoardBluetooth.ready(null) || BoardBluetooth.ready(new JSONObject())) throw new AssertionError("Absent state must fail closed");
    for (String field : REQUIRED) {
      if (BoardBluetooth.ready(status(field))) throw new AssertionError("Missing " + field + " must remain not ready");
      if (BoardBluetooth.ready(status(null).put(field, false).put("authenticated", true))) throw new AssertionError("False " + field + " cannot be replaced by authentication");
    }
    System.out.println("Board BLE readiness: encrypted/bonded Just Works accepted; missing or unsafe connection state rejected: PASS");
  }
}
