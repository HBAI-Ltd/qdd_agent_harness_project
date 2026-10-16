# Repository Guidelines

## Project Structure & Module Organization

This Node.js/TypeScript monorepo provides the initial QDD store assistant service.

- `apps/server/src/index.ts`: HTTP server, configuration validation, and `/health` endpoint.
- `packages/shared/src/index.ts`: shared types and constants, imported as `@qdd/shared`.
- `tsconfig.base.json`: shared strict compiler settings.
- `tsconfig.json`: workspace build references; `tsconfig.check.json`: repository-wide type checking.
- Each workspace emits compiled files into its own `dist/`. No dedicated tests or assets directories exist yet.

When adding workspaces, update build references and dependencies. Add shared-package mappings to `tsconfig.check.json` and consumer project references where needed.

## Build, Test, and Development Commands

Use Node.js 24+ and npm 11+; `.node-version` pins Node.js 24.15.0. Run commands from the repository root:

- `npm ci`: install dependencies from the committed lockfile.
- `npm run dev`: build, watch TypeScript changes, and restart the server automatically.
- `npm run build`: compile workspaces in dependency order.
- `npm run typecheck`: check all source files without generating output.
- `npm start`: run the compiled server after building.
- `npm run clean`: remove TypeScript build outputs and incremental build metadata.

## Coding Style & Naming Conventions

Follow `.editorconfig`: UTF-8, LF endings, two-space indentation, and a final newline. Match existing TypeScript with double quotes and semicolons. Use camelCase for variables/functions, PascalCase for types/interfaces, and UPPER_SNAKE_CASE for constants such as `SERVICE_NAME`.

Use ES modules and NodeNext-compatible imports; import shared code through workspace package names. Mark type-only imports explicitly. Preserve strict compiler checks. No formatter or linter is configured.

## Testing Guidelines

No automated test framework, `npm test` command, or coverage threshold is configured. Before submitting changes, run `npm run typecheck` and `npm run build`. Start the server and verify `GET /health` returns HTTP 200 with `status: "ok"`; unknown routes should return HTTP 404. If introducing tests, document their location, naming convention, and execution command.

## Commit & Pull Request Guidelines

History is limited; the latest commit uses `chore: initialize Node.js monorepo`. Follow that concise, imperative, type-prefixed style, for example `feat: add assistant endpoint`.

Pull requests should describe the change, link relevant issues, list validation performed, and explain configuration or API changes. Include request/response examples for endpoint changes.

## Security & Configuration

Copy `.env.example` to `.env` to customize `HOST` and `PORT`. Keep secrets and local environment files out of Git; update `.env.example` with safe defaults when adding configuration. Commit dependency lockfile changes, but exclude generated `dist/` files.
