package org.json;

import java.util.LinkedHashMap;
import java.util.Map;

/** Small host stand-in for the Android health JSON dependency. */
public final class JSONObject {
  private final Map<String, Object> values = new LinkedHashMap<>();
  public JSONObject put(String key, Object value) throws JSONException { values.put(key, value); return this; }
  public boolean optBoolean(String key) {
    Object value = values.get(key);
    return Boolean.TRUE.equals(value) || (value instanceof String && "true".equalsIgnoreCase((String)value));
  }
  private static String quote(String value) { return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
  @Override public String toString() {
    StringBuilder result = new StringBuilder("{");
    for (Map.Entry<String, Object> entry : values.entrySet()) {
      if (result.length() > 1) result.append(',');
      Object value = entry.getValue();
      result.append(quote(entry.getKey())).append(':').append(value instanceof String ? quote((String) value) : value);
    }
    return result.append('}').toString();
  }
}
