package cn.qdd.screenbridge;

import org.json.JSONObject;

/** Controller readiness from its observed BLE connection, never a pairing grant. */
final class BoardBluetooth {
  static boolean ready(JSONObject bluetooth) {
    return bluetooth != null && bluetooth.optBoolean("connected") && bluetooth.optBoolean("encrypted")
        && bluetooth.optBoolean("bonded") && bluetooth.optBoolean("ready");
  }
}
