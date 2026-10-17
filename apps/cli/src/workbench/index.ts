import type { LoadedConfig } from "../config.js";
import { ConnectorStore } from "./connectors.js";
import { FeishuClient } from "./feishu.js";
import { SecretBox } from "./secrets.js";
import { SkillStore } from "./skills.js";

/** 工作台服务：技能与连接器，供会话（agent）与网关共用。 */
export interface Workbench {
  skills: SkillStore;
  connectors: ConnectorStore;
}

export async function openWorkbench({ paths }: LoadedConfig, feishu = new FeishuClient()): Promise<Workbench> {
  return { skills: new SkillStore(paths), connectors: new ConnectorStore(paths, await SecretBox.open(paths), feishu) };
}
