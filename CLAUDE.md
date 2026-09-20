# CLAUDE.md

DataLooker is a GUI database client for macOS: Tauri 2 (Rust) + React 19. PostgreSQL is the
first target, BigQuery follows. Only the project scaffold exists so far.

Keep this file short. Document decisions the code cannot show; leave everything else to the
code.

## Working here

- Everything committed to this repository is written in English: code comments,
  documentation, commit messages and pull request descriptions.
- Validate with `vp check` (format, lint, type check; `--fix` applies fixes) and, in
  `src-tauri`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and
  `cargo test`. CI runs exactly these.
- Run the app with `vp run tauri dev`.
- Update `README.md` and this file in the change that makes them stale.

## Vite+

The `vp` CLI is the whole TypeScript toolchain (Vite, Oxlint, Oxfmt, Vitest) and it also
installs the pinned Node.js (`devEngines.runtime`) and pnpm (`packageManager`), so do not
add a separate version manager. Its docs sit in `node_modules/vite-plus/docs`.

- `vp <name>` runs a built-in command, `vp run <name>` a `package.json` script. A script
  never shadows a built-in, so the two can differ.
- Run `vp install` after pulling, and `vp env doctor` when the runtime or package manager
  misbehaves.

## Decisions

- The bundle identifier `org.kentunc.datalooker` also decides where application data lives
  (`~/Library/Application Support/org.kentunc.datalooker/`), so changing it strands
  existing data.
- `package.json` is the single source of truth for the version: `tauri.conf.json` reads it
  and `src-tauri/Cargo.toml` stays at `0.0.0`.
- `dragDropEnabled: false` turns off Tauri's native file-drop handling, which otherwise
  swallows HTML5 drag and drop inside the webview.
- The production CSP allows no inline scripts. `style-src 'unsafe-inline'` and
  `worker-src blob:` are there for libraries that inject styles and spawn web workers, and
  `connect-src ipc: http://ipc.localhost` is Tauri's IPC transport.
