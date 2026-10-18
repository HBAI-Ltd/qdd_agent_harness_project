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
    description: "Android HID 通用操作：设备画像与页面状态识别，点击前整屏/局部双图确认，定位点击分离，失败分类与证据核验。",
    files: ["android-operator/SKILL-v2.md", "android-operator/METHODOLOGY.md", "android-operator/PROMPT.md", "android-operator/CAPABILITIES.md"],
    steps: ["重建设备画像，实测增益、线性区间、指针可见性与系统遮挡，先认页面锚点。", "只移动定位，检查新整屏与目标局部图；模拟十字不代表真实指针到位。", "确认校准和定位依据后原地点击，等待页面稳定并核验计数/文案，保存前后证据。", "失败先分链路、未武装、定位或状态；明确未派发才重新执行，非幂等结果不确定只回读；中文沿用 QDD 输入法。"],
    tools: ["android_screenshot", "android_preview_tap", "android_mouse_move", "android_mouse_click", "android_hid_status", "android_control"],
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
