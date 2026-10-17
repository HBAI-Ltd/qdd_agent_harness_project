package cn.qdd.screenbridge;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
  private static final int CAPTURE = 10;
  private static final int NOTIFICATIONS = 11;
  private static final int BACKGROUND = 0xFF0E1116;
  private static final int CARD = 0xFF191D24;
  private static final int BORDER = 0xFF303640;
  private static final int TEXT = 0xFFF3F4F6;
  private static final int MUTED = 0xFFA8AFBB;
  private static final int ACCENT = 0xFFD4380D;
  private final Handler handler = new Handler();
  private ScreenApplication app;
  private TextView status;
  private TextView endpoint;
  private Button start;
  private Button stop;
  private TextView setupGuide;
  private Button bluetooth;
  private boolean consentPending;
  private final Runnable refresh = new Runnable() {
    @Override public void run() { update(); handler.postDelayed(this, 500); }
  };

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    app = (ScreenApplication) getApplication();
    applyConfiguration(getIntent());
    getWindow().setStatusBarColor(BACKGROUND);
    getWindow().setNavigationBarColor(BACKGROUND);
    getWindow().getDecorView().setSystemUiVisibility(getWindow().getDecorView().getSystemUiVisibility()
        & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setBackgroundColor(BACKGROUND);
    LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
    int padding = dp(20); content.setPadding(padding, dp(28), padding, padding);
    content.setBackgroundColor(BACKGROUND); scroll.addView(content);
    TextView eyebrow = label("设备操作台 · 手机端", 12); eyebrow.setTextColor(0xFFF27655); content.addView(eyebrow);
    TextView title = label("设备投屏", 28); title.setTypeface(null, Typeface.BOLD); title.setPadding(0, dp(8), 0, dp(4)); content.addView(title);
    TextView intro = label("同一局域网，共享画面与远程操作。", 14); intro.setTextColor(MUTED); content.addView(intro);

    LinearLayout sharing = card(content, "屏幕共享");
    status = label("尚未开始投屏", 18); status.setPadding(0, dp(12), 0, dp(4)); sharing.addView(status);
    TextView sharingTip = label("允许系统共享屏幕后，电脑即可看到实时画面。", 14); sharingTip.setTextColor(MUTED); sharing.addView(sharingTip);
    start = button(sharing, "开始投屏", true);
    stop = button(sharing, "停止投屏", false);

    LinearLayout network = card(content, "内网连接地址");
    endpoint = label("", 15); endpoint.setPadding(0, dp(12), 0, 0); endpoint.setTextIsSelectable(true); network.addView(endpoint);
    TextView networkTip = label("手机、设备控制器和电脑需要连接同一局域网。", 13); networkTip.setTextColor(MUTED); networkTip.setPadding(0, dp(12), 0, 0); network.addView(networkTip);

    LinearLayout controller = card(content, "设备控制器");
    setupGuide = label("", 14); setupGuide.setTextColor(MUTED); setupGuide.setPadding(0, dp(12), 0, dp(4)); controller.addView(setupGuide);
    bluetooth = button(controller, "连接设备控制器", false);
    bluetooth.setOnClickListener(view -> startActivity(new Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS)));

    LinearLayout guide = card(content, "如何操作");
    TextView details = label("电脑打开设备操作台.exe，点“自动查找”连接设备。\n\n点击实时画面开始操作，按 Esc 返回电脑。\n\n紧急情况：在设备控制器上选择“紧急停止”并按确认。主界面默认选中急停；恢复时选择“取消急停”并确认。", 14);
    details.setTextColor(MUTED); details.setPadding(0, dp(12), 0, 0); guide.addView(details);
    start.setOnClickListener(view -> requestCapture());
    stop.setOnClickListener(view -> stopCapture());
    setContentView(scroll); update();
    if (ScreenService.STOP.equals(getIntent().getAction())) stopCapture();
  }

  private TextView label(String text, int size) {
    TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(TEXT);
    view.setLineSpacing(dp(3), 1.0f);
    view.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    return view;
  }

  private GradientDrawable surface(int color, boolean border) {
    GradientDrawable drawable = new GradientDrawable();
    drawable.setColor(color); drawable.setCornerRadius(dp(16));
    if (border) drawable.setStroke(dp(1), BORDER);
    return drawable;
  }

  private LinearLayout card(LinearLayout parent, String title) {
    LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL);
    panel.setPadding(dp(18), dp(18), dp(18), dp(18));
    panel.setBackground(surface(CARD, true));
    LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    layout.topMargin = dp(16); parent.addView(panel, layout);
    TextView heading = label(title, 17); heading.setTypeface(null, Typeface.BOLD); panel.addView(heading);
    return panel;
  }

  private Button button(LinearLayout parent, String text, boolean primary) {
    Button button = new Button(this); button.setText(text); button.setTextSize(15); button.setAllCaps(false);
    button.setMinHeight(dp(48)); button.setMinimumHeight(dp(48)); button.setPadding(dp(12), dp(10), dp(12), dp(10));
    button.setBackgroundTintList(null);
    StateListDrawable states = new StateListDrawable();
    states.addState(new int[] { -android.R.attr.state_enabled }, surface(primary ? 0xFF563027 : 0xFF20242C, !primary));
    states.addState(new int[] { android.R.attr.state_pressed }, surface(primary ? 0xFFB82E09 : 0xFF303640, !primary));
    states.addState(new int[] {}, surface(primary ? ACCENT : 0xFF232831, !primary));
    button.setBackground(states);
    button.setTextColor(new ColorStateList(new int[][] { new int[] { -android.R.attr.state_enabled }, new int[] {} }, new int[] { 0xFF868D99, TEXT }));
    LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    layout.topMargin = dp(12); parent.addView(button, layout);
    return button;
  }

  private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

  private void setLabel(TextView view, String text) {
    if (!text.contentEquals(view.getText())) view.setText(text);
  }

  private void applyConfiguration(Intent intent) {
    try {
      if (intent != null && intent.hasExtra("espSetupUrl")) app.boardSetup().configure(intent.getStringExtra("espSetupUrl"));
      else if (intent != null && intent.getData() != null && "qddscreen".equals(intent.getData().getScheme())
          && "setup".equals(intent.getData().getHost())) {
        app.boardSetup().configure(intent.getData().getQueryParameter("esp"));
      }
      app.configure(intent);
    }
    catch (IllegalArgumentException | IllegalStateException error) { Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show(); }
  }

  @Override public void onNewIntent(Intent intent) {
    super.onNewIntent(intent); setIntent(intent);
    if (ScreenService.STOP.equals(intent.getAction())) stopCapture();
    else if (!consentPending) applyConfiguration(intent);
    update();
  }

  private void update() {
    boolean active = app.frames.isActive();
    if (active) consentPending = false;
    setLabel(status, app.serverError() != null ? app.serverError() : consentPending ? "等待系统录屏授权" : app.frames.status());
    start.setEnabled(!active && !consentPending && app.serverError() == null); stop.setEnabled(active);
    setLabel(endpoint, app.wifiAddress() == null ? "暂未连接 Wi-Fi，请先连接电脑所在的局域网。" : "http://" + app.wifiAddress() + ":" + app.port());
    setLabel(setupGuide, app.boardSetup().guide());
    bluetooth.setText(app.boardSetup().bluetoothReady() ? "查看蓝牙连接" : "连接 " + app.boardSetup().deviceName());
  }

  private void requestCapture() {
    if (app.frames.isActive() || consentPending) return;
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATIONS); return;
    }
    MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
    consentPending = true; update();
    Intent permission = Build.VERSION.SDK_INT >= 34
        ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay()) : manager.createScreenCaptureIntent();
    startActivityForResult(permission, CAPTURE);
  }

  @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(requestCode, permissions, results);
    if (requestCode == NOTIFICATIONS) {
      if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) requestCapture();
      else Toast.makeText(this, "请允许通知，以便投屏期间随时停止", Toast.LENGTH_LONG).show();
    }
  }

  @Override public void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != CAPTURE) return;
    if (resultCode == RESULT_OK && data != null) {
      Intent service = new Intent(this, ScreenService.class).setAction(ScreenService.START)
          .putExtra("projectionResult", resultCode).putExtra("projectionData", data);
      try { startForegroundService(service); }
      catch (RuntimeException error) { consentPending = false; Toast.makeText(this, "无法启动投屏服务，请重新授权", Toast.LENGTH_LONG).show(); }
      handler.postDelayed(() -> { if (!app.frames.isActive()) consentPending = false; update(); }, 3000);
    } else { consentPending = false; Toast.makeText(this, "未开始投屏，系统授权已取消", Toast.LENGTH_SHORT).show(); }
    update();
  }

  private void stopCapture() { startService(new Intent(this, ScreenService.class).setAction(ScreenService.STOP)); }
  @Override public void onResume() { super.onResume(); handler.post(refresh); }
  @Override public void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
  @Override public void onDestroy() { handler.removeCallbacksAndMessages(null); super.onDestroy(); }
}
