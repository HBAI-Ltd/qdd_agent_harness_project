# 门店手机 · 助手操控

连接器使用 `android-mcp` 与 `android-mcp-rust` 共有的 Streamable HTTP MCP 接口。
两种电脑操作台任选其一运行；`android-screen` 是手机端投屏 App，不是独立 MCP 服务。
画面经手机局域网传给电脑，输入经 ESP32 BLE HID 传给手机。助手使用支持图片与工具调用的模型。

## 准备设备

1. 按 [手机 App 说明](../apps/android-screen/README.zh_CN.md)安装设备投屏 App。
2. 手机、电脑、ESP 控制板连接同一局域网，在手机蓝牙设置中配对控制板。
3. 在手机 App 点击开始投屏，确认系统屏幕共享授权。
4. 启动下述一种电脑操作台，配置手机投屏地址和控制板地址。

连接器默认地址是 `http://127.0.0.1:8792/mcp`，操作台入口为同一地址的 `/`。
Android 独立操作台原默认端口为 `8790`，与天翼视联冲突；接入工作台时将 Android
服务端口设为 `8792`，不改变摄像头或手机投屏端口。

### Node 操作台

按 [android-mcp 说明](../apps/android-mcp/README.zh_CN.md)复制并填写
`apps/android-mcp/.env`，将 `ANDROID_MCP_PORT` 设为 `8792`，然后在仓库根目录执行：

```powershell
.\start-android.cmd
```

### Rust 操作台

按 [原生操作台说明](../apps/android-mcp-rust/README.zh_CN.md)运行设备操作台 EXE，
在设置页将服务端口设为 `8792` 后保存并启动。无需同时启动 Node 版本。

已有操作台使用其他端口或运行在另一台内网电脑时，在网关的 `harness.config.json`
配置实际地址并重启网关，再进行安装：

```json
{
  "mcpServers": {
    "android": { "url": "http://192.168.1.10:8792/mcp" }
  }
}
```

这里的 IP 为示例，请换成电脑实际地址。同名配置仅覆盖连接参数，不会自动安装。

## 安装与使用

在连接器页选择“门店手机 · 助手操控”，选择“Android 设备操作台”，点击“验证并安装”。
验证只握手和列举工具，检查 `android_screenshot` 与 `android_control`，不发送手机输入。
连接成功表示电脑 MCP 服务可用；手机投屏、蓝牙连接和校准状态在“打开设备操作台”查看。

助手工具名称为 `mcp__android__android_*`。只读工具可直接调用，审批模式下输入操作需按普通
对话审批流程确认；输入框下选择“完全访问”可授权本对话的工具调用。连接参数中的
`allowWrite: true` 不会自行取消审批。项目现有的定时任务
无人值守授权策略仍适用。实体急停只能在控制板解除；安装不会跳过手机系统投屏授权。
连接器可改名、重新验证或删除；删除立即撤销工具，重启保留安装选择。

安装 API（使用网关 Bearer 鉴权）：

```http
POST /api/connectors
Content-Type: application/json

{ "type": "phone", "mode": "mcp", "provider": "android", "name": "门店运营手机" }
```

成功返回 HTTP 201，包含 `id: "mcp:android"`、`type: "phone"`、`permission: "confirm"`
以及 `config: { mode: "mcp", provider: "android", consoleUrl: "http://127.0.0.1:8792/" }`。
服务不可用或不是兼容的 Android 服务返回 HTTP 400，不保存安装。

## 离线验证

```powershell
npm run typecheck
npm run build
node --test apps/cli/dist/workbench/connectors-mcp.test.js apps/cli/dist/connector-mcp-gateway.test.js
node --test apps/web/tests/connectors-view.test.mjs
node scripts/test-android-connector.mjs
```

测试覆盖安装、错误服务拒绝、图片工具权限、输入审批、重启恢复、卸载和前端设备入口。
联调脚本启动真实 Node Android MCP 与网关，使用合成图片和模拟 HID 验证图片传递与拒绝输入，
并验证 `/health` 返回 200 与未知路由返回 404，不连接设备或调用模型。
真实投屏、蓝牙输入及模型看图效果需连接设备另行验收。
