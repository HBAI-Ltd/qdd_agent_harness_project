# Android HID 操作技能 · v2 服务端适配版

> 适用：通过 ESP32 BLE 键鼠桥（qdd-android-hid MCP）操作 Android 设备。
> 本版针对 **MCP 服务端 v2**（本机 `http://127.0.0.1:8792/mcp`）重写。
> 与旧版最大的区别：**每个动作必须拆成"定位"和"点击"两个阶段，光标没到位绝不点击。**

---

## 零、统一方法：先认状态，再闭环操作

完整原则见 [METHODOLOGY.md](METHODOLOGY.md)，随本技能默认加载。以下要求适用于点击、导航及文字输入，设备相关历史参数仅作参考：

- **先建设备画像**：换设备、旋转或重新连接后核对分辨率/旋转、增益、线性位移区间、光标可见性、渲染偏移、点击后指针变化、滚动方式及系统手势/Dock 遮挡区。校准值为 `1/增益`，优先用服务支持的无点击测量，不直接沿用下方旧设备示例。
- **先认页面状态**：用顶栏、作者栏、底栏等稳定锚点判断当前页面，再选目标。列表、推荐和轮播目标必须根据新帧现测，并核对标题/作者等唯一信息。
- **三层交叉观测**：坐标回读用于比较，目标点的原分辨率局部裁剪用于确认控件，整屏用于确认状态；需要时用帧差观察真实光标，排除旧位置残影。`positionEstimated` 为 true 时，坐标只是估计，不能单独证明物理落点。
- **点击前双图确认**：必须看到新鲜整屏和目标局部放大图，十字压在目标可点区域内；边缘裁剪的十字应按 `(目标坐标 - crop 原点) × scale` 定位，不能画在裁剪图中心。`android_preview_tap` 仅预览目标、不发送 HID；当前接口要求时传最新 `frameId`，并区分模拟标记与真实指针。无法取得双图或可靠定位依据时停止点击，报告缺口。
- **失败先分类**：区分链路、未武装、定位和页面状态变化。只有明确证明动作未开始/未派发才允许重新执行；已开始但效果图失败时只重新观测。发送、评论、发布、支付等非幂等动作结果不确定时绝不补动作，中文输入 `uncertain` 同样只回读。
- **每次保留证据**：点击前整屏与局部确认图、点击后效果图、判读用的计数/文案/锚点。报告按“期望状态 → 实际状态 → 差别 → 分类 → 下一步”组织，不以 `completed` 或 ACK 代替效果证明。

---

## 一、铁律：定位与点击必须分开

任何一次点击都走完这五步，**不可合并、不可跳步**：

```
① 定位      android_mouse_move / hover   只移动，不点击
② 双图确认  ★必做：新整屏 + 目标局部放大图 → 读坐标/估计状态 → 核对控件、十字与页面锚点
③ 重新校准  cal（移动会清掉校准，点击前必须复位）
④ 点击      android_mouse_click()        原地点击，不移动
⑤ 验证      截图 → 确认效果出现（计数/页面/状态）
```

> ② 是**硬性前置条件**：每次点击、每次文字输入之前，都必须重新截一张图确认光标位置。
> 不复用旧截图（光标静止数秒会被系统隐藏，旧图的 `pointer` 也是上一状态），
> 同时满足才算“已确认”：**新鲜整屏仍为目标页面 + 新鲜局部图十字压住可点控件 + 有依据的定位/校准**。容差按控件大小及本机实测误差确定，下文 30–40px 仅为旧设备示例。

> ③ 是**独立的、不可省略的一步**，不是①的附属动作。
> 原因：相对移动会让服务端把 `calibrated` 复位为 false、`scaleX/scaleY` 变 null，
> 而点击依赖有效校准——少了这一步，点击会被静默丢弃。

### 明确禁止

| 禁止项 | 原因 |
|---|---|
| **跳过②的截图确认就点击/输入** | 本技能最高优先级的硬规则；连"看起来已经到位"也要重新截图 |
| **复用上一轮截图当确认依据** | 光标会静止隐藏，旧图 `pointer` 已过期，等于没确认 |
| `android_tap(x, y)` 直接命中 | 内部是"移动+点击"一体，无法在点击前确认落点 |
| `android_control action=tap` | 同上 |
| 未截图就点击 | 光标位置靠推算，累积误差可达数百像素 |
| 用固定坐标/记忆坐标直接点 | 同上 |
| 点击后不验证就继续 | `actionCompleted: true` 只代表指令下发，不代表事情发生 |

### 校验不通过怎么办

- 落点偏 → **回到①重新定位**，不要"先点了再说"
- 每次点击前均使用当前服务支持的目标预览取得整屏和局部图；不渲染光标时，明确说明“十字为模拟目标，未目视确认真实指针”，结合服务支持的实测校准建立定位依据，不能用模拟标记替代物理位置证明。
- 连续两次定位失败 → 停止，报告，不要盲点

### 校验用坐标，不用肉眼找光标（v2 实测）

服务端会回报指针坐标，两个地方都能读到：

```json
# android_screenshot 的返回
"input": { "pointer": {"x": 999.0, "y": 600.0}, "positionEstimated": true,
           "calibrated": true, "scaleX": 1.0, "scaleY": 1.0 }

# android_control 任意动作的 actionResult 里
"pointer": {"x": 999.0, "y": 600.0}
```

**做法**：`hover(x, y)` → 重新观测整屏及目标局部图 → 读 `input.pointer` 和 `positionEstimated`，按本机误差及控件大小比较 → 同时通过页面状态、控件和定位检查才点击。

> 为什么不能靠截图找灰圈：**Android 会在指针静止数秒后自动隐藏光标**。
> 稍慢一步截图，光标就消失了，会被误判成"没移到位置"。
> 实测曾在同一位置反复"纠正"，实际上指针早已到位。

---

## 二、坐标与校准

### 关键事实

| 事实 | 说明 |
|---|---|
| 命令接收**全分辨率像素** | 预览图坐标必须乘缩放比（预览 838 宽 / 真机 1080 → ×1.289） |
| 校准值 = **每像素计数** = 1/增益 | 手机 1:1 填 `1 1 0`；2 倍增益平板填 `0.5 0.5 0` |
| `android_mouse_move` 的 dx/dy 是**原始计数**，不受校准影响 | 只做相对位移时可以不校准 |
| `android_tap` / `android_mouse_click` 需要**有效校准** | 校准为 null 时点击会被静默忽略 |

### 校准会被动作清掉（v2 实测）

相对移动之后，返回里常见：

```json
"calibrated": false, "scaleX": null, "scaleY": null
```

因此**校准是紧挨点击的独立步骤**，而不是任务开始时做一次就完事：

```
cal → 定位 → 截图校验 → **cal（第二步校准，独立执行）** → android_mouse_click
```

**判定标准**：点击前读一次状态（截图返回体的 `input` 或 `android_hid_status`），
必须同时满足 `calibrated: true` 且 `scaleX/scaleY` 非 null，否则先 `cal` 再点。

> 实测有效的最小配方：`cal 1 1 0` 之后**立即**点击，中间不插入其它动作。

### 设备档案

| 设备 | 分辨率 | 增益 | 校准值 |
|---|---|---|---|
| OnePlus IN2010（手机） | 1080×2400 | 1:1 | `cal 1 1 0` |
| LENOVO TB322FC（平板） | 1904×3040 | 2:1 | `cal 0.5 0.5 0` |

> 手机存在**指针加速**：单次位移超过约 130 计数会被放大 ~1.6 倍。定位时单步不要超过 120 计数。

### 屏幕边缘是不稳定区（v2 实测）

在 **y < 300 的顶部区域**做小步相对移动会被边缘钳制吸附，实测出现过：给"向上 −145"结果更深地贴到 y≈39；连续微调后光标直接不可见。

对策：**边缘控件用绝对定位 `hover(x, y)` 一步到位**，不要用相对小步逼近。
若 `hover` 也落偏，则以 `input.pointer` 为准判断是否真的偏了（见上节，光标可能只是被隐藏）。

---

## 三、v2 变更清单（务必先读）

| 变更 | 影响与对策 |
|---|---|
| **JSON-RPC 请求 ID 去重** | 重复 id 返回 `This MCP tools/call request id was already used; the action was not dispatched again`。客户端必须**每次生成唯一 id**（UUID），不能用进程内自增 |
| `android_status` → **`android_hid_status`** | 旧名返回空 `{}` 而不报错，极易误判"设备正常" |
| 状态并入截图响应 | `android_screenshot` 返回体的 `input` 字段含 `armed / calibrated / scaleX / scaleY / pointer`，可直接读 |
| 新增 **`android_key_report`** | 发送原始键盘报告，`keycode=0` 才释放 → **这是唯一能长按键盘的途径** |
| 新增 **`android_mouse_move(buttons=…)`** | 移动时可按住鼠标键，用于拖拽/连续挖掘 |
| 新增 **`android_release`** | 一次性释放所有按住的键与鼠标键；长按后必须调用 |
| 新增 **`android_hid_pause`** | 立即取消排队输入并释放，用于失控时急停 |
| 新增 **`android_mouse_click`** | 原地点击，**不移动不假设坐标** —— 铁律第③步就用它 |

---

## 四、返回体解析

`structuredContent` 不一定是全的，**数据常只在 `content[0].text`（JSON 字符串）里**。

```python
sc = r.get('structuredContent') or {}
if not sc:
    for c in r.get('content') or []:
        if c.get('type') == 'text':
            sc = json.loads(c['text']); break
```

---

## 五、失败分类（先判因再决定）

| 返回文本特征 | 真因 | 处置 |
|---|---|---|
| `timed out`（hid_status/arm） | 板子不可达（BLE 或 ESP_HOST） | 停止操作，要求重新配对/检查地址 |
| `This MCP tools/call request id was already used` | 请求 id 重复 | 先核查旧请求是否已派发；旧动作不确定时只回读。仅确认未派发或用户明确要求新的动作时使用新 id |
| `Coordinate actions need explicit calibration` | 校准丢失 | 恢复校准并重做双图确认；仅明确未派发时重新执行 |
| `pointer not detectable at (0, 0)` | 归零后零点无指针｜闭环定位不可用 | 检查服务支持的无点击校准/移动观测；不能退回未经确认的 `tap` 或盲点 |
| `input is paused` / `Call ARM explicitly` | 板子空闲自动解除 | `armed` 检查 → `android_hid_arm` |
| `PING/MOVE acknowledgement timed out` | 蓝牙链路抖动 | **不要重放**，等链路恢复 |
| `Screenshot is missing or superseded` | 帧过期 | 重新取帧并认状态；动作是否可重新执行仍取决于原动作是否明确未派发 |

> 经验：**"点了没反应"绝大多数不是 App 的问题**，而是 校准丢失 / 未武装 / 链路超时 / 点击被合并成拖拽 四者之一。

---

## 六、输入能力边界（实测）

| 能力 | 可用性 |
|---|---|
| 鼠标移动 | ✅ 稳定 |
| 鼠标左键单击 | ✅ 可用（需校准有效） |
| 鼠标按钮**按住** | ✅ 通过 `android_mouse_move(buttons=…)` |
| 键盘单键/组合 | ✅ `android_key` |
| 键盘**长按** | ✅ 仅 `android_key_report` + `keycode=0` 释放 |
| 文本输入 | ✅ `android_type` 支持英文及中文；中文经新版 ESP 加密 BLE 文本通道 + 手机 QDD 输入法输入 |
| 字符重复 | v2 已明显改善，但仍需**回读输入框校验** |

> 中文输入：先确认配套新版 ESP 固件、手机投屏 App 和 QDD 输入法已就绪，用户已启用并选择 QDD 输入法，且目标可编辑输入框已聚焦。直接调用 `android_type({text:"淮北采耳店"})` 或 `android_control({action:"type",text:"淮北采耳店"})`，不再默认改用拼音或手写。非 ASCII 文本须为合法 UTF-8、无 NUL，整串最多 512 字节（不是 512 个汉字）。
>
> `textTransfer.status:"accepted"` 只代表手机输入 API 接受，仍须重新截图回读目标输入框；`uncertain`、超时或断线时先观察，禁止自动重发。缺少固件/IME 或焦点时按实际错误处理，不把它判断为“不支持中文”，也不擅自回退到 ADB 或网络远程输入。

---

## 七、返回/导航

只用**三大金刚键**，禁止页面内箭头与边缘手势：

| 用途 | 工具 |
|---|---|
| 返回 | `android_back` |
| 桌面 | `android_home` |
| 任务 | 最近任务（`android_consumer_report` 对应 usage） |

被应用吞掉时按 `返回 → Home → 最近任务 → 报告` 逐级升级，**不得退回页面内箭头**；连续两次无效即停止。

---

## 八、节奏参数

| 场景 | 参数 |
|---|---|
| 点击前静置 | ≥ 0.35s（防移动与按下合并成拖拽） |
| 动作后验证等待 | ≥ 1.2s（等界面稳定再截图） |
| 连续 swipe 间隔 | ≥ 250ms（否则固件丢指令） |
| 单步位移上限 | ≤ 120 计数（避开指针加速） |

---

## 九、标准操作循环（伪代码）

```python
def safe_click(target_xy):
    expected_state = recognize_page(screenshot())
    # ① 定位（只移动）
    move_relative_toward(target_xy)      # android_mouse_move, 单步上限取本机实测线性区间
    # ② 校验（必须在点击之前）
    full, crop, metadata = fresh_target_preview(target_xy)  # 当前接口要求时使用最新 frameId
    if not same_page_state(full, expected_state) or not target_control_under_crosshair(crop):
        return observe_and_relocate_or_abort()      # 只观测/定位，不补点击
    if not positioning_supported_by_evidence(metadata):  # 模拟十字不证明真实指针位置
        return abort_with_evidence_gap()
    # ③ 重新校准（独立步骤：移动已把它清掉）
    ensure_calibrated_from_measured_profile()  # 使用本机实测值，不套用旧设备参数
    assert state.calibrated and state.scaleX is not None
    # ④ 点击（原地，不移动）
    android_mouse_click()
    # ⑤ 验证
    sleep(1.2)
    after = screenshot()
    save_evidence(full, crop, after)
    return verify_expected_change(after)           # 不确定时只回读，绝不补动作
```

---

## 十、速查卡

```
铁律    定位(只移动) → ★截图确认光标 → 重校准(独立步) → 点击(原地) → 验证(截图)
截图    每次点击前必看新整屏+目标局部图；十字压住可点控件，页面锚点仍一致
禁止    android_tap/click 直接命中；跳过截图确认就操作
校验    pointer 可能是估计；模拟十字不是物理落点证明；容差按本机及控件大小设置
校准    动完就失效 → 点前必须单独执行一次 cal；手机 1 1 0 / 平板 0.5 0.5 0
边缘    y<300 区域小步移动会被吸附 → 用绝对 hover 一步到位
id      每次唯一 UUID，否则被判定重放
状态    android_hid_status（不是 android_status）；也可读截图的 input
长按    只有 android_key_report + keycode=0 能实现
返回    系统 Back → Home → 最近任务；每步等待并观察，不盲重发 Back
判因    链路/未武装/定位/状态；只在明确未开始时重试，非幂等结果不确定只回读
留证    点击前整屏+局部图、点击后效果图、计数/文案；参数不得跨设备沿用
```
