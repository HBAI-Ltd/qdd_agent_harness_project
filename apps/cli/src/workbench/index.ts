import { BrowserService } from "../browser/index.js";
import type { LoadedConfig } from "../config.js";
import { ConnectorStore } from "./connectors.js";
import { FeishuClient } from "./feishu.js";
import type { Scheduler } from "./scheduler.js";
import { SecretBox } from "./secrets.js";
import { SkillStore } from "./skills.js";

/** 工作台服务：技能与连接器，供会话（agent）与网关共用。 */
export interface Workbench {
  skills: SkillStore;
  connectors: ConnectorStore;
  /** browser.enabled 时提供 */
  browser?: BrowserService | undefined;
  /** 网关运行时挂载（scheduler 依赖会话中心，创建晚于工作台）；终端许愿时不提供 */
  scheduler?: Scheduler | undefined;
}

export async function openWorkbench(loaded: LoadedConfig, feishu = new FeishuClient()): Promise<Workbench> {
  const { paths, config } = loaded;
  return {
    skills: new SkillStore(paths),
    connectors: new ConnectorStore(paths, await SecretBox.open(paths), feishu),
    browser: config.browser.enabled ? new BrowserService(loaded) : undefined,
  };
}
