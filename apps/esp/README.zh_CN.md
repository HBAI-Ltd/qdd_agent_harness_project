<p align="right">
  <strong>简体中文</strong> · <a href="README.md">English</a>
</p>

# AI Passport 固件子包

`@qdd/esp` 将 FoloToy AI Passport 的 ESP32-C3 硬件测试基线集成到当前 npm
monorepo。目标硬件为 8 MB Flash、无 PSRAM，使用 ESP-IDF **5.5.3**。
这个基线用于后续固件开发，目前尚未连接钱多多助手。

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
- 许可证：[MIT，Copyright (c) 2026 FoloToy](LICENSE)，保留上游许可证与署名。
- 源码放在 `apps/esp/`，没有嵌套 `.git`。初次集成保留上游 `main/`、BSP、分区表
  和依赖声明。
- 本地集成新增这对 README、npm workspace manifest、已忽略的本机环境配置、
  Windows IDF wrapper 和根 npm 入口。统一验证工具也支持原生 Windows Python、
  IDF 路径和 Windows actionlint 发行包。
- 后续更新上游时，需要结合固定 commit 和 `dependencies.lock` 审查本地集成修改。
  子目录中的上游 GitHub workflows 不会自动成为 monorepo 的工作流。
