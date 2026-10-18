package cn.qdd.screenbridge;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Point;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

/** Opened locally by the user; the LAN API cannot launch this or inject events. */
public final class PointerCalibrationActivity extends Activity {
  private String owner;
  private PointerCalibration calibration;
  private Surface surface;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    calibration = ((ScreenApplication) getApplication()).pointerCalibration;
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    surface = new Surface(); setContentView(surface);
  }

  @Override public void onWindowFocusChanged(boolean focused) {
    super.onWindowFocusChanged(focused);
    if (focused) {
      Point size = new Point(); getWindowManager().getDefaultDisplay().getRealSize(size);
      if (owner != null) calibration.end(owner);
      owner = calibration.begin(size.x, size.y, getWindowManager().getDefaultDisplay().getRotation());
      surface.hasPoint = false; surface.invalidate();
    } else closeSession();
  }
  private void closeSession() { if (owner != null) { calibration.end(owner); owner = null; } }
  @Override public void onPause() { closeSession(); super.onPause(); }
  @Override public void onDestroy() { closeSession(); super.onDestroy(); }

  private final class Surface extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean hasPoint;
    private float localX, localY, rawX, rawY;
    Surface() { super(PointerCalibrationActivity.this); setBackgroundColor(0xFF0E1116); setFocusable(true); }
    private boolean mouse(MotionEvent event) {
      int action = event.getActionMasked();
      if (!event.isFromSource(InputDevice.SOURCE_MOUSE) || event.getButtonState() != 0
          || !(action == MotionEvent.ACTION_HOVER_MOVE || action == MotionEvent.ACTION_HOVER_ENTER || action == MotionEvent.ACTION_MOVE)) return false;
      if (!calibration.record(owner, event.getRawX(), event.getRawY(), SystemClock.elapsedRealtime())) return false;
      localX = event.getX(); localY = event.getY(); rawX = event.getRawX(); rawY = event.getRawY(); hasPoint = true; invalidate(); return true;
    }
    @Override public boolean onGenericMotionEvent(MotionEvent event) { return mouse(event) || super.onGenericMotionEvent(event); }
    @Override public boolean onTouchEvent(MotionEvent event) { mouse(event); return true; }
    @Override protected void onDraw(Canvas canvas) {
      super.onDraw(canvas);
      float density = getResources().getDisplayMetrics().density, margin = 24 * density;
      paint.setColor(0xFFF3F4F6); paint.setTextSize(24 * density); canvas.drawText("指针校准", margin, 60 * density, paint);
      paint.setColor(0xFFA8AFBB); paint.setTextSize(14 * density);
      canvas.drawText("保持此页前台，在电脑运行自动校准。", margin, 94 * density, paint);
      canvas.drawText("亮圈来自实际鼠标事件，无需系统光标入镜。", margin, 120 * density, paint);
      canvas.drawText("校准结束后，使用系统返回退出。", margin, 146 * density, paint);
      if (hasPoint) {
        paint.setColor(0xFFFFCA55); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(3 * density);
        canvas.drawCircle(localX, localY, 18 * density, paint);
        canvas.drawLine(localX - 28 * density, localY, localX + 28 * density, localY, paint);
        canvas.drawLine(localX, localY - 28 * density, localX, localY + 28 * density, paint);
        paint.setStyle(Paint.Style.FILL); paint.setTextSize(17 * density);
        canvas.drawText("实际坐标 " + Math.round(rawX) + ", " + Math.round(rawY), margin, getHeight() - 48 * density, paint);
      } else { paint.setTextSize(17 * density); canvas.drawText("等待实际鼠标移动…", margin, getHeight() - 48 * density, paint); }
    }
  }
}
