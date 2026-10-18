import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { Auth } from "./gateway/auth.js";
import { ChatImageError, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_VIDEO_BYTES, readChatImage, readChatVideo } from "./gateway/chat-images.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace } from "./web/site.js";

const TOKEN = "chat-image-gateway-token";
const CAPTURE = `/captures/${"a".repeat(32)}/frame_000001.jpg`;
// Offline JPEG marker fixture: transfer and signature checks never use camera pictures.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
type Mode = "mp4" | "large-video" | "jpeg" | "redirect" | "html" | "spoof" | "truncated" | "missing" | "forbidden" | "error" | "large-header" | "large-stream" | "slow" | "slow-body";

async function setup(t: TestContext, provider: "haik" | "tysl" | "ezviz" = "haik") {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "qdd-chat-images-"));
  let gateway: Gateway | undefined;
  let sources: DataSources | undefined;
  let mode: Mode = "jpeg";
  let mcpFailure = false;
  const captures: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const otherRequests: string[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/captures/")) {
      captures.push({ url: req.url, headers: req.headers });
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      if (req.headers.origin) return void res.writeHead(403).end("cross-site denied");
      if (mode === "mp4") return void res.writeHead(200, { "Content-Type": "video/mp4" }).end(Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"));
      if (mode === "large-video") return void res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": MAX_CHAT_VIDEO_BYTES + 1 }).end();
      if (mode === "redirect") return void res.writeHead(302, { Location: "/secret" }).end();
      if (mode === "missing") return void res.writeHead(404).end("secret upstream text");
      if (mode === "forbidden") return void res.writeHead(403).end("secret upstream text");
      if (mode === "error") return void res.writeHead(500).end("secret upstream text");
      if (mode === "html") return void res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>login</h1>");
      res.setHeader("Content-Type", "image/jpeg");
      if (mode === "spoof") return void res.end("<html>not a JPEG</html>");
      if (mode === "truncated") return void res.end(JPEG.subarray(0, -2));
      if (mode === "large-header") return void res.writeHead(200, { "Content-Length": MAX_CHAT_IMAGE_BYTES + 1 }).end();
      if (mode === "large-stream") {
        res.writeHead(200, { "Transfer-Encoding": "chunked" });
        res.write(Buffer.alloc(MAX_CHAT_IMAGE_BYTES, 0xff));
        return void res.end(Buffer.alloc(1));
      }
      if (mode === "slow-body") res.write(JPEG.subarray(0, 3));
      if (mode === "slow" || mode === "slow-body") {
        timers.push(setTimeout(() => res.end(mode === "slow-body" ? JPEG.subarray(3) : JPEG), 200));
        return;
      }
      return void res.end(JPEG);
    }
    if (req.url === "/secret") {
      otherRequests.push(req.url);
      return void res.writeHead(200).end("must never be fetched");
    }
    if (req.method === "DELETE") return void res.writeHead(200).end();
    if (mcpFailure) return void res.writeHead(503).end("offline fixture");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw) as { id?: number; method: string };
    if (request.id === undefined) return void res.writeHead(202).end();
    const result = request.method === "tools/list" ? { tools: [{ name: "capture_status", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } : {};
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await gateway?.close();
    await sources?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith("qdd-chat-images-"));
    await rm(target, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  loaded.config.mcpServers = { [provider]: { url: `${origin}/mcp`, headers: { "X-MCP-Secret": "source-secret" } } };
  await ensureWorkspace(loaded.paths);
  sources = await DataSources.open(loaded);
  gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => async () => ({ role: "assistant", content: "offline" }), scheduler: false });
  const api = (route: string, init: RequestInit = {}) => fetch(gateway!.url + route, {
    ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  const image = (url = origin + CAPTURE, init: RequestInit = {}) => api("/api/chat/images", { method: "POST", body: JSON.stringify({ url }), ...init });
  const install = async () => {
    const response = await api("/api/connectors", { method: "POST", body: JSON.stringify({ type: "camera", mode: "mcp", provider }) });
    assert.equal(response.status, 201, await response.text());
  };
  return { origin, loaded, sources, gateway, captures, otherRequests, api, image, install, setMode: (value: Mode) => { mode = value; }, failMcp: () => { mcpFailure = true; } };
}

for (const provider of ["haik", "tysl", "ezviz"] as const) {
  test(`chat image reads installed ${provider} JPEG frames and revokes access on uninstall`, async (t) => {
    const { image, install, api, captures, sources } = await setup(t, provider);
    assert.equal((await image()).status, 403, "configured camera URLs are not installed connectors");
    assert.equal(captures.length, 0);
    await install();
    assert.ok(sources.mcpServers[provider]);
    const response = await image(undefined, { headers: { Cookie: "browser-secret", "X-MCP-Secret": "browser-header" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), JPEG);
    assert.equal(captures[0]?.headers.authorization, undefined);
    assert.equal(captures[0]?.headers.cookie, undefined);
    assert.equal(captures[0]?.headers["x-mcp-secret"], undefined);
    assert.equal(captures[0]?.headers.origin, undefined);
    assert.equal((await api(`/api/connectors/mcp%3A${provider}`, { method: "DELETE" })).status, 200);
    assert.equal((await image()).status, 403);
    assert.equal(captures.length, 1);
  });
}

test("chat image endpoint accepts only gateway authentication and POST", async (t) => {
  const { image, install, api, gateway, origin, captures } = await setup(t);
  await install();
  for (const headers of [
    { Authorization: "" },
    { Authorization: "Bearer wrong-token" },
    { Authorization: "", "X-QDD-Page": "camera-page", "X-QDD-Page-Token": new Auth(TOKEN).pageToken("camera-page") },
  ]) assert.equal((await image(undefined, { headers })).status, 401);
  assert.equal((await fetch(`${gateway.url}/api/chat/images?access_token=${TOKEN}`, { method: "POST", body: JSON.stringify({ url: origin + CAPTURE }), headers: { "Content-Type": "application/json" } })).status, 401);
  assert.equal((await api("/api/chat/images")).status, 405);
  assert.equal(captures.length, 0);
  assert.equal((await api("/health")).status, 200);
  assert.equal((await api("/unknown-route")).status, 404);
});

test("chat image endpoint rejects arbitrary URLs, credentials and normalized path bypasses without fetching", async (t) => {
  const { origin, install, image, captures, api } = await setup(t);
  await install();
  const invalid = [
    origin + "/health", origin + CAPTURE + "?token=secret", origin + CAPTURE + "#fragment",
    origin.replace("http://", "http://user:secret@") + CAPTURE,
    origin + CAPTURE.replace("frame_000001.jpg", "recording.mp4"),
    origin + CAPTURE.replace("frame_000001.jpg", "frame_000001.png"),
    origin + "/private/../" + CAPTURE.slice(1), origin + "/private/%2e%2e/" + CAPTURE.slice(1),
    origin + CAPTURE.replace("frame_", "%66rame_"), origin + CAPTURE.replaceAll("/", "\\"),
    "file:///C:/secret.jpg", "data:image/jpeg;base64,/9j/", "//127.0.0.1" + CAPTURE,
  ];
  for (const url of invalid) assert.equal((await image(url)).status, 400, url);
  assert.equal((await image("http://127.0.0.1:1" + CAPTURE)).status, 403);
  assert.equal((await api("/api/chat/images", { method: "POST", body: JSON.stringify({ url: origin + CAPTURE, headers: { Cookie: "secret" } }) })).status, 400);
  assert.equal((await api("/api/chat/images", { method: "POST", body: "null" })).status, 400);
  assert.equal((await api("/api/chat/images", { method: "POST", body: JSON.stringify({ url: "a".repeat(5000) }) })).status, 413);
  assert.equal(captures.length, 0);
});

test("chat image endpoint refuses disconnected or failed camera connectors", async (t) => {
  const { install, image, sources, loaded, failMcp, captures } = await setup(t);
  await install();
  failMcp();
  await sources.reloadMcp(loaded);
  assert.equal((await image()).status, 403);
  assert.equal(captures.length, 0);
});

test("chat image endpoint rejects redirects, non-JPEGs, missing frames and oversized bodies with safe errors", async (t) => {
  const { install, image, setMode, captures, otherRequests } = await setup(t);
  await install();
  for (const [mode, status] of [
    ["redirect", 502], ["html", 502], ["spoof", 502], ["truncated", 502],
    ["missing", 404], ["forbidden", 403], ["error", 502], ["large-header", 413], ["large-stream", 413],
  ] as const) {
    setMode(mode);
    const response = await image();
    assert.equal(response.status, status, mode);
    const error = await response.json() as { error: string };
    assert.equal(typeof error.error, "string");
    assert.doesNotMatch(error.error, /secret|source-secret|Bearer|http:/);
  }
  assert.ok(captures.every((request) => request.url === CAPTURE), "redirect destinations are not followed");
  assert.deepEqual(otherRequests, [], "no redirect request reaches the destination");
});

test("chat image reader bounds both initial response and body waits", async (t) => {
  const { origin, setMode } = await setup(t);
  for (const mode of ["slow", "slow-body"] as const) {
    setMode(mode);
    await assert.rejects(readChatImage({ url: origin + CAPTURE }, new Set([origin]), { timeoutMs: 25 }), (error: unknown) => error instanceof ChatImageError && error.status === 504);
  }
});

test("chat video gateway reads only installed camera MP4 artifacts with admin authorization", async (t) => {
  const { origin, install, api, captures, setMode, otherRequests } = await setup(t, "tysl");
  const url = origin + CAPTURE.replace("frame_000001.jpg", "recording.mp4");
  const video = (value = url, headers = {}) => api("/api/chat/videos", { method: "POST", headers, body: JSON.stringify({ url: value }) });
  setMode("mp4");
  assert.equal((await video()).status, 403);
  await install();
  assert.equal((await video(url, { Authorization: "" })).status, 401);
  assert.equal((await api("/api/chat/videos")).status, 405);
  const response = await video(url, { Cookie: "secret" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("ascii", 4, 8), "ftyp");
  assert.equal(captures.length, 1);
  assert.equal(captures[0]?.headers.cookie, undefined);
  assert.equal(captures[0]?.headers.authorization, undefined);
  for (const invalid of [url + "?token=secret", url + "#fragment", url.replace("recording.mp4", "other.mp4"), origin + "/health", url.replace("/captures/", "/private/../captures/")]) {
    assert.equal((await video(invalid)).status, 400);
  }
  assert.equal((await video("http://127.0.0.1:1" + new URL(url).pathname)).status, 403);
  assert.equal(captures.length, 1);
  for (const [mode, status] of [["redirect", 502], ["html", 502], ["jpeg", 502], ["missing", 404], ["forbidden", 403], ["large-video", 413]] as const) {
    setMode(mode);
    assert.equal((await video()).status, status, mode);
  }
  assert.deepEqual(otherRequests, []);
  setMode("slow");
  await assert.rejects(readChatVideo({ url }, new Set([origin]), { timeoutMs: 25 }), (error: unknown) => error instanceof ChatImageError && error.status === 504);
  await api("/api/connectors/mcp%3Atysl", { method: "DELETE" });
  assert.equal((await video()).status, 403);
});
