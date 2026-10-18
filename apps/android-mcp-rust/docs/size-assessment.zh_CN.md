# 体积评估

[English](size-assessment.md)

2026-10-18 在 Windows x64 上实测。方案为 ESP 保存下载文件，电脑下载后执行。
精确字节数、哈希、构建及验证身份保存在[size-assessment.json](size-assessment.json)。

## 实测产物

| 产物 | 字节数 | MiB |
| --- | ---: | ---: |
| 当前 Node 桌面 EXE | 95,678,464 | 91.246 |
| 当前 Node EXE ZIP | 36,142,076 | 34.468 |
| 建包前的 Rust 依赖/图片处理小样 | 1,027,584 | 0.980 |
| 完整 Rust release EXE | 1,863,168 | 1.777 |
| 完整 Rust release ZIP | 903,569 | 0.862 |

完整原生 EXE 比实测 Node 版缩小 **98.05%**。依赖小样只用于判断
迁移是否值得进行；最终产物已包含冻结基线的 22 个工具、HTTP/SSE 与 stdio MCP、
WebSocket 远控、TCP/USB HID、JPEG/PNG 目标预览、设置/发现及可取消的原生 HTTPS。

构建：`rust-6cd85079fe3bd5e6`。

EXE SHA-256：`9e0f2828471dbf1a3ca376cb8d6898c6ce6238cabe8fe67afa48a48ce4d44c66`。

ZIP SHA-256：`d99a2559cade6de351f91262fd4e3246c67d2fb2aad6f0791d519e8462ae6fc7`。

PE 导入表仅发现 Windows 系统 DLL，没有需要额外分发的 Node、Rust、VC 运行库、
OpenSSL 或浏览器 DLL；空 PATH、空目录及中文/空格路径启动场景也已通过。

## ESP 容量预算

08:56 读回的 v39 设备分区表为双 OTA，每槽 3,080,192 字节，另有 2,097,152 字节
的 assets 分区。当前匹配应用为 1,666,016 字节，已含手机 APK，应用槽因此还余
1,414,176 字节。这里使用真实设备的分区与刷写记录，不能套用仓库单 factory 默认表。

| 存储方式 | 可用容量 | 文件大小 | 剩余 |
| --- | ---: | ---: | ---: |
| 原始 EXE 嵌入当前应用槽 | 1,414,176 | 1,863,168 | 放不下 |
| 原始 EXE 存入 assets 分区 | 2,097,152 | 1,863,168 | 233,984 字节，228.5 KiB |
| ZIP 嵌入当前应用槽 | 1,414,176 | 903,569 | 510,607 字节，0.487 MiB |

原始 EXE 方式适合“下载后双击”，需要先确认 assets 中的旧内容，再实现 ESP 下载
入口。ZIP 方式能放进当前应用余量，无需更改分区，但电脑上需要解压。两种方式还应
给资源清单和新增固件代码留空间；已测容量不代表 assets 中旧数据为空。

ESP 可以从 Flash 分块读取并发送，不需要把整个程序装进 SRAM。ESP-IDF 提供
[分区读取](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/storage/partition.html)
和 [HTTP 分块发送](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/protocols/esp_http_server.html)。
现有固件已有较小的手机 APK 下载实现，电脑程序的多 MiB 下载链路本轮尚未实现或测量。

## 验证与边界

- Rust 58 项测试通过，包含真实回环 TLS 的慢握手/慢响应取消。
- 打包 EXE 使用官方 MCP SDK 完成冻结的 17 项验收场景。
- TypeScript typecheck/build、Rust 全目标检查和格式检查通过。
- Windows 分段 HTTP 请求回归在旧 socket 模式下失败，显式恢复阻塞模式后通过；
  对应 [Microsoft 的 accepted socket 行为说明](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-accept)。
- 没有真实手机输入、ESP 刷写，也没有实现 ESP 存储/下载入口。

原生程序可进入独立真机验收，真实 BLE 时序、物理指针精度和 ESP 下载时的无线并发
尚未验证。TLS 测试使用公开测试密钥，其 Windows 夹具行为见
[测试说明](../tests/fixtures/README.md)。
