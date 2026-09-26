# CLAUDE.md

DataLooker is a GUI database client for macOS: Tauri 2 (Rust) + React 19, for PostgreSQL
and BigQuery.

This file holds the decisions the code cannot show. Anything a reader gets from the code —
what a module does, which file holds what, a number the code already names — stays out, so
that nothing here goes stale when the code moves. A reason that belongs to one module goes
in that module's doc comment, not here.

## Working here

- Everything committed is in English: code, comments, docs, commit messages and pull
  requests.
- Comment why, never what: a reason, a constraint or a workaround the code cannot show.
  Leave out history ("used to", "was changed to") and anything that restates the code.
- Make a convention a check, not a paragraph: oxlint rules live in `vite.config.ts`,
  clippy lints in `src-tauri/Cargo.toml`, and a hook in `.claude/settings.json` for what
  can only be enforced at the moment a file is written.
- A component fetches what it renders; React Query's cache makes two components asking for
  the same thing one request. A parent holds only the state its children share.
- Do not hand-memoize: the React Compiler is on, and `no-restricted-imports` rejects
  `useCallback`, `useMemo` and `memo`.
- Tests sit inside the file they cover — a `#[cfg(test)]` module in Rust, an
  `import.meta.vitest` block in TypeScript — and nothing is exported for a test's sake.
  The exception is `*.browser.test.tsx`, which runs in a real Chromium against
  `src/test/harness.tsx`, a stand-in for Tauri's `invoke`. Use one when the behaviour
  lives in the wiring between components.
- A test that needs a server sits in a `live` module beside the code it covers. It skips
  itself only when the server is absent; a server that answers has to work.
- Validate with `vp check` and `vp test --run`, and in `src-tauri` with `cargo fmt
--check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`. CI runs exactly
  these.
- Update `README.md` and this file in the change that makes them stale.

## Toolchain

`vp` (Vite+) is the whole TypeScript toolchain and installs the pinned Node.js and pnpm, so
do not add a version manager. `vp <name>` runs a built-in, `vp run <name>` a `package.json`
script. Its docs are in `node_modules/vite-plus/docs`. Run `vp install` after pulling.

`skills-lock.json` pins the agent skills, which are not committed: `npx skills
experimental_install` restores them. Use the daisyUI skill whenever you touch the UI.

## Architecture

`app::App` holds what DataLooker can do and knows nothing about Tauri. The window's
commands (`commands/`) and the MCP server (`mcp/`) are both thin callers of it, so an agent
and a reader can do the same set of things and no operation exists twice.

Commands and events are declared once, in `commands!` and `events!` in
`commands/mod.rs`. ts-rs writes `src/bindings/` from the Rust types during `cargo test`;
never edit it by hand, and re-run the Rust tests after changing a type that crosses the
boundary — CI fails when the committed copy differs. Only `src/lib/commands.ts` and
`src/lib/events.ts` name a command or an event.

Commands fail with `AppError`, `{ kind, message }`, and the frontend branches on `kind`,
never on the message.

Drivers are an enum (`drivers::session::Session`), not a trait: the set is closed, the
compiler says when a driver was left out of an operation, and what a driver cannot do is an
arm returning `AppError::Unsupported`.

A cell crosses IPC as JSON. An integer beyond JavaScript's safe range, and a number with
more digits than a JSON number keeps, is sent as a string, because a JSON number would
arrive rounded. A point in time is sent in UTC and moved into the connection's
zone by the grid, so a result need not be read again to be seen in another.

## Storage

`meta.db` (SQLite via sqlx) holds the app's own data. A migration once merged is never
edited — sqlx checksums it and refuses to start — so a schema change is a new file.

Secrets live in the OS keychain behind `SecretStore`, which tests replace with an in-memory
store. They share one keychain item and are cached once read, because macOS asks per item
and asks again after every build that changes the signature. The keychain write sits
inside the SQLite transaction so a keychain failure rolls the row back.

A connection's driver settings are one JSON `config` column, so a new driver needs no
migration. Its shell command, and whether that runs only while the connection is
selected, and its time zone are columns of their own: they belong to the reader, not the
driver.

## Sessions

A connection holds one database session for the reader, reused so that `BEGIN`, `SET` and
temporary tables survive between statements; statements on it run one at a time. The
catalog — the tree, a table's columns and definition — is read over a second session, so
it never waits behind the reader's query or fails inside their aborted transaction. The
tree therefore shows what is committed.

A cancelled statement leaves the wire mid-row, so its session is dropped; an error the
server reported leaves it usable.

A grid save is one transaction on the reader's session, checked against each row's `xmin`,
with values sent as text and cast to the column's type. It is refused while the reader has
a transaction open, since its `COMMIT` would end theirs. A relation with no primary key,
and every BigQuery table, is read-only: there is no key to name a row by.

## BigQuery

Every statement is a job, so there is no session; what is kept is the authenticated
client. A running job is polled until it finishes rather than timed out, and cancelling
cancels the job, since it is billed either way.

A query is billed for every column it scans whatever its `LIMIT`, so an unfiltered,
unsorted page of a table is listed rather than queried, and completion — asked on
keystrokes — reads a table's columns with `tables.get` rather than `INFORMATION_SCHEMA`.

The OAuth scope is not read-only: what the reader may do is the service account's to
decide, as it is the role's on PostgreSQL.

## Completion

PostgreSQL is completed by `sqls`, one per connection, started by the first completion
request. It is told the connection through `initializationOptions`, never a config file,
because a file with a password outlives the process that wrote it. Rust composes only
`initialize` and otherwise forwards bytes; the client is `src/lib/lsp/client.ts`.

BigQuery is completed by `bigquery-analyzer/`, a GoogleSQL helper. A language server would
have to read the service account key from a file, so the app asks BigQuery itself and the
helper only reads the statement.

The helper is downloaded, not built (it takes hours): `analyzer/fetch.rs` pins one Release
by address and hash. `.github/workflows/analyzer.yml` publishes a Release when the helper
changes on `main` under a new version, so the pin is updated in a later change of its own,
together with the version `analyzer/mod.rs` expects. Any change under `bigquery-analyzer/`
other than Markdown — a comment included — has to raise `kVersion` in `main.cc`, or that
workflow fails.

## Agents (MCP)

The server is off until the reader opens it. Its port is stored so an agent configured once
keeps working; its token is in the keychain, because it buys the running app, which holds
the database keys.

An agent may only read, and that is a decision, not a stage. The database enforces it, not
a parser here: a PostgreSQL statement runs inside `BEGIN READ ONLY`, which the statement
cannot undo, and is rolled back rather than committed, since `EXPLAIN ANALYZE` carries out
`CREATE TABLE AS` without the read-only check. The reader's Explain is held the same way.
A BigQuery statement is dry-run first and runs only if BigQuery calls it a `SELECT`. An
agent has its own sessions, a lower row cap and a deadline, since nobody is watching to
cancel it. Its runs are logged beside the reader's and marked.

## Processes

A connection's command, `go install`, and the lookup of a language server all go through
the reader's login shell (`$SHELL -l -c`), because an app opened from Finder inherits a
`PATH` without Homebrew or Go. A command that may fork is stopped by killing its process
group: what the reader wrote is rarely one process, and killing the shell alone would leave
a tunnel holding its port.

## Frontend

- A pane is never unmounted while its tab is open, nor a connection's workspace while it is
  out of front: hidden, not removed, so pending edits and results survive.
- A scroll container a child measures is held in state, not a ref: React attaches a
  parent's ref after the children's effects have run.
- Monaco is imported feature by feature (`features/sql-editor/monaco.ts`) and loads when a
  connection is first opened. It holds one theme for everything it draws, so it is set
  there once.
- daisyUI's `dark` is the only theme; nothing follows the OS.
- One density: a control is `sm` wherever the reader works — a pane, a panel, a dialog —
  and text they read there is `text-sm`. `xs` is for what sits inside a line: a tab, a
  list row, an alert, the title bar, the connection rail, the editor's status line, a
  control over a canvas.

## Build and release

- The bundle identifier `org.kentunc.datalooker` also decides where app data lives, so
  changing it strands existing data.
- `package.json` is the only source of the version; `src-tauri/Cargo.toml` stays at
  `0.0.0`.
- A build is signed when `APPLE_SIGNING_IDENTITY` names an identity. The certificate is not
  for Gatekeeper: macOS ties keychain access to the signature, and an unsigned build's
  signature changes every build.
- The window is transparent with its own title bar, which needs `macOSPrivateApi`. Every
  panel paints its own background.
- `dragDropEnabled: false`, because Tauri's native file drop swallows HTML5 drag and drop.
- The production CSP allows no inline scripts. `style-src 'unsafe-inline'` and
  `worker-src blob:` are for Monaco, which injects styles and spawns workers.
