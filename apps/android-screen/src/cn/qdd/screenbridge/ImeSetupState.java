package cn.qdd.screenbridge;

/** Preparation guidance shared by the Android UI and host regression tests. */
final class ImeSetupState {
  enum Step { CONTROLLER, ENABLE, SELECT, INPUT }
  final Step step;
  final String message;
  final boolean enableAction, selectAction;
  private ImeSetupState(Step step, String message, boolean enable, boolean select) {
    this.step = step; this.message = message; enableAction = enable; selectAction = select;
  }
  static ImeSetupState of(boolean controller, boolean enabled, boolean selected, String runtimeStatus) {
    if (!controller) return new ImeSetupState(Step.CONTROLLER, "先选择当前已配对的设备控制器。", false, false);
    if (!enabled) return new ImeSetupState(Step.ENABLE, "首次使用：在系统设置中启用“设备中文输入”，然后返回此页。", true, false);
    if (!selected) return new ImeSetupState(Step.SELECT, "已启用。请选择“设备中文输入”，再点击需要输入的文本框。", false, true);
    return new ImeSetupState(Step.INPUT, "已选择设备中文输入，无需重复设置。\n" + runtimeStatus, false, false);
  }
}
