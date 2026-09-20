# CLAUDE.md

DataLooker is a GUI database client for macOS: Tauri 2 (Rust) + React 19. PostgreSQL is the
first target, BigQuery follows. Connections can be managed, and SQL can be written and run
against them; the schema tree and table editing are still to come.

Keep this file short. Document decisions the code cannot show; leave everything else to the
code.

## Working here

- Everything committed to this repository is written in English: code comments,
  documentation, commit messages and pull request descriptions.
- Comment why, never what. A comment that restates the code becomes noise the moment the
  code changes, so leave out anything a reader gets from the code itself — write one only
  for a reason, a constraint or a workaround the code cannot show.
- Make a convention a check, not a paragraph. If the linter, the type system or the
  compiler can catch it, encode it there — oxlint rules live in `vite.config.ts`, clippy
  lints in `src-tauri/Cargo.toml` — and keep this file for what none of them can see. A
  rule that exists only in prose is one every reader has to remember.
- A component fetches what it renders. React Query's cache is shared, so two components
  asking for the same thing make one request, and a parent holds only the state its
  children genuinely share — which connection is in front, not the connections.
- Do not hand-memoize. The React Compiler is on, so `useCallback`, `useMemo` and `memo`
  only add noise, and `no-restricted-imports` rejects them. Disable the rule on the line
  with a reason if a case ever needs one.
- Tests sit next to the code they cover: `#[cfg(test)]` modules in Rust, `*.test.ts` in
  TypeScript. When a test would be the only reason to export something, write it in-source
  behind `import.meta.vitest` instead of widening the API.
- Validate with `vp check` (format, lint, type check; `--fix` applies fixes) and
  `vp test --run`, plus `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`
  and `cargo test` in `src-tauri`. CI runs exactly these.
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

## IPC

A command is an adapter: it extracts state and calls `app::App`, which holds what
DataLooker can do and knows nothing about Tauri, so that a second caller — an MCP server
for agents is the one planned — drives the same operations rather than a copy of them.
`app/` keeps one file per feature, each holding that feature's methods beside the rules
they apply; `drivers/` is what talks to a database the user connects to, and `db/` is
meta.db.

`src/bindings/` holds the TypeScript types ts-rs generates from the Rust ones; `cargo test`
rewrites it, so never edit it by hand and re-run the Rust tests after touching a type that
crosses the boundary. Each command gets a typed wrapper in `src/lib/commands.ts`; nothing
else names a command or calls `invoke` directly.

## Agent skills

`skills-lock.json` pins them; the skills themselves are not committed, so run `npx skills
experimental_install` after cloning. Use the daisyUI skill whenever you touch the UI.

## Storage

`meta.db` (SQLite via sqlx, under the app data directory) holds the app's own data;
`src-tauri/migrations/` holds the numbered migration files sqlx applies at startup, so a
schema change is a new file, never an edit to an existing one. Connection secrets live in
the OS keychain behind the `SecretStore` trait, which tests swap for an in-memory
implementation so they never touch the real keychain. The keychain write sits inside the
SQLite transaction, so a keychain failure rolls the row back; a commit that then fails
still leaves the password changed, which is the floor with two stores that cannot commit
together, and nothing tries to compensate for it.

## Querying

A connection holds one PostgreSQL session (`drivers::session::SessionRegistry`), reused across
queries so `BEGIN`, `SET` and temporary tables survive the statement that created them.
Queries on one connection therefore run one at a time. A cancelled query leaves the wire
protocol mid-row, so its connection is dropped and the next query opens a new one; an error
the server reported leaves the session usable and keeps it.

`src-tauri/tests/` runs against the PostgreSQL in `compose.yaml` (`docker compose up -d
--wait`) and each test skips itself when nothing is listening on that port. A server that
does answer has to work: only absence is a skip, never a failure.

## The editor and the grid

Monaco's own entry point pulls every language and every editor feature it ships with, so
`features/sql-editor/monaco.ts` lists the ones this editor needs; it loads as a chunk of
its own the first time a connection is opened. Result rows are plain DOM, virtualized with
`@tanstack/react-virtual`, which the 5,000-row limit makes practical and which keeps
daisyUI's styling and real text selection. Virtualized rows get no help from the browser's
table layout, so `columnWidths` sizes the columns from the first rows.

## Decisions

- The bundle identifier `org.kentunc.datalooker` also decides where application data lives
  (`~/Library/Application Support/org.kentunc.datalooker/`), so changing it strands
  existing data.
- `package.json` is the single source of truth for the version: `tauri.conf.json` reads it
  and `src-tauri/Cargo.toml` stays at `0.0.0`.
- `dragDropEnabled: false` turns off Tauri's native file-drop handling, which otherwise
  swallows HTML5 drag and drop inside the webview.
- A connection's driver-specific settings are stored as JSON in one `config` column, so
  adding a driver needs no migration.
- There is no driver trait. One implementation cannot show which operations a second
  driver would share, so `DriverConfig` is matched where a driver is opened and the
  abstraction waits for BigQuery.
- A result cell crosses IPC as JSON, typed `unknown` in TypeScript. Integers outside
  JavaScript's safe range and `NUMERIC` become strings, because a JSON number would reach
  the frontend rounded.
- Commands fail with `AppError`, which serializes as `{ kind, message }`; the frontend
  branches on `kind` and never on message text.
- The production CSP allows no inline scripts. `style-src 'unsafe-inline'` and
  `worker-src blob:` are there for libraries that inject styles and spawn web workers, and
  `connect-src ipc: http://ipc.localhost` is Tauri's IPC transport.
