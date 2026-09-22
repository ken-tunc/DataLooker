# DataLooker

A GUI database client for macOS, built with Tauri 2 + Rust + React 19.

> **Status:** early development. PostgreSQL connections can be created, edited, duplicated
> and deleted — stored locally, with their passwords in the OS keychain — and each one
> opens a window of SQL tabs: a Monaco editor per tab, the rows in a grid below it. A schema
> tree shows what a database holds, a table is found by name from anywhere with ⌘O, and it
> opens in a tab of its own where its rows can be filtered and sorted — and edited, when the
> table has a primary key to name a row by — beside the statement that would make the table
> again, with its indexes and triggers. The editor marks what PostgreSQL would refuse to
> parse, without asking a server, and has vim keybindings behind a toggle. Every statement
> that runs is logged, and ⌘Y reopens one. ⌘⇧D on a name in a statement opens
> what it names. A connection can carry a shell command — a port
> forward, an SSH tunnel — started and stopped from its row in the list. A BigQuery
> connection can be made, tested, queried, and its datasets read like any other schema
> tree, where a table written a day at a time is folded into one row per set of
> days. A statement completes out of the database it will run against, through
> a language server — `sqls` — where one is installed.

## Prerequisites

- **macOS** to run the app (Linux and Windows are not validated; Linux is where CI runs
  the tests, which need no window)
- **[Vite+](https://viteplus.dev/)** — the `vp` CLI drives the frontend toolchain and
  installs the Node.js and pnpm versions this project pins:
  ```sh
  curl -fsSL https://vite.plus | bash
  ```
  Node.js 26.9.0 (`devEngines.runtime` in `package.json`) and pnpm 11.11.0
  (`packageManager`) are fetched by `vp` — no separate version manager needed.
- **Rust** 1.98, pinned in `rust-toolchain.toml` (rustup installs it on first build)
- Tauri's [system dependencies](https://tauri.app/start/prerequisites/) — on macOS the
  Xcode Command Line Tools are enough

## Getting started

```sh
vp install
vp run tauri dev
```

A native window titled "DataLooker" opens.

## Keyboard

| Keys              | What it does                         |
| ----------------- | ------------------------------------ |
| ⌘O                | Find a table by name and open it     |
| ⌘⇧D, ⌘-click      | Open what a name in the editor names |
| ⌘Y                | Reopen a query that was run before   |
| ⌃N, ⌃P            | Next / previous match in the palette |
| ⌘T                | New SQL tab                          |
| ⌃Tab, ⌃⇧Tab       | Next / previous tab                  |
| Delete, Backspace | Close the focused tab                |
| ⌘Enter            | Run the editor's query               |
| ⌘C                | Copy the selected cell               |
| ⌘Backspace        | Set the cell being edited to NULL    |

## Agent skills

`skills-lock.json` pins the agent skills this repository uses. The skills themselves are
not committed — restore them with:

```sh
npx skills experimental_install
```

To add one, which also updates the lockfile:

```sh
npx skills add saadeghi/daisyui --agent claude-code --yes
```

## Tests

```sh
vp exec playwright install chromium             # once, for the browser tests
vp test --run                                   # frontend
docker compose up -d --wait                     # PostgreSQL for the integration tests
cd src-tauri && cargo test                      # backend
```

`vp test --run` runs two projects: `node` for the `import.meta.vitest` blocks the source
files carry, and `browser` for the `*.browser.test.tsx` files, which mount components in a
real Chromium with the Tauri side stubbed. Run one of them with `--project node` or
`--project browser`.

Both suites can report their coverage — `vp test --run --coverage` and, in `src-tauri`,
`cargo llvm-cov` (`cargo install cargo-llvm-cov`). CI runs both and puts the tables on the
run's summary page. No external coverage service is involved, so there is nothing to sign
up for and no secret to keep — the workflow posts its comment with the token GitHub already
gives the run.

The tests in `src-tauri/tests/` need the PostgreSQL from `compose.yaml`; each one skips
itself when nothing is listening on its port, so `cargo test` still passes without Docker.
`--wait` holds until the server is healthy, so the tests do not skip a container that is
still starting.

`tests/bigquery.rs` needs a real project, which it skips unless one is named:

```sh
cd src-tauri && DATALOOKER_TEST_BQ_KEY=~/keys/project.json DATALOOKER_TEST_BQ_PROJECT=my-project cargo test --test bigquery
```

`DATALOOKER_TEST_BQ_LOCATION` says where the project is read, and defaults to `US`. A key
that is named has to work: only its absence is a skip.

## Scripts

| Command                                                      | What it does                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `vp run tauri dev`                                           | Tauri shell with the Vite dev server (the main dev command) |
| `vp dev`                                                     | Vite dev server only, no Tauri shell                        |
| `vp build`                                                   | Type-check and build the frontend bundle                    |
| `vp run tauri build`                                         | Build a distributable `.app`                                |
| `vp check`                                                   | Format, lint and type check (`--fix` applies fixes)         |
| `vp test --run`                                              | Frontend tests                                              |
| `vp test --run --coverage`                                   | Frontend tests with a coverage report                       |
| `cargo test` (in `src-tauri`)                                | Rust tests                                                  |
| `cargo llvm-cov` (in `src-tauri`)                            | Rust tests with a coverage report                           |
| `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) | Rust linter                                                 |
| `cargo fmt` (in `src-tauri`)                                 | Rust formatter                                              |

## License

MIT
