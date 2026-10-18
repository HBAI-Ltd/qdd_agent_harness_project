# 部署与评委复现指南

本文从全新克隆开始，说明如何运行钱多多工作台、接入经营与监控数据，以及按需构建手机与控制板扩展。以下命令使用 **Windows PowerShell**，除特别说明外均在仓库根目录执行。

主工作台可以独立运行。Android App、Rust 设备操作台和 ESP32 控制板是可选扩展，不是启动聊天、任务、技能和定时任务的前置条件。

| 希望复现的内容 | 从哪里开始 | 额外准备 |
| --- | --- | --- |
| 对话、附件经营看板与技能 | [本机启动工作台](#1-本机启动工作台)，再做[虚构样例演示](#用虚构样例完成一次评审演示) | 自己的模型 Key；样例 CSV 已随仓库提供 |
| 真实收银数据或摄像头画面 | [接入收银与摄像头 MCP](#3-接入收银与摄像头-mcp) | 自己的厂商账号、所需客户端参数与设备权限；看图还需视觉模型 |
| 手机投屏与蓝牙键鼠操作 | [硬件源码部署](#硬件源码部署)，依次完成构建、烧录与安装 | AI Passport、Android 手机、数据线与允许设备互访的局域网 |

设备实物照片、型号与物料清单见 [README 设备实物](../README.md#设备实物与复现清单)。

## 1. 本机启动工作台

![软件部署七步流程示意](assets/hackathon/software-deploy-flow.png)

按图中的顺序完成软件部署后，即可用虚构 CSV 演示看板。步骤示意对应 [README 的七步操作](../README.md#快速部署)，真实账号与硬件在后续章节分别接入。

### 准备环境

- Git。
- Node.js **24.15.0**，与根目录 `.node-version` 一致。
- npm **11+**；仓库声明使用 npm **11.12.1**。
- 可访问所配置模型服务的网络与自己的 API Key。
- 如需助手操作浏览器，另需安装本机 Chrome 或 Edge；项目使用 `puppeteer-core`，不会附带完整浏览器。

主工作台的这条启动路径不需要 Android SDK、Rust 或 ESP-IDF。本地厂商 MCP 服务使用 Windows DPAPI 保存凭据，完整本机演示建议使用 Windows 10/11。

### 在空白 Windows 电脑安装基础工具

1. 从 [Git for Windows 官方安装页](https://git-scm.com/install/windows) 下载并安装，选择允许命令行使用 Git 的 PATH 选项。
2. 从 [Node.js 24.15.0 官方版本目录](https://nodejs.org/download/release/v24.15.0/) 安装与自己电脑架构对应的 MSI。普通 Windows x64 电脑选择 `node-v24.15.0-x64.msi`；安装时保留 npm 与 PATH 选项。
3. 安装后重新打开 PowerShell，按仓库 `packageManager` 对齐 npm，再检查工具是否可用：

```powershell
npm install --global npm@11.12.1
git --version
node --version
npm --version
```

成功标志：Git 正常输出版本，Node 为 `v24.15.0`，npm 为 `11.12.1`。npm 的全局安装选项见 [npm 官方说明](https://docs.npmjs.com/cli/v11/commands/npm-install/)。如果 PowerShell 因执行策略拒绝 `npm.ps1`，可将文中 `npm` 命令写成 `npm.cmd`，不需要为此修改整台电脑的执行策略。

### 获取源码与配置

```powershell
git clone https://github.com/HBAI-Ltd/qdd_agent_harness_project.git
cd qdd_agent_harness_project
npm ci
Copy-Item .env.example .env
Copy-Item harness.config.example.json harness.config.json
notepad .env
```

在 `.env` 中填写自己的 `DEEPSEEK_API_KEY`，保存后继续。首次运行可保留其他示例设置：后端地址为 `http://127.0.0.1:3000`，前端为 `http://127.0.0.1:5177`。

已有配置时不要再次复制覆盖 `.env` 或 `harness.config.json`。

### 启动后端

终端一运行：

```powershell
npm run dev
```

等待终端打印 `网关已启动 http://127.0.0.1:3000`。该命令先构建 TypeScript 工程，再启动后端；修改后端源码后需要重新运行，不是自动监听重启。

后端成功启动后，访问 `http://127.0.0.1:3000/health` 应返回：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

```json
{"status":"ok"}
```

### 获取 token 并启动前端

保持终端一运行，在仓库根目录另开终端二：

```powershell
npm run qdd -- token
npm run dev:web
```

复制第一条命令输出的 token，然后打开 **http://127.0.0.1:5177**。在工作台「设置」中确认网关地址为 `http://127.0.0.1:3000`，填写 token 并连接。如果浏览器保存了旧地址，先点击「使用配置地址」。

成功后可查看对话、任务、技能、定时任务与连接器。模型 Key 用于生成回复；网关 token 用于工作台连接后端，两者不能互换。

发送“你好，介绍一下这个工作台能做什么”。收到正常回复才能确认模型服务也可用；`/health` 的成功只代表网关进程正常。

全新工作区的门店数据初始为空，不会自动填充模拟销量、库存或商户报表。要分析自己的经营情况，需要接入已授权的业务账号或提供实际业务附件。

### 用虚构样例完成一次评审演示

这条路径只需要前面的软件环境和可用模型 Key，可以跳过厂商 MCP 安装与硬件部署。

1. 找到仓库内的 [judge-sales.csv](examples/judge-sales.csv)。这是 2026-10-17 的 **6 笔虚构销售记录**，用于评委重复操作和核对结果。
2. 在工作台新建对话，点击添加文件或拖入 CSV，发送：

   > 读取这份附件，为 2026-10-17 的虚构销售样例生成经营看板。页面根据附件明细计算销售额、成本额、毛利和毛利率，支持按商品分类筛选，并展示明细和计算口径。标注“虚构样例 / 附件快照，非实时门店数据”。

3. 回答助手的需求确认问题。任务完成后，到「任务」打开生成页面，按下表核对数据，再切换分类确认筛选有效。

| 筛选范围 | 销售额（元） | 成本额（元） | 毛利（元） | 毛利率 |
| --- | --- | --- | --- | --- |
| 全部 | 800 | 500 | 300 | 37.5% |
| 生鲜 | 300 | 210 | 90 | 30% |
| 饮品 | 200 | 80 | 120 | 60% |
| 日用品 | 300 | 210 | 90 | 30% |

毛利 = 销售额 − 成本额；毛利率 = 汇总毛利 ÷ 汇总销售额，不能对各行毛利率直接求平均。成功标志是页面能够实际打开、筛选有响应、页面计算结果与附件一致。模型生成的具体布局可能不同，表中的数值用于现场核对。

需要演示复用时，再要求“把刚确认的分析流程保存为技能”，随后到「技能」查看。真实经营演示应另用自己的业务附件或已授权数据源，并保留数据来源标注。

## 2. 配置文件、模型与 token

| 位置 | 用途 |
| --- | --- |
| `.env` | 模型 API Key、后端监听地址、可选固定网关 token |
| `harness.config.json` | 模型列表、CORS、浏览器、数据刷新与 MCP 连接设置 |
| `workspace/` | 会话、任务页面、技能、定时任务、登记数据和连接器选择等运行数据 |
| `workspace/.gateway-token` | 未设置固定 token 时自动生成的网关 token |
| `workspace/.secret-key` | 未指定加密密钥时自动生成的工作台连接器凭据密钥 |
| `mcp/.local/` | 厂商 MCP 的本机凭据、访问密钥与运行状态 |

`.env`、运行工作区和厂商本地状态不应提交到 Git。迁移或备份工作台时，应保留完整工作区及其配套密钥；厂商 DPAPI 凭据与 Windows 用户环境绑定，换机器或用户后按各平台流程重新配置和登录。

### 模型配置

示例默认使用 `deepseek-chat`，只需在 `.env` 中填写：

```dotenv
DEEPSEEK_API_KEY=填写自己的模型服务密钥
```

模型目录来自 `harness.config.json` 的 `llm.models`。若使用其他 OpenAI 兼容服务，在其中增加或修改对应模型，并通过 `apiKeyEnv` 引用 `.env` 中的环境变量。例如以下是需要替换实际服务地址和模型名称的配置片段：

```json
{
  "llm": {
    "models": [
      {
        "id": "my-model",
        "label": "我的模型",
        "model": "填写服务商实际模型名称",
        "baseUrl": "https://模型服务地址/v1",
        "apiKeyEnv": "MY_MODEL_API_KEY",
        "thinking": "disabled"
      }
    ]
  }
}
```

并在 `.env` 中增加 `MY_MODEL_API_KEY`。保留原配置的其他部分，不要用上述片段覆盖完整文件。`baseUrl` 应为服务商的 API 基地址，程序会追加 `/chat/completions`。

显式填写 `model` 的模型列表以第一项为默认；使用示例列表时，仅更改 `DEEPSEEK_MODEL` 或 `llm.model` 不会替换该列表的默认项。示例中的通义千问项使用 `DASHSCOPE_API_KEY`，选择前需自行添加对应密钥。模型名称、工具调用、思考参数与图片输入能力以实际服务支持为准。

修改 `.env` 或后端配置后重启后端。前端输入框中的模型选择作用于后续发送，不能代替服务端 API Key 配置。

### 网关 token

- `QDD_GATEWAY_TOKEN` 留空时，首次启动或执行 `npm run qdd -- token` 会自动生成并保存 token。
- 如自行设置 `QDD_GATEWAY_TOKEN`，至少需要 16 个字符。
- 使用 `npm run qdd -- token` 查看当前实际生效的值。
- token 保存在当前浏览器会话中；新浏览器会话可能需要重新填写。
- 开发模式可从 `.env` 预填固定 token；生产构建不会把 token 注入前端资源。

### 地址与配置优先级

后端 `.env` 中的 `HOST`、`PORT` 覆盖 `harness.config.json` 的 `gateway.host`、`gateway.port`。复制仓库示例后端口是 **3000**；未提供任何地址配置时，源码默认端口为 **5173**。

前端默认网关地址按 `API_PROXY_TARGET` → `HOST`/`PORT` → `gateway.host`/`gateway.port` 解析。`API_PROXY_TARGET` 只修改前端连接目标，不会启动后端或改变其监听地址。前端默认地址在启动或构建时读取，修改后需重启 Vite，或重新构建已部署的前端。

## 3. 接入收银与摄像头 MCP

这里的厂商 MCP 与 Android 设备 MCP 是不同的服务。主项目默认 `mcpServers` 为 `{}`，不会自动安装任何厂商平台。

### 第一步：安装并启动本地服务

在 Windows 的仓库根目录运行：

```powershell
npm run mcp:setup
npm run mcp:build
npm run mcp:start
```

根目录的 `npm ci` 不会替代 `mcp:setup`。后者按独立锁文件安装海康、萤石前端及 FFmpeg/Sharp 等工具；首次需要下载依赖和 FFmpeg。`mcp:start` 启动全部四个本地服务，不自动打开网页，已运行的服务会复用。

| 服务 | 登录控制台 | HTTP MCP |
| --- | --- | --- |
| 海康互联 | `http://127.0.0.1:8787/` | `http://127.0.0.1:8787/mcp` |
| 收钱吧 | `http://127.0.0.1:8788/` | `http://127.0.0.1:8788/mcp` |
| 天翼视联 | `http://127.0.0.1:8790/` | `http://127.0.0.1:8790/mcp` |
| 萤石 | `http://127.0.0.1:8791/` | `http://127.0.0.1:8791/mcp` |

也可以按需使用 `mcp/Start-HAIK.ps1`、`Start-Shouqianba.ps1`、`Start-TYSL.ps1`、`Start-EZVIZ.ps1`。例如只启动天翼：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File mcp/Start-TYSL.ps1
```

停止全部厂商服务：

```powershell
npm run mcp:stop
```

海康与萤石应使用相应停止脚本完成云台停止和媒体清理。停止服务保留本机已保存的账号状态。

### 第二步：在工作台安装所选平台

1. 确认工作台已连接 QDD 网关。
2. 打开「连接器」，选择「收银系统」或「门店摄像头」。
3. 选择实际平台，点击「验证并安装」。
4. 安装成功后，相应工具立即加载；删除连接器后撤销工具，重启后保留安装选择。

**服务启动、工作台安装和云账号登录是三个独立步骤。**「已连接」表示本地 MCP 服务与工具可用，不表示已经登录商户或摄像头云账号。先启动服务不会自动安装连接器。

收钱吧仅提供只读经营数据，不提供收款、退款、充值或数据修改操作。摄像头云台、截图与采集等操作遵循工作台授权流程。

### 第三步：登录自己的官方账号

安装后，从连接器卡片点击「打开登录控制台」，在服务电脑上完成对应平台的登录。

| 平台 | 登录前提与操作 |
| --- | --- |
| 海康互联 | 先配置自己合法取得的 App 客户端参数并初始化，再在控制台完成人机验证和短信登录。未配置参数时，服务可以启动，但不能完成短信登录或取视频。 |
| 天翼视联 | 从控制台打开官方登录页，使用自己的账号登录，将官方跳转后的完整返回地址粘贴回控制台。 |
| 萤石 | 在控制台填写自己的官方开放平台 AppKey/AppSecret；实际功能受账号和设备能力限制。加密视频当前不支持，不会自动关闭设备加密。 |
| 收钱吧 | 在控制台完成人机验证、短信登录及商户身份选择。可使用网页登录；如需原生 App 鉴权，先配置自己的合法客户端参数并初始化。 |

海康初始化命令如下。复制后必须先编辑 JSON，填写自己的实际参数，再执行初始化：

```powershell
New-Item -ItemType Directory -Force mcp/.local | Out-Null
Copy-Item mcp/haik-client-config.example.json mcp/.local/haik-client-config.json
notepad mcp/.local/haik-client-config.json
node mcp/scripts/initialize-haik.mjs
```

收钱吧原生客户端配置为可选项：

```powershell
New-Item -ItemType Directory -Force mcp/.local | Out-Null
Copy-Item mcp/shouqianba-client-config.example.json mcp/.local/shouqianba-client-config.json
notepad mcp/.local/shouqianba-client-config.json
node mcp/scripts/initialize-shouqianba.mjs
```

完成初始化后先停止、再启动对应服务，然后登录账号。已有配置和凭据时按模块文档操作，不要重复覆盖本机 JSON。

### MCP 鉴权与自定义地址

收钱吧的 HTTP MCP 使用独立 Bearer 密钥。本地服务生成后，QDD 默认读取 `mcp/.local/shouqianba/mcp-key`，无需复制到工作台表单或 `.env`。

`harness.config.json` 的 `mcpServers` 可配置自定义 Streamable HTTP 服务。四个内置厂商的同名配置用于覆盖地址和鉴权，实际启用仍取决于工作台安装选择。`bearerTokenFile` 与 `bearerTokenEnv` 只能配置其中一个；相对文件路径以仓库根目录为基准。QDD 后端不接受直接复制通用 MCP 客户端的 stdio 配置。

### 摄像头视频播放

`mediaOrigins` 默认是空数组。生成的任务页面要播放摄像头媒体，需在 `harness.config.json` 中加入实际媒体的**精确 HTTPS 来源**，也允许明确的本机 HTTP 回环来源，例如 `http://127.0.0.1:8790`。下列域名仅为占位示例，使用时替换成真实媒体来源：

```json
{
  "mediaOrigins": ["https://video.example.com", "http://127.0.0.1:8790"]
}
```

来源只包含协议、主机和端口，不包含路径或查询参数；不要把带签名的完整视频 URL 放入 `mediaOrigins`。修改后重新加载任务页面。FLV/HLS 可使用网关 `/assets/camera-player/` 下的同源播放器资源，媒体来源配置不等同于脚本白名单。RTSP/RTMP 需由已有设备或服务转为浏览器支持的媒体流，项目不内置通用转流服务。

允许媒体来源不会绕过媒体服务的 CORS、签名有效期、设备权限或浏览器限制。跨源取流仍需媒体服务允许相应请求；HTTPS 前端还需满足浏览器的混合内容约束。回环地址指向当前浏览器所在设备，不能据此假定其他电脑可播放服务电脑上的本地视频，也不能保证所有厂商返回的媒体格式都可直接播放。

## 4. 局域网与生产资源部署

### 局域网访问工作台

本机的 `127.0.0.1` 指向当前访问设备自己。若另一台电脑或手机访问工作台，前端和网关都需要使用它能访问的地址。

例如服务电脑地址为 `192.168.1.20`，在 `.env` 中设置：

```dotenv
HOST=0.0.0.0
PORT=3000
API_PROXY_TARGET=http://192.168.1.20:3000
```

同时在 `harness.config.json` 的 `gateway.corsOrigins` 中加入实际前端来源：

```json
"corsOrigins": [
  "http://127.0.0.1:5177",
  "http://192.168.1.20:5177"
]
```

将示例 IP 替换成服务电脑的实际地址，然后重启后端与前端。远端设备打开 `http://192.168.1.20:5177`，在设置中确认网关为 `http://192.168.1.20:3000`，并填入 token。Windows 防火墙需允许相应端口的预期网络访问。

`localhost`、`127.0.0.1`、局域网 IP 以及不同端口都是不同来源，CORS 必须匹配实际访问来源。`0.0.0.0` 是监听地址，不能填写为浏览器访问地址；前端解析监听通配地址时会回退本机地址，因此仅设置 `HOST=0.0.0.0` 不足以让远端设备自动连接。

### 使用生产构建

先确定浏览器实际可访问的网关地址，再构建：

```powershell
npm run build
npm run build:web
npm start
```

- `npm start` 运行已编译的网关，不会自动构建，也不托管工作台主界面。
- 将完整 `apps/web/dist/` 发布到独立静态服务，包括其中的 `assets/`。
- 前端使用 history 路由，静态服务需将非文件页面路由回退到 `index.html`。
- 网关使用独立监听或反向代理，保留 API、SDK、任务页面、媒体资源和 SSE 长连接。
- 前端公开网关地址在构建时注入；更换地址后重新构建，或在设置中切换网关。
- `gateway.corsOrigins` 填实际前端站点来源；HTTPS 前端也应连接浏览器可访问的 HTTPS 网关。
- 生产构建不注入网关 token，使用者需通过设置连接。

本机查看构建资源可另开终端运行：

```powershell
npm run preview --workspace @qdd/web
```

默认仍为 `http://127.0.0.1:5177`；运行中的开发服务需先释放该端口。该命令用于查看构建资源，长期托管还需自行配置静态服务、进程管理与网络入口。

### 厂商 MCP 的本机边界

厂商 MCP 默认监听本机并使用本机凭据。推荐与 QDD 网关运行在同一台 Windows 电脑，云账号登录先在该电脑的本地控制台完成。工作台安装后的控制台链接默认是 `127.0.0.1`，从另一台设备点击不会自动访问服务电脑。

工作台可以通过局域网访问，不代表厂商登录控制台、摄像头媒体地址和全部设备功能都能远程使用。视频播放还取决于实际返回地址、设备权限、浏览器支持及 `mediaOrigins` 配置；部署时需按真实访问链路配置，不能只暴露前端端口。

## 5. 可选手机与控制板扩展

手机与控制板扩展用于投屏和真实键鼠控制，与门店数据 MCP、主工作台网关分别运行。图像在局域网传输，输入经电脑 → ESP32 → BLE HID → 手机；USB 是电脑连接控制板的可选方式，手机不依赖 USB/ADB 才能投屏。

### 硬件源码部署

准备 AI Passport 规格的 **ESP32-C3、8 MB Flash、无 PSRAM** 控制板、一根支持数据传输的 USB 线、Android 8+ 手机、Windows x64 电脑，以及允许设备互访的 2.4 GHz Wi-Fi。当前手机验收目标为 Android 13；其他系统版本和手机的实际表现需分别确认。

以下流程从源码生成 APK、电脑程序和固件，再首次烧录控制板。仓库没有随源码提交这些二进制文件，也没有在本文提供已发布的预编译下载地址；控制板自己的下载页要等固件烧好并联网后才能访问。已经拿到与本源码匹配的交付包时，可跳过编译工具安装，直接核对产物与说明后进入烧录或安装步骤。

首次下载 Android SDK、Cargo 依赖和 ESP-IDF 组件需要联网。设备安装包生成并写入控制板后，板上安装页可在局域网分发 APK 和电脑 ZIP；主工作台调用模型及厂商云服务仍取决于各自网络。

### 第一步：安装 Android JDK 与 SDK

1. 从 [Adoptium](https://adoptium.net/installation/windows) 安装 Windows x64 的 **JDK 17**（项目接受 17+），记录实际 JDK 目录。必须安装 JDK，单独 JRE 不包含 `javac`、`jar` 和 `keytool`。
2. 安装 [Android Studio](https://developer.android.com/studio)，在欢迎页 `More Actions → SDK Manager` 中记录 `Android SDK Location`，再安装下列组件。已有独立 Android SDK 时可复用，不必使用 Studio 编辑项目。
3. 在 `SDK Platforms` 中选择 **Android 14 / API 34**；在 `SDK Tools` 勾选 `Show Package Details`，安装 **Android SDK Build-Tools 36.0.0** 和 **Android SDK Platform-Tools**。如需用命令行管理 SDK，再安装 `Android SDK Command-line Tools`，其使用说明见 [sdkmanager](https://developer.android.com/tools/sdkmanager)。

在仓库根目录的 PowerShell 中，将下列两个路径换成自己安装的实际目录：

```powershell
$env:JAVA_HOME = "C:/Java/jdk-17"
$env:ANDROID_HOME = "C:/Android/Sdk"
$env:PATH = "$env:JAVA_HOME/bin;$env:ANDROID_HOME/platform-tools;$env:PATH"

& "$env:JAVA_HOME/bin/javac.exe" -version
Test-Path "$env:ANDROID_HOME/platforms/android-34/android.jar"
Test-Path "$env:ANDROID_HOME/build-tools/36.0.0/aapt2.exe"
Test-Path "$env:ANDROID_HOME/build-tools/36.0.0/apksigner.bat"
```

成功标志：`javac` 输出 17 或更高版本，三个路径检查均为 `True`。目录中还应有 `d8.bat`、`zipalign.exe` 和 `core-lambda-stubs.jar`；构建脚本会逐项检查。

将路径保存为本项目忽略的本机配置，之后换终端也能直接构建 Android App：

```powershell
New-Item -ItemType Directory -Force apps/android-screen/.local | Out-Null
@{ sdkRoot = $env:ANDROID_HOME; javaHome = $env:JAVA_HOME } |
  ConvertTo-Json |
  Set-Content -LiteralPath apps/android-screen/.local/toolchain.json -Encoding utf8
```

以上 `Set-Content` 用于首次配置；已有 `toolchain.json` 时直接编辑它，保留自己的目录。构建脚本不使用 Gradle。也可以不保存 JSON，改为在每个构建终端设置有效的 `ANDROID_HOME` / `ANDROID_SDK_ROOT` 和 `JAVA_HOME`。

### 第二步：安装 Rust、MSVC 与独立 USB 编译器

电脑操作台使用 Rust 的 Windows MSVC 目标：

1. 从 [Microsoft C++ Build Tools](https://learn.microsoft.com/en-us/cpp/overview/acquire-msvc) 安装 **使用 C++ 的桌面开发 / Desktop development with C++**，包含 x64/x86 MSVC 工具和 Windows SDK。
2. 从 [Rust 官网](https://rust-lang.org/tools/install/) 下载 Windows x64 的 `rustup-init.exe` 并安装。项目要求 Rust **1.87+**；安装器配置 PATH 后重新打开 PowerShell。

在构建终端执行：

```powershell
rustup toolchain install stable-x86_64-pc-windows-msvc
$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"
rustc --version
rustc -vV
cargo --version
```

成功标志：`rustc` 版本不低于 1.87，`rustc -vV` 的 `host` 为 `x86_64-pc-windows-msvc`，`cargo` 可运行。若随后报 `link.exe not found`，先核对 C++ workload 和 Windows SDK，再从安装器提供的 Developer PowerShell 运行构建；不要用 GNU Rust 目标替代本项目的 Windows MSVC 打包路径。前述 Node 24/npm 11 也必须可用，Rust 构建会调用已锁定的 esbuild 处理资源。

**USB 下载辅助程序使用另一套 x64 MinGW-w64 GCC。** 可从 [MinGW-w64 工具链列表](https://www.mingw-w64.org/downloads/#w64devkit) 进入 w64devkit 发布页，选择 x64 包，解压到仓库外没有空格的目录，例如 `C:/Toolchains/w64devkit`。MSVC 和 ESP 的 RISC-V 编译器都不能代替这个宿主 GCC。

在运行 USB 资源生成命令的终端设置实际路径：

```powershell
$env:QDD_USB_CC = "C:/Toolchains/w64devkit/bin/gcc.exe"
& $env:QDD_USB_CC --version
& $env:QDD_USB_CC -dumpmachine
```

成功标志：编译器存在，目标为 `x86_64-w64-mingw32`。这套 GCC 也可填写到 ESP 的 `ccPath`，供宿主检查使用。生成的最终设备操作台和 USB 下载器在使用者电脑上均不要求安装这些编译器。

### 第三步：安装 ESP-IDF 5.5.3 并保存本机路径

按 [ESP-IDF 5.5.3 Windows 官方安装说明](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/get-started/windows-setup.html) 下载乐鑫 Tools Installer，**选择 v5.5.3 和 ESP32-C3 支持**，安装 Python、CMake、Ninja 和 RISC-V 工具链。选用仓库外、没有空格或中文的短路径，例如 `C:/Espressif`。同时保留 Git for Windows 的 Git Bash；本项目的门禁通过原生 Windows 工具构建，不使用 WSL Bash。

打开安装器创建的 **ESP-IDF 5.5.3 PowerShell**，回到当前仓库根目录。先查看该终端的实际安装路径：

```powershell
idf.py --version
$env:IDF_PATH
$env:IDF_TOOLS_PATH
(Get-Command python.exe -CommandType Application).Source
```

`idf.py --version` 必须为 `ESP-IDF v5.5.3`。下面从已激活终端记录真实 IDF/Python 路径；Git Bash 和 GCC 两项请按自己的安装位置修改：

```powershell
$qddGitBash = "C:/Program Files/Git/bin/bash.exe"
$qddHostCc = "C:/Toolchains/w64devkit/bin/gcc.exe"

Test-Path -LiteralPath $qddGitBash
Test-Path -LiteralPath $qddHostCc

$qddIdfSettings = [ordered]@{
  idfPath = $env:IDF_PATH
  toolsPath = $env:IDF_TOOLS_PATH
  pythonPath = (Get-Command python.exe -CommandType Application).Source
  bashPath = $qddGitBash
  ccPath = $qddHostCc
}
$qddIdfSettings | ConvertTo-Json |
  Set-Content -LiteralPath apps/esp/.idf.local.json -Encoding utf8

npm run check:esp
```

两项路径检查应为 `True`。已有 `.idf.local.json` 时编辑已有文件，不重复覆盖。`pythonPath` 是用于启动激活脚本的本机 Python 路径，wrapper 会再选取 IDF 激活后的虚拟环境；不是要求把示例中的某个 Python 小版本照搬到自己的电脑。

成功标志：`check:esp` 显示正确的 IDF 版本、Python、CMake、Ninja、RISC-V 编译器，最后打印 **ESP-IDF environment: PASS**。`IDF_PATH`、`IDF_TOOLS_PATH` 和 `CC` 环境变量优先于相应 JSON 字段；旧终端已设置其他版本时应先核对它们。npm wrapper 在子 PowerShell 中激活环境，不会为之后的普通终端自动激活 IDF。

### 第四步：依次生成手机、电脑及板上资源

以下阶段均在仓库根目录执行。**先完成当前阶段并看到成功标志，再进入下一阶段。** 当前 ESP CMake 固定读取 `v56`、`v52`、`v55` 目录；这些是本次资源的输出位置，不是要求下载历史版本。普通安装只用局域网页，编译固件时仍需准备全部资源。

#### 4.1 安装项目依赖

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，先处理当前报错，不继续构建。" }
```

**成功标志：** 安装正常退出，后续工具能从根 workspace 找到 esbuild 等依赖。**失败停点：** 核对当前目录、Node 24.15.0、npm 11+ 和依赖下载网络；此时不要进入 APK 或 Rust 构建。

#### 4.2 构建手机 App

```powershell
npm run build:android:screen
if ($LASTEXITCODE -ne 0) { throw "APK 构建失败，先核对 JDK/SDK 路径和版本。" }
```

**成功标志：** APK 签名验证通过，终端打印 `APK:` 和 `SHA256:`，生成：

- `apps/android-screen/build/qdd-android-screen-debug.apk`。
- 同目录 `manifest.json`，记录 `cn.qdd.screenbridge`、API 34、签名方式和 APK 哈希。

**失败停点：** 返回第一步检查 `toolchain.json`、JDK、Platform 34 和 Build Tools 36.0.0；不要用失败运行之前留下的 APK 继续编译固件。保留 `apps/android-screen/.local/debug.keystore`，以后覆盖安装需要相同签名。

#### 4.3 构建 Windows 操作台

```powershell
$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"
$env:QDD_RUST_OUTPUT_DIR = Join-Path (Get-Location) "apps/android-mcp-rust/build/windows/v56"
npm run build:android:rust
if ($LASTEXITCODE -ne 0) { throw "Windows 操作台构建失败，先处理 Cargo/MSVC 报错。" }
Remove-Item Env:QDD_RUST_OUTPUT_DIR
```

**成功标志：** release 构建成功，`apps/android-mcp-rust/build/windows/v56/` 中同时出现 `设备操作台.exe`、`设备操作台.zip` 和 `manifest.json`；清单记录 EXE/ZIP 大小、SHA-256 与构建身份。

**失败停点：** `link.exe` 或 Windows SDK 错误回到第二步；找不到 Node/esbuild 回到 4.1；依赖下载失败先处理网络。单独构建时默认的 `build/windows/` 不满足当前 ESP 对 `build/windows/v56/` 的要求。若旧 EXE 正在占用这个目录，不要直接停止未知服务，先确认当前操作台使用者和版本。

#### 4.4 准备两个兼容 USB 资源

先生成 Windows USB 下载器；`QDD_USB_CC` 换成第二步核对过的实际 x64 GCC 路径：

```powershell
$env:QDD_USB_CC = "C:/Toolchains/w64devkit/bin/gcc.exe"
node apps/android-mcp-rust/tools/usb-driver/build.mjs
if ($LASTEXITCODE -ne 0) { throw "USB 下载器构建失败，先处理 x64 GCC 或自检报错。" }
```

**成功标志：** `apps/android-mcp-rust/build/usb-driver/v52/` 中生成 `设备USB下载器.exe` 与 `manifest.json`，脚本的协议、传输、设备标识宿主检查和原生自检完成。**失败停点：** 检查 `QDD_USB_CC` 指向 x64 MinGW-w64 GCC；MSVC 和 RISC-V GCC 不能代替它。

再生成独立的浏览器 USB 接收页：

```powershell
node apps/android-mcp-rust/tools/prepare-usb-receiver.mjs
if ($LASTEXITCODE -ne 0) { throw "USB 接收页生成失败，先处理资源或 esbuild 报错。" }
```

**成功标志：** `apps/android-mcp-rust/build/usb-browser/v55/` 中出现 `设备USB接收.html` 与 `manifest.json`。**失败停点：** 检查 4.1 的依赖安装与脚本报告的资源问题，不要手工伪造 manifest。这两个生成工具不要求连接控制板，也不会发送实际设备输入。

#### 4.5 构建并验证控制板固件

```powershell
npm run check:esp
if ($LASTEXITCODE -ne 0) { throw "ESP-IDF 环境未通过，返回第三步检查本机配置。" }
npm run build:esp
if ($LASTEXITCODE -ne 0) { throw "固件构建未通过，禁止使用残留旧镜像进入烧录。" }
```

**成功标志：** 终端显示 `ESP-IDF environment: PASS`、`Merged firmware: PASS`、`Firmware build: PASS`，生成：

- `apps/esp/build/FoloToy-AI-Passport-full.bin`：下一步首次烧录使用的合并镜像。
- `apps/esp/build/firmware/<full-bin-sha256>/`：匹配的 `manifest.json`、ELF/MAP 及组件镜像。

**失败停点：** 缺 APK 或 APK 哈希不符回到 4.2；缺 `v56` / `v52` / `v55` 资源或清单不符回到对应阶段；IDF/编译器错误回到第三步。不要改目录名或绕过哈希检查来继续。

ESP 构建会核对 APK 不超过 1 MiB，并核对下载资源的清单与内容，不会自动获取缺失的项目产物。以上阶段都不会安装 App 或烧录设备；完整宿主与固件检查另有 `npm run validate:esp`。APK 为本机开发签名；手机已有不同签名的同包名 App 时，先确认需要保留的手机端数据，再决定是否卸载旧版。

### 第五步：首次烧录控制板

这是实际写入硬件的步骤，应由设备持有人确认目标板及串口后执行。使用前一步成功生成的 **full.bin**；不要把单独 app 镜像写到 `0x0`。

1. 用数据 USB 线连接目标 AI Passport。在设备管理器的「端口（COM 和 LPT）」确认它新增的实际 COM 口；也可使用下面的只读枚举。
2. 关闭占用该串口的 monitor、WebSerial 页面及设备操作台。不要终止未知进程。
3. 打开安装器创建的 **ESP-IDF 5.5.3 PowerShell**，回到仓库根目录。`npm run check:esp` 的子进程激活不会替代这个烧录终端的环境。

```powershell
Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name
idf.py --version
python -m esptool version

$qddPort = "COMx" # 必须替换为自己确认的真实端口，例如 COM7
$qddFirmware = (Resolve-Path apps/esp/build/FoloToy-AI-Passport-full.bin).Path
Get-FileHash -LiteralPath $qddFirmware -Algorithm SHA256
```

先核对固件哈希与本轮 `build/firmware/<sha256>/` 归档一致，再执行首次完整写入。IDF 5.5 的[官方依赖约束](https://dl.espressif.com/dl/esp-idf/espidf.constraints.v5.5.txt) 使用 esptool 4.12 系列；这里使用它支持的 `write_flash`（下划线），不要直接照抄新版 esptool 文档中的 `write-flash`：

```powershell
python -m esptool --chip esp32c3 --port $qddPort --baud 460800 write_flash 0x0 $qddFirmware
```

成功标志：识别到 **ESP32-C3**，写入完成，出现 **Hash of data verified**，程序正常退出；设备重启后显示本应用的按键/连接引导。连接失败时先核对实际端口、数据线、供电及板卡的下载模式说明，不要改用另一个未确认串口。

完整合并镜像适用于空白设备或明确要完整刷新的场景。它可能覆盖 NVS/PHY 中的 Wi-Fi 和 BLE 配对等数据。已经配置好的设备若要保留数据，先核对当前分区兼容性，再按 [固件布局与数据保留说明](../apps/esp/docs/development/engineering/firmware-layout.zh_CN.md) 采用相应分段烧录；本流程不执行全片擦除。烧录成功只证明字节写入，下一步才检查真实安装与控制。

### 第六步：安装、配网、配对并完成演示

先完成第五步烧录，再按下面顺序操作。板上安装页只有在控制板成功联网后才能打开。

![硬件安装流程示意图](assets/hackathon/hardware-install-flow.png)

*安装顺序示意图；下面的界面图用于识别按钮和页面，不代表已经在你的设备上安装成功。*

#### 6.1 让控制板连接 Wi-Fi

**【操作设备】** ESP32 控制板。

**【操作】** 首次启动显示「按键指南」时，短按确认键选择「开始连接」。进入引导第 1 页「连接无线网」后，短按确认执行「选择无线网」，等待扫描结束，再用上下键选择自己的 **2.4 GHz Wi-Fi** 并确认。已有主界面的设备可走「设置 → 连接无线网」。

有密码的网络会打开屏幕键盘：上下键选行、确认后选字、再次确认输入；密码完成后 **长按确认键**，在菜单中选择「连接网络」并确认。开放网络直接进入「连接网络」菜单。引导中上下键切换前后步骤，短按确认执行当前页动作；长按确认可打开设备设置。

**【成功标志】** 显示网络已连接；切换到「下载电脑软件」或「安装手机软件」页，可以读到真实安装地址 `http://<控制板IP>:3334/` 或二维码。记下地址，后面手机和电脑都访问它。

![控制板连接助手六个页面](assets/hackathon/board-onboarding-v55.png)

*v55 控制板界面渲染：LVGL 主机渲染合图，非实物屏幕照片。图中的 IP、二维码、设备名和电量为示例，以实物为准。*

找不到网络或连接失败时停在此步，核对 2.4 GHz 网络与密码，不要跳到手机/电脑下载步骤。扫描尚未结束时确认键会离开扫描页，应等网络列表出现后再选网。

#### 6.2 在手机上下载 APK

**【操作设备】** Android 手机浏览器。

**【操作】** 让手机加入控制板所在局域网。用浏览器打开 6.1 记下的安装地址，或扫描板上二维码；页面「1. 连接无线网」点「下一步」，到「2. 下载对应安装包」点 **「下载 Android 手机版」**。

**【成功标志】** 浏览器下载列表里出现完整的 `设备投屏.apk`。确认下载完成，再点安装页的「已下载，下一步」。这个按钮只切换引导页，不会检查手机是否真的完成下载或安装。

页面打不开时，先在浏览器手动输入板上地址；若仍打不开，核对手机/控制板是否同一局域网、是否启用了访客网络隔离。不要把电脑操作台地址填到这里。

#### 6.3 安装并打开「设备投屏」

**【操作设备】** Android 手机。

**【操作】** 从浏览器下载列表打开 `设备投屏.apk`，按 Android 提示允许当前浏览器或文件管理器安装应用。安装完成后回到安装页「3. 安装并打开」，点 **「打开设备投屏」**；它会把当前控制板地址交给 App。

**【成功标志】** App 显示「设备投屏」主界面，可看到「屏幕共享」「内网连接地址」「设备控制器」卡片。「内网连接地址」显示手机自己的地址，通常为 `http://<手机IP>:8791`，与控制板的 `:3334` 地址不同。

![手机安装及打开 App 的页面](assets/hackathon/install-mobile-v55.png)

*v55 生产页面夹具：手机尺寸的安装/打开 App 页面，非真机安装完成记录；示例 IP 以实物为准。*

若安装提示签名冲突，停在此步，先确认旧 App 的来源和需要保留的数据；本机重新构建的开发签名不一定能覆盖原安装包。App 若找不到控制板，重新扫描目标板二维码并从它的安装页打开 App。

#### 6.4 配对手机蓝牙

**【操作设备】** Android 手机和控制板。

**【操作】** 在 App 的「设备控制器」卡片点 **「连接 <设备蓝牙名>」**（未连接时显示实际目标名），进入手机系统蓝牙设置，选择与控制板屏幕一致的名称，按手机提示确认配对。当前引导提示无需输入数字。

手机搜不到设备时，在控制板引导「连接手机蓝牙」页短按确认「开始配对」；也可长按确认进入设置，选择「手机蓝牙配对 → 开启手机配对」。已有配对时先使用原配对连接，不要为了重复操作主动重置设备。

**【成功标志】** 手机系统显示已连接，App 引导显示「蓝牙已连接」，按钮变为「查看蓝牙连接」。控制板如果还显示「正在准备键盘鼠标」，等待就绪后再进入下一步；仅点击配对确认不算就绪。

#### 6.5 取得系统投屏授权

**【操作设备】** Android 手机。

**【操作】** 回到 App，在「屏幕共享」卡片点 **「开始投屏」**，本人确认 Android 系统屏幕共享对话框。Android 14+ 按 App 请求共享整个屏幕。通知提示与录屏授权分别处理，不要把通知许可当作屏幕共享完成。

**【成功标志】** App 从「等待系统授权 / 正在启动投屏」转为「正在分享手机画面」，「停止投屏」可用。停止后再次开始仍需本人重新确认系统授权。

没有共享授权或一直启动失败时停在手机端处理，不要反复操作电脑键鼠。保持 App 与控制板连接，先让手机画面服务真正开始。

#### 6.6 在 Windows 下载并解压操作台

**【操作设备】** Windows 电脑浏览器。

**【操作】** 电脑加入同一局域网，打开 6.1 的控制板安装地址。在「1. 连接无线网」点「下一步」，在「2. 下载对应安装包」点 **「下载 Windows 电脑版」**。浏览器下载完成后，右键 `设备操作台.zip` 选择「全部解压缩」。

**【成功标志】** 解压后的文件夹内有 `设备操作台.exe`。不要直接在 ZIP 压缩文件预览里启动它。

![Windows 下载操作台的页面](assets/hackathon/install-desktop-v55.png)

*v55 生产页面夹具：Edge 隔离夹具中的桌面下载安装页，非真实控制板下载完成记录；示例 IP 以实物为准。*

下载失败时保留在此步：检查浏览器下载列表，并使用页面「下载遇到问题」中的提示。也可直接使用 4.3 已生成的对应 ZIP，不必重新编译全部固件。

#### 6.7 使用 8792 端口启动操作台

**【操作设备】** Windows 电脑。

**【操作】** 在刚解压的目录打开 PowerShell，执行：

```powershell
.\设备操作台.exe --port 8792
```

选择 `8792` 是为了避开同机天翼服务默认使用的 `8790`。不要只双击 EXE 后再处理这个已知冲突。

**【成功标志】** 浏览器打开「设备操作台」连接设置；已有有效配置时直接打开操作台。最终使用者电脑无需安装 Node、Rust 或编译器。

若 `8792` 也被其他应用占用，选择实际空闲端口，并同步后续配置和 MCP 地址；不要直接终止未知监听进程。

#### 6.8 查找设备、核对配置并保存

**【操作设备】** Windows 设备操作台设置页。

**【操作】** 点 **「自动查找手机与设备控制器」**。只找到一块板时检查自动填入的信息；找到多块时，从「请选择找到的设备控制器」中选中目标。核对以下字段：

- 「手机投屏地址」：6.3 的手机地址，例如 `http://<手机IP>:8791`。
- 「设备控制器怎样连接电脑」：通常选择「Wi-Fi 内网连接」。
- 「设备控制器内网 IP」：6.1 的控制板 IP。
- 「设备控制器端口」：`3333`，不是下载页端口 `3334`。
- 「高级设置 → 操作台 / MCP 端口」：`8792`。

确认后点 **「保存并打开操作台」**。自动查找没有结果时可以手填上述真实地址；不要选择示例图中的 IP。

**【成功标志】** 操作台显示持续更新的手机画面，并显示电脑的实际操作台地址与 `/mcp` 地址。`http://127.0.0.1:8792/health` 返回 `status: "ok"` 只说明电脑服务启动，不代替手机画面或蓝牙就绪。

如明确使用 USB 连接电脑与控制板，在「设备控制器怎样连接电脑」选择「USB 数据线」，并在「设备控制器 USB 串口」选择真实 COM 口；对应配置为 `ESP_HOST` 留空、`ESP_PORT` 选择该串口。手机画面仍走局域网。此时先退出占用串口的烧录/monitor，设备操作台不能与它们同时使用同一串口。

#### 6.9 验证实际操作、退出与急停

**【操作设备】** Windows 操作台、Android 手机、控制板。

**【操作】** 先结束板上设置：仍在连接引导第 6 页时，短按确认「进入主页」；从设置进入配对的设备，选择「返回上一级 → 返回主界面」。然后在手机打开允许测试的普通页面。电脑第一次点击实时画面只进入控制，再移动鼠标或完成一次无破坏点击。按 **Esc** 回到电脑。需要验证实体急停时，在板上用上下键选 **「紧急停止」** 并确认；恢复必须在板上选 **「取消急停」** 并确认。

**【成功标志】** 手机上的实际指针或界面响应与操作相符，Esc 后电脑恢复操作；实体急停时手机输入被阻断，电脑不能解除该锁定。若只有画面而无输入，先检查蓝牙就绪、板上是否仍在设置页、是否急停，不要反复重发点击。

完成演示后分别记录配网、安装、蓝牙、系统录屏授权、实时画面、真实输入、Esc 与实体急停的实际结果。下载完成、服务健康或短时画面不能证明长期稳定性或持续帧率。

#### 6.10 可选：启用中文输入

**【操作设备】** Android 手机的「设备投屏」App。

**【操作】** 使用匹配的新版固件和 App，在「设备中文输入」卡片依次点 **「1. 选择已配对控制器」→「2. 打开系统输入法设置」→「3. 选择设备中文输入」**。本人允许 Android 12+ 的附近设备连接权限，启用并选择这个输入法，再回到目标 App 聚焦可编辑文本框。

**【成功标志】** 输入法与所选控制器连接就绪；输入一小段文字后，目标文本框的真实内容与新画面一致。仅蓝牙 ACK 不代表目标应用已显示文字。普通鼠标/ASCII 演示不需要先做这项，系统不会静默启用输入法。

#### 可选的安装替代方式

板上下载暂时不可用时，可将 4.2 的 APK 复制到手机安装，将 4.3 的 ZIP 复制到电脑解压；后续仍按 6.3–6.9 完成连接和授权。

具备已授权的 USB 调试设备时，也可在已配置 Android SDK 的电脑上安装 APK：

```powershell
& "$env:ANDROID_HOME/platform-tools/adb.exe" devices
& "$env:ANDROID_HOME/platform-tools/adb.exe" -s "替换为实际设备序列号" install -r apps/android-screen/build/qdd-android-screen-debug.apk
```

ADB 的 `Success` 只表示安装完成，不代替手机系统配对、输入法选择或录屏授权。运行投屏无需手机 USB/ADB。

### 端口与主工作台的区别

| 服务 | 默认端口 | 用途 |
| --- | --- | --- |
| Android 设备操作台 | 8790 | 网页控制台与 `/mcp` 视觉 MCP |
| Android 手机画面服务 | 8791 | 运行在手机上，供电脑读取投屏画面 |
| ESP32 控制 | TCP 3333 | 电脑与控制板的控制连接 |
| 板上安装页 | HTTP 3334 | APK、桌面包和安装引导 |
| 设备发现 | UDP 3335 | 局域网查找设备 |

**Android 操作台默认 8790 与天翼服务冲突。** 同机运行时，保留天翼默认端口，将设备操作台「高级设置 → 操作台/MCP 端口」改为 **8792**；或在解压后的操作台目录中启动 EXE 时指定：

```powershell
.\设备操作台.exe --port 8792
```

随后使用 `http://<电脑IP>:8792/` 和 `http://<电脑IP>:8792/mcp`。Rust 也可在相邻 `qdd-android.json` 中设置 `"ANDROID_MCP_PORT": "8792"`；它不会读取 TypeScript 模块的 `.env`。

主 harness 不会自动连接该视觉 MCP。需要时显式配置其 HTTP 地址，并核对客户端对 MCP 图像内容及所选模型图片输入的支持。设备 MCP 的连接方式与主网关 token 分别配置，不能把设备操作台地址填成 QDD 工作台网关。

手机画面服务的 8791 运行在手机上，萤石服务的 8791 运行在电脑上，两者属于不同主机，不因此产生本机监听冲突。

保留的 TypeScript 实现可按 [模块说明](../apps/android-mcp/README.zh_CN.md) 配置 `apps/android-mcp/.env` 后使用 `start-android.cmd`；其 EXE 构建命令为 `npm run build:exe --workspace @qdd/android-mcp`，需 Node 24.15.0。新部署请选择明确的一套操作台，不要同时启动两套并占用相同端口。

### 将设备 MCP 接入主工作台

工作台连接器页的「门店手机」入口目前尚未开放；使用 `harness.config.json` 的自定义 `mcpServers` 配置接入。先确认设备操作台已运行，并从操作台显示的地址取出电脑的实际局域网 IP。下面的 `192.168.1.20` 只是示例，必须替换为该地址；端口与前面保存的 `8792` 一致：

```json
{
  "mcpServers": {
    "androidDevice": {
      "url": "http://192.168.1.20:8792/mcp",
      "allowWrite": false
    }
  }
}
```

将 `androidDevice` 条目合并到已有的 `mcpServers` 中，保留模型、网关和其他服务配置。当前配置只需要 `url`，不添加 `transport` 字段。`allowWrite: false` 保留手机键鼠等写入操作的逐次授权；不要误设 `allowWrite: true` 跳过确认。设备服务的局域网端点无需填写主网关 token。

保存后在后端终端按 Ctrl+C，再运行 `npm run dev`（使用已构建产物的部署也可重新运行 `npm start`）。保持设备操作台运行，确认它仍有新鲜的手机画面，再在工作台请求查看手机截图；需要所选模型支持图片输入。主工作台连接器安装流程、设备发现、系统蓝牙配对和 Android 录屏授权各自独立，添加这一项配置不会代替这些步骤。

## 6. 常见启动问题

| 现象 | 处理方式 |
| --- | --- |
| PowerShell 提示不能加载 `npm.ps1` | 将命令中的 `npm` 改为 `npm.cmd`，并确认安装工具后已经重新打开终端。 |
| 安装依赖或 TypeScript 构建失败 | 核对 Node 24.15.0、npm 11+，在仓库根目录使用 `npm ci`；不要把厂商 `mcp/` 的独立安装流程与根 workspace 混用。 |
| 找不到 `apps/cli/dist/index.js` | 先执行 `npm run build`，或使用会先构建的 `npm run dev`。 |
| 页面打开但无法连接 | 检查后端是否已打印启动地址，设置中的网关地址是否正确，token 是否来自当前工作区；旧地址可点击「使用配置地址」重置。 |
| HTTP 401 | 重新执行 `npm run qdd -- token`，填写网关 token，而不是模型 Key 或厂商 MCP 密钥。 |
| CORS 错误 | 将当前前端的完整来源加入 `gateway.corsOrigins`，包含协议与端口，然后重启后端。 |
| 缺少模型环境变量或模型调用失败 | 检查 `llm.models` 对应的 `apiKeyEnv`、`.env` 密钥、服务地址和模型名；修改后重启后端。 |
| 没有销量、库存或摄像头数据 | 新工作区初始为空；安装实际连接器并完成账号登录，或提供真实业务附件。 |
| 连接器验证失败 | 确认对应本地 MCP 服务已启动、端口未被其他程序占用；收钱吧还需服务生成的 MCP 密钥文件。 |
| 连接器已安装，但查不到云端数据 | 安装只验证 MCP 工具；在「打开登录控制台」中完成自己的官方账号登录并核对账号权限。 |
| 海康服务可用但无法发短信 | 先完成合法客户端参数配置与初始化，再在控制台完成人机验证；启动服务不会生成厂商认证参数。 |
| FFmpeg 缺失或 DPAPI 不可用 | 厂商服务使用 Windows 10/11 和独立工具依赖，先执行 `mcp:setup`；需要时按模块说明配置 `HAIK_FFMPEG`、`TYSL_FFMPEG`、`EZVIZ_FFMPEG`。 |
| 地址已修改，但界面仍连旧服务 | 重启 Vite 或重新构建前端，并检查浏览器设置保存的地址；`API_PROXY_TARGET` 不改变后端监听地址。 |
| 浏览器操作提示找不到浏览器 | 安装本机 Chrome/Edge，必要时设置 `browser.executablePath`；API Key 配置不能代替浏览器安装。 |

端口被占用时先确认占用者，不要直接终止未知进程。可查看常用端口的监听记录：

```powershell
Get-NetTCPConnection -LocalPort 3000,5177,8787,8788,8790,8791 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

后端端口可通过 `.env` 的 `PORT` 调整，前端连接目标与 CORS 来源同步更新。厂商端口可通过对应服务的环境变量调整，并在 QDD 的同名 MCP 配置中覆盖地址；详细参数见模块 README。

## 进一步阅读

- [工作台前端说明](../apps/web/README.md)
- [厂商 MCP 安装、登录与配置](../mcp/README.md)
- [前端与网关 API](api.md)
- [Android 投屏 App](../apps/android-screen/README.zh_CN.md)
- [Rust 设备操作台与视觉 MCP](../apps/android-mcp-rust/README.zh_CN.md)
- [TypeScript Android MCP](../apps/android-mcp/README.zh_CN.md)
- [ESP32 控制板环境与构建](../apps/esp/README.zh_CN.md)
