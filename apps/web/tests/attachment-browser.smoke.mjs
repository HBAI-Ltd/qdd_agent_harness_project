import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { build } from "vite";
import { docxFixture, pdfFixture } from "./attachment-fixtures.ts";

// Run with Node 24+: node apps/web/tests/attachment-browser.smoke.mjs
// QDD_BROWSER_EXECUTABLE can point at an installed Chrome or Chromium executable.
const executablePath = [process.env.QDD_BROWSER_EXECUTABLE,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(executablePath, "Install Chrome or set QDD_BROWSER_EXECUTABLE to run the attachment browser smoke check.");

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "qdd-attachment-browser-"));
const outputDirectory = join(temporaryRoot, "dist");
const harnessName = `.attachment-smoke-${process.pid}.html`;
const harnessPath = join(webRoot, harnessName);
let browser;
let server;
try {
  writeFileSync(harnessPath, `<!doctype html><html><body><script type="module">
    import { fileToMarkdown } from "./src/utils/attachmentMarkdown.ts";
    window.convertAttachment = (name, bytes) => fileToMarkdown(new File([Uint8Array.from(bytes)], name));
  </script></body></html>`, "utf8");
  await build({
    configFile: false,
    root: webRoot,
    logLevel: "error",
    build: {
      outDir: outputDirectory,
      // Match the app setting; the PDF worker must explicitly opt out of inlining.
      assetsInlineLimit: Infinity,
      rollupOptions: { input: harnessPath },
    },
  });
  server = createServer((request, response) => {
    const path = resolve(outputDirectory, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
    if (!path.startsWith(`${resolve(outputDirectory)}${sep}`)) { response.writeHead(403).end(); return; }
    try {
      const contentType = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css" }[extname(path)] ?? "application/octet-stream";
      response.writeHead(200, {
        "content-type": contentType,
        // Exercise a deployment that allows only same-origin scripts and workers.
        "content-security-policy": "default-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'",
      }).end(readFileSync(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  await page.goto(`http://127.0.0.1:${server.address().port}/${harnessName}`);
  await page.waitForFunction(() => typeof window.convertAttachment === "function");
  const convert = (name, bytes) => page.evaluate((fileName, contents) => window.convertAttachment(fileName, contents), name, Array.from(bytes));

  const pdf = await convert("report.pdf", pdfFixture());
  assert.match(pdf.markdown, /### 第 1 页\n\nSales report 120/);
  const twoPages = await convert("report.pdf", pdfFixture("Page text", 2));
  assert.match(twoPages.markdown, /### 第 2 页\n\nPage text/);
  await assert.rejects(convert("scanned.pdf", pdfFixture("")), /OCR/);
  await assert.rejects(convert("too-many-pages.pdf", pdfFixture("text", 101)), /100 页/);
  await assert.rejects(convert("bad.pdf", Buffer.from("not a PDF")), /无法转换 PDF 附件/);

  const docx = await convert("报告.docx", docxFixture());
  assert.match(docx.markdown, /# 报告标题/);
  assert.match(docx.markdown, /\*\*销售增长\*\*/);
  assert.match(docx.markdown, /\| 门店 \| 销售额 \|\n\| --- \| --- \|\n\| A \| 120 \|/);
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.ok(requests.every((request) => request.method === "GET"), "Conversion must not upload source files.");
  assert.ok(requests.some((request) => /pdf\.worker.*\.mjs/.test(request.url)), "PDF worker should load as a same-origin asset.");
  console.log("Attachment browser smoke passed: built PDF/DOCX conversion, strict CSP, multipage/empty/corrupt/page-limit errors, no file upload.");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(harnessPath, { force: true });
  // Verify the absolute target before recursively removing our isolated temporary build.
  const target = resolve(temporaryRoot);
  assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && basename(target).startsWith("qdd-attachment-browser-"));
  rmSync(target, { recursive: true, force: true });
}
