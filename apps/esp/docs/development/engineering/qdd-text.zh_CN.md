<p align="right"><strong>简体中文</strong> · <a href="qdd-text.md">English</a></p>

# Unicode 文本通道

可选的手机输入法通过控制板已加密、绑定的 BLE 链路，将有界 UTF-8 文本提交给
Android 当前编辑框。ASCII 保留原 HID 键盘路径。启用并选中输入法、聚焦编辑框
都需要用户在手机上主动完成。该通道不读取编辑框正文，不使用剪贴板、无障碍或 ADB 输入。

## 控制板协议

USB/局域网的单行上限保持 128 字节。请求 ID 为正的有符号 32 位十进制数。
传输 ID 是非零无符号 64 位数，固定编码为 16 个十六进制字符，在同一编辑 epoch 内严格递增。

```text
QDDTXT/1 <requestId> BEGIN <transferId> <editorEpoch> <utf8Bytes>
QDDTXT/1 <requestId> DATA <transferId> <offset> <hexBytes>
QDDTXT/1 <requestId> COMMIT <transferId>
QDDTXT/1 <requestId> STATUS <transferId or 0>
QDDTXT/1 <requestId> CANCEL <transferId>
```

`BEGIN` 为当前非零编辑 epoch 预留唯一一份 1–512 字节的传输。
`DATA` 在连续偏移接收 1–24 字节；已收片段完全相同的重复是幂等操作，缺口和覆盖则拒绝。
`COMMIT` 要求正文完整、严格 UTF-8 且不含 NUL，只排队而不等待手机回复。
重复 COMMIT 只返回已有状态，绝不再次提交。

所有修改命令需要当前 USB/局域网 owner、有效 PING 租期、显式 ARM、已加密/绑定且核验
16 字节链路密钥的 HID 就绪状态，且控制板未锁定、不在设置中。文本命令不会隐式 ARM。
`STATUS` 是只读查询，不抢占 owner。原 1500 ms 控制看门狗及 1200 ms 主机 ACK 截止不变。

成功回复包含 `id`、`status`、`editorEpoch`、`ready`、`received`、`bytes`。
状态为 `idle`、`receiving`、`queued`、`sending`、`awaiting_ack`、`accepted`、
`rejected`、`uncertain`、`cancelled`。`STATUS 0`（也接受 Rust 客户端的 16 个十六进制零）返回当前编辑 epoch 和最近传输 ID；
指定 ID 返回该次传输原始 epoch。更早被替代的 ID 返回 `STALE_TRANSFER`。
queued/sending/awaiting_ack 保留完整字节计数；终态清除正文，字节计数归零。

PAUSE、急停、owner 丢失、断连或编辑焦点/epoch 变化会清除待发正文。
接收中失焦为 rejected；已排队或可能已送达为 uncertain。相同 ID 和原 epoch 的晚到手机 ACK
可以将 uncertain 收敛为确定结果，但绝不重放。accepted 不因后续失焦改变。
手机结果窗口从排队开始为 10 秒；可能提交之后不重发正文或 COMMIT。
accepted 仅代表 InputConnection 接受了提交 API，还需新鲜真实投屏图验证目标页面效果。

## BLE 数据帧

新服务追加在原 HID/电池/设备信息服务后，保留原句柄顺序。
使用标准 Service Changed 通知已绑定客户端，保留配对数据，不调用隐藏缓存刷新接口。

- 服务：`9bded201-39ba-4a19-8ff7-25c9d00a0001`。
- 控制板 indication：`9bded201-39ba-4a19-8ff7-25c9d00a0002`。
- 手机加密 write：`9bded201-39ba-4a19-8ff7-25c9d00a0003`。

配对改为显式开启配对窗口内的 Just Works，无需输入数字 PIN，仍要求加密、绑定和
16 字节链路密钥。`authenticated` 如实报告 MITM 标志；正常 Just Works 连接可为 false。
保留已有配对。首次配对和旧绑定恢复仍需手机实测，主机通过不代表真机验收。

每帧以版本字节 1 和下表类型字节开始，整数均为小端。BEGIN/DATA 只需 ATT 确认。
手机业务 ACK 在 COMMIT 后返回，即使 commitText 同步切换焦点，也携带原传输 epoch。

| 类型 | 方向 | 后续字段 | 总字节数 |
| --- | --- | --- | ---: |
| 01 BEGIN | 控制板 → 手机 | id64、epoch32、length16 | 16 |
| 02 DATA | 控制板 → 手机 | id64、offset16、正文 | 12 + 正文字节 |
| 03 COMMIT | 控制板 → 手机 | id64、epoch32 | 14 |
| 04 CANCEL | 控制板 → 手机 | id64 | 10 |
| 81 READY | 手机 → 控制板 | epoch32 | 6 |
| 82 ACK | 手机 → 控制板 | id64、status8、epoch32 | 15 |
| 83 NOT_READY | 手机 → 控制板 | epoch32 | 6 |

ACK 状态 0 为 accepted、1 为 rejected、2 为 uncertain。
只有选中的输入法具有有效编辑框、加密绑定订阅时 READY 才有效。
MTU 23 时每片 DATA 携带 8 字节，最大正文共需 66 次 indication。
唯一一个公开 NimBLE host event 和 64 字节 staging 与 Service Changed 共用 ATT 槽，
任何时刻只分配一个 mbuf。Sent 不当作确认；token 丢弃过期确认。
门禁/焦点失效会取消尚未发出的 staging 帧，发送前再次检查租期及原子急停/设置状态。

## 验证边界

`test_qdd_text.c` 覆盖解析、UTF-8、偏移、递增 ID、MTU 分片、终态清除、重复提交、
焦点 epoch 和取消。静态门禁还运行 `test_qdd_text_integration.py`，提取生产 main/BLE
函数，结合确定性硬件边界执行 owner/ARM/加密绑定门禁、Service Changed 占槽、单片在途、
排队取消、截止及原 epoch 终态结果测试。

构建和主机通过不证明 OEM 输入法与 BLE HID 共存、旧 bond 服务重新发现、实际中文输入
或截图反馈通过；这些仍需要授权真机测试。独立驱动资源格式见[驱动下载资源](download-assets.zh_CN.md)。
