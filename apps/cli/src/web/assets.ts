/** harness 内置的风格提示词与页面主题。agent 无权修改。 */

export const DEFAULT_STYLE_PROMPT = `# 页面风格提示词

所有许愿生成的页面都必须遵守本提示词。可通过 \`PUT /api/style\` 或 \`npm run qdd -- style --edit\` 修改。

- 整体：简洁、专业的门店经营看板风格，信息密度适中，留白充足。
- 必须引入 \`../../assets/theme.css\`，只使用其中的 CSS 变量（--qdd-*）和组件类取色排版，不要新增主色。
- 布局：顶部 \`.qdd-header\`（标题 + 一句话结论 + 数据日期范围）→ \`.qdd-kpis\` KPI 卡片行 → 图表卡片 → 明细表。窄屏单列。
- 图表：统一使用 ECharts 5（jsDelivr CDN），系列颜色依次取 --qdd-chart-1 … --qdd-chart-6（用 getComputedStyle 读取），网格线用 --qdd-border，文字用 --qdd-muted。
- 文案：简体中文；金额前缀「¥」保留两位小数，大数字千分位；结论先行。
- 推演：假设/预测/模拟类需求用 \`.qdd-controls\` 里的滑块或输入框调参，结果在浏览器内实时重算，并标注「推演值」。
- 卡片：圆角 var(--qdd-radius)、细边框，不用大面积阴影和渐变，不用 emoji 充当图标。
- 同时适配浅色和深色模式（theme.css 已处理变量，页面不要写死颜色）。
`;

export const THEME_CSS = `:root {
  --qdd-bg: #f6f7f9;
  --qdd-surface: #ffffff;
  --qdd-text: #1c2430;
  --qdd-muted: #667085;
  --qdd-border: #e4e7ec;
  --qdd-primary: #d4380d;
  --qdd-primary-soft: #fff1ec;
  --qdd-good: #12805c;
  --qdd-warn: #b54708;
  --qdd-bad: #c01048;
  --qdd-chart-1: #d4380d;
  --qdd-chart-2: #2e6fdb;
  --qdd-chart-3: #12805c;
  --qdd-chart-4: #c4920c;
  --qdd-chart-5: #7a5af8;
  --qdd-chart-6: #0e9384;
  --qdd-radius: 10px;
  --qdd-font: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --qdd-bg: #0f1419;
    --qdd-surface: #171d24;
    --qdd-text: #e6e9ee;
    --qdd-muted: #98a2b3;
    --qdd-border: #2a323c;
    --qdd-primary: #ff7a45;
    --qdd-primary-soft: #2b1a13;
    --qdd-good: #3ccb8f;
    --qdd-warn: #f5a524;
    --qdd-bad: #f8577f;
    --qdd-chart-1: #ff7a45;
    --qdd-chart-2: #6ea1ff;
    --qdd-chart-3: #3ccb8f;
    --qdd-chart-4: #e8b931;
    --qdd-chart-5: #a48afb;
    --qdd-chart-6: #2ed3b7;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--qdd-bg); color: var(--qdd-text); font: 14px/1.6 var(--qdd-font); }
.qdd-page { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 16px; }
.qdd-header h1 { margin: 0; font-size: 22px; }
.qdd-header p { margin: 4px 0 0; color: var(--qdd-muted); }
.qdd-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.qdd-card { background: var(--qdd-surface); border: 1px solid var(--qdd-border); border-radius: var(--qdd-radius); padding: 16px; min-width: 0; }
.qdd-card h2 { margin: 0 0 12px; font-size: 15px; }
.qdd-kpi .label { color: var(--qdd-muted); font-size: 12px; }
.qdd-kpi .value { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.qdd-kpi .delta.up { color: var(--qdd-good); }
.qdd-kpi .delta.down { color: var(--qdd-bad); }
.qdd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 16px; }
.qdd-chart { width: 100%; height: 320px; }
.qdd-controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.qdd-controls label { display: grid; gap: 4px; color: var(--qdd-muted); font-size: 12px; }
.qdd-controls input, .qdd-controls select { font: inherit; color: inherit; background: var(--qdd-bg); border: 1px solid var(--qdd-border); border-radius: 6px; padding: 4px 8px; }
.qdd-controls input[type="range"] { accent-color: var(--qdd-primary); padding: 0; }
.qdd-table-wrap { overflow-x: auto; }
table.qdd-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.qdd-table th, .qdd-table td { padding: 8px 10px; border-bottom: 1px solid var(--qdd-border); text-align: left; white-space: nowrap; }
.qdd-table th { color: var(--qdd-muted); font-weight: 500; font-size: 12px; }
.qdd-table td.num, .qdd-table th.num { text-align: right; }
.qdd-muted { color: var(--qdd-muted); }
.qdd-badge { display: inline-block; padding: 0 8px; border-radius: 999px; font-size: 12px; background: var(--qdd-primary-soft); color: var(--qdd-primary); }
.qdd-badge.good { background: transparent; color: var(--qdd-good); border: 1px solid currentColor; }
.qdd-badge.warn { background: transparent; color: var(--qdd-warn); border: 1px solid currentColor; }
.qdd-badge.bad { background: transparent; color: var(--qdd-bad); border: 1px solid currentColor; }
`;
