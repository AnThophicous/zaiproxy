# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript Node.js proxy for Z.AI with OpenAI-compatible routes. Source lives in `src/`, compiled output goes to `dist/`, and runtime state is expected under `data/` and `runtime/`.

- `src/server.ts` starts the Hono server; `src/app.ts` wires middleware and routes.
- `src/routes/` contains HTTP route handlers for health, models, chat, responses, and proxy tools.
- `src/services/` contains upstream Z.AI integration, captcha handling, tool bridging, and request tracking.
- `src/db/` stores SQLite-backed repositories for accounts, conversations, and responses.
- `src/cli/` contains login/bootstrap and account management commands.
- `.env.example` documents supported environment variables. Do not commit `.env`, `data/`, `runtime/`, database files, or keys.

## Build, Test, and Development Commands

- `npm install` installs dependencies from `package-lock.json`.
- `npm run login` opens the visible Chromium OAuth flow and saves an account session.
- `npm run accounts` lists or manages stored accounts.
- `npm run dev` runs `src/server.ts` with `tsx watch` for local development.
- `npm run build` compiles TypeScript into `dist/`.
- `npm run start` runs the built server from `dist/server.js`.
- `npm run typecheck` validates strict TypeScript without emitting files.

## Coding Style & Naming Conventions

Use ESM TypeScript with explicit `.js` suffixes on local imports, matching the existing `NodeNext` setup. Keep `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` clean. Use two-space indentation, semicolons, double quotes, `camelCase` for variables/functions, `PascalCase` for classes and types, and descriptive file names such as `openai-transform.ts`.

## Testing Guidelines

No test runner is currently configured. For now, run `npm run typecheck` and `npm run build` before submitting changes. When adding tests, prefer focused TypeScript tests under `src/tests/` or next to the module being tested, and name them after the behavior, for example `responses-continuity.test.ts`.

## Commit & Pull Request Guidelines

The current history uses short, direct release/update subjects, for example `ZAI PROXY RELEASE`. Keep commits concise and imperative, and mention the touched area when useful: `Fix responses stream cancellation`. Pull requests should describe behavior changes, list validation commands run, call out configuration or migration impacts, and include screenshots or logs only when they clarify runtime behavior.

## Security & Configuration Tips

Keep proxy credentials and Z.AI session material local. Use `.env.example` as the template, and prefer environment variables over hardcoded secrets. Be careful with proxy tool changes: local tools must remain restricted by `PROXY_TOOLS_ROOT` and should never expose `.env`, SQLite databases, `master.key`, private keys, or session files.

## OpenAI Compatibility Contract

Treat `/v1/responses` as the primary Codex route and `/v1/chat/completions` as SDK compatibility. Preserve raw SSE framing (`data: <json>\n\n`; chat streams end with `data: [DONE]\n\n`), Responses lifecycle events (`response.created`, `response.in_progress`, item/content events, `response.completed` or `response.failed`), tool call IDs, and `previous_response_id` continuity. Unknown stored response IDs should return an OpenAI-shaped error instead of silently starting a new thread. Validate route changes with raw SSE checks, AI SDK `createOpenAI({ baseURL })`, and a Codex profile using `wire_api='responses'`.

## Documentation Snapshot

Compatibility notes were refreshed on 2026-06-14 from Context7: OpenAI API `/websites/developers_openai_api`, AI SDK `/websites/ai-sdk_dev`, and Codex CLI `/openai/codex`. Recheck those docs before changing Responses, Chat Completions, streaming, tool calls, cancellation, model routes, or provider configuration.
