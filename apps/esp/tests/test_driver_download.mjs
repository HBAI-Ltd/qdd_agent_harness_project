import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";

const source = await readFile(new URL("../assets/driver-download.js", import.meta.url), "utf8");
const { sha256, downloadDriverZip, downloadAndSaveDriverZip, initDownloadWizard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const digest = value => createHash("sha256").update(value).digest("hex");
const payload = Uint8Array.from({length:20003},(_,i)=>(i*19+11)%256);
payload.set([80,75,3,4]);

function fixture(fault=()=>{}) {
  const calls=[], identity=digest(payload); let active=0, peak=0, cancels=0, arrayBuffers=0, clock=0;
  const fetchImpl=async (_url, options)=>{
    assert.equal(active,0,"Only one unfinished response may exist.");
    assert.equal(options.credentials,"omit"); assert.equal(options.cache,"no-store");
    const headers=new Headers(options.headers), range=headers.get("Range");
    const [start,end]=range.match(/\d+/g).map(Number);
    if (calls.length) assert.equal(headers.get("If-Match"),`"${identity}"`);
    else assert.equal(range,"bytes=0-0");
    const call={start,end,range,attempt:1+calls.filter(c=>c.range===range).length,signal:options.signal}; calls.push(call);
    const altered=fault(call,calls)||{}; if (altered.network) throw new TypeError("connection lost");
    const data=altered.data||payload.slice(start,end+1), status=altered.status||206;
    const responseHeaders=new Headers({"Content-Range":`bytes ${start}-${end}/${payload.length}`,
      "Content-Length":String(end-start+1),"ETag":`"${identity}"`,"X-QDD-ZIP-SHA256":identity,...altered.headers});
    active++;peak=Math.max(peak,active);let done=false,index=0;
    const close=()=>{if(!done){done=true;active--;}};
    const cancel=async()=>{cancels++;close();};
    return {status,headers:responseHeaders,body:{cancel,getReader:()=>({cancel,releaseLock(){},async read(){
      if(options.signal.aborted){close();throw options.signal.reason;}
      if(index>=data.length){close();return{done:true};}
      const value=data.subarray(index,index+Math.min(altered.chunk||1300,data.length-index));index+=value.length;
      return{done:false,value};
    }})},async arrayBuffer(){arrayBuffers++;close();return data.slice().buffer;}};
  };
  return {fetchImpl,calls,get peak(){return peak;},get active(){return active;},get cancels(){return cancels;},get arrayBuffers(){return arrayBuffers;},
    now:()=>clock,sleep:async ms=>{clock+=ms;},advance:ms=>{clock+=ms;}};
}

test("local SHA256 matches empty, abc, binary and multi-block Node crypto vectors without WebCrypto",()=>{
  for(const bytes of [new Uint8Array(),new TextEncoder().encode("abc"),Uint8Array.from({length:256},(_,i)=>i),payload,
    Uint8Array.from({length:100000},(_,i)=>(i*31)%256)]) assert.equal(sha256(bytes),digest(bytes));
  assert.equal(sha256(new TextEncoder().encode("abc")),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("verified sequential blocks save once only after whole ZIP SHA and never use unbounded arrayBuffer",async()=>{
  const f=fixture(),progress=[];let saves=0;
  const result=await downloadAndSaveDriverZip({...f,onProgress:p=>progress.push(p)},r=>{saves++;assert.equal(digest(r.bytes),digest(payload));});
  assert.deepEqual(result.bytes,payload);assert.equal(result.sha256,digest(payload));assert.equal(saves,1);
  assert.deepEqual(f.calls.map(c=>c.range),["bytes=0-0","bytes=0-8191","bytes=8192-16383","bytes=16384-20002"]);
  assert.equal(result.blocks,3);assert.equal(result.retries,0);assert.equal(result.attempts,4);
  assert.equal(f.peak,1);assert.equal(f.active,0);assert.equal(f.arrayBuffers,0);
  assert.deepEqual(progress.map(p=>p.received),[0,8192,16384,20003]);
  assert.deepEqual(Object.keys(progress[0]).sort(),["blocks","received","retries","total"]);
});

test("truncated block retries only that block without duplicating accepted bytes",async()=>{
  const f=fixture(c=>c.start===8192&&c.attempt===1?{data:payload.slice(8192,9000)}:null),progress=[];
  const result=await downloadDriverZip({...f,onProgress:p=>progress.push(p.received)});
  assert.deepEqual(result.bytes,payload);assert.equal(result.retries,1);
  assert.deepEqual(f.calls.map(c=>c.start),[0,0,8192,8192,16384]);
  assert.deepEqual(progress,[0,8192,16384,20003]);assert.equal(f.peak,1);assert.equal(f.active,0);
});

test("temporary busy and connection failures retry in a bounded sequential manner",async()=>{
  const f=fixture(c=>c.start===8192&&c.attempt===1?{status:503}:c.start===8192&&c.attempt===2?{network:true}:null);
  const result=await downloadDriverZip(f);
  assert.equal(result.retries,2);assert.equal(result.durationMs,750);assert.deepEqual(result.bytes,payload);assert.ok(f.cancels>0);
});

for(const [name,fault,code] of [
  ["wrong range",()=>({headers:{"Content-Range":`bytes 1-1/${payload.length}`}}),"invalid_response"],
  ["wrong hash",()=>({headers:{"X-QDD-ZIP-SHA256":"0".repeat(64)}}),"invalid_response"],
  ["weak etag",()=>({headers:{ETag:`W/\"${digest(payload)}\"`}}),"invalid_response"],
  ["full response instead of range",()=>({status:200}),"invalid_response"],
  ["resource version changed",c=>c.start===8192?{status:412}:null,"version_changed"],
  ["new valid etag/hash mid-download",c=>c.start===8192?{headers:{ETag:`\"${"f".repeat(64)}\"`,"X-QDD-ZIP-SHA256":"f".repeat(64)}}:null,"version_changed"],
  ["oversized response body",c=>c.end>0?{data:new Uint8Array(8193),chunk:8193}:null,"invalid_response"],
  ["wrong final SHA",c=>c.start===8192?{data:new Uint8Array(8192)}:null,"hash_mismatch"],
]) test(`${name} fails closed and never saves`,async()=>{
  const f=fixture(fault);let saves=0;
  await assert.rejects(downloadAndSaveDriverZip(f,()=>{saves++;}),error=>error.code===code);
  assert.equal(saves,0);assert.equal(f.active,0);
});

test("retry exhaustion does not restart accepted prefix or save partial bytes",async()=>{
  const f=fixture(c=>c.start===8192?{network:true}:null);let saves=0;
  await assert.rejects(downloadAndSaveDriverZip(f,()=>saves++),error=>error.code==="retry_exhausted");
  assert.deepEqual(f.calls.map(c=>c.start),[0,0,8192,8192,8192,8192]);assert.equal(saves,0);assert.equal(f.now(),1750);
});

test("cancellation after an accepted block and during backoff never starts another block or saves",async()=>{
  for(const backoff of [false,true]){
    const control=new AbortController(),f=fixture(c=>backoff&&c.start===8192?{status:503}:null);let saves=0;
    const options={...f,signal:control.signal,onProgress:p=>{if(!backoff&&p.received===8192)control.abort(new Error("user cancelled"));},
      sleep:async()=>{control.abort(new Error("user cancelled"));}};
    await assert.rejects(downloadAndSaveDriverZip(options,()=>saves++),/user cancelled/);
    assert.equal(f.calls.filter(c=>c.start===8192).length,backoff?1:0);assert.equal(saves,0);assert.equal(f.active,0);
  }
});

test("total ten-minute deadline is checked even when a supplied clock advances between blocks",async()=>{
  const f=fixture();let saves=0;
  await assert.rejects(downloadAndSaveDriverZip({...f,onProgress:p=>{if(p.received===8192)f.advance(600000);}},()=>saves++),error=>error.code==="timeout");
  assert.equal(f.calls.length,2);assert.equal(saves,0);
});

test("real loopback HTTP truncated response recovers only the current block with native fetch",async context=>{
  const identity=digest(payload),calls=[];let dropped=false;
  const server=createServer((request,response)=>{
    const [start,end]=request.headers.range.match(/\d+/g).map(Number);calls.push(start);
    if(calls.length>1) assert.equal(request.headers["if-match"],`"${identity}"`);
    response.writeHead(206,{"Content-Range":`bytes ${start}-${end}/${payload.length}`,
      "Content-Length":end-start+1,"ETag":`"${identity}"`,"X-QDD-ZIP-SHA256":identity,"Connection":"close"});
    if(start===8192&&!dropped){dropped=true;response.end(payload.subarray(start,start+1234));}
    else response.end(payload.subarray(start,end+1));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  context.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await downloadDriverZip({url:`http://127.0.0.1:${server.address().port}/qdd-desktop.zip`,signal:AbortSignal.timeout(5000)});
  assert.deepEqual(result.bytes,payload);assert.equal(result.retries,1);
  assert.deepEqual(calls,[0,0,8192,8192,16384]);assert.equal(result.sha256,identity);
});

test("DOM binds only the explicit resume entry; direct ZIP/APK links stay native and resume can cancel",async()=>{
  const nodes=new Map(),requests=[];
  function node(id,href){
    const value={id,href,hidden:false,listeners:new Map(),attributes:new Map(),parentNode:{append(){}},
      addEventListener(type,handler){this.listeners.set(type,handler);},
      setAttribute(key,value){this.attributes.set(key,value);},removeAttribute(key){this.attributes.delete(key);}};
    if(id)nodes.set(id,value);return value;
  }
  const direct=node("primary","/qdd-desktop.zip"),secondary=node("secondary","/qdd-desktop.zip"),apk=node("apk","/qdd-remote.apk"),resume=node("resume","/qdd-desktop.zip");
  for(const id of ["driver-download-status","driver-download-progress","driver-download-cancel","driver-download-retry"])node(id);
  const previousDocument=globalThis.document,previousFetch=globalThis.fetch;
  globalThis.document={readyState:"complete",getElementById:id=>nodes.get(id),createElement:()=>node(),
    querySelectorAll:selector=>selector==="[data-driver-resume]"?[resume]:selector==="a[href='/qdd-desktop.zip']"?[direct,secondary,resume]:[],};
  globalThis.fetch=(_url,options)=>new Promise((_,reject)=>{
    requests.push(options);options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true});
  });
  try{
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#resume-dom`);
    for(const link of [direct,secondary,apk])assert.equal(link.listeners.has("click"),false,"Ordinary downloads must not be intercepted.");
    assert.equal(requests.length,0,"Loading the page must never begin downloading.");
    const cancel=nodes.get("driver-download-cancel");assert.equal(cancel.hidden,true);
    let prevented=0;const click=resume.listeners.get("click");assert.equal(typeof click,"function");
    const pending=click({preventDefault(){prevented++;}});
    assert.equal(requests.length,1);assert.equal(new Headers(requests[0].headers).get("Range"),"bytes=0-0");
    assert.equal(cancel.hidden,false);assert.equal(nodes.get("driver-download-progress").hidden,false);
    await click({preventDefault(){prevented++;}});assert.equal(requests.length,1,"Repeated resume clicks cannot start a second task.");
    cancel.listeners.get("click")();await pending;
    assert.equal(prevented,2);assert.equal(cancel.hidden,true);assert.equal(nodes.get("driver-download-retry").hidden,false);
    assert.equal(nodes.get("driver-download-status").textContent,"已取消下载。");
    assert.equal(resume.attributes.has("aria-disabled"),false);assert.equal(requests.length,1);
  }finally{
    if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;
    globalThis.fetch=previousFetch;
  }
});

function wizardFixture(platform = "windows") {
  const nodes = new Map();
  const node = (id, attributes = {}) => {
    const value = { id, hidden: false, disabled: false, textContent: "", listeners: new Map(),
      getAttribute: name => attributes[name] ?? null,
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      setAttribute(name, value) { attributes[name] = value; },
      removeAttribute(name) { delete attributes[name]; },
      click(event = { preventDefault() { assert.fail("Native download must not be intercepted"); } }) { return this.listeners.get("click")?.(event); } };
    nodes.set(id, value); return value;
  };
  node("download-wizard", { "data-platform": platform });
  for (const id of ["install-step-1", "install-step-2", "install-step-3", "install-previous", "install-next", "install-counter", "install-navigation", "install-windows", "install-android", "install-download-note"]) node(id);
  const links = [node("zip", { "data-install-platform": "windows" }), node("apk", { "data-install-platform": "android" })];
  return { nodes, links, node, document: { getElementById: id => nodes.get(id), querySelectorAll: selector => selector === "[data-install-platform]" ? links : [] } };
}

test("computer resume keeps the complete wizard on Windows instructions and blocks competing native downloads", async context => {
  const f = wizardFixture("android"), el = id => f.nodes.get(id), transfer = fixture(), saves = [];
  const resume = f.node("resume");
  for (const id of ["driver-download-status", "driver-download-progress", "driver-download-cancel", "driver-download-retry"]) f.node(id);
  let release, pending;
  const paused = new Promise(resolve => { release = resolve; });
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  const nativeTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (handler, delay, ...args) =>
    delay === 60000 ? (handler(...args), 0) : nativeTimeout(handler, delay, ...args));
  globalThis.document = {...f.document, readyState: "complete", body: {append() {}},
    querySelectorAll: selector => selector === "[data-driver-resume]" ? [resume] : f.document.querySelectorAll(selector),
    createElement: () => ({click() { saves.push({href: this.href, name: this.download}); }, remove() {}})};
  globalThis.fetch = async (...args) => { await paused; return transfer.fetchImpl(...args); };
  try {
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#resume-wizard`);
    assert.equal(transfer.calls.length, 0, "Opening the page must not download.");
    el("install-next").click();
    assert(!el("install-step-2").hidden);
    let intercepted = 0;
    pending = resume.click({preventDefault() { intercepted++; }});
    assert(el("install-next").disabled && el("install-previous").disabled);
    assert(!el("install-windows").hidden && el("install-android").hidden,
      "The explicit computer resume action must select Windows instructions even on Android/unknown UA.");
    for (const link of f.links) link.click({preventDefault() { intercepted++; }});
    assert.equal(intercepted, 3, "Busy resume must prevent both native APK and ZIP requests.");
    assert(!el("install-windows").hidden && el("install-android").hidden,
      "A blocked Android click must not switch the active installation platform.");
    release();
    await pending;
    assert.equal(saves.length, 1); assert.equal(saves[0].name, "设备操作台.zip");
    assert(!el("install-step-2").hidden, "Saving a verified ZIP must never advance the guide automatically.");
    assert(!el("install-next").disabled);
    el("install-next").click();
    assert(!el("install-step-3").hidden && !el("install-windows").hidden && el("install-android").hidden);
    el("install-previous").click();
    f.links[1].click();
    assert(el("install-windows").hidden && !el("install-android").hidden,
      "After resume finishes, ordinary native downloads must be usable again.");
  } finally {
    el("driver-download-cancel").click();
    release();
    await pending;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
});

test("download wizard navigates only by explicit next/previous without claiming download completion", () => {
  for (const platform of ["windows", "android"]) {
    const f = wizardFixture(platform), el = id => f.nodes.get(id);
    initDownloadWizard(f.document);
    assert(!el("install-step-1").hidden); assert(el("install-step-2").hidden && el("install-step-3").hidden);
    assert(el("install-previous").disabled); assert(!el("install-navigation").hidden);
    el("install-next").click(); assert(!el("install-step-2").hidden);
    assert.equal(el("install-next").textContent, "已下载，下一步");
    f.links[platform === "windows" ? 0 : 1].click();
    assert(!el("install-step-2").hidden, "Native attachment click must not advance the wizard.");
    assert.match(el("install-download-note").textContent, /交给浏览器下载.*确认文件/);
    assert.doesNotMatch(el("install-download-note").textContent, /下载成功|下载完成|安装成功|已安装/);
    el("install-next").click(); assert(!el("install-step-3").hidden); assert(el("install-next").hidden);
    assert.equal(el("install-windows").hidden, platform !== "windows");
    assert.equal(el("install-android").hidden, platform !== "android");
    el("install-previous").click(); el("install-previous").click();
    assert(!el("install-step-1").hidden); assert(el("install-previous").disabled);
  }
});

test("explicit platform download changes installation instructions and active resume blocks navigation", () => {
  const f = wizardFixture("windows"), el = id => f.nodes.get(id), wizard = initDownloadWizard(f.document);
  el("install-next").click(); f.links[1].click();
  wizard.setBusy(true); assert(el("install-next").disabled && el("install-previous").disabled);
  el("install-next").click(); el("install-previous").click(); assert(!el("install-step-2").hidden);
  wizard.setBusy(false); assert(!el("install-next").disabled && !el("install-previous").disabled);
  el("install-next").click(); assert(el("install-windows").hidden); assert(!el("install-android").hidden);
});

test("incomplete wizard markup stays readable without partial enhancement", () => {
  const f = wizardFixture(); f.nodes.delete("install-next");
  assert.equal(initDownloadWizard(f.document), null);
  for (const id of ["install-step-1", "install-step-2", "install-step-3", "install-windows", "install-android"]) assert(!f.nodes.get(id).hidden);
});
