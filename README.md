# DataLooker

A GUI database client for macOS, built with Tauri 2, Rust and React 19. It speaks
PostgreSQL and BigQuery.

## Features

- **Connections** — PostgreSQL and BigQuery (service account key). Secrets stay in the
  macOS keychain. A connection can carry a shell command, such as an SSH tunnel, started
  and stopped from its header.
- **SQL editor** — Monaco with tabs, completion from the database (`sqls` for PostgreSQL,
  a GoogleSQL helper for BigQuery), PostgreSQL syntax errors marked as you type, and vim
  keybindings.
- **Results** — a virtualized grid with resizable columns, cell copy, and the whole of a
  value the cell cuts short on hover, with documents indented.
- **Schema tree** — schemas and tables, filterable; day-named tables such as
  `events_20250101` are folded into one row.
- **Tables** — rows with filter, sort and paging, and the `CREATE` statement with its
  indexes and triggers. PostgreSQL tables with a primary key can be edited in place.
- **History** — every statement run is logged and can be reopened.
- **Agents** — an optional MCP server on localhost, behind a token, lets your own agents
  list connections, read schemas and run read-only statements. Their runs are logged and
  marked.

## Keyboard

Press ⌘? for this list in the app.

| Keys              | What it does                          |
| ----------------- | ------------------------------------- |
| ⌘?                | Show these shortcuts                  |
| ⌘O                | Find a table by name and open it      |
| ⌘Y                | Reopen a query that was run before    |
| ⌘T                | New SQL tab                           |
| ⌃Tab, ⌃⇧Tab       | Next / previous tab                   |
| Delete, Backspace | Close the focused tab                 |
| ⌘Enter            | Run the editor's query                |
| ⌘⇧D, ⌘-click      | Open the table a name in SQL names    |
| ⌘C                | Copy the selected cell                |
| Space             | Show the selected cell in full        |
| ⌘Backspace        | Set the cell being edited to NULL     |
| ⌃N, ⌃P            | Next / previous item in a palette     |
| ⌥↑, ⌥↓            | Move the focused connection up / down |

## Installing a release

Download `DataLooker.app.tar.gz` from a Release, unpack it and move `DataLooker.app` to
`/Applications`. The app is self-signed, so the first launch needs **right-click → Open**
(or **System Settings → Privacy & Security → Open Anyway**).

Every merge to `main` that changes more than Markdown builds the app. If its version is
already released, the build replaces the draft Release **DataLooker (unreleased)**;
otherwise it is published as `v<version>`, so bumping `version` in `package.json` is how a
release is cut. See `.github/workflows/release.yml`.

## Development

Requirements:

- macOS (CI runs the tests on Linux)
- [Vite+](https://viteplus.dev/) — `curl -fsSL https://vite.plus | bash`. The `vp` CLI
  installs the Node.js and pnpm versions pinned in `package.json`.
- Rust, pinned in `rust-toolchain.toml`
- Tauri's [system dependencies](https://tauri.app/start/prerequisites/) — on macOS, the
  Xcode Command Line Tools
- Docker, optionally, for the demo database and the PostgreSQL-backed tests

```sh
vp install
npx skills experimental_install   # agent skills pinned in skills-lock.json
vp run tauri dev
```

### Demo database

```sh
docker compose --profile demo up -d --wait demo
```

Connect to `localhost:55433`, database `demo`, user and password `demo`.
`docker compose --profile demo down -v` removes it.

### Tests

```sh
vp exec playwright install chromium   # once, for the browser tests
vp check                              # format, lint, type check
vp test --run                         # frontend
docker compose up -d --wait           # PostgreSQL for the live tests
cd src-tauri && cargo test            # backend
```

Tests that need a PostgreSQL skip themselves when none is listening. The BigQuery ones
need a real project and skip unless one is named:

```sh
DATALOOKER_TEST_BQ_KEY=~/keys/project.json DATALOOKER_TEST_BQ_PROJECT=my-project cargo test bigquery
```

`--coverage` (frontend) and `cargo llvm-cov` (backend) report coverage.

### Building the app

```sh
./scripts/make-signing-identity.sh
APPLE_SIGNING_IDENTITY="DataLooker Self-Signed" vp run tauri build
```

The bundle lands in `src-tauri/target/release/bundle/macos/`. The self-signed certificate
keeps the app's signature stable across builds, so macOS remembers the keychain access you
granted. The built app and `vp run tauri dev` share the same data directory.

## License

MIT
