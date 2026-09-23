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
> connection can be made, tested, queried, its tables' rows paged through, and its
> datasets read like any other schema tree, where a table written a day at a time is folded into one row per set of
> days. A statement completes out of the database it will run against, through
> a language server — `sqls` for PostgreSQL, `bqls` for BigQuery — which
> DataLooker will build with your Go toolchain if you have none. BigQuery
> completion reads as your own `gcloud` credentials rather than as the
> connection's service account. Your own agents can be let in over MCP, on this
> machine and behind a token, to see which connections there are, what they
> hold, what a table holds, and to run statements that read — logged beside your
> own, and marked. They never write: that is not something DataLooker does on an
> agent's behalf.

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

The sidebar is as wide, and the editor as tall, as the line beside it is dragged to; a
double-click on the line puts it back.

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

## Building the app

```sh
./scripts/make-signing-identity.sh
APPLE_SIGNING_IDENTITY="DataLooker Self-Signed" vp run tauri build
```

The bundle lands at `src-tauri/target/release/bundle/macos/DataLooker.app`, and it is yours
to run rather than anyone else's to install: the certificate is self-signed, so Gatekeeper
on another Mac will refuse a copy that was downloaded there.

The signature is not about that, though. macOS keys what an app is allowed to reach — the
keychain items holding your passwords, the folders it has been let into — to the app's
signature, and the one the linker leaves behind is a hash of the binary, which every build
changes:

```
designated => cdhash H"4571b98e…"                                        # unsigned
designated => identifier "org.kentunc.datalooker" and certificate leaf = H"323b037b…"
```

The second one is the same after the next build, so a permission you grant once stays
granted. `make-signing-identity.sh` makes that certificate if the keychain has none, and
the key stays on the machine that made it.

The built app and `vp run tauri dev` are the same app to macOS — the identifier decides
where the data lives — so they share `meta.db`, the connections in it and the language
servers under `servers/`. A migration applied by one is applied for the other, which is
worth remembering when running a branch that does not have it.

## Releases

Every merge to `main` builds the app and leaves it on a draft Release called **DataLooker
(unreleased)**, so there is always a download of what `main` currently is. Publishing one
is bumping `version` in `package.json` and merging that: the build for it goes out as
`v<version>` — tag made, notes written from the pull requests since the release before —
and the draft is swept. Nothing is tagged or published by hand;
`.github/workflows/release.yml` says how it decides which of the two it is doing.

**Installing a build.** Download `DataLooker.app.tar.gz`, unpack it, move `DataLooker.app`
to `/Applications`, then **right-click it → Open** and confirm. The build is signed but by
nobody Apple knows, so Gatekeeper asks once; without the signature it would refuse the app
as damaged instead. (If macOS offers only "Move to Trash", open **System Settings →
Privacy & Security** and press **Open Anyway**.)

The certificate is made by the workflow for that one build and goes with the runner, so
each release is signed by a different one and macOS asks again after an update — it has no
way to know the new build is the same app. Keeping one certificate in the repository's
secrets and signing every release with it is what would end that, and it is worth doing
when the asking becomes a nuisance.

## Scripts

| Command                                                      | What it does                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `vp run tauri dev`                                           | Tauri shell with the Vite dev server (the main dev command) |
| `vp dev`                                                     | Vite dev server only, no Tauri shell                        |
| `vp build`                                                   | Type-check and build the frontend bundle                    |
| `vp run tauri build`                                         | Build the `.app` (see above; sign it by naming an identity) |
| `./scripts/make-signing-identity.sh`                         | Make the self-signed certificate builds are signed with     |
| `vp check`                                                   | Format, lint and type check (`--fix` applies fixes)         |
| `vp test --run`                                              | Frontend tests                                              |
| `vp test --run --coverage`                                   | Frontend tests with a coverage report                       |
| `cargo test` (in `src-tauri`)                                | Rust tests                                                  |
| `cargo llvm-cov` (in `src-tauri`)                            | Rust tests with a coverage report                           |
| `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) | Rust linter                                                 |
| `cargo fmt` (in `src-tauri`)                                 | Rust formatter                                              |

## License

MIT
