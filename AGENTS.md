# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript VS Code extension for visualizing Alembic migration graphs.

- `src/extension.ts` activates and wires the extension.
- `src/core/` contains pure graph, layout, parser, and type logic; keep it free of VS Code, Node, and DOM dependencies when it must also run in webviews.
- `src/services/` wraps filesystem, Git, Alembic CLI, and Python-environment integration.
- `src/ui/` owns VS Code-facing panels, actions, status items, and HTML creation.
- `src/webview/` contains browser-side graph and sidebar code; its separate `tsconfig.json` is intentional.
- `test/unit/` holds Vitest tests. `fixtures/` provides healthy and broken Alembic projects; `docs/manual-test.md` covers Extension Development Host checks.

## Build, Test, and Development Commands

- `npm install` installs the pinned development dependencies.
- `npm run build` bundles the extension and webviews into `dist/` with esbuild.
- `npm run watch` rebuilds while files change.
- `npm run check` type-checks both the extension and webview TypeScript projects.
- `npm run test:unit` runs the Vitest unit suite.

For UI or VS Code integration changes, also follow the applicable steps in `docs/manual-test.md` using the Extension Development Host (`F5`).

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, double-quoted imports/strings, and strict types. Prefer small, deterministic functions in `src/core/`; isolate side effects in services or UI code. Use `camelCase` for functions and values, `PascalCase` for types/classes, and descriptive file names such as `migrationService.ts`. Keep tests and fixtures focused on observable behavior.

## Testing Guidelines

Add or update a `test/unit/<area>.test.ts` file for behavior changes. Use Vitest `describe`/`it` blocks with scenario-focused descriptions, for example `"broken link: ghost created"`. Run `npm run check` and `npm run test:unit` before opening a pull request. No coverage threshold is configured; exercise happy paths, edge cases, and fixture-backed integration logic.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit-style history: `feat:`, `fix:`, `test:`, and `chore:` followed by a concise imperative summary. Keep commits scoped. Pull requests should explain user-visible behavior, list validation performed, link relevant issues, and include screenshots or a short recording for graph/webview changes. Call out fixture or manual-test updates explicitly.
