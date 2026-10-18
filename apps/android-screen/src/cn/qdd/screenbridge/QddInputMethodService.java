package cn.qdd.screenbridge;

import android.content.Context;
import android.inputmethodservice.InputMethodService;
import android.os.Handler;
import android.os.Looper;
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
  private final Utf8ImeProtocol protocol = new Utf8ImeProtocol();
  private long editorEpoch = new SecureRandom().nextInt() & 0xffffffffL;
  private ImeGattClient bluetooth;
  private ScreenApplication app;
  private boolean editorActive, destroyed;
  private TextView status;
  private String connectionStatus = "请先在投屏 App 中选择已配对的控制器";
  private final Runnable refresh = new Runnable() {
    @Override public void run() {
      if (destroyed) return;
      if (editorActive) {
        if (getCurrentInputConnection() == null) inactive();
        else bluetooth.ensureConnected();
      }
      updateStatus(); main.postDelayed(this, 1000);
    }
  };
  private long nextEpoch() { editorEpoch = (editorEpoch + 1) & 0xffffffffL; if (editorEpoch == 0) editorEpoch = 1; return editorEpoch; }

  @Override public void onCreate() {
    super.onCreate(); app = (ScreenApplication)getApplication();
    bluetooth = new ImeGattClient(this, main, new ImeGattClient.Listener() {
      @Override public void availability(boolean active, String message) {
        connectionStatus = message; protocol.link(active);
        if (active) bluetooth.send(protocol.state());
        updateStatus();
      }
      @Override public void packet(byte[] bytes) {
        final long round = protocol.epoch();
        byte[] response = protocol.receive(bytes, text -> {
          InputConnection connection = getCurrentInputConnection();
          if (!editorActive || !protocol.ready() || protocol.epoch() != round || connection == null) return false;
          return connection.commitText(text, 1);
        });
        if (response != null) bluetooth.send(response);
        updateStatus();
      }
    });
    protocol.editor(nextEpoch(), false); main.post(refresh);
  }
  @Override public void onStartInput(EditorInfo info, boolean restarting) {
    super.onStartInput(info, restarting);
    editorActive = info != null && getCurrentInputConnection() != null;
    protocol.editor(nextEpoch(), editorActive);
    bluetooth.send(protocol.state()); bluetooth.ensureConnected(); updateStatus();
  }
  private void inactive() {
    editorActive = false; protocol.editor(nextEpoch(), false);
    if (bluetooth != null) bluetooth.send(protocol.state()); updateStatus();
  }
  @Override public void onFinishInput() { inactive(); super.onFinishInput(); }
  @Override public void onUnbindInput() { inactive(); super.onUnbindInput(); }
  @Override public void onDestroy() {
    destroyed = true; inactive(); main.removeCallbacks(refresh);
    if (bluetooth != null) bluetooth.close(); super.onDestroy();
  }
  private void updateStatus() {
    String message = protocol.ready() ? "设备中文输入已就绪" : editorActive ? connectionStatus : "请选择目标文本框；中文仅由所选控制器蓝牙传入";
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
