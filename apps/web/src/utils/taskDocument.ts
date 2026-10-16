export const TASK_PREVIEW_CHANNEL = "harness-task-preview";

function serializeScriptValue(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildTaskDocument(
  content: { html: string; script: string; css: string },
  token: string,
): string {
  const document = new DOMParser().parseFromString(content.html, "text/html");
  const bootstrap = document.createElement("script");
  bootstrap.textContent = `(() => {
    const reportError = (message) => {
      parent.postMessage({
        channel: ${serializeScriptValue(TASK_PREVIEW_CHANNEL)},
        token: ${serializeScriptValue(token)},
        type: "error",
        message: String(message || "页面脚本运行失败")
      }, "*");
    };
    window.addEventListener("error", (event) => {
      if (event instanceof ErrorEvent) reportError(event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      reportError(event.reason instanceof Error ? event.reason.message : event.reason);
    });
    const style = document.createElement("style");
    style.textContent = ${serializeScriptValue(content.css)};
    document.head.append(style);
  })();`;
  document.head.prepend(bootstrap);

  if (!document.querySelector("meta[charset]")) {
    const charset = document.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    document.head.prepend(charset);
  }

  if (!document.querySelector('meta[name="viewport"]')) {
    const viewport = document.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    document.head.insertBefore(viewport, bootstrap);
  }

  if (content.script) {
    const scriptBootstrap = document.createElement("script");
    scriptBootstrap.textContent = `(() => {
      const script = document.createElement("script");
      script.textContent = ${serializeScriptValue(content.script)};
      document.body.append(script);
    })();`;
    document.body.append(scriptBootstrap);
  }

  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
}
