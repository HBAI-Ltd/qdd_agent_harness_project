<p align="right">
  <strong>简体中文</strong> · <a href="README.md">English</a>
</p>

# AI Passport 固件子包

`@qdd/esp` 构建运行在 FoloToy AI Passport 上的设备控制器键鼠桥接固件
（ESP32-C3、8 MB Flash、无 PSRAM、ESP-IDF **5.5.3**）。设备通过 Wi-Fi TCP 或
USB Serial/JTAG 接电脑，通过 BLE 键盘/鼠标连接安卓。手机安装独立投屏 App，通过 Wi-Fi
内网将画面传给电脑并封装 MCP；手机 USB 仅用于首次安装或调试，不使用无障碍输入。
实时画面可选极速灰度、快速、标准、原画四档；MCP 按需获取原尺寸截图。App 和电脑端无需应用令牌或连接码，
安卓录屏授权与 BLE 系统配对仍保留。
详见[桥接设置与协议](docs/android-bridge.zh_CN.md)。

设备界面统一显示“设备控制器”，手机 App 为“设备投屏”，电脑为“设备操作台”。
240 × 320 暗色卡片界面以 `#d4380d` 为主题色，右侧固定三条无文字、主题色圆头竖条，
分别对应上、下、确认实体按键；贴靠屏幕可见右缘无缝，沿圆角轻弯，最上和最下分别距边缘 4 px。
主界面纵向显示“紧急停止 / 取消急停”和“设置”，启动及返回主界面时默认选中急停。
上下键只选择，确认键执行当前项；确认急停立即阻断输入并锁定，电脑不能解除。
只有在设备上选中“取消急停”并确认才能解锁，同一轮出现急停和解锁时急停优先。
设置及普通子页用上下选择、确认进入，纵向“返回上一级”无需长按。
设置期间持续阻断手机输入，退出设置不清除急停锁，不增加启用或暂停步骤；按键指南位于设置内，按实物绘制灰色高机身、顶部挂绳槽、上半部偏左屏幕、右下斜纹扬声器和银色侧键，用引线说明对应动作，并保留“返回上一级”。
Wi-Fi 扫描遍历全部 SDK 结果，按名称及安全类型去重后保留最多 64 个网络，按信号排序，
每页显示四行，同名 Mesh 路由器不再占用多个名额。当前中国配置覆盖 2.4 GHz 的 1–13 信道，
并延长每信道扫描时间；ESP32-C3 无法发现仅有 5 GHz 的网络。列表保存在静态存储，
界面只按索引读取单条，避免大列表占满任务栈。
打开扫描列表后立即显示 40 × 40 转动动画及“正在扫描 Wi-Fi”“通常需要 3-5 秒”“请稍候”。
扫描期间短按确认返回设置，扫描在后台继续；上下键不能选择旧网络。
扫描完成、失败或离开页面时，会销毁转动控件及其动画。
Wi-Fi 可从设置进入，密码页保留四页、每页四行六列的 95 个可打印 ASCII 字符键盘；
上下先选行、确认后选字，再确认输入。密码输入是明确的操作例外：长按确认打开纵向
“连接网络、继续输入、删除一位、清空密码、返回上一级”菜单。清空会擦除整个密码缓冲区并返回键盘，
保留选中的网络和键盘位置；“删除一位”仍可用。密码始终掩码显示。
未配置设备会在步骤一之前先显示机身按键指南，短按确认“开始连接”后进入原来的无线网络步骤，
不会自动扫描；之后仍可从设置查看按键指南。
手机配对从设置选择，不会删除既有绑定。配对页立即显示窗口已开启及手机端操作指引，
再次开启也有明确反馈；页面随真实蓝牙状态更新，及时隐藏过期配对码，并区分手机已连接和键鼠就绪。
设置内新增“重置设备”，确认页默认选中“返回上一级”；只有用实体确认键选择
“清除并重新开始”才执行。设备先释放输入并重启，在蓝牙和 Wi-Fi 启动前清空默认 NVS，
包括 Wi-Fi 密码和蓝牙配对，并重新进入首次连接引导；固件和内嵌 APK 保留。
手机需要忽略旧蓝牙配对后重新配对。仅安装这版固件不会清空现有配置。
“电脑已连接”要求控制心跳在线；仅文字或颜色变化时更新控件。
14/20 px 中文字体的许可、生成和渲染验证见[资源说明](assets/README.zh_CN.md)。
串口协议操作名与广播蓝牙标识仍保留 ASCII。

未配置网络时，启动停留在连接引导步骤一，不自动进入无线网络或扫描；需主动选择“设置”，再选择“无线网络”开始。
连接引导不显示紧急停止；扫码/安装 App 和蓝牙配对说明可选择“跳过”，并保留“设置”。
跳过仅保存在本次开机内存中，重启或重置后重新引导；它不会伪造下载、蓝牙或输入就绪状态。
未完成安全蓝牙连接时仍不能控制手机，正常控制页继续保留实体确认的紧急停止。

联网后扫码页显示 `http://<控制板IP>:3334/`，可扫码或用浏览器打开下载 App。
首页及内嵌 APK 采用 SDK 定长响应，APK 声明准确的内嵌文件长度，发送成功后才标记下载完成；Wi-Fi 初始化后保持
`WIFI_PS_NONE`，USB 使用及 TCP 控制断开后也不切回 modem 省电。
首次引导中，App 成功登记会记录“曾打开 App”；这项进度与下载完成标记在本次开机期间断开
Wi-Fi 后仍保留，与手机/电脑登记的 15 秒在线有效期分开。手机切到蓝牙设置或暂时没有心跳，
不再退回下载二维码。登记过期会隐藏旧地址和投屏状态，Wi-Fi 断开也会作废实时登记。
配对完成或用户跳过蓝牙说明后，第五步提示返回 App 恢复连接并开始投屏；完成首次引导仍要求手机登记新鲜、
正在投屏及电脑控制心跳在线。重启或重置会清除这些内存中的进度标记。
手机、电脑和控制板须同一局域网。电脑可自动查找，或将 `ESP_HOST` 设为
该 IPv4，`ESP_TCP_PORT` 设为控制端口 `3333`；留空 `ESP_HOST` 时使用 `ESP_PORT` 的 USB 串口。
同一时间只有一个连接能控制设备，断线立即释放输入。重连后，电脑心跳与安全
蓝牙连接就绪即可接收新操作，无需再次启用，也不会重放断线前的按键。
网络信息单独保存在设备 NVS 中，不会删除手机蓝牙配对。
首次连接最多尝试四次，按 500/1000/2000 ms 退避，成功或耗尽前保持连接中；
暂时的配置状态冲突在 250 ms 后重试，连接 API 立即报错也会重试。
采用全信道扫描并按 RSSI 选点，不锁定 BSSID；拒绝旧配置、错误接口或 SSID 的 IP 事件，
曾连通的网络断线后继续有界退避重连。

开发前先读 [AGENTS.md](AGENTS.md)，再按其中的任务路由读取资料。
[上游文档索引](docs/README.zh_CN.md) 和
[官方教程](https://ai-passport.folotoy.cn/guides/create-a-play-with-agent/)
介绍硬件与开发流程。衍生应用必须设计自己的 UI，不能复用基线的测试菜单与页面。

## Windows 环境

使用乐鑫官方 Windows Tools Installer 安装 ESP-IDF v5.5.3，包含 ESP32-C3
支持。工具链放在仓库外、没有空格的路径中。
[环境指南](docs/development/engineering/environment-setup.zh_CN.md)
说明了其他平台和官方下载方式。

下方 npm 命令会启动子 PowerShell，通过所选 IDF 安装的官方 `export.ps1`
激活环境，不修改 shell 启动文件或全局环境设置。

可以通过 `IDF_PATH` 选择安装，也可以创建已忽略的本机配置文件：

```powershell
Copy-Item apps/esp/.idf.local.example.json apps/esp/.idf.local.json
```

填写实际安装路径。相对路径以 `apps/esp/` 为基准，可选字段为空时忽略。

| 字段 | 用途 |
| --- | --- |
| `idfPath` | 包含 `export.ps1` 的 ESP-IDF 目录，例如 `C:/Espressif/frameworks/esp-idf-v5.5.3`。优先使用 `IDF_PATH`。 |
| `toolsPath` | 安装器的工具目录，例如 `C:/Espressif`。优先使用已有的 `IDF_TOOLS_PATH`。 |
| `pythonPath` | 可选的安装器 `python.exe` 路径；当前 shell 找不到 Python 时需要。后续命令使用激活后的 IDF 虚拟环境。 |
| `bashPath` | Git for Windows 的 `bin/bash.exe`，统一验证门禁需要。留空时从 Git 安装目录寻找，不使用 WSL Bash。 |
| `ccPath` | 原生宿主 C 编译器，静态/完整门禁需要，例如便携 w64devkit 的 `bin/gcc.exe`。优先使用已有的 `CC`。 |

`.idf.local.json` 包含本机路径，已被 Git 忽略，请保留在本地。
示例配置刻意不包含任何特定机器的安装路径。

## 命令

执行 `npm ci` 后，从 monorepo 根目录运行：

| 命令 | 行为 |
| --- | --- |
| `npm run check:esp` | 检查 ESP-IDF v5.5.3、Python、CMake、Ninja 和 RISC-V 编译器。这是环境检查，不会构建固件或运行宿主测试。 |
| `npm run build:esp` | 调用统一 `tools/validate.sh --firmware` 门禁，构建、合并、验证固件，并归档匹配的调试文件。 |
| `npm run validate:esp` | 执行完整统一门禁，包含仓库检查、宿主测试和固件门禁。 |
| `npm run validate:esp -- --static` | 只执行仓库检查和宿主测试。 |
| `npm run idf:esp -- --version` | 激活环境并验证版本后执行原生 IDF 命令。 |
| `npm run idf:esp -- build` | 执行开发用增量构建。 |
| `npm run idf:esp -- menuconfig` | 打开原生 IDF 配置菜单。 |

额外的原生 IDF 参数会原样转发。例如
`npm run idf:esp -- -B build/dev build` 使用独立的增量构建目录。
`idf:esp` 不传参数时显示 IDF 帮助。

`check:esp`、`build:esp`、`validate:esp` 都不会烧录设备。烧录必须显式选择原生
IDF 操作，并遵守 [AGENTS.md](AGENTS.md) 的授权要求。monorepo 原有的
`npm run build`、`typecheck` 和 `clean` 保持 TypeScript 行为；此 C 工程不添加
TypeScript project reference。

Linux 或 macOS 上先激活 ESP-IDF v5.5.3，再从 `apps/esp/` 直接运行
`./tools/validate.sh`。npm PowerShell wrapper 面向原生 Windows。

## 构建产物

固件门禁会生成经过验证的合并镜像 `build/FoloToy-AI-Passport-full.bin`，并将
匹配的 manifest、ELF、MAP 及组件镜像保留在
`build/firmware/<full-bin-sha256>/`。验证与归档细节见
[构建与测试](docs/development/engineering/build-and-test.zh_CN.md)。失败的门禁
可能保留之前的产物，不要把旧镜像当成失败运行的新结果。

`build/`、生成的 `sdkconfig` 和 `managed_components/` 已忽略。跟踪的
`dependencies.lock` 独立于 npm lockfile，固定 ESP-IDF Managed Components。
编译与宿主测试不能证明设备上的实际行为。

## 来源与本地集成

- 来源：[Gitee 上的 FoloToy/ai-passport](https://gitee.com/FoloToy/ai-passport)。
- 导入 commit：`a06235e4c94361e3f8a2d498930254101718acae`。
- 钱多多应用入口为 `main/qdd_main.c`；上游硬件测试源码保留为未链接的参考与宿主测试夹具。
- 许可证：[MIT，Copyright (c) 2026 FoloToy](LICENSE)，保留上游许可证与署名。
- 源码放在 `apps/esp/`，没有嵌套 `.git`。初次集成保留上游 `main/`、BSP、分区表
  和依赖声明。
- 本地集成新增这对 README、npm workspace manifest、已忽略的本机环境配置、
  Windows IDF wrapper 和根 npm 入口。统一验证工具也支持原生 Windows Python、
  IDF 路径和 Windows actionlint 发行包。
- 后续更新上游时，需要结合固定 commit 和 `dependencies.lock` 审查本地集成修改。
  子目录中的上游 GitHub workflows 不会自动成为 monorepo 的工作流。
