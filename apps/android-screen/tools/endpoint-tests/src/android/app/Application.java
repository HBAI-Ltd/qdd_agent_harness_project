package android.app;
import android.content.SharedPreferences;
public class Application {
 public static final int MODE_PRIVATE=0;
 public void onCreate() {}
 public static final java.util.Map<String,Object> preferences=new java.util.HashMap<>();
 public SharedPreferences getSharedPreferences(String name,int mode){return new SharedPreferences(){
  public String getString(String key,String fallback){Object value=preferences.get(key);return value instanceof String?(String)value:fallback;}
  public int getInt(String key,int fallback){Object value=preferences.get(key);return value instanceof Integer?(Integer)value:fallback;}
  public Editor edit(){return new Editor(){
   public Editor remove(String key){preferences.remove(key);return this;}
   public Editor putInt(String key,int value){preferences.put(key,value);return this;}
   public Editor putString(String key,String value){preferences.put(key,value);return this;}
   public void apply(){} public boolean commit(){return true;}
  };}
 };}
 public <T> T getSystemService(Class<T> type){if(type==android.hardware.display.DisplayManager.class)return type.cast(new android.hardware.display.DisplayManager());if(type==android.net.ConnectivityManager.class)return type.cast(android.net.ConnectivityManager.INSTANCE);return null;}
}
