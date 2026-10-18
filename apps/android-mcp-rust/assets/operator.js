"use strict";

(() => {
  const element = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "connect-button", "disconnect-button", "capture-button",
    "home-button", "back-button", "scroll-up-button", "scroll-down-button", "calibrate-button", "type-button",
    "enter-button", "typing-input", "scale-x", "scale-y", "phone-screen", "screen-stage", "screen-empty",
    "screen-state", "frame-info", "coordinate-info", "connection-badge", "device-name",
    "calibration-state", "status-connected", "status-encrypted", "status-ready",
    "error-box", "error-message", "error-detail", "activity", "capture-state", "screen-profile", "screen-profile-state", "access-url",
  ].map((id) => [id, element(id)]));
  const connectionSettings = document.createElement("a");
  connectionSettings.id = "connection-settings-link";
  connectionSettings.className = "text-button";
  connectionSettings.href = "/desktop/settings#discover";
  connectionSettings.textContent = "检查连接设置 / 重新查找";
  connectionSettings.hidden = true;
  ui["error-box"].append(connectionSettings);
  let client = null;
  let frame = null;
  let hid = {};
  let input = {};
  let connecting = false;
  let pendingConnection = null;
  let connectionEpoch = 0;
  let generation = 0;
  let timer = null;
  let cleanup = Promise.resolve();
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let autoConnect = true;
  let errorRevision = 0;
  const boundedMotion = (value) => Math.max(-4096, Math.min(4096, value));
  const profiles = { turbo: "极速（灰度）", fast: "快速", standard: "标准", original: "原画" };
  const inputTools = new Set(["android_hid_arm", "android_home", "android_back", "android_scroll",
    "android_key", "android_type", "android_calibrate_pointer"]);

  function scheduleReconnect() {
    if (!autoConnect || client || connecting || document.hidden || reconnectTimer !== null) return;
    const wait = Math.min(5000, 500 * 2 ** Math.min(reconnectAttempt++, 4));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (autoConnect && !client && !connecting && !document.hidden) void connect(true);
    }, wait);
  }

  const current = (context, epoch, revision = context.revision) => client === context && generation === epoch && context.revision === revision;
  const locallyArmed = () => client?.armIntent === true && hid.armed === true && !hid.locked;
  const videoReady = () => client?.videoFresh === true && !document.hidden;
  const remoteReady = () => locallyArmed() && videoReady() && !client.actionTask && !client.pauseTask;
  const remoteInputReady = (context) => context?.remoteActive && context.remoteLeaseReady && remoteReady();
  const remoteUiLocked = () => Boolean(client?.remoteActive || client?.enteringRemote);

  function render() {
    const connected = client !== null;
    const acting = Boolean(client?.actionTask);
    const capturing = Boolean(client?.captureTask);
    const pausing = Boolean(client?.pauseTask);
    ui["connect-button"].disabled = connecting || acting;
    ui["connect-button"].textContent = connecting ? "连接中…" : connected ? "重新连接" : "连接";
    ui["disconnect-button"].disabled = !connected && !connecting;
    ui["capture-button"].disabled = !connected || connecting || acting || capturing;
    ui["capture-button"].textContent = "重新连接画面";
    ui["phone-screen"].style.cursor = client?.remoteActive ? "none" : "";
    document.body.classList.toggle("remote-active", Boolean(client?.remoteActive));
    for (const id of ["home-button", "back-button", "scroll-up-button", "scroll-down-button", "type-button", "enter-button"]) {
      ui[id].disabled = !connected || !videoReady() || !hid.ready || hid.locked || acting || connecting || pausing;
    }
    ui["calibrate-button"].disabled = !connected || connecting || acting || capturing || !frame || pausing;
    ui["connection-badge"].textContent = connecting ? "正在连接操作台…" : connected ? "操作台已连接" : "尚未连接";
    ui["connection-badge"].dataset.active = String(connected);
    const statuses = [
      ["connected", hid.connected, "手机已连接设备控制器", "手机还没连接设备控制器"],
      ["encrypted", hid.encrypted, "手机配对成功", "等待手机配对"],
      ["ready", hid.ready, "鼠标键盘可用", "暂时不能操作"],
    ];
    for (const [key, active, yes, no] of statuses) {
      const pill = ui[`status-${key}`];
      const locked = key === "ready" && connected && hid.locked === true;
      pill.textContent = locked ? "已紧急停止" : active && connected ? yes : no;
      pill.dataset.active = String(Boolean(active && connected && !locked));
      pill.dataset.locked = String(locked);
    }
    ui["calibration-state"].textContent = input.calibrated ? "已设置" : "尚未设置";
    ui["calibration-state"].dataset.active = String(Boolean(input.calibrated));
    ui["coordinate-info"].textContent = "点击画面操作，Esc 退出";
    ui["screen-stage"].dataset.interactive = String(Boolean(connected && videoReady() && hid.ready && !hid.locked));
    ui["screen-stage"].dataset.busy = String(acting);
    ui["screen-stage"].dataset.stale = String(!videoReady());
    ui["screen-state"].hidden = ui["phone-screen"].hidden || (connected && videoReady());
    ui["screen-state"].textContent = !connected ? "连接已断开" : "等待手机画面";
    ui["capture-state"].textContent = videoReady() ? "正在连续传送画面" : "等待手机开始投屏";
    ui["capture-state"].dataset.updating = "false";
    ui["screen-profile"].disabled = !connected || connecting || remoteUiLocked();
    ui["screen-profile"].value = client?.profileDesired ?? client?.profileActual ?? "standard";
    ui["screen-profile-state"].textContent = remoteUiLocked() ? "按 Esc 退出远控后，可切换画质" : client?.profileBusy ? "正在切换画质…" :
      client?.profileNotice ?? `${profiles[client?.profileActual ?? "standard"]}画质 · AI 截图保留原画`;
    ui["screen-profile-state"].dataset.busy = String(Boolean(client?.profileBusy));
    ui["screen-profile-state"].dataset.error = String(Boolean(client?.profileError));
  }

  const profileReason = (error) => typeof error?.message === "string" ? error.message.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 160) || "请求未完成，请重试" : "请求未完成，请重试";

  async function profileResponseError(response) {
    const fallback = `画质请求失败（HTTP ${response.status}）`;
    if (!response.body) return fallback;
    const reader = response.body.getReader();
    try {
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return fallback;
      const bytes = new Uint8Array(4096);
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (length + chunk.value.byteLength > bytes.length) return fallback;
        bytes.set(chunk.value, length); length += chunk.value.byteLength;
      }
      const value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
      if (!value || typeof value.error !== "string") return fallback;
      return profileReason({ message: value.error });
    } catch { return fallback; }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async function requestProfile(context, method, profile) {
    const controller = new AbortController();
    context.profileRequests ??= new Set();
    context.profileRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/screen/profile", { method, cache: "no-store", signal: controller.signal,
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile }) } : {}) });
      if (!response.ok) throw new Error(await profileResponseError(response));
      const data = await response.json();
      if (!Object.hasOwn(profiles, data.profile)) throw new Error("手机返回的画质无效");
      return data.profile;
    } finally {
      clearTimeout(timeout);
      context.profileRequests.delete(controller);
    }
  }

  async function loadProfile(context) {
    const revision = context.profileRevision ?? 0;
    try {
      const profile = await requestProfile(context, "GET");
      if (client !== context || context.closeTask || (context.profileRevision ?? 0) !== revision || context.profileFrameSeen) return;
      context.profileActual = profile;
      context.profileDesired = profile;
      context.profileNotice = null;
      context.profileError = false;
    } catch (error) {
      if (client !== context || context.closeTask || (context.profileRevision ?? 0) !== revision || context.profileFrameSeen) return;
      context.profileNotice = `暂时无法读取画质：${profileReason(error).replace(/[。.!?！？]+$/u, "")}。可重新选择`;
      context.profileError = true;
    }
    render();
  }

  function changeProfile(context, profile) {
    if (client !== context || remoteUiLocked() || !Object.hasOwn(profiles, profile)) { render(); return; }
    context.profileDesired = profile;
    context.profileRevision = (context.profileRevision ?? 0) + 1;
    context.profileNotice = null;
    context.profileError = false;
    context.profileBusy = true;
    render();
    if (context.profileTask) return;
    // Serialize changes, retaining only the latest requested choice. Neither
    // profile HTTP requests nor their replies own or alter the HID session.
    context.profileTask = (async () => {
      while (client === context && !context.closeTask) {
        const target = context.profileDesired, revision = context.profileRevision;
        try {
          const actual = await requestProfile(context, "POST", target);
          if (client !== context || context.closeTask) return;
          context.profileActual = actual;
          if (context.profileRevision !== revision) continue;
          context.profileDesired = actual;
          context.profileNotice = `已切换为${profiles[actual]}画质 · AI 截图保留原画`;
          context.profileError = false;
        } catch (error) {
          if (client !== context || context.closeTask) return;
          if (context.profileRevision !== revision) continue;
          // The request may have applied before its response failed. Read the
          // phone's actual setting before restoring the selector.
          try {
            const actual = await requestProfile(context, "GET");
            if (client !== context || context.closeTask) return;
            context.profileActual = actual;
          } catch { /* Keep the last confirmed setting when the phone is offline. */ }
          if (context.profileRevision !== revision) continue;
          context.profileDesired = context.profileActual ?? "standard";
          context.profileNotice = `切换失败：${profileReason(error).replace(/[。.!?！？]+$/u, "")}。已恢复${profiles[context.profileDesired]}画质`;
          context.profileError = true;
        }
        break;
      }
    })().finally(() => {
      context.profileTask = null;
      context.profileBusy = false;
      if (client === context && !context.closeTask) render();
    });
  }

  function clearError() { errorRevision++; ui["error-box"].hidden = true; connectionSettings.hidden = true; }
  function showError(error, recoverConnection = false) {
    const message = error instanceof Error ? error.message : String(error);
    const endpointError = /^(?:ESP_CONNECTION_ERROR|SCREEN_CONNECTION_ERROR):\s*/u;
    const refused = /\bos error 10061\b|\bECONNREFUSED\b/iu.test(message);
    const friendly = error?.textTransfer?.status === "uncertain" || message.includes("delivery is uncertain") ? "文字可能已输入，请先查看手机输入框，不要重复发送。" :
      message.startsWith("TEXT_IME_REJECTED:") || message.includes("IME explicitly rejected") ? "手机输入框未接受文字，请确认当前输入框可编辑。" :
      /^(?:TEXT_IME_UNAVAILABLE|TEXT_IME_NOT_READY|TEXT_RECEIVER_UNAVAILABLE|TEXT_RECEIVER_NOT_READY):/u.test(message) || /\bIME\b/u.test(message) ? "在新版手机“设备投屏”内选择当前控制器，首次启用并选中“设备中文输入”，再点选目标输入框。保持选中即可连续使用。" :
      message.includes("Queued input was cancelled") || message.includes("HID operation cancelled") ? "远控已退出，点击画面即可重新进入。" :
      endpointError.test(message) ? message.replace(endpointError, "") :
      refused ? "连接被拒绝，请检查手机投屏地址和设备控制器地址；可打开连接设置重新查找。" :
      message.includes("实时连接") || message.includes("正在重连") || message.includes("操作台需要更新") || message.includes("旧版服务") ? message :
      message.includes("LOCKED") || message.includes("physical lock") ? "已紧急停止，请在设备控制器上选择“取消急停”并确认。" :
      message.includes("HID_NOT_READY") ? "手机还没连好，请在手机蓝牙设置里连接设备控制器。" :
      message.includes("CONFIGURING") || message.includes("SETUP_BUSY") ? "设备控制器正在设置 Wi-Fi，请在板上完成设置后再点击画面。" :
      message.includes("expired") || message.includes("superseded") ? "画面已更新或过期，请等待新截图后再点按。" :
      message.includes("calibrat") ? "AI 点击位置需要重新设置。电脑鼠标遥控无需校准。" :
      /鼠标|键盘|投屏|图像|局域网|截图|校准比例|控制板|Wi-Fi|蓝牙|文字|输入|字符/u.test(message) ? message :
      error?.name === "TimeoutError" || error?.name === "AbortError" ? "请求超时，已尝试暂停键鼠，请检查局域网连接。" :
      message.includes("ASCII") ? "文字含不支持的控制字符，请删除后再发送。" :
      message.includes("fetch") || message.includes("Network") ? "操作台连接中断，已尝试暂停设备。" : "操作未完成，请查看设备状态。";
    ui["error-message"].textContent = friendly;
    ui["error-detail"].textContent = message;
    connectionSettings.hidden = !(recoverConnection || endpointError.test(message) || refused);
    ui["error-box"].hidden = false;
    return ++errorRevision;
  }

  async function rpc(context, method, params, options = {}) {
    const notification = options.notification === true;
    const id = notification ? undefined : context.nextId++;
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (context.sessionId) headers["Mcp-Session-Id"] = context.sessionId;
    if (context.protocolVersion) headers["MCP-Protocol-Version"] = context.protocolVersion;
    const response = await fetch("/mcp", {
      method: "POST", headers, cache: "no-store", keepalive: options.keepalive === true,
      signal: options.keepalive ? undefined : AbortSignal.timeout(20000),
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    });
    if (!response.ok) {
      const error = new Error(`操作台服务 HTTP ${response.status}`);
      error.connectionLost = [401, 403, 404].includes(response.status);
      throw error;
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) context.sessionId = sessionId;
    if (notification || response.status === 202 || response.status === 204) return null;
    let message;
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const body = await response.text();
      const messages = body.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")).filter(Boolean).map((data) => JSON.parse(data));
      message = messages.find((item) => item.id === id);
    } else message = await response.json();
    if (!message || message.id !== id) throw new Error("操作台服务返回了无法匹配的请求结果。");
    if (message.error) throw new Error(message.error.message ?? "操作台服务请求失败。");
    return message.result;
  }

  async function tool(context, name, args = {}, options = {}) {
    // Board STATUS is shared across clients. Only this page's own dispatched
    // action may give its visibility/network cleanup authority to pause input.
    if (inputTools.has(name)) context.inputOwned = true;
    const result = await rpc(context, "tools/call", { name, arguments: args }, options);
    if (!result) throw new Error("未收到操作结果。");
    const text = (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (result.isError) {
      const error = new Error(text || "设备操作失败。");
      error.textTransfer = result.structuredContent?.textTransfer;
      throw error;
    }
    let data = result.structuredContent ?? {};
    if (text) {
      try { data = JSON.parse(text); } catch { /* An optional human-readable result is not state. */ }
    }
    return { data, content: result.content ?? [] };
  }

  function updateState(data) {
    if (data && typeof data === "object") {
      const linkLost = client && hid.armed && typeof data.connected === "boolean" &&
        (!data.connected || !data.encrypted || data.ready === false);
      if (typeof data.connected === "boolean") hid = data;
      if (data.input) input = data.input;
      else if (typeof data.calibrated === "boolean") input = data;
      if (client && (data.locked === true || data.armed === false || data.input?.armed === false)) client.armIntent = false;
      if (client?.remoteActive && (data.locked === true || data.armed === false || data.input?.armed === false)) clearRemote(client);
      if (typeof hid.name === "string") ui["device-name"].textContent = hid.name;
      if (linkLost) emergencyPause("设备连接已中断，已请求暂停键鼠。", true);
    }
    render();
  }

  function stopVideo(context) {
    context.videoEpoch = (context.videoEpoch ?? 0) + 1;
    context.video?.close(); context.video = null;
    if (context.videoBlobUrl) URL.revokeObjectURL(context.videoBlobUrl);
    context.videoBlobUrl = null;
    clearTimeout(context.videoDeadline);
    context.videoFresh = false;
    context.pendingVideo = null;
  }

  function startVideo(context) {
    stopVideo(context);
    const epoch = context.videoEpoch;
    const channel = new QddScreenChannel("/screen/stream");
    context.video = channel;
    context.videoCount = 0;
    context.videoStarted = performance.now();
    context.videoTimes = [];
    context.videoLossEpoch = (context.videoLossEpoch ?? 0) + 1;
    const unavailable = (message) => {
      if (client !== context || epoch !== context.videoEpoch) return;
      context.videoFresh = false;
      context.videoLossEpoch++;
      context.pendingVideo = null;
      context.videoError = true;
      emergencyPause("手机画面中断，操作已暂停。画面恢复后，请点击画面重新进入。", true);
      context.videoErrorRevision = showError(new Error(message), true);
    };
    channel.addEventListener("unavailable", (event) => {
      let message = "手机没有传来新画面，请检查手机上的投屏开关和 Wi-Fi。";
      try { message = event.data.message ?? message; } catch { /* Use the readable fallback. */ }
      unavailable(message);
    });
    channel.addEventListener("error", () => unavailable("画面连接断开，正在重新连接。请检查手机和电脑的 Wi-Fi。"));
    channel.addEventListener("frame", (event) => {
      if (client !== context || epoch !== context.videoEpoch || document.hidden) return;
      let data;
      try {
        data = event.data;
        if (data.mimeType !== "image/jpeg" || !(data.image instanceof Blob) || !data.sourceFrameId ||
          typeof data.deviceSerial !== "string" || !data.deviceSerial || ![0, 1, 2, 3].includes(data.rotation) ||
          !Number.isInteger(data.width) || data.width <= 0 || !Number.isInteger(data.height) || data.height <= 0 ||
          !Number.isFinite(data.frameAgeMs) || data.frameAgeMs < 0 || data.frameAgeMs > 3000 ||
          !Number.isSafeInteger(data.sentAt) || Date.now() < data.sentAt || Date.now() - data.sentAt + data.frameAgeMs > 3000) throw new Error();
        if (data.deviceWidth !== undefined || data.deviceHeight !== undefined) {
          if (!Number.isInteger(data.deviceWidth) || data.deviceWidth <= 0 || !Number.isInteger(data.deviceHeight) || data.deviceHeight <= 0) throw new Error();
        }
      } catch { unavailable("手机视频不完整，操作已暂停。请重新开始投屏。"); return; }
      context.pendingVideo = { data, lossEpoch: context.videoLossEpoch,
        profileRevision: context.profileRevision ?? 0, profileBusy: Boolean(context.profileBusy) };
      if (context.videoDecode) return;
      context.videoDecode = (async () => {
        while (context.pendingVideo && client === context && epoch === context.videoEpoch) {
          const packet = context.pendingVideo;
          context.pendingVideo = null;
          const decoded = new Image();
          const blobUrl = URL.createObjectURL(packet.data.image);
          decoded.src = blobUrl;
          try { await decoded.decode(); }
          catch (error) { URL.revokeObjectURL(blobUrl); throw error; }
          if (client !== context || epoch !== context.videoEpoch || document.hidden || packet.lossEpoch !== context.videoLossEpoch) {
            URL.revokeObjectURL(blobUrl);
            if (client !== context || epoch !== context.videoEpoch || document.hidden) break;
            continue;
          }
          const age = packet.data.frameAgeMs + Date.now() - packet.data.sentAt;
          if (age >= 3000) { URL.revokeObjectURL(blobUrl); unavailable("手机画面太久没有更新，操作已暂停。"); break; }
          const geometry = { width: packet.data.deviceWidth ?? packet.data.width, height: packet.data.deviceHeight ?? packet.data.height,
            rotation: packet.data.rotation, deviceSerial: packet.data.deviceSerial };
          if (context.remoteActive && context.videoGeometry && Object.keys(geometry).some((key) => geometry[key] !== context.videoGeometry[key])) {
            emergencyPause("手机画面的尺寸或方向已改变，操作已暂停。请点击画面重新进入。");
          }
          // The displayed stream is authoritative when another client changes
          // quality. A packet received before/during our own choice must not
          // restore its old profile after a delayed image decode or POST ACK.
          const profile = packet.data.previewProfile;
          if (Object.hasOwn(profiles, profile) && !context.profileBusy && !packet.profileBusy &&
              packet.profileRevision === (context.profileRevision ?? 0)) {
            context.profileFrameSeen = true;
            if (context.profileActual !== profile || context.profileDesired !== profile) {
              context.profileActual = context.profileDesired = profile;
              context.profileNotice = null;
              context.profileError = false;
            }
          }
          context.videoGeometry = geometry;
          ui["phone-screen"].src = decoded.src;
          if (context.videoBlobUrl) URL.revokeObjectURL(context.videoBlobUrl);
          context.videoBlobUrl = blobUrl;
          ui["phone-screen"].hidden = false;
          ui["screen-empty"].hidden = true;
          context.videoFresh = true;
          context.videoCount++;
          const now = performance.now();
          context.videoTimes = context.videoTimes.filter((time) => now - time < 1000);
          context.videoTimes.push(now);
          const fps = context.videoTimes.length;
          ui["frame-info"].textContent = `${packet.data.width} × ${packet.data.height} · ${fps} 帧/秒 · 画面约 ${Math.round(age)}ms 前`;
          if (context.videoError) {
            context.videoError = false;
            // A recovered phone stream says nothing about a later controller
            // or input error. Only retire this stream's own displayed error.
            if (context.videoErrorRevision === errorRevision) {
              clearError();
              ui["activity"].textContent = "画面已恢复。点击画面即可继续操作。";
            }
          }
          clearTimeout(context.videoDeadline);
          context.videoDeadline = setTimeout(() => unavailable("手机画面已中断，操作已暂停。"), Math.max(1, 3000 - age));
          render();
        }
      })().catch(() => unavailable("手机画面无法显示，请重新开始投屏。"))
        .finally(() => { context.videoDecode = null; });
    });
  }

  function clearRemote(context, preserveCapture = false) {
    const wasActive = context.remoteActive;
    const previousRound = context.remoteRound;
    context.remoteRevision = (context.remoteRevision ?? 0) + 1;
    context.remoteActive = false;
    context.remoteMode = null;
    context.remoteLeaseReady = false;
    context.remoteReports = [];
    const channel = context.remoteChannel;
    context.remoteChannel = null;
    channel?.close();
    for (const controller of context.remoteRequests ?? []) controller.abort();
    context.remoteRequests = new Set();
    context.remoteSequence = 0;
    context.remoteAckSequence = 0;
    context.remoteRound = null;
    context.pendingHover = null;
    cancelAnimationFrame(context.remoteAnimation);
    context.remoteAnimation = null;
    context.remoteRemainder = { dx: 0, dy: 0 };
    context.ignoreNextMotion = true;
    context.remoteButtons = 0;
    context.remoteKeys = new Map();
    clearInterval(context.remoteLeaseTimer);
    if (wasActive && !channel && previousRound && context.sessionId) void fetch("/remote/lease", {
      method: "DELETE", keepalive: true, headers: { "Mcp-Session-Id": context.sessionId,
        ...(previousRound ? { "X-Remote-Round": previousRound } : {}) },
    }).catch(() => {});
    if (!preserveCapture) {
      context.enteringRemote = false;
      context.remoteEntryKey = null;
      clearTimeout(context.captureTimer);
      context.lockIntent = null;
      context.capturePending = false;
      context.captureAcquired = false;
      if (document.pointerLockElement === ui["phone-screen"]) document.exitPointerLock();
    }
  }

  function remotePump(context) {
    if (!remoteInputReady(context)) return;
    while (context.remoteRequests.size < 4 && context.remoteReports.length) remoteSend(context);
  }

  function remoteSend(context) {
    const epoch = generation, revision = context.remoteRevision;
    const next = context.remoteReports[0];
    if (!next) return;
    let report = next.report;
    if (next.hover) {
      const limit = (value) => Math.max(-127, Math.min(127, value));
      report = { ...report, dx: limit(report.dx), dy: limit(report.dy) };
      next.report.dx -= report.dx; next.report.dy -= report.dy;
      if (!next.report.dx && !next.report.dy) context.remoteReports.shift();
    } else {
      context.remoteReports.shift();
    }
    const controller = new AbortController();
    const requests = context.remoteRequests;
    requests.add(controller);
    const sequence = ++context.remoteSequence;
    void context.remoteChannel.send(sequence, report, controller.signal).then((data) => {
      if (client === context && generation === epoch && context.remoteRevision === revision && context.remoteActive && sequence > context.remoteAckSequence) {
        context.remoteAckSequence = sequence;
        updateState(data);
      }
    }).catch((error) => { if (client === context && generation === epoch && context.remoteRevision === revision) void handleFailure(context, error); })
      .finally(() => {
        requests.delete(controller);
        if (client === context && generation === epoch && context.remoteRevision === revision && context.remoteActive) {
          // Merge the newest browser position before choosing the next queued hover.
          flushRemoteHover(context);
          remotePump(context);
        }
      });
  }

  function remoteReport(context, report, hover = false) {
    if (!context.remoteActive || !remoteReady()) return;
    const tail = context.remoteReports.at(-1);
    if (hover && tail?.hover && tail.report.buttons === report.buttons) {
      tail.report.dx = boundedMotion(tail.report.dx + report.dx);
      tail.report.dy = boundedMotion(tail.report.dy + report.dy);
    }
    else {
      // Fast relative motion may exceed the BLE lane's current capacity. Keep
      // a bounded coalesced movement, rather than treating a swipe as a fault.
      // Button/key edges remain separate ordered reports and are never dropped.
      if (hover) report = { ...report, dx: boundedMotion(report.dx), dy: boundedMotion(report.dy) };
      if (context.remoteReports.length >= 32) { emergencyPause("输入来不及发送，已暂停。请点击画面重新进入。"); return; }
      context.remoteReports.push({ report, hover });
    }
    remotePump(context);
  }

  function flushRemoteHover(context) {
    cancelAnimationFrame(context.remoteAnimation);
    context.remoteAnimation = null;
    const pending = context.pendingHover;
    context.pendingHover = null;
    if (!pending || client !== context || !context.remoteActive || !remoteReady()) return;
    const position = pictureScale(context);
    if (!position) return;
    if (pending.ignoreEntry) { context.ignoreNextMotion = false; return; }
    const dx = pending.dx * position.scaleX + context.remoteRemainder.dx;
    const dy = pending.dy * position.scaleY + context.remoteRemainder.dy;
    context.remoteRemainder = { dx: dx - Math.trunc(dx), dy: dy - Math.trunc(dy) };
    if (Math.trunc(dx) || Math.trunc(dy)) remoteReport(context, { kind: "mouse", dx: Math.trunc(dx), dy: Math.trunc(dy), buttons: pending.buttons, wheel: 0 }, true);
  }

  function scheduleRemoteHover(context, event) {
    if (!Number.isFinite(event.movementX) || !Number.isFinite(event.movementY)) return;
    const pending = context.pendingHover ?? { dx: 0, dy: 0, buttons: context.remoteButtons, ignoreEntry: context.ignoreNextMotion };
    if (!pending.ignoreEntry) {
      pending.dx = boundedMotion(pending.dx + event.movementX);
      pending.dy = boundedMotion(pending.dy + event.movementY);
    }
    pending.point = { clientX: event.clientX, clientY: event.clientY };
    context.pendingHover = pending;
    if (context.remoteAnimation !== null) return;
    const revision = context.remoteRevision;
    const handle = requestAnimationFrame(() => {
      if (context.remoteAnimation === handle) context.remoteAnimation = null;
      if (client === context && context.remoteRevision === revision) flushRemoteHover(context);
    });
    context.remoteAnimation = handle;
  }

  async function capture(context, epoch, revision) {
    const { data, content } = await tool(context, "android_screenshot");
    if (!current(context, epoch, revision)) return false;
    const image = content.find((item) => item.type === "image" && ["image/jpeg", "image/png"].includes(item.mimeType));
    if (!image || !data.frameId || !Number.isInteger(data.width) || !Number.isInteger(data.height)) throw new Error("未收到完整的手机截图。");
    // MCP snapshots are for AI coordinates. The operator's pixels only come from the video channel.
    frame = data;
    context.confirmedRevision = revision;
    updateState(data);
    return true;
  }

  function refresh(context, afterAction = false) {
    if (client !== context || document.hidden) return Promise.resolve();
    if (context.captureTask) {
      if (afterAction || context.captureRevision !== context.revision) context.refreshWanted = true;
      return context.captureTask;
    }
    context.refreshWanted = true;
    if (context.actionTask) return Promise.resolve();
    stopPolling();
    context.captureTask = Promise.resolve().then(async () => {
      while (context.refreshWanted && client === context && !context.actionTask && !document.hidden) {
        context.refreshWanted = false;
        const epoch = generation, revision = context.revision;
        context.captureEpoch = epoch;
        context.captureRevision = revision;
        if (!await capture(context, epoch, revision)) continue;
        if (!current(context, epoch, revision)) continue;
        const status = (await tool(context, "android_hid_status")).data;
        if (!current(context, epoch, revision)) continue;
        updateState(status);
        if (context.confirmationLabel) {
          ui["activity"].textContent = `${context.confirmationLabel}完成，画面已更新。`;
          context.confirmationLabel = null;
        }
      }
    }).catch((error) => {
      if (current(context, context.captureEpoch, context.captureRevision)) return handleFailure(context, error, true);
    }).finally(() => {
      context.captureTask = null;
      if (client !== context) return;
      render();
      if (context.refreshWanted && !context.actionTask && !document.hidden) void refresh(context);
      else schedulePoll();
    });
    render();
    return context.captureTask;
  }

  function stopPolling() { clearTimeout(timer); timer = null; }
  function schedulePoll() {
    stopPolling();
    if (!client || document.hidden || client.pauseTask) return;
    timer = setTimeout(async () => {
      const context = client, epoch = generation, revision = context?.revision;
      try {
        if (context && !context.actionTask && !context.pauseTask && !document.hidden) {
          const { data } = await tool(context, "android_hid_status");
          if (current(context, epoch, revision)) updateState(data);
        }
      } catch (error) { if (current(context, epoch, revision)) void handleFailure(context, error, true); }
      finally { schedulePoll(); }
    }, 1000);
  }

  async function pauseContext(context, keepalive = false) {
    if (!context.inputOwned) return;
    // Relinquish synchronously: late cleanup must not claim input back from a
    // new controller after this page has already requested its own pause.
    context.inputOwned = false;
    const epoch = generation, revision = context.revision;
    try {
      const result = await tool(context, "android_hid_pause", {}, { keepalive });
      if (current(context, epoch, revision)) updateState(result.data);
    }
    catch { /* ESP USB heartbeat expiry remains the hardware fallback. */ }
  }

  async function startLiveness(context) {
    const controller = new AbortController();
    context.livenessController = controller;
    context.livenessIntentional = false;
    const deadline = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch("/mcp", {
        method: "GET", cache: "no-store", signal: controller.signal,
        headers: { Accept: "text/event-stream",
          "Mcp-Session-Id": context.sessionId, "MCP-Protocol-Version": context.protocolVersion },
      });
    } finally { clearTimeout(deadline); }
    if (!response.ok) throw new Error(`电脑连接未完成（HTTP ${response.status}），正在重连。`);
    if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      throw new Error("电脑连接暂时不可用，正在重连。");
    }
    const reader = response.body.getReader();
    // Drain the official session SSE stream without interpreting notifications
    // as operator actions. Its open HTTP connection is the server's stop lease.
    context.livenessTask = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("电脑连接中断，正在重连。恢复后点击画面继续操作。");
      }
    })().catch((error) => {
      if (context.livenessIntentional || controller.signal.aborted || client !== context) return;
      emergencyPause("电脑连接中断，正在重连。恢复后点击画面继续操作。", true);
      client = null;
      frame = null;
      hid = {};
      input = {};
      ui["device-name"].textContent = "实时连接已断开";
      showError(new Error("电脑连接中断，正在重连。恢复后点击画面继续操作。"));
      render();
      // Restore viewing automatically without replaying held input.
      void closeContext(context).finally(scheduleReconnect);
    }).finally(() => reader.releaseLock());
  }

  async function stopLiveness(context) {
    context.livenessIntentional = true;
    context.livenessController?.abort();
    try { await context.livenessTask; } catch { /* Intentional channel closure. */ }
  }

  function closeContext(context) {
    if (context.closeTask) return context.closeTask;
    for (const controller of context.profileRequests ?? []) controller.abort();
    context.closeTask = cleanup.catch(() => {}).then(async () => {
      // Wait for an interrupted initialize to expose its session ID before DELETE.
      try { await context.initializeTask; } catch { /* Failed initialize. */ }
      stopVideo(context);
      clearRemote(context);
      await stopLiveness(context);
      await pauseContext(context);
      if (context.sessionId) {
        try {
          await fetch("/mcp", {
            method: "DELETE", cache: "no-store", signal: AbortSignal.timeout(5000),
            headers: { "Mcp-Session-Id": context.sessionId,
              "MCP-Protocol-Version": context.protocolVersion },
          });
        } catch { /* Server/firmware independently release on loss. */ }
      }
      await Promise.allSettled([context.captureTask, context.actionTask].filter(Boolean));
    });
    cleanup = context.closeTask.catch(() => {});
    return context.closeTask;
  }

  function emergencyPause(message, keepalive = false) {
    generation++;
    hid = { ...hid, armed: false };
    input = { ...input, armed: false };
    stopPolling();
    ui["activity"].textContent = message;
    const context = client;
    if (context) {
      clearRemote(context);
      context.armIntent = false;
      context.refreshWanted = false;
      context.confirmationLabel = null;
      if (!context.pauseTask) context.pauseTask = pauseContext(context, keepalive).finally(() => {
        context.pauseTask = null;
        if (client === context) { render(); if (!document.hidden) schedulePoll(); }
      });
    }
    render();
  }

  async function handleFailure(context, error, recoverConnection = false) {
    if (context !== client) return;
    frame = null;
    showError(error, recoverConnection);
    emergencyPause("本次操作未完成，连接恢复后点击画面继续操作。");
    if (error.connectionLost || error instanceof TypeError) {
      client = null;
      input = {};
      void closeContext(context).finally(scheduleReconnect);
      ui["activity"].textContent = "连接已中断，请重新连接。";
    }
    render();
  }

  function run(label, action, arm = false) {
    const context = client;
    if (!context || context.actionTask || context.pauseTask || connecting || document.hidden) return Promise.resolve();
    const epoch = generation, revision = ++context.revision;
    context.refreshWanted = false;
    context.confirmationLabel = null;
    stopPolling();
    clearError();
    ui["activity"].textContent = `${label}…`;
    context.actionTask = Promise.resolve().then(async () => {
      if (!current(context, epoch, revision)) return;
      const data = await action(context);
      if (!current(context, epoch, revision)) return;
      if (arm) context.armIntent = true;
      if (data) updateState(data);
      const transfer = data?.textTransfer;
      ui["activity"].textContent = transfer?.mode === "ime" && transfer.status === "accepted"
        ? "输入法已接受文字，请查看手机确认，勿重复发送。"
        : `${label}已发送。画面会持续跟随手机。`;
    }).catch((error) => {
      if (current(context, epoch, revision)) return handleFailure(context, error);
    }).finally(() => {
      context.actionTask = null;
      if (client !== context) return;
      render();
      schedulePoll();
      if (arm && current(context, epoch, revision) && locallyArmed()) void enterDirect(context);
    });
    render();
    return context.actionTask;
  }

  async function disconnect() {
    autoConnect = false;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    stopPolling();
    connectionEpoch++;
    connecting = false;
    generation++;
    const previous = client ?? pendingConnection;
    client = null;
    pendingConnection = null;
    frame = null;
    hid = {};
    input = {};
    ui["device-name"].textContent = "已断开连接";
    ui["activity"].textContent = "已请求暂停并断开连接。";
    render();
    if (previous) await closeContext(previous);
  }

  async function connect(automatic = false) {
    if (connecting) return;
    if (!automatic) { autoConnect = true; reconnectAttempt = 0; }
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const previous = client;
    const attempt = ++connectionEpoch;
    generation++;
    client = null;
    frame = null;
    hid = {};
    input = {};
    connecting = true;
    stopPolling();
    render();
    clearError();
    ui["activity"].textContent = previous ? "正在关闭旧连接并释放键鼠…" : "正在连接操作台服务…";
    let pending = null;
    try {
      if (previous) await closeContext(previous);
      await cleanup;
      if (attempt !== connectionEpoch) return;
      const health = await fetch("/health", { cache: "no-store", signal: AbortSignal.timeout(3000) });
      const healthState = await health.json();
      if (!health.ok || healthState.runtimeVersion !== 9) throw new Error("设备操作台需要更新，请重新打开设备操作台.exe。");
      if (attempt !== connectionEpoch) return;
      const access = new URL(healthState.operatorUrl ?? "/", location.href);
      ui["access-url"].textContent = access.href;
      ui["access-url"].href = access.href;
      const context = { sessionId: null, protocolVersion: null, nextId: 1, revision: 0,
        confirmedRevision: -1, armIntent: false, inputOwned: false, refreshWanted: false };
      pending = context;
      pendingConnection = context;
      context.initializeTask = rpc(context, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "qdd-operator", version: "0.1.0" } });
      const initialized = await context.initializeTask;
      if (attempt !== connectionEpoch) return;
      context.protocolVersion = initialized.protocolVersion;
      await rpc(context, "notifications/initialized", {}, { notification: true });
      if (attempt !== connectionEpoch) return;
      client = context;
      pendingConnection = null;
      await startLiveness(context);
      if (client !== context || attempt !== connectionEpoch) return;
      reconnectAttempt = 0;
      ui["activity"].textContent = "正在连接手机画面和设备控制器…";
      startVideo(context);
      void loadProfile(context);
      await refresh(context);
      if (client === context && frame && !context.pauseTask && ui["error-box"].hidden) ui["activity"].textContent = "手机已连接。点击画面即可操作手机。";
    } catch (error) {
      if (pending) {
        if (client === pending) client = null;
        await closeContext(pending);
      }
      if (attempt === connectionEpoch) showError(error, true);
    }
    finally {
      if (attempt !== connectionEpoch && pending) void closeContext(pending);
      if (pendingConnection === pending) pendingConnection = null;
      if (attempt === connectionEpoch) { connecting = false; render(); schedulePoll(); scheduleReconnect(); }
    }
  }

  function action(button, label, name, args = () => ({})) {
    ui[button].addEventListener("click", () => {
      let snapshot;
      try { snapshot = args(); } catch (error) {
        if (client) void handleFailure(client, error); else showError(error);
        return;
      }
      void run(label, async (context) => {
        const epoch = generation, revision = context.revision;
        if (!locallyArmed()) {
          const armed = (await tool(context, "android_hid_arm")).data;
          if (!current(context, epoch, revision)) return;
          context.armIntent = true;
          updateState(armed);
        }
        return (await tool(context, name, snapshot)).data;
      });
    });
  }
  ui["connect-button"].addEventListener("click", () => void connect());
  ui["disconnect-button"].addEventListener("click", () => void disconnect());
  ui["screen-profile"].addEventListener("change", () => {
    if (client && !connecting) changeProfile(client, ui["screen-profile"].value);
  });
  ui["capture-button"].addEventListener("click", () => {
    if (!client || connecting || client.actionTask || document.hidden) return;
    const context = client;
    emergencyPause("正在重新连接画面，请稍后点击画面继续操作。");
    const epoch = generation;
    startVideo(context);
    clearError(); ui["activity"].textContent = "正在重新连接手机画面…";
    void refresh(context).then(() => {
      if (current(context, epoch) && frame && !context.actionTask && ui["error-box"].hidden) ui["activity"].textContent = "手机画面已更新。";
    });
  });
  function startControlCapture(entryKey = null) {
    const context = client;
    if (!context || !videoReady() || context.remoteActive || context.enteringRemote || context.actionTask || context.pauseTask || connecting) return;
    if (hid.locked) { showError(new Error("LOCKED")); return; }
    if (!hid.ready) { showError(new Error("HID_NOT_READY")); return; }
    context.enteringRemote = true;
    context.remoteEntryKey = entryKey;
    ui["screen-stage"].scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    void run("连接鼠标", async (active) => (await tool(active, "android_hid_arm")).data, true);
    // Keep the browser's user activation: request capture in this click handler,
    // while ARM and the input lease still gate every report independently.
    requestMouseCapture(context);
  }
  ui["phone-screen"].addEventListener("click", () => startControlCapture());
  action("home-button", "返回主页", "android_home");
  action("back-button", "返回上一页", "android_back");
  action("scroll-up-button", "向上滚动", "android_scroll", () => ({ amount: 3 }));
  action("scroll-down-button", "向下滚动", "android_scroll", () => ({ amount: -3 }));
  action("enter-button", "发送回车", "android_key", () => ({ combo: "enter" }));
  action("type-button", "发送文字", "android_type", () => {
    const text = ui["typing-input"].value;
    if (!text) throw new Error("请输入要发送的文字。");
    if (text.includes("\0")) throw new Error("文字不能包含空字符。");
    for (const character of text) {
      const code = character.codePointAt(0);
      if (code >= 0xd800 && code <= 0xdfff) throw new Error("文字含不完整字符，请重新输入该字符。");
    }
    if (/[^\x00-\x7f]/u.test(text)) {
      if (new TextEncoder().encode(text).byteLength > 512) throw new Error("每次最多发送 512 字节文字（约 170 个汉字），请分段发送。");
    } else if (!/^[\x09\x0a\x0d\x20-\x7e]+$/.test(text)) {
      throw new Error("文字含不支持的控制字符，请删除后再发送。");
    }
    return { text };
  });
  ui["calibrate-button"].addEventListener("click", () => {
    const scaleX = Number(ui["scale-x"].value), scaleY = Number(ui["scale-y"].value);
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) { showError(new Error("点击位置的调整数值必须大于 0。")); return; }
    void run("保存点击位置", async (context) => {
      const snapshot = (await tool(context, "android_screenshot")).data;
      return (await tool(context, "android_calibrate_pointer", { frameId: snapshot.frameId, scaleX, scaleY })).data;
    });
  });
  function pictureScale(context) {
    const geometry = context.videoGeometry;
    if (!geometry) return null;
    const bounds = ui["phone-screen"].getBoundingClientRect();
    const style = getComputedStyle(ui["phone-screen"]);
    const pixels = (key) => Number.parseFloat(style[key]) || 0;
    const width = bounds.width - pixels("borderLeftWidth") - pixels("borderRightWidth") - pixels("paddingLeft") - pixels("paddingRight");
    const height = bounds.height - pixels("borderTopWidth") - pixels("borderBottomWidth") - pixels("paddingTop") - pixels("paddingBottom");
    const fit = style.objectFit;
    const scale = fit === "cover" ? Math.max(width / geometry.width, height / geometry.height) :
      fit === "none" ? 1 : fit === "scale-down" ? Math.min(1, width / geometry.width, height / geometry.height) : Math.min(width / geometry.width, height / geometry.height);
    const pictureWidth = !fit || fit === "fill" ? width : geometry.width * scale;
    const pictureHeight = !fit || fit === "fill" ? height : geometry.height * scale;
    if (width <= 0 || height <= 0 || pictureWidth <= 0 || pictureHeight <= 0) return null;
    return { scaleX: geometry.width / pictureWidth, scaleY: geometry.height / pictureHeight };
  }
  function captureUnavailable(context, intent) {
    if (context.lockIntent !== intent || !current(context, intent.epoch, intent.revision)) return;
    clearTimeout(context.captureTimer);
    context.capturePending = false;
    render();
  }
  function requestMouseCapture(context) {
    if (document.pointerLockElement === ui["phone-screen"] || context.capturePending) return;
    const intent = { epoch: generation, revision: context.revision, legacy: false };
    context.lockIntent = intent;
    context.capturePending = true;
    ui["phone-screen"].focus({ preventScroll: true });
    try {
      if (typeof ui["phone-screen"].requestPointerLock !== "function") { captureUnavailable(context, intent); return; }
      const request = ui["phone-screen"].requestPointerLock();
      intent.legacy = !request?.then;
      if (request?.then) void Promise.resolve(request).catch(() => captureUnavailable(context, intent));
      if (context.capturePending) context.captureTimer = setTimeout(() => captureUnavailable(context, intent), 1000);
    } catch { captureUnavailable(context, intent); }
  }
  async function enterDirect(context) {
    if (client !== context || context.remoteActive || !remoteReady()) return;
    clearRemote(context, true);
    const revision = context.remoteRevision;
    const active = () => client === context && context.remoteActive && context.remoteRevision === revision;
    context.remoteActive = true;
    context.remoteMode = "relative";
    clearError();
    render();
    try {
      const response = await fetch("/remote/lease", { method: "POST", headers: { "Mcp-Session-Id": context.sessionId }, signal: AbortSignal.timeout(800) });
      if (!active()) return;
      if (!response.ok) throw new Error("远控连接已断开，点击画面即可重新进入。");
      const round = response.headers.get("x-remote-round");
      if (!round) throw new Error("远控连接已更新，请点击画面重新进入。");
      context.remoteRound = round;
      const channel = new QddRemoteChannel("/remote/socket", context.sessionId, round);
      context.remoteChannel = channel;
      channel.addEventListener("error", (event) => { if (active()) void handleFailure(context, event.error); });
      await channel.ready;
      if (!active() || !remoteReady()) return;
      context.remoteLeaseReady = true;
      context.enteringRemote = false;
      context.remoteLeaseTimer = setInterval(() => { if (active()) channel.ping(); }, 250);
      ui["activity"].textContent = "远控已连接。";
      render();
      remotePump(context);
    } catch (error) {
      if (active()) void handleFailure(context, error);
    }
  }
  document.addEventListener("pointerlockchange", () => {
    const context = client;
    if (document.pointerLockElement === ui["phone-screen"]) {
      const intent = context?.lockIntent;
      if (!context || !intent || !current(context, intent.epoch, intent.revision) || (!context.actionTask && !context.remoteActive)) {
        document.exitPointerLock(); return;
      }
      context.capturePending = false;
      clearTimeout(context.captureTimer);
      context.captureAcquired = true;
      cancelAnimationFrame(context.remoteAnimation);
      context.remoteAnimation = null;
      context.pendingHover = null;
      context.ignoreNextMotion = true;
    } else if (context?.captureAcquired) {
      context.captureAcquired = false;
      emergencyPause("鼠标已回到电脑，手机操作已暂停。");
    }
    render();
  });
  document.addEventListener("pointerlockerror", () => {
    if (client?.capturePending && client.lockIntent?.legacy) captureUnavailable(client, client.lockIntent);
  });
  document.addEventListener("mousemove", (event) => {
    const context = client;
    if (!context?.remoteActive) return;
    scheduleRemoteHover(context, event);
  });
  document.addEventListener("click", (event) => {
    if (!remoteUiLocked()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    ui["phone-screen"].focus({ preventScroll: true });
  }, true);
  for (const type of ["mousedown", "mouseup"]) document.addEventListener(type, (event) => {
    const context = client;
    if (!remoteUiLocked()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    ui["phone-screen"].focus({ preventScroll: true });
    if (!context?.remoteActive) return;
    flushRemoteHover(context);
    if (!context.remoteActive) return;
    if (!remoteInputReady(context)) return;
    context.remoteButtons = event.buttons & 7;
    remoteReport(context, { kind: "mouse", dx: 0, dy: 0, buttons: context.remoteButtons, wheel: 0 });
  }, true);
  document.addEventListener("contextmenu", (event) => {
    if (remoteUiLocked()) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener("wheel", (event) => {
    const context = client;
    if (!remoteUiLocked()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!context?.remoteActive) return;
    flushRemoteHover(context);
    if (!context.remoteActive) return;
    if (!remoteInputReady(context)) return;
    remoteReport(context, { kind: "mouse", dx: 0, dy: 0, buttons: context.remoteButtons, wheel: -Math.sign(event.deltaY) });
  }, { passive: false, capture: true });
  function keyUsage(code) {
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4;
    if (/^Digit[1-9]$/.test(code)) return Number(code[5]) + 0x1d;
    if (code === "Digit0") return 0x27;
    if (/^F(?:[1-9]|1[0-2])$/.test(code)) return Number(code.slice(1)) + 0x39;
    return { Enter: 0x28, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e,
      BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33, Quote: 0x34,
      Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
      Insert: 0x49, Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
      ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52 }[code] ?? 0;
  }
  for (const type of ["keydown", "keyup"]) document.addEventListener(type, (event) => {
    const context = client;
    if (event.code === "Escape") {
      if (type === "keydown" && (context || !ui["error-box"].hidden)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (context && (remoteUiLocked() || context.actionTask || context.capturePending || locallyArmed())) emergencyPause("远控已退出。");
        else { ui["activity"].textContent = "远控已退出。"; render(); }
        clearError();
      }
      return;
    }
    if (context?.remoteEntryKey === event.code) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (type === "keyup") context.remoteEntryKey = null;
      return;
    }
    if (!remoteUiLocked()) {
      if (type === "keydown" && !event.repeat && document.activeElement === ui["phone-screen"] &&
          (event.code === "Enter" || event.code === "Space")) {
        event.preventDefault(); event.stopImmediatePropagation();
        startControlCapture(event.code);
      }
      return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    if (!context?.remoteActive) return;
    flushRemoteHover(context);
    if (!remoteInputReady(context)) return;
    if (event.repeat) return;
    const usage = keyUsage(event.code);
    if (type === "keydown" && usage) context.remoteKeys.set(event.code, usage);
    else if (type === "keyup") context.remoteKeys.delete(event.code);
    const modifier = (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
    remoteReport(context, { kind: "key", modifier, keycode: [...context.remoteKeys.values()].at(-1) ?? 0 });
  }, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) emergencyPause("页面已隐藏，已请求暂停设备。", true);
    else { if (client) startVideo(client); render(); schedulePoll(); scheduleReconnect(); }
  });
  window.addEventListener("blur", () => { if (client?.remoteActive || client?.actionTask || locallyArmed()) emergencyPause("已离开操作台，手机操作已暂停。", true); });
  window.addEventListener("pagehide", () => { autoConnect = false; clearTimeout(reconnectTimer); reconnectTimer = null; emergencyPause("页面已关闭，已请求暂停设备。", true); });
  window.addEventListener("offline", () => emergencyPause("网络连接中断，已请求暂停设备。", true));
  window.addEventListener("online", () => { reconnectAttempt = 0; scheduleReconnect(); });

  render();
  void connect(true);
})();
