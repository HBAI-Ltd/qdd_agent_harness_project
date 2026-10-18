const BLOCK = 8192, RETRIES = 3, LIMIT = 2 * 1024 * 1024, WALL_MS = 600000;
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];

// Works on an ordinary HTTP LAN origin; WebCrypto/secure context is not needed.
export function sha256(bytes) {
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 128;
  const view = new DataView(padded.buffer), words = new Uint32Array(64);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, bytes.length * 8);
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x,7) ^ rotate(x,18) ^ (x >>> 3)) + words[i - 7] + (rotate(y,17) ^ rotate(y,19) ^ (y >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const t = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + K[i] + words[i]) >>> 0;
      const u = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+t)>>>0; d=c; c=b; b=a; a=(t+u)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((value, i) => { hash[i] = (hash[i] + value) >>> 0; });
  }
  return hash.map(value => value.toString(16).padStart(8, "0")).join("");
}

class DownloadError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new DownloadError(code); };
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, {once:true});
  if (signal.aborted) abort();
});

export async function downloadDriverZip({url="/qdd-desktop.zip", fetchImpl=globalThis.fetch,
  signal, onProgress=()=>{}, onRetry=()=>{}, now=()=>performance.now(), sleep=wait}={}) {
  const control = new AbortController(), started = now();
  const abort = () => control.abort(signal.reason || new DownloadError("cancelled"));
  signal?.addEventListener("abort", abort, {once:true});
  if (signal?.aborted) abort();
  const wall = setTimeout(() => control.abort(new DownloadError("timeout")), WALL_MS);
  let output, identity, blocks=0, retries=0, attempts=0;
  const check = () => {
    if (control.signal.aborted) throw control.signal.reason;
    if (now() - started >= WALL_MS || now() < started) fail("timeout");
  };
  async function read(start, end) {
    for (let retry=0;;retry++) {
      check(); attempts++;
      const request = new AbortController(), stop = () => request.abort(control.signal.reason);
      control.signal.addEventListener("abort", stop, {once:true});
      const timeout = setTimeout(() => request.abort(new Error("request timeout")), 8000);
      let response;
      try {
        const headers = {Range:`bytes=${start}-${end}`};
        if (identity) headers["If-Match"] = identity.etag;
        response = await fetchImpl(url, {headers, signal:request.signal, cache:"no-store", credentials:"omit"});
        if (response.status === 412) fail("version_changed");
        if (response.status === 503) throw new Error("busy");
        if (response.status !== 206) fail("invalid_response");
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
        const total = range ? Number(range[3]) : NaN;
        const hash = response.headers.get("X-QDD-ZIP-SHA256") || "", etag = response.headers.get("ETag");
        if (!range || Number(range[1]) !== start || Number(range[2]) !== end ||
            !Number.isSafeInteger(total) || total < 64 || total > LIMIT || end >= total ||
            response.headers.get("Content-Length") !== String(end-start+1) || !/^[0-9a-f]{64}$/.test(hash) || etag !== `"${hash}"`) fail("invalid_response");
        if (identity && (total !== identity.total || hash !== identity.sha256 || etag !== identity.etag)) fail("version_changed");
        if (!response.body?.getReader) fail("invalid_response");
        const reader=response.body.getReader(), bytes=new Uint8Array(end-start+1); let used=0;
        try {
          for (;;) {
            const {done,value}=await reader.read(); check();
            if (done) break;
            if (value.length>bytes.length-used) fail("invalid_response");
            bytes.set(value,used); used+=value.length;
          }
          if (used!==bytes.length) throw new Error("truncated block");
        } finally { try {await reader.cancel();} catch {} reader.releaseLock(); }
        check();
        return {bytes, total, sha256:hash, etag};
      } catch (error) {
        check();
        if (error instanceof DownloadError) throw error;
        if (retry >= RETRIES) fail("retry_exhausted");
        retries++; onRetry({start,end,attempt:retry+1});
      } finally {
        clearTimeout(timeout); control.signal.removeEventListener("abort", stop);
        try { await response?.body?.cancel(); } catch {}
      }
      await sleep(250 * 2 ** retry, control.signal); check();
    }
  }
  try {
    identity = await read(0,0); output = new Uint8Array(identity.total);
    onProgress({received:0,total:identity.total,blocks,retries});
    for (let offset=0; offset<output.length;) {
      const end = Math.min(offset+BLOCK,output.length)-1, part = await read(offset,end);
      output.set(part.bytes,offset); offset=end+1; blocks++;
      onProgress({received:offset,total:output.length,blocks,retries});
    }
    check();
    if (sha256(output) !== identity.sha256) fail("hash_mismatch");
    check();
    return {bytes:output,sha256:identity.sha256,etag:identity.etag,total:output.length,blocks,retries,attempts,durationMs:now()-started};
  } catch (error) { output?.fill(0); throw error; }
  finally { clearTimeout(wall); signal?.removeEventListener("abort",abort); }
}

export async function downloadAndSaveDriverZip(options, save) {
  const result = await downloadDriverZip(options); await save(result); return result;
}

export function initDownloadWizard(document) {
  const root = document.getElementById("download-wizard");
  if (!root) return null;
  const panes = [1, 2, 3].map(step => document.getElementById(`install-step-${step}`));
  const previous = document.getElementById("install-previous"), next = document.getElementById("install-next");
  const counter = document.getElementById("install-counter"), navigation = document.getElementById("install-navigation");
  const windows = document.getElementById("install-windows"), android = document.getElementById("install-android");
  const note = document.getElementById("install-download-note");
  // Keep the complete, usable HTML guide if any required element is missing.
  if ([...panes, previous, next, counter, navigation, windows, android, note].some(node => !node)) return null;
  const platformLinks = [...document.querySelectorAll("[data-install-platform]")];
  let step = 1, busy = false, platform = root.getAttribute("data-platform") === "windows" ? "windows" : "android";
  const render = () => {
    panes.forEach((pane, index) => { pane.hidden = index !== step - 1; });
    counter.textContent = `第 ${step} 步 / 共 3 步`;
    previous.disabled = busy || step === 1;
    next.disabled = busy;
    next.hidden = step === 3;
    next.textContent = step === 2 ? "已下载，下一步" : "下一步";
    windows.hidden = platform !== "windows";
    android.hidden = platform !== "android";
    for (const link of platformLinks) {
      if (busy) link.setAttribute("aria-disabled", "true"); else link.removeAttribute("aria-disabled");
    }
  };
  previous.addEventListener("click", () => { if (!busy && step > 1) { step--; render(); } });
  next.addEventListener("click", () => { if (!busy && step < 3) { step++; render(); } });
  for (const link of platformLinks) {
    link.addEventListener("click", event => {
      if (busy) { event.preventDefault(); return; }
      platform = link.getAttribute("data-install-platform") === "windows" ? "windows" : "android";
      note.textContent = "已交给浏览器下载。请在下载列表确认文件，再点击“已下载，下一步”。";
      render();
      // This is a native attachment link: do not intercept or start a fetch.
    });
  }
  navigation.hidden = counter.hidden = false;
  render();
  return {
    setBusy(value) { busy = !!value; render(); },
    setPlatform(value) { if (!busy) { platform = value === "windows" ? "windows" : "android"; render(); } }
  };
}

function init() {
  const wizard = initDownloadWizard(document);
  const links = [...document.querySelectorAll("[data-driver-resume]")];
  if (!links.length) return;
  const element = (id,tag) => {
    let node=document.getElementById(id);
    if (!node) { node=document.createElement(tag); node.id=id; links[0].parentNode.append(node); }
    return node;
  };
  const status=element("driver-download-status","p"), progress=element("driver-download-progress","progress");
  const cancel=element("driver-download-cancel","button"), retry=element("driver-download-retry","button");
  status.setAttribute("role","status"); status.setAttribute("aria-live","polite");
  cancel.textContent="取消下载"; retry.textContent="重新下载"; cancel.hidden=retry.hidden=progress.hidden=true;
  let active;
  const begin = async event => {
    event?.preventDefault(); if (active) return;
    active=new AbortController(); retry.hidden=true; cancel.hidden=false; progress.hidden=false;
    wizard?.setPlatform("windows");
    wizard?.setBusy(true);
    links.forEach(link=>link.setAttribute("aria-disabled","true")); status.textContent="正在连接设备…";
    try {
      await downloadAndSaveDriverZip({signal:active.signal,
        onProgress:({received,total})=>{progress.max=total;progress.value=received;status.textContent=`正在下载 ${Math.floor(received/total*100)}%`;},
        onRetry:()=>{status.textContent="连接中断，正在重试当前部分…";}}, ({bytes})=>{
          const url=URL.createObjectURL(new Blob([bytes],{type:"application/zip"}));
          const link=document.createElement("a"); link.href=url; link.download="设备操作台.zip";
          document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
        });
      status.textContent="校验通过，已发起 ZIP 下载。解压后运行设备操作台。";
    } catch(error) {
      status.textContent=active.signal.aborted ? "已取消下载。" : error.code==="version_changed" ? "设备版本已变化，请重新下载。" :
        error.code==="hash_mismatch" ? "文件校验未通过，请重试。" : "下载未完成，请检查连接后重试。";
      retry.hidden=false;
    } finally {active=null;cancel.hidden=true;links.forEach(link=>link.removeAttribute("aria-disabled"));wizard?.setBusy(false);}
  };
  links.forEach(link=>link.addEventListener("click",begin)); retry.addEventListener("click",begin);
  cancel.addEventListener("click",()=>active?.abort(new DownloadError("cancelled")));
}
if (typeof document!=="undefined") {
  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",init,{once:true}); else init();
}
