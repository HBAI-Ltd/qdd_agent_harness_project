import vm from "node:vm";

// Execute only the settings script in an isolated DOM/network fixture.
export function bootSettingsHtml(html, options = {}) {
  const elements = new Map(), requests = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", hidden: false, children: [],
      append(child) { this.children.push(child); }, replaceChildren() { this.children = []; this.value = ""; } });
    return elements.get(id);
  };
  const context = { document: { getElementById: element, createElement: () => ({}) }, location: { href: "", hash: options.hash ?? "" }, AbortController, URL, performance,
    setTimeout: options.setTimeout ?? setTimeout, clearTimeout: options.clearTimeout ?? clearTimeout,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (fetchResponse) return fetchResponse(url, options);
      return { ok: true, json: async () => options.method === "POST"
        ? { url: "http://127.0.0.1:8971/", restart: false } : { boards: [] } };
    } };
  const fetchResponse = options.fetch;
  vm.runInNewContext(html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>")), context);
  return { elements, requests, context, html };
}
