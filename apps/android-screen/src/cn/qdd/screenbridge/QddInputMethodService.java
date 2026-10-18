package cn.qdd.screenbridge;

import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.text.InputType;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.security.SecureRandom;

/** Optional user-selected IME. Only the selected bonded ESP's encrypted BLE bytes can commit text. */
public final class QddInputMethodService extends InputMethodService {
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ImeTextSession session = new ImeTextSession(new SecureRandom().nextInt() & 0xffffffffL);
  private ImeGattClient bluetooth;
  private ScreenApplication app;
  private SharedPreferences preferences;
  private InputConnection connection;
  private String controller = "";
  private long transportRevision;
  private boolean destroyed, receiverRegistered;
  private TextView status;
  private String connectionStatus = "请先在投屏 App 中选择已配对的控制器";
  private final Runnable refresh = new Runnable() {
    @Override public void run() {
      if (destroyed) return;
      refresh(); main.postDelayed(this, 1000);
    }
  };
  private final SharedPreferences.OnSharedPreferenceChangeListener preferenceListener = (settings, key) -> {
    if (ImeGattClient.ADDRESS.equals(key)) refresh();
  };
  private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
    @Override public void onReceive(Context context, Intent intent) {
      if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) {
        session.environment(controller, false); resetTransport(); updateStatus();
      } else refresh();
    }
  };

  @Override public void onCreate() {
    super.onCreate(); app = (ScreenApplication)getApplication();
    preferences = getSharedPreferences("screen-source", MODE_PRIVATE);
    preferences.registerOnSharedPreferenceChangeListener(preferenceListener);
    IntentFilter filter = new IntentFilter();
    filter.addAction(Intent.ACTION_SCREEN_OFF); filter.addAction(Intent.ACTION_SCREEN_ON); filter.addAction(Intent.ACTION_USER_PRESENT);
    try {
      if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
      else registerReceiver(screenReceiver, filter);
      receiverRegistered = true;
    } catch (RuntimeException unavailable) {
      connectionStatus = "无法监听锁屏状态，设备中文输入暂不可用";
    }
    main.post(refresh);
  }
  private boolean unlocked() {
    try {
      KeyguardManager keyguard = getSystemService(KeyguardManager.class);
      PowerManager power = getSystemService(PowerManager.class);
      return keyguard != null && power != null && power.isInteractive() && !keyguard.isKeyguardLocked() && !keyguard.isDeviceLocked();
    } catch (RuntimeException unavailable) { return false; }
  }
  private boolean valid(InputConnection expected) {
    return !destroyed && receiverRegistered && expected != null && connection == expected
        && getCurrentInputConnection() == expected && unlocked() && ImeGattClient.permitted(this)
        && !controller.isEmpty() && controller.equals(preferences.getString(ImeGattClient.ADDRESS, ""));
  }
  private void resetTransport() {
    transportRevision++; session.link(false);
    ImeGattClient previous = bluetooth; bluetooth = null;
    if (previous != null) previous.close();
  }
  private void refresh() {
    if (destroyed || preferences == null) return;
    String selected = preferences.getString(ImeGattClient.ADDRESS, "");
    if (!controller.equals(selected)) { resetTransport(); controller = selected; }
    if (connection != null && connection != getCurrentInputConnection()) inactive();
    boolean allowed = receiverRegistered && unlocked() && ImeGattClient.permitted(this);
    session.environment(controller, allowed);
    if (!allowed) {
      if (bluetooth != null) resetTransport();
      if (receiverRegistered) connectionStatus = !unlocked() ? "屏幕已锁定或关闭，中文输入已暂停" : "请在投屏 App 中允许附近设备权限";
    } else if (connection != null && !controller.isEmpty()) {
      if (bluetooth == null) connect();
      bluetooth.ensureConnected();
    }
    updateStatus();
  }
  private void connect() {
    final long revision = ++transportRevision;
    bluetooth = new ImeGattClient(this, main, new ImeGattClient.Listener() {
      @Override public void availability(boolean active, String message) {
        if (destroyed || revision != transportRevision) return;
        connectionStatus = message; session.link(active);
        if (active) bluetooth.send(session.state());
        updateStatus();
      }
      @Override public void packet(byte[] bytes) {
        if (destroyed || revision != transportRevision) return;
        refresh();
        if (destroyed || revision != transportRevision) return;
        final ImeGattClient sender = bluetooth;
        byte[] response = session.receive(bytes);
        if (destroyed || revision != transportRevision || bluetooth != sender) return;
        if (response != null) sender.send(response);
        updateStatus();
      }
    });
  }
  @Override public void onStartInput(EditorInfo info, boolean restarting) {
    super.onStartInput(info, restarting);
    connection = info != null && info.inputType != InputType.TYPE_NULL ? getCurrentInputConnection() : null;
    final InputConnection target = connection;
    session.editor(target == null ? null : new ImeTextSession.Editor() {
      @Override public boolean valid() { return QddInputMethodService.this.valid(target); }
      @Override public boolean commit(String text) { return target.commitText(text, 1); }
    });
    refresh();
    if (bluetooth != null) bluetooth.send(session.state());
  }
  private void inactive() {
    connection = null; session.editor(null);
    if (bluetooth != null) bluetooth.send(session.state()); updateStatus();
  }
  @Override public void onFinishInput() { inactive(); super.onFinishInput(); }
  @Override public void onUnbindInput() { inactive(); super.onUnbindInput(); }
  @Override public void onDestroy() {
    destroyed = true; inactive(); session.close(); main.removeCallbacks(refresh); resetTransport();
    if (preferences != null) preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener);
    if (receiverRegistered) { unregisterReceiver(screenReceiver); receiverRegistered = false; }
    super.onDestroy();
  }
  private void updateStatus() {
    String message = session.ready() ? "设备中文输入已就绪；发送后请查看实际文字，未确认时不要重复发送"
        : controller.isEmpty() ? "请先在投屏 App 中选择当前已配对的控制器"
        : connection != null ? connectionStatus : "请点击目标文本框；中文仅由所选控制器蓝牙传入";
    if (app != null) app.imeStatus = message;
    if (status != null) status.setText(message);
  }
  @Override public boolean onEvaluateFullscreenMode() { return false; }
  @Override public View onCreateInputView() {
    LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL);
    int pad = Math.round(12 * getResources().getDisplayMetrics().density); panel.setPadding(pad,pad,pad,pad); panel.setBackgroundColor(0xFF191D24);
    status = new TextView(this); status.setTextSize(14); status.setTextColor(0xFFF3F4F6); panel.addView(status);
    Button change = new Button(this); change.setText("切换输入法"); change.setAllCaps(false);
    change.setOnClickListener(view -> ((InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE)).showInputMethodPicker()); panel.addView(change);
    updateStatus(); return panel;
  }
}
