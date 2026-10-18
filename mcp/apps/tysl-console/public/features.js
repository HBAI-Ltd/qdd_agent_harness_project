'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const api = window.TyslConsole;
  const PAGE = 50;
  const statusLabels = { running: '采集中', done: '已完成', failed: '采集失败', cancelled: '已取消', interrupted: '已中断' };
  const state = { cameraId: '', connected: false, selectionVersion: 0, recordVersion: 0, datesVersion: 0, capabilityVersion: 0, records: [], recordOffset: 0, recordTotal: 0, recordMore: false, recordBusy: false, datesBusy: false, capabilityBusy: false, captureBusy: false, jobs: [], jobsVersion: 0, jobsBusy: false, timer: null, selectedJob: '', detailVersion: 0, detailOffset: 0, detailMore: false, detailBusy: false, root: '', directory: '', disposed: false };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function message(id, text = '', error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
  function errorText(error) {
    if (['TimeoutError', 'AbortError'].includes(error?.name)) return '本地服务响应超时，请稍后刷新任务确认结果。';
    if (error instanceof TypeError) return '无法连接本地服务，请确认控制台服务仍在运行。';
    return String(error?.message || '请求未完成，请稍后重试。').slice(0, 400);
  }
  function button(text, listener, className = 'button button-light') {
    const result = node('button', className, text); result.type = 'button';
    result.addEventListener('click', listener); return result;
  }
  function empty(target, text) { $(target).replaceChildren(node('p', 'feature-empty', text)); }
  function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
  function timestamp(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') { const date = new Date(value < 100000000000 ? value * 1000 : value); return Number.isNaN(date.getTime()) ? null : date; }
    const raw = String(value);
    if (/^\d{10,13}$/.test(raw)) return timestamp(Number(raw));
    // The service may return an explicitly Beijing-local value without a zone.
    const date = new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? raw.replace(' ', 'T') + '+08:00' : raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function displayTime(value, date = false) {
    const parsed = timestamp(value);
    if (!parsed) return value ? String(value).slice(0, 80) : '时间未提供';
    return parsed.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ...(date ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  function duration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    return seconds >= 60 ? Math.floor(seconds / 60) + ' 分 ' + Math.round(seconds % 60) + ' 秒' : Math.round(seconds * 10) / 10 + ' 秒';
  }
  function size(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';
  }
  function fileUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.username || url.password || url.search || url.hash) return '';
      if (!/^\/captures\/[a-f0-9]{32}\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.pathname)) return '';
      const filename = url.pathname.split('/').pop();
      if (filename.includes('..')) return '';
      return url.href;
    } catch { return ''; }
  }
  function jobId(value) { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : ''; }
  async function copyPath(path) {
    if (!path) return;
    try { await navigator.clipboard.writeText(path); message('jobs-message', '文件路径已复制，可交给本机图片分析工具使用。'); }
    catch { message('jobs-message', '浏览器未允许复制，可选中显示的路径手动复制。', true); }
  }
  function download(text, url, filename = '') {
    const anchor = node('a', 'button button-light', text); anchor.href = url; anchor.download = filename;
    return anchor;
  }
  function canUseCamera() { return state.connected && !!api?.getCamera?.()?.id; }
  function renderEnabled() {
    const ready = canUseCamera();
    $('recording-search').disabled = !ready || state.recordBusy;
    $('recording-source').disabled = state.recordBusy;
    $('recording-date').disabled = state.recordBusy;
    $('recording-dates').disabled = !ready || state.datesBusy || $('recording-source').value !== 'cloud';
    $('recording-live').disabled = !ready;
    $('camera-capabilities').disabled = !ready || state.capabilityBusy;
    for (const id of ['capture-snapshot', 'capture-frames', 'capture-video']) $(id).disabled = !ready || state.captureBusy;
    $('jobs-refresh').disabled = !state.connected || state.jobsBusy;
    $('recording-prev').disabled = state.recordBusy || state.recordOffset === 0;
    $('recording-next').disabled = state.recordBusy || !state.recordMore;
    $('frames-prev').disabled = state.detailBusy || state.detailOffset === 0;
    $('frames-next').disabled = state.detailBusy || !state.detailMore;
  }
  function clearRecords(text = '选择日期，查询该摄像头的录像。') {
    state.records = []; state.recordOffset = 0; state.recordTotal = 0; state.recordMore = false;
    $('recording-pagination').hidden = true; empty('recording-list', text);
  }
  function query() {
    const cameraId = api.getCamera()?.id, date = $('recording-date').value, source = $('recording-source').value;
    if (!state.connected || !cameraId) throw new Error('请先连接账号并选择摄像头。');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请选择有效的录像日期。');
    if (date > today()) throw new Error('录像日期不能晚于北京时间今天。');
    return { cameraId, date, source };
  }
  async function recordings(offset = 0) {
    let args;
    try { args = query(); } catch (error) { message('recording-message', errorText(error), true); return; }
    const version = ++state.recordVersion, selection = state.selectionVersion;
    state.recordBusy = true; $('recording-list').setAttribute('aria-busy', 'true'); renderEnabled();
    message('recording-message', '正在查询' + (args.source === 'cloud' ? '云端' : 'SD 卡') + '录像…');
    try {
      const result = await api.request('recordings', { ...args, offset, limit: PAGE });
      if (version !== state.recordVersion || selection !== state.selectionVersion) return;
      state.records = Array.isArray(result.recordings) ? result.recordings : [];
      state.recordOffset = Number.isInteger(result.offset) ? result.offset : offset;
      state.recordTotal = Number.isFinite(result.total) ? result.total : state.recordOffset + state.records.length;
      state.recordMore = result.hasMore === true;
      renderRecords(args);
      message('recording-message', state.records.length ? '已读取 ' + args.date + ' 的录像，时间均为北京时间。' : '该日期未查到录像。云存储服务状态或 SD 卡状态可能影响结果。');
    } catch (error) {
      if (version !== state.recordVersion || selection !== state.selectionVersion) return;
      clearRecords('录像查询未完成，请调整条件或重试。'); message('recording-message', errorText(error), true);
    } finally {
      if (version === state.recordVersion && selection === state.selectionVersion) { state.recordBusy = false; $('recording-list').setAttribute('aria-busy', 'false'); renderEnabled(); }
    }
  }
  function renderRecords(args) {
    const list = $('recording-list'); list.replaceChildren();
    if (!state.records.length) empty('recording-list', '这一天没有可显示的录像片段。');
    for (const record of state.records) {
      const row = node('article', 'recording-item'), copy = node('div', 'recording-copy');
      copy.append(node('strong', '', record.name || displayTime(record.startTime) + ' — ' + displayTime(record.endTime)));
      const details = [record.name ? displayTime(record.startTime) + ' — ' + displayTime(record.endTime) : '', duration(record.durationSeconds), size(record.bytes)].filter(Boolean);
      copy.append(node('p', '', details.join(' · ') || '时间与大小以云端提供的信息为准。'));
      if (record.encrypted) copy.append(node('p', 'recording-encrypted', '此录像已加密，暂不兼容回放与下载。'));
      const actions = node('div', 'recording-actions');
      const play = button('回放', async () => {
        const selection = state.selectionVersion;
        play.disabled = true; message('recording-message', '正在连接录像回放…');
        try { await api.playback({ date: args.date, source: args.source, recordId: record.id }); if (selection === state.selectionVersion) message('recording-message', '已切换到录像回放，可在上方画面中查看。'); }
        catch (error) { if (selection === state.selectionVersion) message('recording-message', errorText(error), true); }
        finally { if (selection === state.selectionVersion) play.disabled = !!record.encrypted; }
      }, 'button button-primary');
      play.disabled = !!record.encrypted;
      const clipDuration = Number(record.durationSeconds);
      if (Number.isFinite(clipDuration) && clipDuration > 600) copy.append(node('p', '', '本次保存片段前 10 分钟，可分段处理更长录像。'));
      const save = button('下载到本机', () => createCapture('capture-start', { cameraId: args.cameraId, mode: 'playback', source: args.source, date: args.date, recordId: record.id, kind: 'video', durationSeconds: Math.min(600, Number.isFinite(clipDuration) ? Math.floor(clipDuration) : 30) }, '正在提交录像保存任务…'));
      save.disabled = !!record.encrypted || (Number.isFinite(clipDuration) && clipDuration < 1);
      if (save.disabled && !record.encrypted) save.title = '该片段不足 1 秒，无法创建录像保存任务。';
      actions.append(play, save); row.append(copy, actions); list.append(row);
    }
    $('recording-pagination').hidden = state.recordOffset === 0 && !state.recordMore;
    $('recording-page-label').textContent = state.records.length ? '第 ' + (state.recordOffset + 1) + '–' + (state.recordOffset + state.records.length) + ' 段' + (state.recordTotal ? ' / 共 ' + state.recordTotal + ' 段' : '') : '没有更多片段';
  }
  async function dates() {
    if (!canUseCamera()) return;
    const cameraId = api.getCamera().id, selection = state.selectionVersion, version = ++state.datesVersion;
    state.datesBusy = true; renderEnabled(); message('recording-message', '正在读取可用的云录像日期…');
    try {
      const result = await api.request('recording-dates', { cameraId });
      if (selection !== state.selectionVersion || version !== state.datesVersion) return;
      const values = [...new Set((Array.isArray(result.dates) ? result.dates : []).filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort().reverse();
      const target = $('recording-date-options'); target.replaceChildren(); target.hidden = !values.length;
      for (const date of values) {
        const choose = button(date, () => { $('recording-date').value = date; updateDateButtons(); recordings(0); });
        choose.dataset.date = date; choose.setAttribute('aria-pressed', String(date === $('recording-date').value)); target.append(choose);
      }
      message('recording-message', values.length ? '可用日期 ' + values.length + ' 天，点击日期查询片段。' : '云端未返回可用录像日期，可手动选择日期查询。');
    } catch (error) { if (selection === state.selectionVersion && version === state.datesVersion) message('recording-message', errorText(error), true); }
    finally { if (selection === state.selectionVersion && version === state.datesVersion) { state.datesBusy = false; renderEnabled(); } }
  }
  function updateDateButtons() { for (const item of $('recording-date-options').querySelectorAll('button')) item.setAttribute('aria-pressed', String(item.dataset.date === $('recording-date').value)); }
  async function capabilities() {
    if (!canUseCamera()) return;
    const cameraId = api.getCamera().id, selection = state.selectionVersion, version = ++state.capabilityVersion;
    state.capabilityBusy = true; renderEnabled();
    const target = $('camera-capabilities-result'); target.hidden = false; target.textContent = '正在检查设备提供的能力…';
    try {
      const result = await api.request('capabilities', { cameraId });
      if (selection !== state.selectionVersion || version !== state.capabilityVersion) return;
      const flag = value => value === true ? '支持' : value === false ? '未提供' : '待确认';
      target.textContent = '实时预览：' + flag(result.live?.available) + ' · 云台控制：' + flag(result.ptz?.available) + ' · SD 卡回放：' + flag(result.sdPlayback?.available) + ' · 云录像查询：' + flag(result.cloudRecording?.queryAvailable) + '。实际录像以查询结果为准。';
    } catch (error) { if (selection === state.selectionVersion && version === state.capabilityVersion) target.textContent = errorText(error); }
    finally { if (selection === state.selectionVersion && version === state.capabilityVersion) { state.capabilityBusy = false; renderEnabled(); } }
  }
  function captureOptions(kind) {
    if (!canUseCamera()) throw new Error('请先连接账号并选择摄像头。');
    const maxWidth = Number($('capture-width').value);
    if (!Number.isInteger(maxWidth) || maxWidth < 320 || maxWidth > 1920) throw new Error('截图最大宽度应为 320–1,920 的整数。');
    const options = { cameraId: api.getCamera().id, maxWidth };
    if (kind === 'snapshot') return options;
    const durationSeconds = Number($('capture-duration').value);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > (kind === 'video' ? 600 : 3600)) throw new Error(kind === 'video' ? '本地视频时长应为 1–600 秒的整数。' : '批量截图时长应为 1–3,600 秒的整数。');
    Object.assign(options, { mode: 'live', kind, durationSeconds });
    if (kind === 'frames') {
      const fps = Number($('capture-fps').value);
      if (!Number.isFinite(fps) || fps < 0.1 || fps > 5) throw new Error('截图帧率应为每秒 0.1–5 帧。');
      if (Math.ceil(durationSeconds * fps) > 1800) throw new Error('单次最多保存 1,800 张截图，请降低时长或帧率。');
      options.fps = fps;
    }
    return options;
  }
  async function createCapture(action, args, progress) {
    if (state.captureBusy) { message('capture-message', '正在提交任务，请稍候。'); return; }
    const selection = state.selectionVersion;
    state.captureBusy = true; renderEnabled(); message('capture-message', progress || '正在提交本地采集任务…');
    try {
      const result = await api.request(action, args);
      if (selection !== state.selectionVersion) return;
      message('capture-message', action === 'snapshot' ? '截图已提交。保存路径与图片可在下方任务详情中查看。' : '采集任务已创建，文件保存在本机。可在下方查看进度与下载。');
      await refreshJobs();
      if (selection === state.selectionVersion && jobId(result.job?.id)) await openJob(result.job.id, 0);
    } catch (error) { if (selection === state.selectionVersion) message('capture-message', errorText(error), true); }
    finally { if (selection === state.selectionVersion) { state.captureBusy = false; renderEnabled(); } }
  }
  async function startCapture(kind) {
    let args;
    try { args = captureOptions(kind); } catch (error) { message('capture-message', errorText(error), true); return; }
    await createCapture(kind === 'snapshot' ? 'snapshot' : 'capture-start', args, kind === 'snapshot' ? '正在获取单张截图…' : '正在创建本地采集任务…');
  }
  function schedulePoll() {
    clearTimeout(state.timer); state.timer = null;
    if (!state.disposed && state.connected && state.jobs.some(job => job.status === 'running')) state.timer = setTimeout(() => refreshJobs(true), 5000);
  }
  async function refreshJobs(silent = false) {
    if (!state.connected || state.disposed) return;
    const version = ++state.jobsVersion;
    state.jobsBusy = true; $('jobs-list').setAttribute('aria-busy', 'true'); renderEnabled();
    if (!silent) message('jobs-message', '正在读取本地采集任务…');
    try {
      const result = await api.request('capture-list', {});
      if (version !== state.jobsVersion || !state.connected || state.disposed) return;
      state.jobs = (Array.isArray(result.jobs) ? result.jobs : []).filter(job => jobId(job?.id));
      state.root = typeof result.root === 'string' ? result.root : '';
      $('capture-root-path').textContent = state.root; $('capture-root').hidden = !state.root;
      renderJobs();
      if (!silent) message('jobs-message', state.jobs.length ? '共 ' + state.jobs.length + ' 个本地任务。' : '尚无采集任务，可先获取单张截图。');
      if (state.selectedJob) {
        if (!state.jobs.some(job => job.id === state.selectedJob)) closeJob();
        else if (!state.detailBusy) await openJob(state.selectedJob, state.detailOffset, true);
      }
    } catch (error) { if (version === state.jobsVersion) message('jobs-message', errorText(error), true); }
    finally { if (version === state.jobsVersion) { state.jobsBusy = false; $('jobs-list').setAttribute('aria-busy', 'false'); renderEnabled(); schedulePoll(); } }
  }
  function renderJobs() {
    const target = $('jobs-list'); target.replaceChildren();
    if (!state.jobs.length) { empty('jobs-list', '尚无本地任务。获取截图或保存录像后，可在这里查看。'); return; }
    for (const job of state.jobs) {
      const row = node('article', 'job-row'), copy = node('div', 'job-row-copy');
      const kind = job.kind === 'video' ? '本地录像' : '截图采集';
      copy.append(node('strong', '', (job.cameraName || '摄像头') + ' · ' + kind));
      const startedAt = job.startedAt || job.createdAt;
      const info = [job.sourceInfo?.mode === 'playback' ? '历史录像' : '实时采集', duration(job.durationSeconds), job.kind === 'frames' && job.fps ? job.fps + ' 帧/秒' : '', job.kind !== 'video' ? Number(job.frameCount || 0) + ' 张图片' : '', startedAt ? displayTime(startedAt, true) : ''].filter(Boolean);
      copy.append(node('p', '', info.join(' · ')));
      const status = Object.hasOwn(statusLabels, job.status) ? job.status : '';
      const badge = node('span', 'job-state' + (status ? ' ' + status : ''), statusLabels[status] || '状态待确认');
      const actions = node('div', 'job-row-actions'); actions.append(button(job.id === state.selectedJob ? '刷新详情' : '查看文件', () => openJob(job.id, 0)));
      if (status === 'running') actions.append(button('取消任务', async event => {
        const control = event.currentTarget, selection = state.selectionVersion; control.disabled = true;
        try { await api.request('capture-cancel', { jobId: job.id }); if (selection !== state.selectionVersion) return; message('jobs-message', '已请求取消，已保存的文件会保留。'); await refreshJobs(); }
        catch (error) { if (selection === state.selectionVersion) message('jobs-message', errorText(error), true); control.disabled = false; }
      }));
      row.append(copy, badge, actions); target.append(row);
    }
  }
  async function openJob(id, offset = 0, silent = false) {
    if (!jobId(id) || !state.connected || state.disposed) return;
    const version = ++state.detailVersion, selection = state.selectionVersion;
    state.selectedJob = id; state.detailBusy = true; renderEnabled();
    if (!silent) message('jobs-message', '正在读取任务详情…');
    try {
      const result = await api.request('capture-status', { jobId: id, offset, limit: PAGE });
      if (version !== state.detailVersion || selection !== state.selectionVersion || !state.connected) return;
      const job = result.job;
      if (!job || job.id !== id) throw new Error('本地服务返回了无法识别的任务详情。');
      state.detailOffset = Number.isInteger(result.offset) ? result.offset : offset;
      state.detailMore = result.hasMore === true;
      renderDetail(job, result);
      if (!silent) message('jobs-message', job.status === 'running' ? '任务正在采集，运行期间每 5 秒刷新。' : '任务文件已列出，图片与录像均保存在本机。');
      renderJobs();
    } catch (error) { if (version === state.detailVersion && selection === state.selectionVersion) message('jobs-message', errorText(error), true); }
    finally { if (version === state.detailVersion && selection === state.selectionVersion) { state.detailBusy = false; renderEnabled(); } }
  }
  function renderDetail(job, result) {
    $('job-detail').hidden = false;
    $('job-detail-title').textContent = (job.cameraName || '摄像头') + ' · ' + (job.kind === 'video' ? '本地录像' : '截图采集');
    const total = Number.isFinite(result.totalFrames) ? result.totalFrames : Number(job.frameCount || 0);
    const source = job.sourceInfo?.mode === 'playback' ? '历史录像' + (job.sourceInfo.date ? ' · ' + job.sourceInfo.date : '') : '实时采集';
    const description = [statusLabels[job.status] || '状态待确认', source, job.kind !== 'video' ? '已保存 ' + total + ' 张' : '', '任务 ' + job.id].filter(Boolean);
    $('job-detail-description').textContent = description.join(' · ');
    state.directory = typeof job.directory === 'string' ? job.directory : '';
    $('job-directory-path').textContent = state.directory; $('job-directory').hidden = !state.directory;
    const videoTarget = $('job-video'); videoTarget.replaceChildren();
    const manifest = download('下载任务清单 · JSON', '/api/captures/' + job.id + '/manifest', 'capture-' + job.id + '.json'); manifest.classList.add('job-manifest'); videoTarget.append(manifest);
    if (job.error?.message) videoTarget.append(node('p', 'feature-message error', String(job.error.message).slice(0, 400)));
    if (job.kind !== 'video' && total) videoTarget.append(node('p', 'feature-hint', '下方时间为本机任务开始时间加解码采样时间的近似值；历史录像拍摄时间请参见任务清单 sourceInfo。'));
    const videoUrl = fileUrl(job.video?.url);
    if (videoUrl) {
      const video = node('div', 'capture-video-file'), info = node('div', 'capture-video-copy', '视频已保存' + (size(job.video.bytes) ? ' · ' + size(job.video.bytes) : ''));
      if (typeof job.video.path === 'string') info.append(node('code', '', job.video.path));
      video.append(info, download('下载 MP4', videoUrl));
      if (typeof job.video.path === 'string') video.append(button('复制视频路径', () => copyPath(job.video.path)));
      videoTarget.append(video);
    } else if (job.kind === 'video') videoTarget.append(node('p', 'feature-hint', job.status === 'running' ? '录像完成后会显示 MP4 下载链接。' : '本次任务暂无可下载的视频文件。'));
    const frames = Array.isArray(job.frames) ? job.frames : [];
    const grid = $('job-frames'); grid.replaceChildren();
    for (const frame of frames.slice(0, PAGE)) {
      const url = fileUrl(frame?.url); if (!url) continue;
      const card = node('figure', 'frame-card');
      const imageLink = node('a', 'frame-image-link'); imageLink.href = url; imageLink.target = '_blank'; imageLink.rel = 'noopener noreferrer';
      const image = node('img'); image.src = url; image.loading = 'lazy'; image.decoding = 'async';
      image.alt = '截图 ' + (Number.isFinite(frame.sequence) ? frame.sequence : '') + (Number.isFinite(frame.relativeSeconds) ? ' · 第 ' + frame.relativeSeconds + ' 秒' : ''); imageLink.append(image);
      const caption = node('figcaption'); caption.append(node('span', 'frame-caption', image.alt));
      if (frame.capturedAt) caption.append(node('span', 'frame-date', '本机采集约 ' + displayTime(frame.capturedAt, true) + ' 北京时间'));
      const actions = node('div', 'frame-actions'); actions.append(download('下载图片', url));
      if (typeof frame.path === 'string') { const copy = button('复制路径', () => copyPath(frame.path)); copy.title = frame.path; actions.append(copy); }
      caption.append(actions); card.append(imageLink, caption); grid.append(card);
    }
    if (!grid.childElementCount && job.kind !== 'video') grid.append(node('p', 'feature-hint', job.status === 'running' ? '正在采集，首张截图保存后会显示在这里。' : '本次任务暂无已保存的图片。'));
    $('frames-pagination').hidden = state.detailOffset === 0 && !state.detailMore;
    $('frames-page-label').textContent = frames.length ? '第 ' + (state.detailOffset + 1) + '–' + (state.detailOffset + frames.length) + ' 张 / 共 ' + total + ' 张' : '共 ' + total + ' 张';
  }
  function closeJob() { ++state.detailVersion; state.selectedJob = ''; state.detailBusy = false; state.detailOffset = 0; state.detailMore = false; state.directory = ''; $('job-detail').hidden = true; $('job-frames').replaceChildren(); $('job-video').replaceChildren(); renderEnabled(); }
  function selectionChanged() {
    if (!api) return;
    ++state.selectionVersion; ++state.recordVersion; ++state.datesVersion; ++state.capabilityVersion; ++state.jobsVersion;
    clearTimeout(state.timer); state.timer = null;
    state.connected = api.getConnected() === true; state.cameraId = api.getCamera()?.id || '';
    state.recordBusy = false; state.datesBusy = false; state.capabilityBusy = false; state.captureBusy = false; state.jobsBusy = false;
    $('recording-list').setAttribute('aria-busy', 'false'); $('jobs-list').setAttribute('aria-busy', 'false');
    $('recording-camera').textContent = api.getCamera() ? '当前摄像头：' + (api.getCamera().name || state.cameraId) : '选择摄像头后查询云端或 SD 卡录像。';
    clearRecords(); $('recording-date-options').replaceChildren(); $('recording-date-options').hidden = true;
    $('camera-capabilities-result').hidden = true; $('camera-capabilities-result').textContent = '';
    message('recording-message'); message('capture-message'); message('jobs-message'); closeJob();
    if (!state.connected) { state.jobs = []; state.root = ''; $('capture-root').hidden = true; empty('jobs-list', '连接账号后查看当前账号的本地采集任务。'); }
    renderEnabled(); if (state.connected) refreshJobs();
  }

  $('recording-date').value = today(); $('recording-date').max = today();
  if (!api || typeof api.request !== 'function') { message('recording-message', '网页组件未加载完成，请刷新控制台。', true); for (const section of document.querySelectorAll('.media-features button')) section.disabled = true; return; }
  $('recording-form').addEventListener('submit', event => { event.preventDefault(); updateDateButtons(); recordings(0); });
  $('recording-source').addEventListener('change', () => { ++state.recordVersion; ++state.datesVersion; state.recordBusy = false; state.datesBusy = false; clearRecords(); $('recording-date-options').hidden = true; message('recording-message'); renderEnabled(); });
  $('recording-date').addEventListener('change', () => { ++state.recordVersion; state.recordBusy = false; clearRecords(); updateDateButtons(); message('recording-message'); renderEnabled(); });
  $('recording-dates').addEventListener('click', dates);
  $('recording-prev').addEventListener('click', () => recordings(Math.max(0, state.recordOffset - PAGE)));
  $('recording-next').addEventListener('click', () => recordings(state.recordOffset + PAGE));
  $('recording-live').addEventListener('click', async () => { const selection = state.selectionVersion; try { await api.live(); if (selection === state.selectionVersion) message('recording-message', '已返回实时预览。'); } catch (error) { if (selection === state.selectionVersion) message('recording-message', errorText(error), true); } });
  $('camera-capabilities').addEventListener('click', capabilities);
  $('capture-form').addEventListener('submit', event => event.preventDefault());
  $('capture-snapshot').addEventListener('click', () => startCapture('snapshot'));
  $('capture-frames').addEventListener('click', () => startCapture('frames'));
  $('capture-video').addEventListener('click', () => startCapture('video'));
  $('jobs-refresh').addEventListener('click', () => refreshJobs());
  $('capture-root-copy').addEventListener('click', () => copyPath(state.root));
  $('job-directory-copy').addEventListener('click', () => copyPath(state.directory));
  $('job-detail-close').addEventListener('click', closeJob);
  $('frames-prev').addEventListener('click', () => openJob(state.selectedJob, Math.max(0, state.detailOffset - PAGE)));
  $('frames-next').addEventListener('click', () => openJob(state.selectedJob, state.detailOffset + PAGE));
  window.addEventListener('tysl-selection', selectionChanged);
  window.addEventListener('pagehide', () => { state.disposed = true; clearTimeout(state.timer); });
  selectionChanged();
})();
