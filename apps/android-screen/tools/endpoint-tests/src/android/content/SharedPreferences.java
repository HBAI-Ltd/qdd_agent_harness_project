package android.content;
public interface SharedPreferences { String getString(String key,String fallback); int getInt(String key,int fallback); Editor edit(); interface Editor { Editor remove(String key); Editor putInt(String key,int value); Editor putString(String key,String value); void apply(); boolean commit(); } }
