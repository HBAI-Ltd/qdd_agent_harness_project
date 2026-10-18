package cn.qdd.screenbridge;

import android.app.AppOpsManager;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.PersistableBundle;
import android.os.PowerManager;
import android.os.Process;
import java.security.SecureRandom;
import java.util.function.BooleanSupplier;

/** One main-thread GATT receiver, owned exclusively by a live projection service. */
final class ClipboardGattReceiver implements AutoCloseable {
  private final ScreenApplication app;
  private final Handler main;
  private final BooleanSupplier projecting;
  private final SharedPreferences preferences;
  private final ClipboardTextSession session;
  private ImeGattClient client;
  private long epoch = new SecureRandom().nextInt() & 0xffffffffL;
  private long transportRevision;
  private String selected = "";
  private boolean enabled, linked, closed, receiverRegistered;
  private final Runnable poll = new Runnable() {
    @Override public void run() { refresh(); if (!closed) main.postDelayed(this, 1000); }
  };
  private final SharedPreferences.OnSharedPreferenceChangeListener preferenceListener = (settings, key) -> {
    if (ImeGattClient.ADDRESS.equals(key)) refresh();
  };
  private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
    @Override public void onReceive(Context context, Intent intent) {
      if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) suspend("屏幕已锁定或关闭，剪贴板输入已暂停");
      else refresh();
    }
  };

  ClipboardGattReceiver(ScreenApplication app, Handler main, BooleanSupplier projecting) {
    this.app = app; this.main = main; this.projecting = projecting;
    preferences = app.getSharedPreferences("screen-source", Context.MODE_PRIVATE);
    session = new ClipboardTextSession(new ClipboardTextSession.Clipboard() {
      @Override public boolean writeAllowed() { return eligible() && clipboardWriteAllowed(); }
      @Override public void write(String token, String text) {
        // Recheck immediately before the system call; stopping capture must not
        // permit a queued packet to change the clipboard.
        if (!eligible()) throw new IllegalStateException("Clipboard receiver is inactive");
        ClipboardManager manager = app.getSystemService(ClipboardManager.class);
        if (manager == null) throw new IllegalStateException("Clipboard service unavailable");
        ClipData clip = ClipData.newPlainText(token, text);
        PersistableBundle extras = new PersistableBundle();
        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
        clip.getDescription().setExtras(extras);
        manager.setPrimaryClip(clip);
      }
      @Override public boolean canVerify() { return eligible() && app.clipboardWindowFocused; }
      @Override public boolean matches(String token, String text) {
        ClipboardManager manager = app.getSystemService(ClipboardManager.class);
        if (manager == null || !app.clipboardWindowFocused) return false;
        ClipData clip = manager.getPrimaryClip();
        if (clip == null || clip.getItemCount() != 1) return false;
        ClipDescription description = clip.getDescription();
        CharSequence label = description == null ? null : description.getLabel();
        CharSequence value = clip.getItemAt(0).getText();
        return label != null && token.contentEquals(label) && value != null && text.contentEquals(value);
      }
    });
    session.lifecycle(nextEpoch(), false);
    preferences.registerOnSharedPreferenceChangeListener(preferenceListener);
    IntentFilter filter = new IntentFilter();
    filter.addAction(Intent.ACTION_SCREEN_OFF); filter.addAction(Intent.ACTION_SCREEN_ON); filter.addAction(Intent.ACTION_USER_PRESENT);
    try {
      if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
      else app.registerReceiver(screenReceiver, filter);
      receiverRegistered = true;
    } catch (RuntimeException denied) {
      // Without prompt lock notifications, fail closed rather than accepting a
      // stale ready interval until the next timer tick.
      close(); app.imeStatus = "无法监听锁屏状态，剪贴板输入未启用"; return;
    }
    main.post(poll);
  }

  private long nextEpoch() { epoch = epoch == 0xffffffffL ? 1 : epoch + 1; return epoch; }
  private boolean unlocked() {
    try {
      KeyguardManager keyguard = app.getSystemService(KeyguardManager.class);
      PowerManager power = app.getSystemService(PowerManager.class);
      return keyguard != null && power != null && power.isInteractive() && !keyguard.isKeyguardLocked() && !keyguard.isDeviceLocked();
    } catch (RuntimeException unavailable) { return false; }
  }
  @SuppressWarnings("deprecation")
  private boolean clipboardWriteAllowed() {
    try {
      AppOpsManager operations = app.getSystemService(AppOpsManager.class);
      // Clipboard's operation string is not a public OPSTR constant. Query only
      // our own UID through the public API; unknown/vendor-denied queries fail.
      return operations != null && operations.checkOpNoThrow("android:write_clipboard", Process.myUid(), app.getPackageName()) == AppOpsManager.MODE_ALLOWED;
    } catch (RuntimeException unavailable) { return false; }
  }
  private boolean eligible() {
    return !closed && enabled && projecting.getAsBoolean() && unlocked()
        && !selected.isEmpty() && selected.equals(preferences.getString(ImeGattClient.ADDRESS, ""));
  }
  private void resetTransport() {
    transportRevision++; linked = false;
    session.link(false); session.lifecycle(nextEpoch(), false);
    ImeGattClient previous = client; client = null;
    if (previous != null) previous.close();
  }
  private void suspend(String status) {
    if (closed) return;
    enabled = false; resetTransport(); app.imeStatus = status;
  }
  private void refresh() {
    if (closed) return;
    if (!projecting.getAsBoolean()) { close(); return; }
    String address = preferences.getString(ImeGattClient.ADDRESS, "");
    if (!address.equals(selected)) { enabled = false; resetTransport(); selected = address; }
    if (!unlocked()) {
      if (enabled || client != null) suspend("屏幕已锁定或关闭，剪贴板输入已暂停");
      else app.imeStatus = "屏幕已锁定或关闭，剪贴板输入已暂停";
      return;
    }
    if (!clipboardWriteAllowed()) { if (enabled || client != null) suspend("系统未允许剪贴板写入，中文输入已暂停"); else app.imeStatus = "系统未允许剪贴板写入，中文输入已暂停"; return; }
    if (selected.isEmpty()) { app.imeStatus = "请选择已配对控制器，保留当前键盘即可"; return; }
    if (!enabled) { enabled = true; session.lifecycle(nextEpoch(), true); }
    if (client == null) {
      final long revision = ++transportRevision;
      client = new ImeGattClient(app, main, new ImeGattClient.Listener() {
        @Override public void availability(boolean active, String status) {
          if (closed || revision != transportRevision) return;
          if (linked && !active) session.lifecycle(nextEpoch(), enabled);
          linked = active; session.link(active);
          app.imeStatus = session.ready() ? "剪贴板输入已连接；请在目标 App 聚焦文本框" : status;
          if (active && client != null) client.send(session.state());
        }
        @Override public void packet(byte[] bytes) {
          if (closed || revision != transportRevision) return;
          refresh();
          if (closed || revision != transportRevision || client == null) return;
          byte[] response = session.receive(bytes);
          if (response != null) client.send(response);
        }
      });
    }
    client.ensureConnected();
  }
  @Override public void close() {
    if (closed) return;
    closed = true; enabled = false; resetTransport(); main.removeCallbacks(poll);
    preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener);
    if (receiverRegistered) { receiverRegistered = false; try { app.unregisterReceiver(screenReceiver); } catch (RuntimeException ignored) {} }
    app.imeStatus = "开始投屏后可用剪贴板输入，无需切换键盘";
  }
}
