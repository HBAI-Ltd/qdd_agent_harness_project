'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const state = { connected: false, cameras: [], selected: '', status: {}, loading: true, listKnown: false, listError: '', refreshVersion: 0, previewVersion: 0, playerCleanup: null, playback: 'idle', viewMode: 'live', playbackArgs:null, protocol: '', operation: null, stopping: false, disposed: false };
  const directions = new Set(['up', 'down', 'left', 'right']);
  const directionLabels = { up: '向上', down: '向下', left: '向左', right: '向右' };
  const MAX_HOLD_MS = 10000;
  const camera = () => state.cameras.find(c => c.id === state.selected);
  const selectionChanged = () => window.dispatchEvent(new CustomEvent('tysl-selection',{detail:{cameraId:state.selected,connected:state.connected}}));
  const icon = name => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const u = document.createElementNS(s.namespaceURI, 'use'); u.setAttribute('href', '#i-' + name); s.append(u); s.setAttribute('aria-hidden', 'true'); return s; };

  class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
  async function request(action, data = {}, options = {}) {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(25000) : undefined;
    const response = await fetch(action === 'status' ? '/api/status' : '/api/action', action === 'status' ? { cache: 'no-store', signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }), cache: 'no-store', keepalive: options.keepalive === true, signal });
    let result;
    try { result = await response.json(); } catch { throw new ApiError('本地服务返回了无法识别的响应，请检查服务状态。', response.status); }
    if (!response.ok || result?.error || result?.ok === false) {
      const detail = typeof result?.error === 'object' ? result.error : result;
      const message = detail?.message || (typeof result?.error === 'string' ? result.error : '') || '请求未完成，请稍后重试。';
      throw new ApiError(message, response.status, detail?.code || result?.code);
    }
    return result;
  }
  function notice(message, error = false) { $('notice-text').textContent = message || ''; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
  function errorMessage(error) { return ['TimeoutError', 'AbortError'].includes(error?.name) ? '本地服务响应超时，请稍后重试。' : error instanceof TypeError ? '无法连接本地服务，请确认控制台服务仍在运行。' : error?.message || '请求未完成，请稍后重试。'; }
  function showError(error) {
    if (error?.status === 401 || ['LOGIN_REQUIRED', 'SESSION_EXPIRED', 'UNAUTHORIZED'].includes(error?.code)) disconnect();
    notice(errorMessage(error), true);
  }
  function disconnect() {
    releaseOperation(); ++state.refreshVersion; state.loading = false; state.connected = false; state.status = {}; state.cameras = []; state.listKnown = false; state.selected = ''; resetPlayer(); render(); selectionChanged();
  }
  function renderStatus() {
    const s = state.status;
    $('connection-badge').classList.toggle('online', state.connected);
    $('connection-badge').querySelector('span').textContent = state.connected ? '云端已连接' : '等待云端连接';
    $('account-name').textContent = s.phoneMasked || '云端账号';
    $('account-subtitle').textContent = state.connected ? s.roleName || '天翼视联 · 已连接' : '连接天翼视联';
    const unknownList = (state.connected && !state.listKnown) || (state.loading && !state.cameras.length);
    $('total-count').textContent = unknownList ? '—' : String(state.cameras.length);
    $('sidebar-count').textContent = unknownList ? '—' : String(state.cameras.length);
    $('online-count').textContent = unknownList ? '—' : String(state.cameras.filter(c => c.online).length);
    $('online-summary').textContent = state.loading ? '正在更新' : state.cameras.filter(c => c.online).length + ' 个在线';
    $('role-name').textContent = s.roleName || (state.connected ? '当前账号' : '未连接');
    $('refresh').disabled = state.loading;
    $('refresh').querySelector('svg').classList.toggle('refreshing', state.loading);
    $('dialog-status').textContent = state.connected ? '已连接' : '未连接';
    $('dialog-phone').textContent = s.phoneMasked || '—'; $('dialog-role').textContent = s.roleName || '—';
    $('account-description').textContent = state.connected ? '当前云端会话已连接。需要切换账号时，可重新打开官方登录页面。' : '通过官方页面完成登录，由本机服务接收授权结果。';
  }
  function emptyList(title, description, login = false) {
    const node = document.createElement('div'); node.className = 'list-empty'; node.append(icon('camera'));
    const strong = document.createElement('strong'); strong.textContent = title; node.append(strong);
    const p = document.createElement('p'); p.textContent = description; node.append(p);
    if (login) { const button = document.createElement('button'); button.className = 'text-button'; button.textContent = '连接云端账号 ›'; button.addEventListener('click', openAccount); node.append(button); }
    $('device-list').append(node);
  }
  function renderList() {
    const target = $('device-list'); target.replaceChildren(); target.setAttribute('aria-busy', String(state.loading));
    const query = $('search').value.trim().toLocaleLowerCase();
    if (!state.cameras.length) {
      if (state.loading) emptyList('正在加载设备', '从本地服务读取云端设备。');
      else if (state.listError) emptyList('设备列表未加载', state.listError);
      else if (!state.connected) emptyList('尚未连接云端账号', '登录后查看账号已授权的摄像头。', true);
      else emptyList('当前账号没有摄像头', '云端返回了空列表，可切换账号或角色后刷新。');
      return;
    }
    const visible = state.cameras.filter(c => [c.name, c.model, c.regionName].some(value => String(value || '').toLocaleLowerCase().includes(query)));
    if (!visible.length) { emptyList('没有匹配的摄像头', '试试其他名称、区域或型号。'); return; }
    for (const c of visible) {
      const button = document.createElement('button'); button.className = 'device-item' + (c.id === state.selected ? ' selected' : ''); button.setAttribute('aria-pressed', String(c.id === state.selected));
      const picture = document.createElement('span'); picture.className = 'device-icon'; picture.append(icon('camera')); const dot = document.createElement('i'); dot.className = c.online ? 'online' : ''; picture.append(dot);
      const copy = document.createElement('span'); copy.className = 'device-copy'; const name = document.createElement('strong'); name.textContent = c.name || '未命名摄像头'; const region = document.createElement('small'); region.textContent = c.regionName || c.model || '区域未提供'; copy.append(name, region);
      const online = document.createElement('span'); online.className = 'device-status' + (c.online ? ' online' : ''); online.textContent = c.online ? '在线' : '离线'; button.append(picture, copy, online); button.addEventListener('click', () => selectCamera(c.id)); target.append(button);
    }
  }
  function renderCamera() {
    const c = camera(); $('camera-name').textContent = c?.name || '选择摄像头'; $('camera-region').textContent = c?.regionName || '—'; $('camera-model').textContent = c?.model || '—';
    $('camera-status').textContent = c ? (c.online ? '设备在线' : '设备离线') : '未选择设备'; $('camera-status').classList.toggle('online', !!c?.online);
    $('preview-start').disabled = !state.connected || !c?.online || state.playback === 'requesting'; $('reconnect').disabled = !state.connected || !c || (!c.online && state.viewMode!=='playback') || state.playback === 'requesting';
    $('quality').disabled = !c || state.playback === 'requesting' || state.viewMode === 'playback'; $('fullscreen').disabled = !['loading', 'playing', 'paused'].includes(state.playback);
    if (state.playback === 'idle') setPlaceholder(c ? (c.online ? '画面，随时连接' : '摄像头当前离线') : '你的设备，一屏查看', c ? (c.online ? '开始预览以获取该摄像头的实时画面。' : '设备重新上线后，可刷新并开始预览。') : state.connected ? '从左侧选择摄像头，开始实时预览。' : '连接账号后，从左侧选择摄像头。');
    renderControls();
  }
  function renderControls() {
    const c = camera(), op = state.operation, allowed = state.connected && !!c?.online && c.ptzAvailable !== false && state.viewMode !== 'playback';
    for (const button of document.querySelectorAll('[data-direction]')) { button.disabled = !allowed || state.stopping || (!!op && (op.released || button.dataset.direction !== op.direction)); button.classList.toggle('active', !!op && !op.released && op.direction === button.dataset.direction); }
    $('speed').disabled = !!op || state.stopping; $('step').disabled = !!op || state.stopping;
    $('stop').disabled = !state.connected || (!c && !op) || state.stopping; $('pad-stop').disabled = $('stop').disabled;
    $('control-indicator').classList.toggle('active', !!op && !op.released);
    $('ptz-description').textContent = !c ? '选择在线摄像头后可操作。' : !c.online ? '设备离线，暂时无法控制。' : c.ptzAvailable === false ? '该摄像头未提供可用的云台能力。' : c.ptzAvailable === true ? '点按微调，按住连续移动。' : '云台能力待确认，以实际请求结果为准。';
    if(state.viewMode==='playback')$('ptz-description').textContent='正在查看历史录像；返回实时画面后可操作云台。';
  }
  function render() { renderStatus(); renderList(); renderCamera(); }
  async function refresh() {
    const version = ++state.refreshVersion; state.loading = true; state.listError = ''; render();
    try {
      const status = await request('status'); if (version !== state.refreshVersion) return;
      const identityChanged = state.connected && (state.status.phoneMasked !== status?.phoneMasked || state.status.roleName !== status?.roleName);
      state.status = status || {}; state.connected = status?.connected === true;
      if (identityChanged) { releaseOperation(); state.cameras = []; state.listKnown = false; selectCamera(''); resetPlayer(); }
      if (!state.connected) { state.cameras = []; state.listKnown = false; selectCamera(''); notice(''); return; }
      renderStatus();
      const data = await request('list'); if (version !== state.refreshVersion) return;
      if (!Array.isArray(data?.cameras)) throw new Error('设备列表格式不受支持，请检查本地服务响应。');
      state.cameras = data.cameras.filter(c => c && typeof c.id === 'string' && c.id).map(c => ({ ...c, online: c.online === true })); state.listKnown = true;
      if (!state.cameras.some(c => c.id === state.selected)) selectCamera(state.cameras[0]?.id || '');
      if (camera() && !camera().online) { releaseOperation(); resetPlayer(); }
      notice(Array.isArray(data.warnings) ? data.warnings.filter(value => typeof value === 'string').join(' ') : '');
    } catch (error) { if (version !== state.refreshVersion) return; state.listError = errorMessage(error); showError(error); }
    finally { if (version === state.refreshVersion) { state.loading = false; render(); selectionChanged(); } }
  }
  function selectCamera(id) {
    if (state.selected !== id) { releaseOperation(); state.selected = id; resetPlayer(); $('control-state').textContent = '等待操作'; }
    renderList(); renderCamera(); selectionChanged();
  }

  // Player integration contract owned by this page. This is NOT a vendor SDK API.
  // registerPlayer(protocol, async ({video,url,onState,onError}) => cleanupFunction)
  // A local FLV bridge may alternatively provide window.TyslFlvPlayer.mount(context).
  // The bridge must implement this adapter contract around its actual SDK.
  const playerAdapters = new Map();
  window.TyslConsole = Object.freeze({ registerPlayer(protocol, mount) { if (!['hls', 'flv', 'mp4'].includes(protocol) || typeof mount !== 'function') throw new TypeError('播放器适配器格式无效'); playerAdapters.set(protocol, mount); }, refresh,request,getCamera:()=>camera()?{...camera()}:undefined,getConnected:()=>state.connected,live:()=>preview(),playback:async args=>{const result=await preview('playback',args);if(!result?.url)throw new Error('录像回放未完成，请查看上方画面提示。');return result;} });
  function resetPlayer() {
    ++state.previewVersion; try { state.playerCleanup?.(); } catch { /* cleanup must not block switching cameras */ } state.playerCleanup = null;
    state.playback = 'idle'; state.viewMode='live'; state.playbackArgs=null; const video = $('video'); video.pause(); video.removeAttribute('src'); video.load(); $('video-frame').classList.remove('has-media'); $('live-badge').hidden = true; $('video-loading').hidden = true; $('video-placeholder').hidden = false;
    state.protocol = ''; $('camera-protocol').textContent = '—'; $('playback-state').textContent = '尚未开始预览';
  }
  function setPlaceholder(title, description) { $('video-title').textContent = title; $('video-description').textContent = description; $('video-placeholder').hidden = false; }
  function playerState(value) {
    state.playback = value; $('live-badge').hidden = value !== 'playing' || state.viewMode==='playback'; $('video-loading').hidden = value !== 'loading' && value !== 'requesting';
    $('playback-state').textContent = ({ idle: '尚未开始预览', requesting: '正在请求视频地址', loading: '正在连接视频', playing: state.viewMode==='playback'?'正在回放录像':'正在实时预览', paused: '播放已暂停', ended:'录像回放结束', error: '预览连接失败', unsupported: '当前播放器暂不支持该协议' })[value] || '等待播放'; renderCamera();
  }
  function previewFailure(error, unsupported = false) {
    ++state.previewVersion;
    try { state.playerCleanup?.(); } catch {} state.playerCleanup = null; $('video').pause(); $('video').removeAttribute('src'); $('video-frame').classList.remove('has-media');
    playerState(unsupported ? 'unsupported' : 'error'); setPlaceholder(unsupported ? '播放器正在接入' : '暂时无法预览', errorMessage(error));
    if (!unsupported) showError(error);
  }
  async function nativePlayer(context) {
    const { video, url, protocol, onError, onState } = context;
    if (protocol === 'hls') {
      const Hls = window.Hls;
      if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
        const hls = new Hls();
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) { console.warn('HLS playback', data.type, data.details); onError(new Error('HLS 视频连接中断，请重新连接预览。')); } });
        hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => onState('paused')); });
        hls.loadSource(url); hls.attachMedia(video); return () => hls.destroy();
      }
      if (!video.canPlayType('application/vnd.apple.mpegurl')) { const error = new Error('当前浏览器没有可用的 HLS 播放能力。'); error.unsupported = true; throw error; }
    }
    video.src = url; video.play().catch(() => onState('paused')); return () => { video.pause(); video.removeAttribute('src'); };
  }
  async function preview(action='preview',args={}) {
    const selected = camera(); if (!selected || !state.connected || (action!=='playback'&&!selected.online)) return;
    releaseOperation(); resetPlayer(); state.viewMode=action==='playback'?'playback':'live'; state.playbackArgs=state.viewMode==='playback'?{...args}:null;
    const version = state.previewVersion, id = selected.id; playerState('requesting'); $('video-loading-text').textContent = '正在获取视频地址'; notice('');
    const isCurrent = () => version === state.previewVersion && id === state.selected && !state.disposed;
    try {
      const result = await request(action, { ...args,cameraId: id,...(action==='preview'?{quality:$('quality').value}:{}) }); if (!isCurrent()) return;
      const protocol = result?.protocol; state.protocol = protocol || ''; $('camera-protocol').textContent = typeof protocol === 'string' ? protocol.toUpperCase() : '—';
      if (!['hls', 'flv', 'mp4'].includes(protocol)) { const error = new Error(result?.message || '当前设备的视频协议尚未接入本地网页，设备列表和云台仍可单独使用。'); error.unsupported = true; throw error; }
      let url; try { url = new URL(result.url); } catch { throw new Error('本地服务未返回有效的视频地址。'); }
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('视频地址协议暂不支持。');
      let mount = playerAdapters.get(protocol);
      if (!mount && protocol === 'flv') {
        if (window.TyslFlvPlayer && typeof window.TyslFlvPlayer.mount === 'function') mount = context => window.TyslFlvPlayer.mount(context);
        else { const error = new Error(result?.message || '已取得 FLV 视频地址，本地 FLV 播放器正在接入，当前暂不能在此页播放。'); error.unsupported = true; throw error; }
      }
      const context = { video: $('video'), url: url.href, protocol, onState: value => { if (isCurrent()) playerState(value); }, onError: error => { if (isCurrent()) previewFailure(error); } };
      $('video-placeholder').hidden = true; $('video-frame').classList.add('has-media'); $('video-loading-text').textContent = '正在连接视频'; playerState('loading');
      const cleanup = await (mount || nativePlayer)(context);
      if (!isCurrent()) { if (typeof cleanup === 'function') cleanup(); return; }
      state.playerCleanup = typeof cleanup === 'function' ? cleanup : null;
      return result;
    } catch (error) { if (isCurrent()) previewFailure(error, error?.unsupported === true); }
  }
  $('video').addEventListener('playing', () => { if (['loading', 'paused', 'playing'].includes(state.playback)) { $('video-placeholder').hidden = true; playerState('playing'); } });
  $('video').addEventListener('pause', () => { if (['playing', 'loading'].includes(state.playback)) playerState('paused'); });
  $('video').addEventListener('waiting', () => { if (['playing', 'paused'].includes(state.playback)) playerState('loading'); });
  $('video').addEventListener('ended', () => { if(state.viewMode==='playback')playerState('ended'); });
  $('video').addEventListener('error', () => { if ($('video').getAttribute('src') && ['playing', 'loading', 'paused'].includes(state.playback)) previewFailure(new Error('浏览器无法播放当前视频，请重新连接或检查本地播放器支持。')); });

  async function stopRequest(id, quiet = false) {
    try { const result = await request('stop', { cameraId: id }, { keepalive: true }); if (result?.ok !== true) throw new Error('停止请求未得到确认。'); return true; }
    catch (error) { if (!quiet && !state.disposed) { $('control-state').textContent = '停止未确认'; showError(new Error('云台停止未得到确认：' + errorMessage(error))); } return false; }
  }
  function releaseOperation() {
    const op = state.operation; if (!op || op.released) return;
    op.released = true; if (op.waitResolve) op.waitResolve(); $('control-state').textContent = '正在安排停止…'; renderControls();
    // Capture the moving camera ID. Never stop the newly selected camera instead.
    op.releasePromise = stopRequest(op.cameraId, state.disposed);
  }
  async function move(direction, source, keyOrPointer) {
    const c = camera(); if (!c?.online || !state.connected || c.ptzAvailable === false || !directions.has(direction) || state.operation || state.stopping) return;
    const op = { cameraId: c.id, direction, source, keyOrPointer, released: false, releasePromise: null, durationMs: Number($('step').value), speed: Number($('speed').value), deadline: performance.now() + MAX_HOLD_MS };
    state.operation = op; op.timeout = setTimeout(() => { if (state.operation === op && !op.released) { releaseOperation(); if (!state.disposed) notice('本次长按达到 10 秒上限，已安排停止。'); } }, MAX_HOLD_MS); renderControls(); notice(''); $('control-state').textContent = directionLabels[direction] + '移动中';
    let failed = false;
    try {
      do {
        const pulseStarted = performance.now();
        const result = await request('ptz', { cameraId: op.cameraId, direction, speed: op.speed, durationMs: op.durationMs });
        if (result?.ok !== true) throw new Error('云台操作未得到确认。');
        const remaining = op.durationMs - (performance.now() - pulseStarted);
        if (!op.released && remaining > 0) await new Promise(resolve => { const timer = setTimeout(done, remaining); function done() { clearTimeout(timer); op.waitResolve = null; resolve(); } op.waitResolve = done; });
        if (performance.now() >= op.deadline) { releaseOperation(); if (!state.disposed) notice('本次长按达到 10 秒上限，已安排停止。'); }
      } while (!op.released && state.selected === op.cameraId && state.connected && !state.disposed);
    } catch (error) { failed = true; op.released = true; if (!state.disposed) showError(error); }
    finally {
      op.released = true; clearTimeout(op.timeout); if (op.waitResolve) op.waitResolve();
      // A release can overtake an in-flight start request. Stop again AFTER that
      // pulse settles, and wait for any earlier stop before accepting a new hold.
      if (op.releasePromise) await op.releasePromise;
      const confirmed = await stopRequest(op.cameraId, state.disposed);
      if (state.operation === op) state.operation = null;
      if (!state.disposed) { $('control-state').textContent = confirmed ? (failed ? '操作未完成，停止已确认' : '停止已确认') : '停止未确认，请在官方客户端确认云台状态'; renderControls(); }
    }
  }
  async function emergencyStop() {
    if (state.operation) { releaseOperation(); return; }
    const c = camera(); if (!c || state.stopping || !state.connected) return;
    state.stopping = true; renderControls(); $('control-state').textContent = '正在停止…';
    const confirmed = await stopRequest(c.id); state.stopping = false; $('control-state').textContent = confirmed ? '停止已确认' : '停止未确认，请在官方客户端确认云台状态'; renderControls();
  }
  for (const button of document.querySelectorAll('[data-direction]')) {
    button.addEventListener('pointerdown', event => { if (event.button !== 0 || state.operation || state.stopping) return; event.preventDefault(); button.focus({ preventScroll: true }); try { button.setPointerCapture(event.pointerId); } catch {} void move(button.dataset.direction, 'pointer', event.pointerId); });
    button.addEventListener('lostpointercapture', event => { const op = state.operation; if (op?.source === 'pointer' && op.keyOrPointer === event.pointerId) releaseOperation(); });
    button.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!event.repeat) void move(button.dataset.direction, 'keyboard', event.key); } });
    button.addEventListener('blur', () => { if (state.operation?.source === 'keyboard') releaseOperation(); });
  }
  window.addEventListener('pointerup', event => { const op = state.operation; if (op?.source === 'pointer' && event.pointerId === op.keyOrPointer) releaseOperation(); }, true);
  window.addEventListener('pointercancel', () => releaseOperation(), true);
  window.addEventListener('keyup', event => { const op = state.operation; if (op?.source === 'keyboard' && event.key === op.keyOrPointer) releaseOperation(); }, true);
  window.addEventListener('blur', releaseOperation);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseOperation(); });
  window.addEventListener('pagehide', () => { state.disposed = true; releaseOperation(); if (state.operation) void stopRequest(state.operation.cameraId, true); resetPlayer(); });

  let loginState = '';
  function openAccount() { releaseOperation(); $('login-error').hidden = true; renderStatus(); $('account-description').textContent = '在官方页面完成短信登录，再将官方返回地址复制到下面的本机表单。现有连接会保留至新账号验证成功。'; $('account-dialog').showModal(); }
  function closeAccount() { $('login-callback').value = ''; $('account-dialog').close(); }
  async function startLogin() {
    $('login-error').hidden = true; $('login-fallback').hidden = true; $('login-start').disabled = true; $('login-complete-form').hidden = true; $('login-callback').value = ''; loginState = '';
    let popup = null; try { popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null; } catch {}
    try {
      const result = await request('login-start'); let url;
      try { url = new URL(result?.url); } catch { throw new Error('本地服务没有提供官方登录地址。'); }
      if (url.origin !== 'https://open.e.189.cn' || url.pathname !== '/api/logbox/oauth2/separate/unifyAccountLogin.do' || url.username || url.password || url.hash || !/^[a-f0-9]{32}$/.test(result?.state || '')) throw new Error('本地服务提供的登录流程无效。');
      loginState = result.state; $('login-complete-form').hidden = false;
      if (popup && !popup.closed) popup.location.replace(url.href);
      else { $('login-fallback').href = url.href; $('login-fallback').hidden = false; }
      $('account-description').textContent = '请在新打开的官方页面完成短信登录，然后复制完整返回地址到下方。此流程 10 分钟内有效。';
    } catch (error) { try { popup?.close(); } catch {} $('login-error').textContent = errorMessage(error); $('login-error').hidden = false; }
    finally { $('login-start').disabled = false; }
  }
  async function completeLogin(event) {
    event.preventDefault(); if (!loginState) return;
    const callbackUrl = $('login-callback').value.trim();
    if (!callbackUrl) { $('login-error').textContent = '请先粘贴官方登录后的完整返回地址。'; $('login-error').hidden = false; return; }
    $('login-error').hidden = true; $('login-complete').disabled = true; $('login-start').disabled = true; $('login-callback').value = '';
    try {
      const response = await fetch('/api/login/complete', {method:'POST', headers:{'Content-Type':'application/json'}, cache:'no-store', body:JSON.stringify({state:loginState,callbackUrl}), signal:AbortSignal.timeout(180000)});
      let result; try { result = await response.json(); } catch { throw new Error('本机登录服务返回了无法识别的响应。'); }
      if (!response.ok || result?.ok !== true) throw new ApiError(result?.message || '账号连接未完成。', response.status, result?.code);
      loginState = ''; $('login-complete-form').hidden = true; $('login-fallback').hidden = true; $('login-fallback').removeAttribute('href');
      await refresh(); closeAccount(); notice('账号已连接。');
    } catch (error) {
      if (!['LOGIN_CALLBACK_INVALID','LOGIN_PARAS_INVALID','INVALID_BODY'].includes(error?.code)) { loginState = ''; $('login-complete-form').hidden = true; }
      $('login-error').textContent = errorMessage(error); $('login-error').hidden = false;
    } finally { $('login-complete').disabled = false; $('login-start').disabled = false; }
  }
  $('account-button').addEventListener('click', openAccount); $('close-account').addEventListener('click', closeAccount);
  $('account-dialog').addEventListener('click', event => { if (event.target === $('account-dialog')) { const rect = $('account-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeAccount(); } });
  $('login-start').addEventListener('click', () => void startLogin());
  $('login-complete-form').addEventListener('submit', event => void completeLogin(event));
  $('login-refresh').addEventListener('click', async () => { $('login-refresh').disabled = true; await refresh(); $('login-refresh').disabled = false; if (state.connected && !state.listError) closeAccount(); else { $('login-error').textContent = state.listError || '当前尚未连接，请先完成官方登录并提交返回地址。'; $('login-error').hidden = false; } });
  $('dismiss-notice').addEventListener('click', () => notice('')); $('search').addEventListener('input', renderList); $('refresh').addEventListener('click', () => void refresh());
  $('preview-start').addEventListener('click', () => void preview()); $('reconnect').addEventListener('click', () => void (state.viewMode==='playback'?preview('playback',state.playbackArgs||{}):preview()));
  $('quality').addEventListener('change', () => { if (['playing', 'loading', 'paused'].includes(state.playback)) void preview(); });
  $('fullscreen').addEventListener('click', () => { if ($('video-frame').requestFullscreen) $('video-frame').requestFullscreen().catch(error => showError(error)); });
  $('speed').addEventListener('input', () => { $('speed-value').textContent = $('speed').value; }); $('stop').addEventListener('click', () => void emergencyStop()); $('pad-stop').addEventListener('click', () => void emergencyStop());
  $('local-origin').textContent = window.location.origin;
  render();
  void refresh().then(() => {
    const entry = new URLSearchParams(window.location.search);
    const id = entry.get('cameraId');
    if (!id || !state.connected || state.listError) return;
    if (!state.cameras.some(c => c.id === id)) { notice('链接中的摄像头不在当前账号设备列表中。', true); return; }
    selectCamera(id);
    if (['main', 'sub'].includes(entry.get('quality'))) $('quality').value = entry.get('quality');
    if(entry.get('playback')==='1')void preview('playback',{source:entry.get('source')||'cloud',date:entry.get('date'),...(entry.get('recordId')?{recordId:entry.get('recordId')}:{startTime:entry.get('startTime'),endTime:entry.get('endTime')})});
    else if (entry.get('preview') === '1') void preview();
  });
})();
