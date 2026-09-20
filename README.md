# DataLooker

A GUI database client for macOS, built with Tauri 2 + Rust + React 19.

> **Status:** early development. PostgreSQL connections can be created, edited, duplicated
> and deleted — stored locally, with their passwords in the OS keychain. Nothing connects
> to a database yet. BigQuery follows PostgreSQL.

## Prerequisites

- **macOS** (Linux and Windows are not validated)
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

## Scripts

| Command                                                      | What it does                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `pnpm tauri dev`                                             | Tauri shell with the Vite dev server (the main dev command) |
| `pnpm dev`                                                   | Vite dev server only, no Tauri shell                        |
| `pnpm build`                                                 | Type-check and build the frontend bundle                    |
| `pnpm tauri build`                                           | Build a distributable `.app`                                |
| `pnpm typecheck`                                             | `tsc --noEmit`                                              |
| `pnpm lint`                                                  | Biome lint + format + import sort (check only)              |
| `pnpm format`                                                | The same checks, applying fixes                             |
| `cargo test` (in `src-tauri`)                                | Rust tests                                                  |
| `cargo clippy --all-targets -- -D warnings` (in `src-tauri`) | Rust linter                                                 |
| `cargo fmt` (in `src-tauri`)                                 | Rust formatter                                              |

## License

MIT
