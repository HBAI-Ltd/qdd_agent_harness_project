import vm from "node:vm";

// Execute only the settings script in an isolated DOM/network fixture.
export function bootSettingsHtml(html) {
  const elements = new Map(), requests = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", hidden: false, append() {}, replaceChildren() {} });
    return elements.get(id);
  };
  const context = { document: { getElementById: element, createElement: () => ({}) }, location: { href: "" }, AbortController, URL, performance, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, json: async () => options.method === "POST"
        ? { url: "http://127.0.0.1:8971/", restart: false } : { boards: [] } };
    } };
  vm.runInNewContext(html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>")), context);
  return { elements, requests, context, html };
}
