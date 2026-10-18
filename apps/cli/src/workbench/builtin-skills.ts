import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Skill } from "@qdd/shared";

// src/ 和 dist/ 的层级一致，不依赖进程 cwd 或用户工作空间位置。
const root = new URL("../../../../skills/", import.meta.url);
const createdAt = "2026-10-18T00:00:00.000Z";
const definitions = [
  {
    id: "55c30541-587c-4d2a-b538-3bc71b6c3ded",
    name: "android-operator",
    description: "Android HID 通用操作：定位与点击分离，截图核验光标，重新校准后点击，验证实际结果。",
    files: ["android-operator/SKILL-v2.md", "android-operator/PROMPT.md", "android-operator/CAPABILITIES.md"],
    steps: ["确认设备分辨率、指针增益和校准状态。", "移动定位后重新截图，确认控件可点及光标落点。", "点击前独立校准，原地点击，随后截图核验实际结果。", "滑动、读取屏幕和输入文字遵循完整操作说明；连续定位失败时停止并报告。"],
    tools: ["android_screenshot", "android_mouse_move", "android_mouse_click", "android_hid_status", "android_control"],
  },
  {
    id: "de711339-f80e-4603-9032-cdf057823d82",
    name: "xiaohongshu-hid-control",
    description: "通过 qdd-android-hid 操作真机小红书，包含设备画像、校准、布局识别、逐动作截图和故障处理。",
    files: ["xiaohongshu-hid-control/SKILL.md"],
    steps: ["先校准并测量指针增益，更换设备后重新建立设备画像。", "按当前截图识别页面布局、可操作区域及目标。", "按 Android 通用规程定位、截图确认、校准、点击；导航后等待再截图。", "逐动作核验效果，避免重复提交；失败时按完整说明分类处理。"],
    tools: ["android_screenshot", "android_mouse_move", "android_mouse_click", "android_control"],
  },
];

/** 内置技能随代码分发，不复制到运行时目录，也不覆盖已有用户技能。 */
export async function builtinSkills(): Promise<Skill[]> {
  return Promise.all(definitions.map(async ({ files, ...definition }) => {
    const documents = await Promise.all(files.map(async (file) => {
      const url = new URL(file, root);
      return `参考文件：${fileURLToPath(url)}\n${await readFile(url, "utf8")}`;
    }));
    return {
      ...definition,
      source: "builtin" as const,
      instructions: documents.join("\n\n---\n\n"),
      createdAt,
      updatedAt: createdAt,
    };
  }));
}
