import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Resolve the workspace's TypeScript 6 JS API rather than the server's hoisted TS 7.
require("vue-tsc").run(require.resolve("typescript/lib/tsc"));
