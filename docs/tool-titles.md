# 工具展示名称

工具调用记录的中文名称由后端 `apps/cli/src/tool-titles.ts` 维护，前端只显示事件里的 `tool.title`。`tool.name` 继续作为模型调用、权限校验和 API 的技术标识。

- 内置工具名称配置在 `TOOL_TITLES`。
- 天翼视联、海康、萤石摄像头操作配置在 `CAMERA_TITLES`，服务名配置在 `PROVIDER_TITLES`。
- MCP 服务可在 `tools/list` 的工具定义中提供 `title`（优先）或 `annotations.title`；未提供时使用后端配置，再回退到工具说明的首句。
- 展示名称随调用事件持久化，实时调用和历史回放使用同一个名称。旧记录没有 `title` 时仍显示原工具标识。
- `GET /api/tools` 也返回 `title`，网关自身的 MCP `tools/list` 同样提供标题。

例如 `mcp__tysl__tysl_camera_capture_start` 显示“天翼视联：开始采集摄像头画面”，`mcp__tysl__tysl_capture_status` 显示“天翼视联：查询画面采集进度”。

验证：运行 `npm run typecheck`、`npm run build`，然后运行 `node --test apps/cli/dist/tool-titles.test.js` 和 `node --experimental-strip-types --test apps/web/tests/chat-timeline.test.ts`。
