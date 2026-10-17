<p align="right">
  <strong>简体中文</strong> · <a href="README.md">English</a>
</p>

# 资源目录（Assets）

本目录集中存放可复用的资源（字库、图片、音乐等），按资源类型分子目录管理。每个资源放在其类型对应的子目录，并记录放置路径、命名方式、集成方式与来源/许可。二进制资源（字体、图片、音频）不属于纯 markdown 文档，请勿与文档混放。涉及版权/授权的资源需注明来源与许可。

## 字库（fonts）

可复用的字库文件与生成的字库源码放在 `fonts/`。

- 命名要能反映字族、字重、字级与格式。
- 记录来源、许可、字符范围、转换命令与目标放置路径。
- 添加字库前评估 Flash 与内部 RAM 影响；ESP32-C3 无 PSRAM。
- 不提交许可不允许分发的字库。

### QDD 中文控制器字体

`fonts/qdd_cjk_14.c`、`fonts/qdd_cjk_20.c` 是应用位图子集，源自 LVGL **9.5.0**
随附的 Source Han Sans SC Normal OTF。使用 **SIL OFL 1.1**，Adobe 版权声明和
完整许可见 [`fonts/OFL-SourceHanSans.txt`](fonts/OFL-SourceHanSans.txt)，派生字体
符号使用 QDD 名称。源字体来自固定版本托管依赖，不另复制一份 16 MB OTF。
上游地址、源文件 SHA-256、转换器版本和生成文件哈希记录在
[`fonts/qdd-fonts.json`](fonts/qdd-fonts.json)。

托管依赖已就绪后，在 `apps/esp/` 运行 `node tools/generate_qdd_fonts.mjs` 可重现。
使用官方 `lv_font_conv@1.5.3`、4 bpp、不压缩、不使用字距表。两种尺寸覆盖可打印
ASCII U+0020..U+007E 的全部 95 个字符，以及从界面、配网模型和应用反馈收集到的 222 个非 ASCII 字符，清单见
[`fonts/qdd_glyphs.txt`](fonts/qdd_glyphs.txt)。实际行高为 **17/24 px**，不能按名义
14/20 px 排版。CMake 各编译一次，每个标签显式选择字体。位图与描述以常量放在
Flash，未引入运行时字体加载、完整 CJK 字库、PSRAM，也未扩大显示缓冲。

界面支持固定中文提示及完整可打印 ASCII 密码键盘。扫描到的 SSID 保留原始
32 字节 UTF-8 名称用于连接；已覆盖字形正常显示，长名称仅在屏幕上缩短。
无法显示的名称明确使用“网络序号 + BSSID 后四位”，不显示缺字方框。
不提供任意中文手动输入。
`tests/test_qdd_fonts.py` 检查源码清单漂移、cmap、缺字负例、哈希和字体绑定。
`tests/qdd_ui_host/` 使用真实 LVGL 9.5 字形查询和 RGB565 渲染，验证主界面、连接助手、按键指南与配网状态、
标签换行/高度、无文字三段提示条像素、增量/整帧重绘一致性、30 px 圆角遮罩及 24 KiB 池下重复刷新不新增分配、不触发刷屏。
实体屏幕字形、BLE 运行时系统剩余堆和最大连续块仍需单独真机检查。
配置好原生 C/C++ 编译器和 CMake 后，在 `apps/esp/` 执行
`cmake -S tests/qdd_ui_host -B build/ui-host`、`cmake --build build/ui-host`。
从已忽略的输出目录运行 `qdd_ui_host`（Windows 加 `.exe`），传入 `qdd_glyphs.txt`
绝对路径，即可生成 PPM，并输出字形、布局、内存和刷新检查结果。
右侧固定三段主题色提示条与键盘使用自绘；键盘保留四行，避免为每个按键创建 LVGL 控件；重置页加入前已测的 24 KiB 池峰值为 17,080 字节；本次按要求跳过测试，新重置页的运行时内存尚未验证。
主界面与配网页面状态不变时不分配、不刷屏；一百二十次页面切换保持相同活跃分配数，
分配器对齐带来的有界循环保持稳定。

## 图片（images）

可复用的源图与生成的显示资产放在 `images/`。

| 文件 | 尺寸与格式 | 用途与来源 |
| --- | --- | --- |
| [`images/home.jpg`](images/home.jpg) | 3840 × 2160，JPEG | 嵌入中英文项目 README 的产品主图，突出 AI Passport 产品形象与开放、人人可创作的理念。 |
| [`images/readme-hardware-specs.png`](images/readme-hardware-specs.png) | 2172 × 724，PNG RGBA | 保留为可选技术参考图，不再用于首页主视觉。于 2026-09-17 使用内置图像生成工具为本仓库生成；已根据文档中的硬件能力契约核对图中的六项标签与参数。 |
| [`images/logo-wordmark.png`](images/logo-wordmark.png) | 1648 × 336，PNG RGBA | 从仓库原始 `images/logo.png` 中精确裁切并去除背景的黑色字标；用于中英文项目 README 的浅色主题。 |
| [`images/logo-wordmark-dark.png`](images/logo-wordmark-dark.png) | 1648 × 336，PNG RGBA | 提取字标的白色版本；README 使用 `<picture>` 在 GitHub 深色主题下显示。 |

- 使用描述性命名，并记录尺寸、像素格式、转换步骤与目标路径。
- 优先采用适合 240 × 320 RGB565 显示的格式，并纳入 Flash 与内部 RAM 考量。
- 许可允许时保留可编辑源文件，并记录来源与许可。
- 图片中不得包含设备二维码秘密、凭证或个人数据。

## 音乐与音效（music）

可复用的音乐与音效源码放在 `music/`。

- 记录来源、许可、采样率、位深、声道、转换命令与目标路径。
- 与当前 BSP 音频路径匹配时优先采用 16 kHz、16 位单声道 PCM。
- 嵌入音频前评估 Flash 与内部 RAM 成本；长录音应流式或分块。
- 无再分发许可不提交媒体文件。
