import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
});

// Markdown also decodes entities in URLs before validating them. Keep the
// allowed protocols narrow rather than relying on a list of unsafe schemes.
markdown.validateLink = (url) => {
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* Keep malformed escapes literal. */ }
  const normalized = decoded.trim().replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  return !protocol || protocol === "https" || protocol === "http" || protocol === "mailto";
};

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]!;
  if (/^https?:|^\/\//i.test(token.attrGet("href") ?? "")) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return renderer.renderToken(tokens, index, options);
};

// Give wide tables their own scroll area instead of widening the conversation.
markdown.renderer.rules.table_open = () => '<div class="markdown-table-scroll"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";

markdown.core.ruler.after("inline", "task_lists", (state) => {
  for (let index = 2; index < state.tokens.length; index += 1) {
    const token = state.tokens[index]!;
    const item = state.tokens[index - 2]!;
    const firstText = token.children?.[0];
    if (token.type !== "inline" || state.tokens[index - 1]?.type !== "paragraph_open"
      || item.type !== "list_item_open" || firstText?.type !== "text") continue;
    const marker = /^\[([ xX])\](?:\s+|$)/.exec(firstText.content);
    if (!marker) continue;
    firstText.content = firstText.content.slice(marker[0].length);
    item.attrJoin("class", "task-list-item");
    const checkbox = new state.Token("task_checkbox", "input", 0);
    checkbox.attrSet("type", "checkbox");
    checkbox.attrSet("disabled", "");
    checkbox.attrSet("aria-label", marker[1] === " " ? "未完成" : "已完成");
    if (marker[1] !== " ") checkbox.attrSet("checked", "");
    token.children!.unshift(checkbox);
  }
});
markdown.renderer.rules.task_checkbox = (tokens, index, options, _env, renderer) =>
  `${renderer.renderToken(tokens, index, options)} `;

/** Render untrusted assistant Markdown; raw HTML is always displayed as text. */
export function renderMarkdown(content: string): string {
  return markdown.render(content);
}
