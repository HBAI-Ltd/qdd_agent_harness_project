<p align="right"><strong>简体中文</strong> · <a href="acceptance.md">English</a></p>

# 安卓内网投屏与控制验收

## v14 ESP Wi-Fi 完整扫描与分页

2026-10-17：扫描由只取 8 条原始记录改为保留信号最强的 **64 个独立 SSID**。
先遍历 SDK 返回的全部 AP 记录，再按 SSID 去重、同名保留最强 AP，并按 RSSI 排序。
采用中国 2.4 GHz **1–13 信道**及 **100–300 ms** 主动扫描驻留时间。
已发布/待发布 AP 列表放在静态存储，轻量状态仅携带扫描版本；带版本校验的 getter 每次只复制一个 AP。
设备列表每页四项，所有结果、“重新查找”和“返回”均可到达；返回保持最后页，
同数量的新扫描也会按版本刷新名称。

| 检查 | 结果与边界 |
| --- | --- |
| Build | PASS：ESP-IDF 5.5.3 编译、固件布局及匹配归档校验通过 |
| Host tests | 仅 Wi-Fi 后端局部回归 PASS；未运行完整宿主门禁 |
| UI 编译 | PASS：仅原生 UI/模型/字体编译及 mock getter 链接，未执行 UI 用例 |
| 烧录 | PASS：COM5 仅写入 `0x10000` 的 1,651,520 字节 App，写入哈希校验通过并 RTS 重启；日志 `apps/esp/build/wifi-v14-flash.log` |
| 电脑服务 | 已重新启动，`GET /health` 返回 `status=ok`、buildId `ee8995646ca7089ab7ec`、runtimeVersion 9、地址 `http://192.168.100.160:8790/`；证据 `apps/android-mcp/build/device-tests/firmware-final-v14.json` |
| Device tests | NOT RUN：实体扫描完整性、实际射频/信道行为及板上菜单分页仍为 UNVERIFIED |

擦除范围为 `0x10000..0x1a3fff`，NVS/PHY 和既有设置、蓝牙绑定保留。
本次刷入没有执行恢复出厂设置（`resetTriggered=false`）。这不能证明所有附近网络均可见，
ESP32-C3 仍只扫描 2.4 GHz 网络。

合并镜像 SHA-256：`bede789711c50b673df0b525665a92cd265478eff11fcd99e3dda203f9520ab0`（1,717,056 字节）。
App SHA-256：`c45b3eabcb146a081585385a9e522e9c2b5cd9af7c631fadf9cf5adc66e0c6eb`（1,651,520 字节）。
ELF SHA-256：`72aa50d2e69494dbdb6ca4c2a499c869b181bb440725490f7f4284525072fa08`。
归档：`apps/esp/build/firmware/bede789711c50b673df0b525665a92cd265478eff11fcd99e3dda203f9520ab0/manifest.json`。
成功构建日志：`apps/esp/build/wifi-v14-build-fixed.log`；下方旧版本证据作为历史保留。

## v13 ESP 设置内重置设备

2026-10-17：已在设置内加入“重置设备”，确认页默认返回；实体确认“清除并重新开始”
后释放输入并重启，在 BLE/Wi-Fi 启动前清空默认 NVS，重走连接引导。手机需忽略旧配对后重配。
本次仅更新应用镜像 `0x10000..0x1a2fff`，没有触及现有 NVS，未代替用户执行重置。
Build：PASS（编译、布局与归档校验）；Host tests：NOT RUN；Device tests：NOT RUN
（按用户要求跳过测试，COM5 烧录及写入哈希校验成功）。Unverified：实体菜单和实际重置流程。
合并镜像 SHA-256 `4f65a1e31e90afb7068c736fa5d41b2dbd6a485c60f765827af737a5228c2699`，
ELF `6460009723503134474b489277044bebc9eeef7e3f8d2af705c113355484c879`。
日志 `apps/esp/build/reset-v13-{build,flash}.log`；下方 v12 实机结果属于历史固件，不能当作本版验收。

## v12 设备操作台、四档预览与控制器卡片界面

检查时间：**2026-10-17。安装包、四档预览及一分钟60Hz真机输入通过；持续画面流畅度与MCP空闲连接稳定性尚未通过。**
本节记录当前版本，下方 v11 及更早版本保留为历史证据。

| 检查 | 结果与证据 |
| --- | --- |
| 局域网操作台 | 默认监听 `0.0.0.0:8790`，显示真实私网地址；本机与私网 peer/Host/Origin 可访问 HTTP、MCP、WebSocket，公网及无效来源拒绝。真实一加通过 Wi-Fi 访问电脑 `/health` 成功，见 `phone-to-console-lan-v12.json` |
| 产品名称与界面 | 电脑为“设备操作台”，ESP 为“设备控制器”，手机为“设备投屏”；三端暗色卡片，主题 `#d4380d`。已有 BLE 标识及 MCP 协议名称保持兼容 |
| ESP 按键与图示 | 正文14px/标题20px；右缘三段主题色无文字指示贴合圆角，上下距边4px。主界面上下选择，默认“紧急停止”，确认后变“取消急停”；取消仅实体确认。设置与返回纵向排列，密码保留原行/字选择。说明图参照实物外壳、挂绳槽、偏上屏幕、扬声器和三个侧键位置，不提示电源键 |
| ESP 主机验证 | 实际 LVGL 字形/文字边界/逐像素右缘/说明图结构、增量与整帧重绘一致、100次静止零刷新、120次切页稳定、快速导航与急停优先回归通过。201个非ASCII+95个ASCII字形，14/20px；24KiB池峰值17,080字节。二维码两张实际解码通过；不能替代真实摄像头扫码或实体按键验收 |
| 四档真实预览 | 同一手机与控制轮次各20秒：极速360灰度 **14.60fps**、快速540彩色 **16.35fps**、标准720彩色 **10.95fps**、原画1080彩色 **7.30fps**；2401/2401条30Hz小幅MOVE收到协议确认，零新增断流/错误。此轮ESP为v11，不冒充新UI固件验收，见 `profiles-v12.json` |
| 原图与坐标 | Pillow逐像素验证8张图：极速确实灰度，四档MCP均返回1080×2400彩色新原图；预览档位不改变物理坐标/控制轮次。原图按需请求391–823ms，切档后恢复标准并释放输入 |
| 延迟与限制 | 四档画面年龄中位/P95依次51/113、44/113、105/298、165/499ms。协议ACK中位约2ms/P95约7ms，不是手机可见响应延迟；最大画面间隔仍约1秒。迟到帧携带增长的源年龄并成批到达，尚不足以认定采集pending1000ms为根因，保留7cff APK，不盲改超时或伪造新帧 |
| MCP取消传播 | 超时/取消贯穿原图HTTP与队列；排队任务立即拒绝且轮到时跳过，进行中的body被取消，迟到响应不发布；不会停其他观察者或预览源。6项回归完成红绿验证，动作超时不重放 |
| Windows端口占用 | Windows上127或具体LAN地址的非HTTP监听可与通配绑定重叠；启动前TCP预检避免误连，占用时进入已有换端口流程。原失败fixture不改监听来掩盖问题，foreign保持运行，回归通过 |
| PC主机门禁与EXE | 最终版本typecheck/build、Node383/383、根CLI35/35通过；EXE12/12、120秒纯loopback压力通过：150KiB夹具30.05fps、最大间隔48ms，丢ACK不重放、重连/关闭/释放通过。压力数据是夹具，不是手机实收帧率。日志 `delivery-v12-*.log` |
| 观察者与画质修复 | 只读原图请求失败不再误停其他输入持有者，本会话失败仍安全释放，旧轮次晚失败不伤新持有者；4项回归通过。实时帧同步实际画质与文案，本页切档及迟到旧帧不覆盖选择，完整VM62/62通过 |
| 视频写入修复 | 原大帧专项曾在全量失败，独立两次通过；新增确定性突发回归证明末帧及断流通知会遗失。改为一条在写记录加一个最新待发记录，回调后发送，排队时间计入帧龄，过3秒不发送，断流通知优先；3项红转绿，专项15/15通过，原1秒时限及夹具未放宽 |
| 最终ESP固件与MCP | 照片指南固件完整门禁通过，COM5分段烧录后三段哈希校验通过，NVS/PHY及BLE绑定保留。与旧9aed EXE的官方MCP13次调用/42报告通过保留在 `exe-real-v12.json`。最终ee899 EXE初始化/listTools20项、10次调用与42/42报告完成，但随后16秒空闲检查发现socket已关闭，尚未归因，见 `exe-real-v12-owner-fix.json`；不能标整轮MCP稳定性通过 |
| 最终60Hz实机压力 | 首轮9aed EXE约49秒时结束，2950已发/2948确认，原FAIL保留 `exe-real-soak-v12-final.json`。最终ee899 EXE与照片指南固件增强复测60秒3600/3600、60Hz最大±127 MOVE通过，ACK中位2.14ms/P95 7.01ms；694帧/11.57fps、帧龄中位101ms/P95 301ms、最大间隔1331ms，仍有卡顿。恢复标准/armed=false，BLE连接/加密/绑定/就绪，见 `exe-real-soak-v12-owner-fix.json`；后续通过不抹去先前失败，也不证明其根因已修复 |
| 最终浏览器 | 新EXE页面已重新加载，真实内网画面、三项连接就绪及标准画质文案正常；未进入远控，保持释放输入。截图 `operator-v12-final.png`。本轮未重复点击/Esc实体输入验收 |

EXE：`build/windows/设备操作台.exe`，buildId `ee8995646ca7089ab7ec`、runtimeVersion=9，
SHA-256 `27771d8856f567299f91660c404f3f8358b03f51cb36726bc48e0687539d6357`，93,252,608字节。
已安装APK SHA-256 `7cff0c5e1f3d00fdb645d1dad64a08cd9b692c7bdbb2eef203c136db06931812`；
已读取目标一加 `dcf4e720` 的系统实际base.apk核对一致。
当前访问地址 `http://192.168.100.160:8790/`，MCP `http://192.168.100.160:8790/mcp`。

最终ESP合并SHA-256 `d5f3e4c493506804cd0c2ae0a1dd56a8e3f4eb1de1d0c9fa1efdd8898eb83d2b`，
ELF `78cc0a475ec56c9f4eb4622821fc2f3e0d6aadc78f150951cb25c1517592191f`。
App 1,645,552字节，merged 1,711,088字节；已核对App内嵌APK与上方安装包逐字节一致。
仅分段写入bootloader、分区表、App；`0x9000..0xffff`的NVS/PHY未触及。
完整门禁及烧录日志为 `apps/esp/build/device-ui-v12-photo-final-{gate,flash}.log`。

运行时图像始终来自手机LAN MediaProjection，输入始终经过ESP BLE；ADB仅用于安装、授权准备和诊断。
尚未验证新菜单的实体操作/显示、实际扫码完整初次引导、其他厂商及持续30fps；
源码未提交或push，自动检查保持PAUSED。

## v11 历史：固定帧率、快速滑动和连接引导

检查时间：**2026-10-17。静止降帧已移除，快速移动回归通过；持续 30fps 实收和
真实 ESP 内网首次连接尚未通过。** 下方 v10 为历史记录，当时产物以本节为准；当前版本见上方v12。

| 检查 | 结果与证据 |
| --- | --- |
| 固定采集节拍 | 连续流固定 33ms 目标，静止也不降到 500ms；双 ImageReader 轮换且只允许一个待合成刷新，独立 JPEG worker/两个 bitmap/一个最新待编码帧，保留原图 1080×2400、JPEG75 和真实采集时间 |
| 真实静止对照 | 旧版 60s：PC 1.78fps、手机直读 1.80fps；首版固定采集手机约 25–27fps。单路电脑首版 6.05fps，加入会话 Wi-Fi 性能锁后另一次 60s 为 **8.2fps**、源年龄中位 157ms/p95 348ms，零断流/超时。后者是该次实测，不能保证所有网络提速；见 `preview-{baseline,single,wifi-lock}-v11.json` |
| 快速滑动 | 浏览器累计/缩放位移超限改为合并并限制纯移动，不再错误急停；按键/鼠标边沿仍顺序保留。真机 COM5→BLE 一分钟 **3601/3601** 条最大 ±127 MOVE 通过，ACK 中位 2.00ms/p95 6.87ms，无错误；见 `exe-real-soak-v11-fast.json`，该记录使用 v10 ESP 固件、新 PC 与首版固定采集 APK |
| ESP 六步引导 | Wi-Fi→二维码与 IP→下载/安装 App→手机蓝牙→电脑 EXE→操作。板上直接提供嵌入 APK，HTTP3334、UDP3335；扫码或浏览器输入地址下载，并明确手机/电脑/ESP同一局域网。注册不授予输入权限，实体下键急停优先 |
| 发现与归属 | 手机收集去重后只自动选择唯一板；多板须扫码选择目标；旧 IP 按已选择设备名恢复，旧请求不能覆盖新选择。电脑自动发现填入手机地址/UUID，保存前不控制；USB 选择保留 |
| 回归 | 仓库 typecheck/build PASS；Node **338/338**、操作台 **47/47**；EXE **11/11** 打包/HTTP/stdio/生命周期 PASS；原生 socket/pixel/cadence/setup/Wi-Fi 锁回归 PASS；ESP 中文布局/203个非ASCII字形覆盖/真实二维码解码 PASS |
| 同版 MCP 真机 | 最终 EXE+APK+ESP 上，官方 SDK 初始化/listTools 20项、13次工具调用、42条 WS 报告/63次心跳均通过；主页/移动/返回/等待返回动作后真实新图，结束释放输入且保留加密绑定。见 `exe-real-v11.json` |
| 最终固件连续控制 | 同版最终产物一分钟 **3600/3600** 条60Hz最大幅度来回 MOVE 通过，ACK中位1.99ms/p95 6.83ms、画面年龄中位128ms/p95 273ms，697帧/**11.62fps**，无错误。该轮为桌面壁纸画面，不能替代前述 App 静止内容8.2fps对照。见 `exe-real-soak-v11-final.json` |
| 最终浏览器 | 真实 IAB 点击画面进入、Esc退出通过，最终画面显示约11–13fps且三项连接状态正常；操作台留在退出远控、继续投屏状态，见 `operator-v11-final.png` |

当前 EXE buildId `4738559a1d6f4e80029a`，runtimeVersion=7，SHA-256
`eec2f0923406af9bd8ed973f140e7d8ebede3776f47fce4f5c5712967e0c3ec7`（93,224,448字节）。
最终 APK SHA-256 `e3ada15f097807ff5ee1750ff8dc498ce04b93a8bd88f88bc4c3b107f1bda234`
（45,538字节），已覆盖安装并读取系统实际 base.apk 核对一致；一加显示 high_performance 锁已持有。
最终 ESP 合并 SHA-256：`b2d3ca6c37d5d0a06315abba868bdef03bbe602cc1c71e46c1302baf761a2a70`，
ELF：`b4f2b7f4dacc9a4ea217512177cf1c709509dc09169481e223d7eccad0ad6e06`。
App 1,652,576字节、merged 1,718,112字节；完整门禁含 C/LVGL 和 124项 Python检查通过
（21项原有平台跳过）。直接搜索 App 镜像确认嵌入的 45,538字节 APK 与最终安装包逐字节一致。
分区表与 v10 相同；已向同一 COM5 C3 分段写入 0x0、0x8000、0x10000，未触及
0x9000..0xffff 的 NVS/PHY，原有 BLE 加密绑定自动恢复。
门禁与烧录日志：`apps/esp/build/onboarding-v11-{final-gate,flash}.log`。

自动审批拒绝通过 USB 设置 ESP 当前 Wi-Fi（仅 `blocked by policy`），未换接口重试。
因此保留 COM5 联调，板上需要通过现有屏幕键盘连入同一内网后才能验证真实
扫码下载、手机登记和电脑发现。未把 host 仿真、QR 图片解码或普通 API 编译当作真实扫码验收。
运行时画面始终来自 LAN MediaProjection，输入始终走 ESP BLE；ADB 仅安装、授权与只读诊断。
尚未验证真实摄像头扫码、主动 AP/改 IP、实际多板、其他安卓厂商及持续实收30fps。
源码未提交或 push，自动化保持 **PAUSED**。

## v10 历史：Windows EXE 与连接稳定性验收

检查时间：**2026-10-17。Windows EXE、官方 MCP 与一加/COM5 核心链路及
两分钟连续真机控制 PASS。** 手机当前经 Wi-Fi `192.168.101.46:8791` 提供真实
MediaProjection 画面；电脑以 USB COM5 连接 ESP，再由原有加密 BLE 配对输入。
运行时未使用 ADB 截图或 ADB 输入回退。点击画面进入、Esc 退出、移出画面继续控制，
没有开始/接管/暂停按钮。

| 当前检查 | 结果与证据 |
| --- | --- |
| Windows 单文件 EXE | 已生成 `build/windows/QDD-Android.exe`，内嵌 Node 24.15.0、五个页面资源及原生串口模块；空 PATH、中文/空格/# 路径通过，无需另装 Node/npm |
| EXE 设置/生命周期 | **11/11 PASS**：首次设置及并发提交防覆盖、重复启动复用、旧有 EXE 替换、同进程五轮配置重载/换端口、串口/TCP 释放、外来端口占用恢复及旧设置页收尾 |
| 输入通道 | 浏览器 WebSocket 独立于 HTTP 视频/MCP 连接池；四条按序待 ACK，250 ms 续约不等待报告 ACK；丢连接释放，不重放输入 |
| 断连恢复 | 观看自动按 0.5/1/2/4/5 秒退避重连；恢复观看后重新点击进入控制；旧报告、旧心跳、旧工具超时/取消不误停新控制轮次 |
| 主机门禁 | 根目录 typecheck/build PASS；`test:android` **319/319 PASS**，含 MCP 46 项、串口/TCP 46 项、操作台 44 项。日志 `build/device-tests/host-v11-observer-tests.log` |
| 原生投屏 | socket 12、像素 3、刷新节拍 2 项 PASS；最终 APK 已核对 manifest/哈希并覆盖安装，系统投屏授权完成 |
| COM5 实体中性检查 | 181 秒、90/90 STATUS、三次关闭/重新打开均通过；BLE connected/encrypted/bonded/ready=true，armed/locked=false。零非中性输入，见 `usb-neutral-soak-v10.json` |
| 一加静态真实内网流 | 30 秒、55 个唯一源帧、1.83 fps；帧龄中位 123 ms、p95 267 ms；原始 1080×2400，零断流/写失败。见 `native-v10-static.json` |
| EXE 官方 HTTP MCP / 真实 ESP | 20 个工具；截图与 home、两次相对 move、escape、back、wait 均返回 JPEG；每次高层操作后为不同、动作完成后采集的源帧。见 `exe-real-v10.json` |
| EXE WebSocket / 真实 ESP | 42/42 鼠标键盘报告确认，报告 ACK 中位 8.07 ms、p95 14.28 ms；空闲 16 秒、63 次续约回复不断连；STOP 后 armed=false、BLE 就绪/加密/绑定保持。ACK 不是视觉延迟 |
| 最终 EXE 两分钟真机持续控制 | **PASS**：120.008 秒、3600/3600 MOVE（30 reports/s）、465 次续约回复、1819 张完整真实 JPEG（15.16 fps）；零断流/输入错误。ACK 中位 2.02 ms/p95 6.87 ms，源帧年龄中位 79 ms/p95 199 ms，最后释放/未锁定。见 `exe-real-soak-v10.json` |
| 只读会话 | 另一个官方 SDK 观察会话读取并关闭后，原输入持有者仍 armed=true，不被观看连接打断 |
| 观察页误暂停修复 | 纯观看页面隐藏/离线/关闭/画面错误不再发送全局 PAUSE；本页发起实际控制后仍在退出时释放。VM 红→绿验证；runtimeVersion=6 阻止旧页面重连新版 |
| ESP 完整门禁与更新 | 新 50 ms USB SOF 丢失确认通过完整门禁，Python 124 项（含既有平台 SKIP）、C/LVGL 通过；分段烧录 0x0/0x8000/0x10000 并校验，保留 NVS/PHY 与蓝牙绑定 |
| USB 修复后的真实直连 | 同时接收手机 LAN 视频，60 秒 1800/1800 MOVE、每秒 30 条，无心跳过期；清理前 BLE 就绪/加密/绑定、armed=true。见 `usb-realtime-trace-v10.json` |
| 实际 IAB 操作台 | 最终 EXE/固件真实 PASS：点击画面进入、整页 cursor=none、画面右侧外点击仍控制、Esc 后 cursor=auto/无错误；连续 MCP 控制中跳转连接设置再返回也未打断。截图 `operator-v10-final.png`、状态 `operator-v10-final.json` |
| 重复双击 EXE | PASS；正常启动入口打开操作台并复用 PID 54280，没有第二个服务或串口实例 |
| 同传输内核前包 loopback 压力 | 前包 `4ad1c514…`：120 秒、3602 张 150 KiB JPEG、30.009 fps、4508 个 WS ACK；15 秒空闲、WS 断开恢复、TCP 丢 ACK 不重放通过。**仅夹具指标，零真实设备输入**，见 `build/windows/exe-soak.json`；最终包另通过上述真机检查 |

`android_control` 自动准备一次输入并返回新画面；tap/swipe 仍要求真实标定。
普通 AI 输入接管浏览器时关闭旧浏览器输入会话，旧停止/取消请求无法停掉新操作者。
当前轮次失败仍释放键鼠，物理 DOWN 急停始终优先。

手机原热点在本轮中消失，用户提供当前 Wi-Fi 后已通过普通系统设置连接，
电脑与手机处于同一个 `/23` 内网并实际 HTTP 验证身份；未将代理 TCP 成功当作设备可用。
Wi-Fi 密码未写入项目、构建配置或测试日志。ADB 只用于安装、配网、系统投屏授权及只读诊断。

原图静态采集耗时中位 81 ms，其中 JPEG 编码 56 ms；33 ms 是采集间隔上限，
**未证明手机可持续 30 fps 或完全流畅**。两分钟鼠标运动期间实测约 15.16 fps。
ADB 打开动态诊断页被自动审批拒绝（仅返回 `blocked by policy`），该操作已停止，
未更换接口绕过。复杂动态内容/持续 30 fps、
主动 AP/换 IP 恢复、旋转/重新授权、实体 DOWN/OK 新一轮与其他安卓厂商仍不作通过声明。

最终 EXE SHA-256：`549e491565cf7068e10632c458e8f8bf2cf6684b96b84ec284424e2beb7f62a4`，
buildId `972b70a19caa74ca1b38`，93,210,624 字节，runtimeVersion=6。
已安装 APK SHA-256：`d2343a4c42539df17524fe651efc981f5d1570384de299707c3bb7ad01117c59`，
已读取一加系统实际安装包并再次核对一致。
当前 ESP 合并 SHA-256：`24c50368241392d8446af94f08e4fc2585c4d4cd597b387c0994aa108e4e284d`；
ELF：`f104f221c6ecc8add6c53544e2923509a926948e9cdaa14cdb50e04383028814`。
App 1,534,688 字节、merged 1,600,224 字节，分区表与 v8 相同；未擦除 NVS 或蓝牙绑定。
完整门禁/烧录日志为 `apps/esp/build/usb-stability-v10-{gate,flash}.log`。

连续输入最初在 364 条后失败，保存为 `exe-real-soak-v10-before-usb-fix.json`。
独立 USB trace 随后记录：PING 8453 ms 已确认，MOVE 8640 ms 仍正常，8660 ms 却
返回 `HEARTBEAT_EXPIRED`。SDK SOF 在线信号短暂抖动会立即清除旧控制源。
原 probe 曾错误吞掉异步拒绝并标 PASS，原始数据与纠正记录分别保留为
`usb-realtime-trace-v10-original.json` 和 `usb-realtime-trace-v10-audit.json`，不算通过证据。
修复仅对原始 USB 信号确认连续丢失 50 ms，1500 ms PING 与实体 DOWN 仍独立生效。
源码未提交或 push，自动化保持 **PAUSED**。

## v9 历史：传输与 MCP 联调

以下为 v9 的阶段快照；当前进度、进程和产物以本页 v10 为准。

检查时间：**2026-10-17。已实现连续二进制画面与四报告实时输入窗口，首轮真机吞吐
有所提高；整体连续流畅度仍未验收。** 点击画面进入、Esc 退出、移出画面不退出及
整页隐藏电脑光标的交互保持不变。

| v9 改动/检查 | 证据与边界 |
| --- | --- |
| 手机采集 | 每 33 ms 最多一帧（约 30 fps），JPEG 质量 75；保留 1080×2400 原尺寸，减少连续 RGBA 和重复缓冲区复制；不是持续 FPS 实测保证 |
| 手机新版安装 | APK SHA-256 `d55e935bb6a36b108fe8e67a768c00c723f1073d394f9ab1135984ceb9e540d5` 与 manifest 核对后覆盖安装一加 8，用户重新确认投屏授权；原签名一致 |
| 电脑到浏览器 | `/screen/stream` 二进制 JPEG，不再为操作台逐帧 Base64 转码；只留最新待解码帧，传输/解码仍计入三秒时效；SSE 仅保留兼容 |
| 人工输入 | 最多四条待 ACK 报告，发送不再逐条等待 Wi-Fi 回执；每轮序号保留鼠标/按键边沿顺序；缺序号、取消或确认错误即释放，不重放 |
| 普通 AI 输入 | 等已有实时报告完成后独占执行，保留坐标标定、截图守卫与原有定位节拍 |
| MCP | 20 个工具；新增 `android_control`，使用本会话 frameId，内部准备一次动作并返回动作完成后采集的真实新帧；图片超时明确返回动作是否已经完成，不能盲目重做 |
| 会话归属 | 只读观察会话或视频观看连接关闭不再中断其他操作者；输入持有者断开、真实源丢失仍释放键鼠 |
| 主机专项回归 | 输入/串口/TCP 92/92；画面 TS 33/33；原生 socket 10/10、像素 3/3。完整最终门禁与新进程证据待本轮最终联调补齐 |
| ESP | 沿用 v8 合并 SHA-256 `8e4045a5bbf943793ef9f10934bb2ac0108e8969ebdc7f9248562d0728cd2462`；本轮未烧录、未改描述符或 NVS/蓝牙绑定 |

首轮同版后端对照使用真实 ESP Wi-Fi → BLE → 一加，48 次交替 ±2 的 MOVE 均 HTTP 200：

| 输入模式 | 48 条总耗时 | 吞吐 | HTTP 请求完成中位 / p95 |
| --- | --- | --- | --- |
| 串行兼容路径 | 6.689 s | 7.18 reports/s | 105 / 377 ms |
| 四报告窗口 | 4.190 s | 11.46 reports/s | 305 / 920 ms |

这说明本轮吞吐提高，**没有证明单次延迟降低**。记录中的 `medianAckMs` / `p95AckMs`
实际从发出 HTTP 请求计到读取完整结果，含主机排队、ESP 确认及 HTTP 往返；不是单独
BLE ACK、端到端画面延迟或持续视频 FPS。首轮成功记录单独保存在
`remote-performance-v9-before-initial-success.json` 与 `remote-performance-v9-after-initial-success.json`。
此前旧进程测试发到第 25 条后遇到续约 409，保存在
`remote-performance-v9-before-initial-failed.json`，不能计为成功对照。

只读 ICMP 各 20 次：ESP 最小/平均/最大 41/268/732 ms；手机 12/73/208 ms，均无丢包。
见 `lan-latency-v9.json`。这是当时热点的往返抖动，未逐样核验 TCP 控制状态，
不能直接当作 BLE 或整体操控延迟。局域网带宽快不等于每条消息往返及时；旧版
12.5 fps 采集、逐请求 ACK 等待及转码还会叠加开销。

最终连续画面、MCP 真机动作与新版浏览器流程仍在本轮联调，未以旧 v8 交互通过替代。
新版实体 DOWN/OK 与板屏、其他浏览器 PointerLock、长时资源、AP/换 IP、旋转/STOP
重新授权及其他手机仍未复验。代码未提交或 push；自动化保持 **PAUSED**。

<details>
<summary>v8 历史：简化交互与默认输入功能通过，流畅度未验收</summary>

以下 v8 哈希、进程、APK 与门禁属于历史快照；当前 v9 以本页上方为准。

## 点击进入遥控检查点

检查时间：**2026-10-17，当前一加/IAB 的 v8 交互与默认输入功能 PASS，高 FPS 连续流畅度未验收**。
当前交互为 **点击画面操作，Esc退出**。
移出画面绝不退出：document 全页继续相对输入、整页隐藏电脑光标。首次点击画面
只建立遥控，后续点击操作手机已有真实指针，不映射网页点击位置。

最终主机门禁：安卓测试 **235/235 PASS**，包含实际操作台脚本 **31/31 项 VM 回归**；
根目录 build/typecheck/diff 检查通过。日志：`apps/android-mcp/build/host-simple-v8-tests.log`。

| v8 改动/检查 | 当前证据 |
| --- | --- |
| 简化 UI | 开始/接管/暂停按钮与状态 pill 已删除，只保留固定的点击画面进入、Esc 退出说明 |
| 进入与全页输入 | 已实现：首击建立遥控，后续 document 点击输入手机；捕获阶段拦截页面点击，避免同时误触工具栏 |
| 移出画面 | 新固件/UI 真实 IAB PASS：picture 内点击后，再在右侧 15 px 外点击，仍 remoteActive=true/cursor=none/error=false |
| 光标与旧按钮 | 真实 IAB PASS：点击 picture 进入后整页隐藏光标，旧三个控制 DOM 元素数为 0 |
| 闲置工具栏 | 内部准备控制，无手动 ARM 步骤，没有手动启停 UI |
| 正常 Esc 退出 | 真实 IAB 两次 PASS：remoteActive=false/cursor=auto/error=false，activity 为远控已退出；旧 timeout 路径先复现两项 VM 失败，修复退出期间轮询后通过，同轮真实故障仍保留红错直到明确 Esc |
| ESP 默认激活 | 真机 PASS：PING → MOVE 无 ARM；PAUSE → MOVE 也无需 ARM 或 OK；TCP 断开及 1850 ms 租约过期后 fresh STATUS 均 armed=false |
| ESP 实体键 | 主机策略：DOWN 急停锁、OK 只解除该锁、短 UP 无操作、长 UP 保留 Wi-Fi 设置；本轮未实体复测 DOWN/OK 或板屏 |
| 新 ESP 完整门禁/烧录 | PASS；COM5 再次核验目标 MAC 4c11ae2fa1b8，0x0/0x8000/0x10000 分段烧录校验通过，保留 NVS 0x9000–0xefff |

连接、控制源、心跳、BLE 认证/加密、绑定、报告就绪与实体停止仍是内部门禁。
网页进入和闲置工具栏在内部处理连接准备，UI 不显示手动启停或暂停恢复流程。
MCP 兼容的 ARM/PAUSE 调用保留；固件默认激活不等于静默改变当前电脑控制器
API/AI 调用流程。

完整固件门禁 PASS，日志：`apps/esp/build/default-control-v8-gate.log`。
Python 总计 123 项，21 项平台/symlink SKIP（仓库检查 4/归档 5/安装 12）。
C/LVGL 检查通过；主机证据包含锁优先、162 字形、17 张 LVGL 帧与 120 次切屏，
不能替代上表尚未复测的实体显示。app 镜像 1534528 字节，合并镜像 1600064 字节，归档验证通过。
合并 SHA-256：`8e4045a5bbf943793ef9f10934bb2ac0108e8969ebdc7f9248562d0728cd2462`。
ELF SHA-256：`cf2e8836ac1055ba8483460bd136cd24a8fcb2793f8801f55a6e84737d597dfe`。
APK 仍为 `0a4a6f78aa1a0dfe3ee3dcc2ba6d2469251aa42ea89f5e4ab30fe72633318d1b`。

证据：`esp-default-v8-status.json`（Wi-Fi 10.65.201.147、BLE 就绪/加密/绑定，无崩溃标记）、
`esp-default-control-v8.json`（默认输入与租约）、`operator-simple-runtime-v8.json`
（源码哈希与 runtime）及 `operator-simple-v8-final.png`。操作台 JS SHA-256：
`d1959c048eba49f2ac672d853adbb18c56d10988439ce8efa4c78d63574abb78`。
runtime 的 05:23:37Z 状态是合法 active 快照（armed=true），不是空闲或最终状态断言。
旧 v7 helper 复制的 idle 断言因此失败，已单独保留，不计为固件故障。

服务 PID **40392**、runtimeVersion=3，运行于工具托管前台 session **92816**；
health=200、未知路由=404 通过。两次后台 Start-Process 被自动审核拒绝后，受控前台运行
获准，未再尝试隐藏后台启动。Esc 采样当时退出通过；稍后只读截图在另一桌面页显示
“远控已连接”，不能推断是谁重新进入，也不能声称持续空闲或持续 FPS。
服务当前可用，允许默认控制。

高帧率连续流畅度仍未验收（原生采集上限 12.5 fps）；其他浏览器真实 PointerLock、
长时资源、AP/换 IP 恢复、旋转/STOP 重新授权及其他手机仍未验证。

代码尚未提交或 push；
自动化仍为 **PAUSED**。

<details>
<summary>v7 历史：窗口内相对遥控功能通过，高帧率流畅度未验收</summary>

以下属于 v7，其中开始/接管控件与移出画面退出行为不代表当前 v8 交互。

检查时间：**2026-10-17，当前一加/IAB 窗口内相对遥控功能 PASS，高帧率连续流畅度未验收**。
用户明确允许安卓
鼠标加速度，要求隐藏电脑光标，只看投屏里手机真实的鼠标。人工遥控因此从 v6 的
定时坐标定位改为连续相对 HID 移动。下列功能检查已通过，不代表整体高 FPS 成品验收通过。

最终根目录 typecheck/build 与 diff 检查通过；`npm run test:android` **231/231 PASS**，
包含实际操作台脚本 **27/27 项 VM 回归**。日志：
`apps/android-mcp/build/host-relative-v7-tests.log`。源码已冻结。

| v7 方向与证据 | 状态 |
| --- | --- |
| 人工鼠标输入 | 已实现：动画帧调度、相对 MOVE 累加、最多一个请求传输，按键与鼠标边沿保序 |
| PointerLock | 真实 IAB 未允许捕获（lock=null），窗口内相对遥控降级已通过；真实 PointerLock 捕获与其他浏览器未验证，仅可选接管按钮重试捕获 |
| 光标显示 | 真实 IAB 单次 ARM 后 computed cursor=none，只看视频中的手机真实指针；Esc 后 cursor=default |
| 首次画面点击 | 真实 PASS：手机指针已位于主页“小工具”图标时，首击未归零、未吞掉，确实打开文件夹；不是网页点击位置的映射 |
| 安卓加速度 | 允许；人工移动是相对输入，不是网页绝对像素到手机像素的映射 |
| 人工标定、撞角归零、定时坐标定位 | 人工路径取消这些步骤，不需要坐标标定、撞角或 100 ms 定位定时器 |
| AI 坐标工具 | 原逻辑不变：明确标定、估算位置、归零/节拍和截图守卫保留 |
| 暂停与松开 | 最后 reload → ARM → 立即 Escape PASS，包含 ARM/捕获尚未完成时取消：“已按 Esc 暂停，鼠标和键盘已松开”；后续轮询仍暂停，cursor=default/errorVisible=false/lock=null；VM 回归覆盖捕获退出、窗口内移出、失焦、隐藏/离线与掉流 |
| 原始相对通路基准 | 第二轮独立运行完成：32 次 MOVE 均 HTTP 200，总计 3474 ms，约 9.2 reports/s，最后暂停 |
| 同时录制 PC SSE 的原始移动 | 32 次报告耗时 5722.64 ms，收到 40 帧/36 个图片哈希；输入 ACK 中位 107 ms、p95 479 ms、最大 714 ms |
| v7 验收边界 | 当前一加/IAB 窗口内相对遥控功能检查通过，高帧率连续流畅度仍待验收 |

浏览器证据：`operator-relative-v7-click.png`、`operator-relative-v7-final.png`。
`operator-relative-runtime-v7.json` 保存 PID **50580**、`runtimeVersion=3`、冻结哈希及
最终 BLE 状态：connected/encrypted/bonded/ready=true、armed=false、locked=false。
操作台 JS SHA-256：
`478f28690ffe426421b2b6ac7b4d8c4857988b9006926286d913dd0e8ff18b10`。
ARM/捕获待完成时 Esc 的用例先复现失败，修复后通过。最终截图为最新暂停 UI，
手机显示通知栏；此前 click 截图保留打开文件夹的证据，最后这项修复未改变其点击代码。
准备时 BLE Back 先执行，画面稍后才更新；即时缓存截图仍显示文件夹。测试等待真实
浏览器确认主页后才做文件夹首击，未把先前缓存画面记为返回失败。

原始基准只代表请求/报告吞吐，不能当作端到端画面延迟或浏览器流畅度结果。
证据为 `apps/android-mcp/build/device-tests/relative-hover-bench.json`，前后图片为
`relative-hover-before.jpg`、`relative-hover-after.jpg`。首次 helper 在用户同时操作
UI 时被取消，已与第二轮分开，不计为成功基准。

同时录像的记录为 `apps/android-mcp/build/device-tests/relative-hover-video/result.json`。
ACK 耗时不是画面延迟；本轮存在并行 SSE 录制和实际 Wi-Fi 抖动，视频采集上限
12.5 fps，不能据这些数值宣称完全流畅。初始化时旧 MCP tap(540,600) 进入了
文件夹标题编辑，但没有输入任何文字、没有更改文件夹名称；这项初始化操作不算
v7 浏览器遥控验收。

本轮修改浏览器人工输入路径，PC 后端、ESP 固件与手机 APK 哈希不变，未烧录或
处理绑定。v6 已验证的点击与安全事实保留，但其连续悬停流畅度未通过，不能算作
v7 流畅度通过。最终服务已暂停。

源帧时效仍为三秒并计入传输，AI 坐标截图有效期仍为 30 秒。长时资源压力、主动
Wi-Fi AP 掉线/换 IP 恢复、旋转/投屏 STOP/重新授权及其他手机仍未验证。
代码尚未提交或 push；自动化仍为 **PAUSED**。

<details>
<summary>v6 历史：坐标定位遥控的点击/安全已通过，连续悬停未通过</summary>

以下记录属于 v6 坐标定位鼠标模式，其中人工对齐、标定和 100 ms 节拍不适用于
v7 相对人工鼠标；AI 坐标工具仍保留自己的原有节拍。

检查时间：**2026-10-17，v6 IN PROGRESS，连续悬停流畅度未通过**。点击 ARM 后自动进入
画面直接遥控，hover 位置与点击映射到手机像素，不再要求第二个遥控按钮或
PointerLock。新版替代 v5 的窗口内相对遥控交互；此前传输与硬件证据保留在下方。

当前服务 PID **50580**，`runtimeVersion=3`。ESP Wi-Fi 固件仍为
`8b602a11edf74f123183cd70caa1d5fc6413538dd564259753934ad793aa2f42`，
v6 未重新烧录固件。

最终主机门禁：安卓测试 **226/226 PASS**，包含实际操作台脚本 **22/22 项 VM 回归**
及 `preventScroll`。证据：`apps/android-mcp/build/host-direct-release-tests.log`。
旧 poll/refresh 失败竞争先复现三项失败，修复后四项新增回归通过。该门禁早于最新
悬停流畅度反馈，不能视为本次问题已验收。

| v6 直接遥控检查 | 结果 |
| --- | --- |
| ARM 后自动直接操作画面 | 真实 IAB reload 后 PASS；一次 ARM，无第二次遥控按钮或 PointerLock 步骤 |
| 显示区域映射与输入顺序 | 主机 PASS；270×600 显示映射到 1080×2400 手机，按下/松开等边沿保序，hover 合并为最新目标而不积压 |
| Wi-Fi 真实指针目标 | 三次 HTTP 200：(540,1200)、(665,1200)、(675,1210)，耗时约 3869/393/371 ms |
| JPEG 指针位置对照 | 初始质心 (541.1,1201.46)、最终 (674.92,1212.02)，与对应目标误差约 2 px，仅代表本机观察 |
| IAB 真实直接点击 | PASS：ARM → 原生首次 hover 对齐 → 直接画面点击，正确打开“小工具”文件夹，工具截图已观察 |
| 连续悬停流畅度 | 未通过；用户反馈 hover 鼠标明显闪现、卡顿，需要优化后重新验收 |
| 旧 poll/refresh STATUS 失败与新 ARM、正常 Esc 暂停竞争 | 已修复；epoch/revision 守卫及四项新增回归防止旧失败影响新控制轮次，同轮真实错误仍正常报告并暂停 |
| 移出画面 | 真实 IAB PASS；正常暂停，无错误 |
| 最后真实 Esc 复验 | PASS；明确 ARM 后按 Escape，activity 为“已按Esc暂停，鼠标和键盘已松开”，无错误，后续状态轮询未覆盖 |

指针对照采用 JPEG 差分阈值及圆环指针质心，是当前一加手机和设置下的近似观察，
不能作为所有设备通用的标定保证。首次对齐仍约 3.869 秒，随后短距离移动约 0.4 秒。

ARM 后首次 hover 会对齐手机鼠标。请等界面提示对齐完成再点击：对齐期间有等待
提示，点击会被主动忽略，避免点到错误位置。这不是零延迟输入，也不保证所有设备
都能达到相同像素精度。

原始更快移动对照出现漂移：静置 350 ms 后移动 125 counts，实际约 175 像素；
静置 700 ms 后，125 counts 才与预期距离一致。因此当前保留每次 ACK 后 100 ms
间隔，不据此夸大快速远控表现。

证据位于 `apps/android-mcp/build/device-tests/`：

- `pointer-direct-device.json`：三个真实目标 ACK、耗时及该独立测试的最终暂停状态。
- `pointer-direct-1.jpg`、`pointer-direct-2.jpg`、`pointer-direct-3.jpg` 和 `pointer-direct-final.jpg`：真实 JPEG 指针证据。
- `operator-direct-folder-open.png`：实际浏览器打开文件夹的观察。
- `operator-direct-final-runtime.json`：最终 runtime 版本/PID、冻结源码哈希、门禁计数及实际检查记录。
- `operator-direct-final.png`：修复后最终浏览器截图。

已有点击与安全检查事实保留，但连续悬停流畅度未通过，当前整体直接遥控尚不可验收。
上一轮验收结束时已暂停，连续画面仍可用。长时资源压力、
主动 Wi-Fi AP 掉线/换 IP 恢复、旋转/投屏 STOP/重新授权及其他安卓厂商仍为
NOT RUN。源帧年龄保持三秒并计入传输，坐标截图有效期保持 30 秒。

代码尚未提交或 push；自动化仍为 **PAUSED**。

<details>
<summary>v5 历史：Wi-Fi/连续视频与此前相对遥控交互</summary>

以下记录属于 v5，其中窗口内相对遥控描述不代表当前 v6 的直接画面遥控 UI。

检查时间：**2026-10-17，v5 传输/硬件核心 PASS，直接遥控体验 IN PROGRESS**。
一加手机经内网持续发送 MJPEG，MCP 读取有效缓存帧；电脑已通过 Wi-Fi TCP 连接
真实 ESP，再由 BLE 键鼠控制手机。新固件已构建、烧录，板上选择 Wi-Fi、屏幕
键盘输入密码及控制源租约均已有真机证据。本机浏览器窗口内实时键鼠、实体停止
恢复和 Wi-Fi 坐标标定已有通过证据。但用户随后反馈：开始控制后不能直接点击
画面，hover 模拟鼠标也不跟随。现有窗口内相对遥控回退不满足该预期，默认直接
hover/click 及正确映射正在修订，完整遥控体验尚待重新验收。v4 记录单独保留为
旧 USB 路径的历史证据。

直接遥控体验新修订前，最近已完成 PC 检查：**PASS** — `npm run typecheck`、`npm run build`、
`npm run test:android`（**195/195**，已包含实际操作台脚本 **17/17** 项 VM 回归
及 11 项 HTTP 输入检查，防止慢请求正文跨越 ARM、旧回调误暂停新控制会话）。
日志：`apps/android-mcp/build/host-stream-final-tests.log`。
原生生产 FrameServer/FrameStore socket 测试 **10/10 PASS**。
新 ESP 完整固件门禁 **PASS**，包含 **18 个 C 程序**与 **121 项 Python 检查**；
分段烧录通过，保留 NVS。

| 本轮升级检查 | 结果 |
| --- | --- |
| 一加 8 / IN2010、Android 13 安装新 MJPEG APK | PASS；已覆盖旧 APK，用户已开始投屏，哈希见下方 |
| 真实手机内网 `/stream.mjpg` | PASS；25.011 秒内仅一个 HTTP GET，58 张完整 1080×2400 图片、58 个源帧 ID、32 个图片哈希，零错误 |
| 视频新鲜度与帧率 | 含传输最大有效源帧年龄 617 ms；动态画面某一秒峰值 12 帧，不代表持续达到 12 fps |
| 30 次直接读取最新帧缓存 | PASS；本机缓存方法最大 0.0301 ms |
| 官方 InMemory SDK 读取真实手机内网视频 | PASS；30 张图片，缓存命中调用中位 2.0485 ms/最大 7.8379 ms；输入 mock，零输入报告 |
| 新 HTTP 画面路径，只读 SDK 与 SSE | PASS；10/10 JPEG 截图，10 个 MCP frameId/6 个源帧 ID；调用中位 3.496 ms/最大 8.986 ms。10 秒 SSE 收到 10 张完整帧/10 个源帧 ID，最终源帧年龄最大 486 ms，零错误 |
| 板上 Wi-Fi 列表与屏幕密码键盘 | PASS；用户在板上配网成功；USB 只读状态确认 configured/connected=true、TCP 地址 10.65.201.147:3333 |
| 保留 NVS 烧录后的 BLE | PASS；自动恢复 connected/encrypted/bonded/ready=true |
| 真实 TCP → ESP → BLE 键鼠 | PASS；MOVE (12,-8)、反向移动和中性 KEY；前后内网图片确认指针 |
| 不发送 PING 的 1500 ms 控制租约 | PASS；约 1850 ms 后旧 socket 已关闭，新 STATUS 为 armed=false |
| 主动断开 TCP socket | PASS；200 ms 后 STATUS 为 armed=false |
| 官方 MCP 经 HTTP 与 Wi-Fi ESP 输入 | PASS；主页 93 ms、Tab 320 ms、返回 160 ms、PAUSE 302 ms；截图 4/4/5 ms，最终暂停 |
| 最终服务 Wi-Fi `/remote/input` | PASS；鼠标 (4,-4)、Tab 按下和键盘松开均 HTTP 200，耗时 197.59/222.51/21.925 ms；删除租约后 armed=false/locked=false/ready=true |
| 当前固件实体 DOWN/OK | PASS；DOWN 后 locked=true/armed=false，ARM 返回 LOCKED；用户按 OK 后真实浏览器显示已解锁、暂停，明确 ARM 成功 |
| 此前浏览器窗口内相对遥控检查 | 已观察 PASS：画面点击、Tab、短拖动影响手机，Esc 和移出画面暂停；这些检查不代表新要求的直接遥控体验通过 |
| 开始控制后直接画面 hover/click | IN PROGRESS；用户反馈点击和 hover 跟随不符合预期，默认交互与映射待修正并重新验收 |
| PointerLock 兼容 | IAB Chromium 仍拒绝 PointerLock，已通过窗口内遥控回退兼容该浏览器；不声称其他浏览器已验证 |
| Wi-Fi 路径的 AI 坐标标定 | 1:1 PASS；点按 (540,1200)、(550,1210)，JPEG 圆形指针与预期吻合；首次定位 5062 ms，附近第二次 522 ms |
| 长时 Wi-Fi/BLE 压力与资源余量、主动 AP 掉线/换 IP 恢复、旋转、投屏 STOP/重新授权、其他安卓厂商 | NOT RUN |

纯缓存耗时不包含采集、JPEG 编码或内网传输；InMemory SDK 缓存命中耗时不包含
首次冷读取，且输入为 mock。本地 HTTP SDK 耗时包含 HTTP 传输、服务器缓存读取/
序列化及客户端 HTTP/JSON/SDK 处理，不能当作纯缓存或端到端画面延迟；保守计入
整个 RPC 后源帧年龄最大 1245.58 ms。SSE 源帧年龄已通过同机 `sentAt` 计入传输。
后续官方 HTTP/Wi-Fi 核心输入测试使用了真实硬件，与 InMemory 测试分开记录。
Wi-Fi 首次坐标定位较慢，实测 5.062 秒，附近第二次为 0.522 秒；这些结果不能说明
Wi-Fi 控制在所有操作上都快于 USB。

证据位于 `apps/android-mcp/build/device-tests/`：

- `oneplus-stream-v5.json`：单次 GET 连续视频及 30 次直接缓存读取。
- `oneplus-stream-sdk-v5.json`：真实内网视频/InMemory SDK，零输入报告。
- `operator-stream-http-v5.json`：有界只读 HTTP SDK/SSE；结束后 SDK 关闭，服务继续运行。
- `esp-wifi-configured.json`：USB 只读 STATUS/WIFI_STATUS，无 PING 或输入。
- `esp-wifi-device-v5.json`：真实 TCP 移动、租约到期与断连停用。
- `oneplus-wifi-core.actions.json.results.json`：官方 MCP/HTTP/Wi-Fi 真实硬件操作通过。
- `operator-final-remote-v5.json`：最终重启后的真实 `/remote/input` 与租约释放状态。
- `physical-stop-wifi-v5.json`：当前 Wi-Fi 固件实体 DOWN 锁定、ARM 拒绝；随后真实浏览器确认 OK 恢复。
- `oneplus-wifi-calibration.actions.json.results.json`：真实 Wi-Fi 1:1 标定、两次坐标点按及最终暂停。
- `operator-stream-wifi-final.png`：连续 Wi-Fi 操作台最终浏览器截图。
- `oneplus-stream-motion.actions.json.results.json`：此前视频期间使用旧服务/旧固件的 USB 运动检查。

两次测试脚本写错的失败独立保留，不记为产品故障：
`esp-wifi-device-invalid-test-command.json` 将 MOVE 写成 MOUSE；
`oneplus-wifi-core-invalid-test-argument.json` 将 android_key 的 combo 写成 key。
修正后的测试均通过。

已安装流式投屏 APK SHA-256：
`0a4a6f78aa1a0dfe3ee3dcc2ba6d2469251aa42ea89f5e4ab30fe72633318d1b`。
已安装 Wi-Fi 合并固件 SHA-256：
`8b602a11edf74f123183cd70caa1d5fc6413538dd564259753934ad793aa2f42`。
匹配 ELF SHA-256：
`e2aadeae7e66e7a9f93aa46e00ddd79484367f1572cbeda76f674c0d6fd8d72a`。
本地产物哈希已核对。下方旧 `eee6…` 仅属于 v4 历史，不是当前 Wi-Fi 固件。

最终 Wi-Fi HTTP 服务运行于 PID **42880**，配置为 `ESP_HOST=10.65.201.147`、
TCP 端口 3333，健康检查为 `runtimeVersion=2`，服务不占用 COM5。重启已在用户
明确授权后由同一 PowerShell 严格核验目标进程执行，此前自动审批拒绝保留为历史
记录。当前服务保持暂停；传输/硬件证据仍有效，但完整遥控体验须先修正并复验。
NOT RUN 项仍为额外覆盖边界。

代码仍在 `codex/android-agent`，尚未提交或 push；自动化仍为 **PAUSED**。
源帧年龄限制为三秒并计入传输，坐标截图有效期仍为 30 秒，未放宽限制。

<details>
<summary>v4 历史验收：旧版 USB ESP 固件与 HTTP 操作台</summary>

以下为上一轮检查点，保留作为历史证据；其中“当前”均指 v4，不能替代当前 v5
构建的验收结果。

检查时间：**2026-10-17**。手机安装 MediaProjection 投屏 App，经 Wi-Fi 内网发送
原始分辨率 JPEG；电脑提供 MCP 图片和工具，通过 USB 串口连接 ESP32-C3，再由
BLE 键鼠控制手机。运行时手机无需 USB 或 ADB。App 与本机 MCP HTTP 服务均无需
令牌或 Authorization 请求头；MCP HTTP 仍只监听本机，并检查 Host/Origin。

构建与主机检查：**PASS** — `npm run typecheck`、`npm run build`、
`npm run test:android`（**144/144**）与 `npm test`（**35/35**）。
完整隔离 ESP-IDF 固件门禁通过，包含 **14 个 C 程序**与 **116 项 Python 检查**；
APK v2/v3 签名验证通过。主机回归覆盖官方 SDK 会话释放、取消、截图守卫、JPEG
尺寸与截断、串口冷连及操作台异步竞争。坐标操作出队时重新检查截图；源帧年龄
继续限制为三秒并计入传输时间，坐标截图有效期仍为 30 秒。

黑客松核心演示路径：**PASS**。真实 **一加 8 / IN2010、Android 13** 已通过内网
JPEG → MCP → BLE HID 链路；本检查点未覆盖所有恢复路径或其他安卓厂商。

| 当前真机检查 | 结果 |
| --- | --- |
| 无令牌 JPEG 签名 APK 安装与系统投屏授权 | PASS；安装 APK 与下方哈希一致，用户已确认投屏授权 |
| 真实手机内网画面 → 接收端 → MCP 原生图片/操作台 | PASS；1080×2400 原始尺寸、`image/jpeg`，手机 USB 断开仍可工作 |
| 无令牌传输 | PASS；不发送 Authorization 时 `/frame.jpg` 返回 200，旧 `/frame.png` 返回 404 |
| BLE 加密、绑定、HID 就绪、主页、键鼠输入与暂停 | 已观察操作 PASS |
| 当前固件中文 LCD 显示 | 用户确认中文正常、无乱码；代理未实际目视检查实体 LCD |
| 桌面静置 16 秒，再间隔 1 秒串行读取 30 次 | PASS；30/30 新鲜、30 个不同源帧，无超时或过期拒绝；详细统计见下表 |
| 当前中文固件连续校准点按 | PASS；同一官方 HTTP MCP 会话、1:1 标定：(540,1200) 首次耗时 1859 ms，随后 (550,1210) 为 188 ms、(560,1220) 为 169 ms；每次 JPEG 确认指针位置，最后 PAUSE |
| 当前中文固件实体 DOWN 锁定、ARM 拒绝、板上 OK 恢复 | PASS；DOWN 后 locked=true/armed=false，ARM 返回 LOCKED；用户按 OK 后明确 ARM/主页操作成功，官方 SDK 随后确认 locked=false |
| 真实浏览器操作台响应与最终暂停 | PASS；无需令牌输入框、自动连接，明确 ARM 后后台截图期间主页按钮仍启用且执行成功，最后 UI 暂停/释放成功 |
| 当前 APK 运行时旋转、STOP 与重新投屏授权 | NOT RUN；此前模拟器尝试被自动审批审核拒绝，仅返回 blocked by policy，不声称当前真机已验收 |
| Wi-Fi 断开/恢复、地址变化、ESP USB 拔插恢复、其他安卓厂商 | 当前构建尚未验证 |

桌面 JPEG 采样使用下方 APK，保持默认 3000 ms 新鲜度限制，并计入图片正文传输。
30 张均通过 JPEG SOF、分段、SOS 与完整 EOI 结尾结构校验，尺寸均为 1080×2400。
静止桌面产生两个内容哈希，App 源帧 ID 有 30 个；未用 HTTP 返回时间伪造新鲜度。

| 桌面 JPEG 指标 | 最小 | 上中位数 | 最大 |
| --- | ---: | ---: | ---: |
| 图片字节数 | 197672 | 197691 | 197691 |
| HTTP 响应头中的源帧年龄（ms） | 50 | 624 | 1065 |
| 含正文传输的最终源帧年龄（ms） | 99 | 703 | 1260 |
| 单次截图请求耗时（ms） | 131 | 240 | 589 |

上中位数取 30 个样本排序后的第 16 项，与保存的 JSON 汇总一致。

本地证据：`apps/android-mcp/build/device-tests/oneplus-wallpaper-jpeg-v4.json`
与 `oneplus-wallpaper-jpeg-v4-last.jpg`；同目录连续点按证据为
`oneplus-chinese-nearby.actions.json.results.json` 和 `oneplus-chinese-tap-*.jpg`。
此前 PNG 和模拟器记录仅作历史证据，其中连接码/401 检查不代表当前产品合同。
当前实体停止证据为 `oneplus-chinese-physical-stop.json`；浏览器证据为
`operator-no-token-final.json` 与 `operator-no-token-final.png`。随后
`oneplus-chinese-recovery.actions.json.results.json` 确认加密/绑定/就绪，
locked=false/armed=false，真实 JPEG 有效且最后 PAUSE。

此前真机还验证过 MITM 配对、100 ms 鼠标节拍及停止 PING 1.8 秒后看门狗停用输入。
这些不能替代当前构建的恢复测试。

当前中文合并固件 SHA-256：
`eee6d19893483eb6ad38e64cfe280fa607ec17ad060818be9ab4fc314c40dcb1`。
匹配 ELF SHA-256：
`8c7c575762bd9f596a4a93f3f6a7bda665650f7f133aeb6747c00444d84b1775`。
已将验证过的分段镜像烧录到 COM5 的 0x0、0x8000、0x10000，保留 NVS 地址范围及
蓝牙绑定，未执行整片擦除。

已安装签名 APK SHA-256：
`94458e41878fdaac309e6103ab0080504aa1e46a48e557e947a38f790539da89`。
固件产物位于 `apps/esp/build/firmware/<hash>/`，APK 位于 `apps/android-screen/build/`；
日志、截图、本地配置及签名密钥保持 Git 忽略。

当前运行的本机 MCP 服务已包含无令牌、JPEG、操作台与输入优化。最新串口冷连
修复已编译并通过主机测试：仅首次中性握手 PING 的 ACK 超时允许再试一次，输入与
ARM 均不重发；下次服务重启才会生效。本轮本机 MCP 重启被自动审批审核拒绝，
因此不声称当前进程已启用该修复，也未绕过审核。

代码位于 `codex/android-agent`，本轮增量尚未提交或 push。定时自动化已实际
**PAUSED**。剩余真机检查为上表的未验收与未验证项目。

</details>

</details>

</details>

</details>

</details>
