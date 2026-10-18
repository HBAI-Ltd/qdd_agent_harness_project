import MarkdownIt from "markdown-it";
import { mediaKind, safeMediaUrl, type MediaKind } from "./media.ts";

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

const renderImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index]!;
  const src = token.attrGet("src") ?? "";
  if (env?.mediaLinks && safeMediaUrl(src)) {
    const label = renderer.renderInlineAsText(token.children ?? [], options, env) || "图片";
    const enclosingLink = tokens.slice(0, index).findLast((entry) => entry.type === "link_open" || entry.type === "link_close");
    if (enclosingLink?.type === "link_open") return markdown.utils.escapeHtml(label);
    return `<a href="${markdown.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${markdown.utils.escapeHtml(label)}</a>`;
  }
  return renderImage(tokens, index, options, env, renderer);
};

export interface MarkdownMedia {
  src: string;
  label: string;
  kind: MediaKind;
}

// Parse HTML as opaque tokens for discovery only; the displayed HTML stays disabled.
const mediaMarkdown = new MarkdownIt({ html: true, linkify: true });
mediaMarkdown.validateLink = markdown.validateLink;

export function markdownMedia(content: string): MarkdownMedia[] {
  const result = new Map<string, MarkdownMedia>();
  for (const block of mediaMarkdown.parse(content, {})) {
    const tokens = block.children ?? [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.type !== "image" && token.type !== "link_open") continue;
      if (token.markup === "linkify" && /\]\(\s*$/.test(tokens[index - 1]?.content ?? "")) continue;
      const src = token.attrGet(token.type === "image" ? "src" : "href") ?? "";
      if (!safeMediaUrl(src) || !markdown.validateLink(src)) continue;
      const kind = mediaKind(src, token.attrGet("title") ?? "") ?? (token.type === "image" ? "image" : undefined);
      if (!kind) continue;
      let label = token.content;
      if (token.type === "link_open") {
        const close = tokens.findIndex((entry, position) => position > index && entry.type === "link_close");
        label = markdown.renderer.renderInlineAsText(tokens.slice(index + 1, close), markdown.options, {});
      }
      result.set(src, { src, kind, label: label || (kind === "image" ? "图片" : "视频") });
    }
  }
  return [...result.values()];
}

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
export function renderMarkdown(content: string, mediaLinks = false): string {
  return markdown.render(content, { mediaLinks });
}
