import type { BrowserSessionState } from "@qdd/shared";
import type { LoadedConfig } from "../config.js";
import { createBrowserRuntime, type ToolResult, type ToolUpdate } from "./host.js";
import { z } from "zod";
import { browserActionSchema } from "./protocol.js";

/** 会改变网页状态、需要店长授权的动作（confirm 模式下每个会话授权一次）。 */
export const INTERACTIVE_ACTIONS = new Set(["click", "type", "pressKey"]);

/** agent 工具的参数描述（与 Toonflow 浏览器工具一致）。 */
export const BROWSER_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: browserActionSchema.options.map((schema) => schema.shape.action.value) },
    browserSessionId: { type: "string", description: "当前对话之前返回的浏览器会话 ID；省略则复用本对话会话。" },
    url: { type: "string", description: "HTTP/HTTPS 网页地址，用于 open、navigate 或 newTab。" },
    ref: { type: "string", description: "最近一次 snapshot 返回的元素引用，click、hover 和 type 必填；页面变化后重新 snapshot。" },
    text: { type: "string", description: "type 操作填入的完整文本。" },
    key: { type: "string", description: "pressKey 的 Puppeteer 按键名称，例如 Enter、Tab、Escape、Backspace。" },
    direction: { type: "string", enum: ["up", "down", "left", "right"], description: "scroll 的方向。" },
    amount: { type: "integer", minimum: 1, maximum: 10000, description: "scroll 的像素距离，默认 600。" },
    tabId: { type: "string", description: "tabs 返回的标签页 ID，用于 selectTab 或 closeTab。" },
    offset: { type: "integer", minimum: 0, description: "snapshot、read 或 tabs 的分页起点，默认 0；按返回的 nextOffset 继续读取。" },
  },
  required: ["action"],
  additionalProperties: false,
};

/**
 * 浏览器服务：每个 harness 会话对应一个独立浏览器会话（独立临时资料，不读个人浏览器登录）。
 * 运行时与网关的实时画面接口共享，店长可在前端观看并接管。
 */
export class BrowserService {
  readonly runtime = createBrowserRuntime();
  /** confirm 模式下已授权操作浏览器的会话 */
  private readonly granted = new Set<string>();

  constructor(private readonly loaded: LoadedConfig) {}

  get cwd(): string {
    return this.loaded.paths.workspace;
  }

  needsGrant(sessionId: string, action: string): boolean {
    return this.loaded.config.browser.permission === "confirm" && INTERACTIVE_ACTIONS.has(action) && !this.granted.has(sessionId);
  }

  grant(sessionId: string): void {
    this.granted.add(sessionId);
  }

  async execute(sessionId: string, args: Record<string, unknown>, signal?: AbortSignal, onUpdate?: ToolUpdate): Promise<ToolResult> {
    // 参数错误给出可读提示，而不是原始的 zod 问题列表
    const parsed = browserActionSchema.safeParse(args);
    if (!parsed.success) throw new Error(`browser 参数错误：${z.prettifyError(parsed.error).replace(/\n/g, "；")}。各动作只接受自己的参数，例如 pressKey 只要 key，click 只要 ref。`);
    return this.runtime.execute(this.cwd, sessionId, args, { executablePath: this.loaded.config.browser.executablePath }, signal, onUpdate);
  }

  state(browserSessionId: string): BrowserSessionState | undefined {
    return this.runtime.getSession(this.cwd, browserSessionId);
  }

  closeBrowser(sessionId: string, browserSessionId: string): Promise<BrowserSessionState> {
    return this.runtime.closeOwnedSession(this.cwd, sessionId, browserSessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.granted.delete(sessionId);
    await this.runtime.closeOwner(this.cwd, sessionId);
  }

  close(): Promise<void> {
    return this.runtime.closeAll();
  }
}
