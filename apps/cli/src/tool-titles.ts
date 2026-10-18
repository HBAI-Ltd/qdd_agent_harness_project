/** 工具展示名称在后端维护；技术标识继续用于模型调用和权限校验。 */
const TOOL_TITLES: Readonly<Record<string, string>> = {
  read_attachment: "读取附件", view_image: "查看图片", snapshot_data: "保存数据快照",
  write_file: "写入页面文件", read_file: "读取页面文件", list_files: "列出页面文件",
  edit_page: "选择要修改的页面", reply: "回复结果", finish: "发布页面", clarify: "确认需求",
  recall: "检索历史记录", read_session: "读取历史对话", read_artifact: "读取历史产物",
  propose_metric_change: "调整指标口径", load_skill: "加载技能", save_skill: "保存技能",
  send_notification: "发送通知", define_record: "定义记录表", create_schedule: "创建定时任务",
  edit_schedules: "修改定时任务", list_schedules: "查看定时任务", browser: "操作浏览器", progress: "执行进度",
  list_metrics: "查看指标口径", list_datasets: "查看数据集", aggregate: "汇总数据",
  timeline: "查询数据趋势", segments: "查询分组数据", get_store_info: "查看门店信息",
  list_products: "查询商品", get_inventory: "查询库存", query_orders: "查询订单", sales_summary: "汇总销售数据",
};

const CAMERA_TITLES: Readonly<Record<string, string>> = {
  camera_status: "检查摄像头连接状态", camera_connection_status: "检查摄像头连接状态",
  camera_list: "查询摄像头列表", list_cameras: "查询摄像头列表",
  camera_preview: "获取摄像头预览", get_live_stream: "获取摄像头实时视频流",
  camera_ptz: "移动摄像头云台", move_camera: "移动摄像头云台",
  camera_stop: "停止摄像头云台", stop_camera: "停止摄像头云台",
  camera_capabilities: "查询摄像头能力", camera_recording_dates: "查询录像日期",
  camera_recordings: "查询历史录像", camera_playback: "播放历史录像",
  camera_snapshot: "截取摄像头画面", camera_capture_start: "开始采集摄像头画面",
  capture_status: "查询画面采集进度", capture_list: "查看画面采集任务", capture_cancel: "停止画面采集",
  camera_usage_guide: "读取摄像头使用指南", usage_guide: "读取摄像头使用指南",
};

const PROVIDER_TITLES: Readonly<Record<string, string>> = {
  tysl: "天翼视联", haik: "海康", ezviz: "萤石", shouqianba: "收钱吧", android: "安卓设备",
};

/** MCP 优先使用服务声明的 title；未命名工具以说明的首句兜底。 */
export function toolDisplayTitle(name: string, description = "", title?: string, provider?: string): string {
  const declared = title?.trim();
  if (declared) return declared;
  const localName = provider ? name.replace(/^(tysl|ezviz)_/, "") : name.replace(/^store__/, "");
  const configured = provider ? (["tysl", "haik", "ezviz"].includes(provider) ? CAMERA_TITLES[localName] : undefined) : TOOL_TITLES[localName];
  const label = configured ?? (description.split(/[。；;\r\n]/, 1)[0]?.trim().slice(0, 60) || name);
  return provider ? `${PROVIDER_TITLES[provider] ?? provider}：${label}` : label;
}
