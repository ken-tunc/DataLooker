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
- Tests sit inside the file they cover: a `#[cfg(test)]` module in Rust, an
  `import.meta.vitest` block at the foot of the file in TypeScript. Nothing is exported for
  a test's sake, and there is no second file to keep in step with the first. The one
  exception is a test that needs a browser, which has to be its own file — below. `define`
  in `vite.config.ts` strips the blocks from the production bundle, and a hook in
  `.claude/settings.json` refuses to write a `*.test.ts` that is not one of those browser
  files.
- A `*.browser.test.tsx` runs in a real Chromium and drives a component the way a reader
  does — clicking, typing, reading the screen. `src/test/harness.tsx` stands in for Tauri
  by replacing `window.__TAURI_INTERNALS__.invoke`, so everything from `lib/commands.ts`
  upwards runs unchanged and a test can assert on what would have been sent. Reach for one
  when the behaviour lives in the wiring between components, and for an in-source test when
  it lives in a function.
- Validate with `vp check` (format, lint, type check; `--fix` applies fixes) and
  `vp test --run`, plus `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`
  and `cargo test` in `src-tauri`. CI runs exactly these, with coverage: `--coverage` on
  the frontend and `cargo llvm-cov` on the backend, both reported on the run's summary
  page. No threshold gates a merge — the numbers are there to say where a test is missing.
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
else names a command or calls `invoke` directly. `CARRIES_MESSAGE` in
`src/lib/invoke.ts` lists every `AppError` kind, so a variant added in Rust fails the type
check there rather than reaching the frontend as an error nothing can branch on.

## Agent skills

`skills-lock.json` pins them; the skills themselves are not committed, so run `npx skills
experimental_install` after cloning. Use the daisyUI skill whenever you touch the UI.

`.claude/settings.json` holds the hooks. They bind an agent working in this repository and
nothing else — an editor, a script or CI can still write whatever it likes — so a hook is
where a rule can only be enforced at the moment something is written, and a linter or the
type system is the place for everything a file can be checked for afterwards.

## Storage

`meta.db` (SQLite via sqlx, under the app data directory) holds the app's own data;
`src-tauri/migrations/` holds the numbered migration files sqlx applies at startup, so a
schema change is a new file, never an edit to an existing one. Connection secrets live in
the OS keychain behind the `SecretStore` trait, which tests swap for an in-memory
implementation so they never touch the real keychain. The keychain write sits inside the
SQLite transaction, so a keychain failure rolls the row back; a commit that then fails
still leaves the password changed, which is the floor with two stores that cannot commit
together, and nothing tries to compensate for it.

## Drivers

`drivers/` is what talks to a database the reader connects to, one module per driver, and
`Session` is the enum a connection opens. PostgreSQL is whole; BigQuery reaches a project,
runs statements against it and says what it holds. What it cannot do yet, and what it will not do, both come
back as `AppError::Unsupported` with a sentence saying which.

BigQuery sends every value as text, whatever its type, so the schema beside the rows is
the only thing that says how to read one — `bigquery/value.rs` is that reading, and it
follows the same rules the PostgreSQL driver does: a whole number past what JavaScript
keeps, and anything with more digits than a JSON number holds, arrive as strings. A
statement is a job, and a job outlives the request that started it, so a query still
running is asked after until it finishes rather than refused for taking too long.
Cancelling cancels the job, which is billed for what it reads whether or not anyone is
listening — except in the moment before BigQuery has said which job it started, when
there is nothing yet to name.

A BigQuery connection is a project and a location — where its jobs run and where the
catalog describing it lives — and its secret is the service account key, which is where
the account it reads as is named. The token is not asked to be read-only: what the reader
may do is the service account's to say, the way it is the role's to say on a PostgreSQL
connection, and a statement they are entitled to run is one this editor runs. There is no
session to hold open, since every statement is a job of its own, so what a session keeps
is the authenticated client — building one is an exchange with Google.

A BigQuery table is read-only for a further reason: a row is written here by naming it,
and a key to name one by is what BigQuery has no notion of.

## Querying

A connection holds one PostgreSQL session (`drivers::session::SessionRegistry`), reused across
queries so `BEGIN`, `SET` and temporary tables survive the statement that created them.
Queries on one connection therefore run one at a time. A cancelled query leaves the wire
protocol mid-row, so its connection is dropped and the next query opens a new one; an error
the server reported leaves the session usable and keeps it.

`tests/bigquery.rs` reaches a real BigQuery project, and skips unless
`DATALOOKER_TEST_BQ_KEY` and `DATALOOKER_TEST_BQ_PROJECT` name one — there is no BigQuery
to stand up in a container. Only their absence is a skip.

`src-tauri/tests/` runs against the PostgreSQL in `compose.yaml` (`docker compose up -d
--wait`) and each test skips itself when nothing is listening on that port. A server that
does answer has to work: only absence is a skip, never a failure. CI starts the container
on a Linux runner so that these tests actually run there; the macOS job compiles the
keychain, which is the only code that runner can see and Linux cannot.

## The editor and the grid

Monaco's own entry point pulls every language and every editor feature it ships with, so
`features/sql-editor/monaco.ts` lists the ones this editor needs; it loads as a chunk of
its own the first time a connection is opened. Result rows are plain DOM, virtualized with
`@tanstack/react-virtual`, which the 5,000-row limit makes practical and which keeps
daisyUI's styling and real text selection. Virtualized rows get no help from the browser's
table layout, so `columnWidths` sizes the columns from the first rows. A scroll container a
child measures — the virtualizer's — is held in state rather than a ref, because React
attaches a parent's ref only after its children have run their effects, and the child would
measure nothing.

## Editing a table

A value the reader types is sent as text and cast to the column's own type
(`SET "price" = $1::numeric(10,2)`), so PostgreSQL parses it with the input functions it uses
everywhere else and a bad value comes back as its own complaint. A save is checked against
the row's `xmin` — the transaction that last wrote it — which needs no round trip through
our rendering of a value, and catches any concurrent change to the row. One save is one
transaction: a row that matches nothing refuses the lot. A relation with no primary key
cannot name a row, so it is read-only.

## A table's structure

PostgreSQL has no `SHOW CREATE TABLE`. What it does offer is `pg_get_*def` for the pieces
that are objects of their own — an index, a trigger, a constraint, a view's body — so
`drivers/postgres/ddl.rs` rebuilds the `CREATE` statement around them out of
`pg_attribute`. An index that backs a constraint is left out of the index list, since the
statement already names it as that constraint, and a trigger PostgreSQL marks internal is
left out too, because a foreign key wrote it rather than a reader. What the statement does
carry is everything that changes what the relation is: an unlogged table is made unlogged,
a partition is written as part of the table it belongs to rather than as a table of its
own, and a materialized view that was never filled says so. A foreign table's server and
its options are not rebuilt.

It shows inside the table's own tab rather than in a tab of its own: a tab is the table,
and its rows and its structure are two ways of looking at it. Switching between them
leaves a pending edit pending and the reader on the page they were on.

`components/SqlText.tsx` colours a statement with `editor.colorize`, the editor's own
tokenizer, so a definition reads the way the same SQL does in a tab. It imports Monaco
when the first statement is drawn rather than in its own chunk: opening a connection opens
a SQL tab, which has loaded it already.

## From a name to the table

⌘⇧D, or a ⌘-click, on a name in the editor opens that table's tab on its
structure. `features/sql-editor/jump.ts` reads the name out of the line: the
identifier the cursor is in, and the schema qualifying it if one does, folded
to lower case unless it was quoted — which is what PostgreSQL does to a name,
so that what is read compares to a catalog's by equality.

It is the line that is read rather than the statement parsed, so nothing here
tells an alias from a table: `o` in `from orders o` is looked up as a table
called `o`, and opens one where a schema holds one. A name no schema qualifies can mean a
table in any schema the search path reaches, and which one is the server's
answer rather than the tree's, so more than one match opens the ⌘O palette on
that name instead of guessing at it.

## What a connection holds

The tree says what there is — schemas and their tables — and not what is in them. A
BigQuery project can hold tens of thousands of tables and many times that many columns,
and asking for every column of every table is what makes a tree slow enough to give up
on; a table's columns are asked for when the table is opened, and the cache is what keeps
a table opened twice from being read twice. PostgreSQL reads the same way, so that the
tree is one shape whatever it came from.

A name ending in a date — `events_20250101` and the years of days beside it — is
one day of a table written a day at a time, so the tree folds a set of them into
one row and lists the days inside it, newest first. That is read out of the
names rather than asked of a driver, because the convention is a naming one and
nothing in a catalog says a table is a shard; a prefix only one table carries
stays that table, since a row that opens onto a single table hides it rather
than summing it up. What the schema holds is what decides that, and a filter
only decides which days are shown: a set of a thousand is still a set when the
reader has narrowed it to one. The ⌘O palette still offers every day by name, which is how
one of them is reached directly.

BigQuery answers out of `INFORMATION_SCHEMA` in the region its jobs run in, which is one
catalog per region and named after it. What comes back is read page by page rather than
row-limited, because every row of it is wanted — that is `query::collect`, beside the
`execute` a reader's own statement goes through. A name the reader typed is sent as a
query parameter rather than written into the statement.

## Completing a statement

A connection can have a language server behind it — `sqls` for PostgreSQL,
`bqls` for BigQuery — which reads the database it is pointed at and says what
could follow what the reader typed. `lsp/` is the pipe: it starts one server per connection, frames
the JSON-RPC going each way and carries it, and reads none of it. What a
message means belongs with the editor that asked, so the client lives in the
window.

BigQuery is the exception to all of that. bqls takes credentials from the
environment and nowhere else, so the connection's service account key is never
handed to it: it is told the project and the location, and it completes as
whoever the reader is to Google — their own `gcloud` credentials. That means
completion can see a different project than the one queries run against, or
nothing at all where the reader has never logged in, and it is the price of
not writing a service account key to a file that outlives the process which
wrote it.

The one message composed here is `initialize`, because it is the one that
carries a PostgreSQL connection's password: the server is told about the database
through its `initializationOptions` rather than through a config file, since
sqls will read a file and a file with a password in it outlives the process
that wrote it. It is asked under a string id, which is not the number space
the window's own requests use. The window is handed what the server said it
can do, and speaks for itself from there.

A reader who has none can have one built rather than downloaded — `lsp/install.rs`
says why — and the editor's footer is where that is offered, because it is where
a reader is when they notice that nothing is being suggested.

Where the server is, is asked of the reader's login shell — a window opened
from Finder inherits none of the places one is installed, the same reason a
connection's command is run through one. `DATALOOKER_SQLS_BIN` names one
directly, which is also how a test hands over something that is not a language
server at all. A server the reader installed themselves comes before the one
DataLooker built, which is the fallback for a machine that had none — and a
name the reader set that leads nowhere is theirs to put right rather than
something a build would fix, so it is said rather than offered around.

A server is stopped rather than asked to shut down: it holds nothing that
outlives it, so the protocol's parting words would buy a wait. Editing or
deleting a connection stops it too, since it was handed those credentials when
it started.

In the window, `lib/lsp/client.ts` is the client: one per connection, made when
something first asks and kept for as long as the window. It holds every
document of that connection as it now stands, and **a server is started by the
first completion asked for** — not by a tab opening, since sqls reads the whole
schema on its way up and a reader who asks nothing of it never needed that
read. A start that fails is not tried again: there is no completion then, and
asking per keystroke would only be slower about it.

Because the client outlives any one server, a server that dies is replaced
under the editors holding it: the documents stay, marked as no longer known,
and the next server is told about them before it is asked anything. Messages go
out one at a time — each is its own call, and two in flight could reach the
server in either order, which for a document means a change arriving before the
open that made it.

Every SQL tab is a document, named `file:///datalooker/<connection>/<tab>.sql`
(`features/sql-editor/documents.ts`). Monaco holds completion providers by
language rather than by editor, so one provider answers for every tab and the
document's own name is what says whose server to ask. The whole text goes with
every change, which is the synchronization sqls asks for and the only kind that
cannot drift from what the editor holds.

`wordBasedSuggestions` is off: what a server says is the only thing offered,
and Monaco's own suggestions are the words already in the statement. The
suggestion widget is imported as the contribution it lives in rather than
through Monaco's feature split, which has an entry named `suggest` that
registers the inline kind and not the widget.

## Syntax errors

`app/syntax.rs` marks what PostgreSQL would refuse, using the parser libpg_query carries
(the `pg_query` crate), so no server is asked and an editor with no connection open still
gets them. The text is scanned into tokens once, split into statements at the semicolons,
and each statement parsed on its own, so one mistake does not silence the statements after
it. The parser reports only a message — the crate drops the cursor position libpg_query
returns — so the mark is placed on the token the message quotes, matched against the
scanner's tokens rather than searched for in the text, and only when the statement uses
that word once — `WHERE a = 1 AND FROM b` names `FROM`, and the first one in the text is
the one that parsed. Otherwise the whole statement is marked, which says less than the
truth rather than something other than it. An error at end of input is dropped: that is what every statement looks like
while it is still being typed.

## Query history

Every run is logged to meta.db, whatever became of it: a statement that failed or was
cancelled is the one a reader most wants back. Nothing in the log is collapsed, because it
is the record of what was run against a database and when — the palette behind ⌘Y is what
collapses it, offering the newest run of each distinct statement and opening it in a tab of
its own. Only the newest runs of a connection are kept, so a long-lived `meta.db` stays
bounded. A log that cannot be written never fails the query it describes: the rows are
already in hand, and there is nothing the reader could do about it.

## A connection's command

A connection can carry a shell command the reader runs before connecting — a port forward,
an SSH tunnel — started and stopped from its row in the list. It is the reader's, not the
driver's, so it sits in a column of its own rather than in `config`.

`shell/` runs it through the reader's login shell (`$SHELL -l -c`), because a window opened
from Finder inherits a `PATH` with none of the places `ssh` or `kubectl` are installed and
the login profile is what puts them back. The shell leads a process group of its own and
stopping kills the group: what the reader wrote is rarely one process, and killing the
shell alone would leave the tunnel holding its port while the window says it stopped. The
group also goes when the app does — a tunnel that outlives the window which opened it is
one nothing here can stop any more.

A command that ends is announced rather than returned: `app::App` has no window to tell and
no way to reach one, so it publishes the ending on a broadcast channel and
`commands/shell.rs` is what turns that into a Tauri event. `lib/events.ts` is to an event
what `lib/commands.ts` is to a command — the only module that names one.

## Vim keybindings

A toggle under the editor turns them on, and `features/sql-editor/vim.ts` holds the answer
for all of them: every tab has an editor, and turning vim on is not something a reader does
per tab. It is kept in `localStorage`, because it is how this window behaves rather than
something DataLooker knows — nothing else that drives the app has an editor to apply it to.

monaco-vim needs two lines in `vite.config.ts` that look arbitrary and are not. The entry
its package offers a browser is a UMD bundle calling `require`, which no browser answers
and which the dependency optimizer hangs on rather than rejecting, so the ESM build is
named directly and the package is kept out of pre-bundling. That build then reaches into
Monaco by a path Monaco does not publish (`./*` already maps to `./esm/vs/*.js`), so the
prefix is aliased away — onto the same module the editor imports, which is what keeps one
Monaco in the page rather than two.

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
- A second driver arrived as an enum rather than a trait. `drivers::session::Session` has
  an arm per driver and a method per operation, so the set of drivers is the closed one
  this app ships: the compiler says when a driver was left out of an operation, and what a
  driver cannot do is an arm that says so rather than a method returning an error nobody
  wrote down. A trait would also have had to be `async_trait` to be object-safe.
- A result cell crosses IPC as JSON, typed `unknown` in TypeScript. Integers outside
  JavaScript's safe range and `NUMERIC` become strings, because a JSON number would reach
  the frontend rounded.
- Commands fail with `AppError`, which serializes as `{ kind, message }`; the frontend
  branches on `kind` and never on message text.
- Monokai Pro is the only theme. It has no light counterpart, so no built-in daisyUI
  theme is enabled and nothing follows the OS light/dark preference. Monaco paints
  itself rather than reading the theme, so it is pinned to its own `vs-dark` — close
  enough that a second palette to maintain is not worth it. That is set in
  `features/sql-editor/monaco.ts` rather than on each editor, because Monaco holds one
  theme for everything it draws, including the statements it colours outside an editor.
- The table palette (⌘O) ranks names itself rather than through a fuzzy-search library.
  The haystack is a few thousand `schema.table` strings already in memory, and what makes
  one hit better than another here is structural — a run of letters that is contiguous,
  that starts a word, and that lands in the table's own name rather than its schema's —
  where a library tuned for typos in prose scores by edit distance. Doing it in
  `features/table-search/search.ts` also hands the palette the positions it marks up.
- ⌘O and ⌘Y are the same component (`components/Palette.tsx`). A palette is the modal
  list, the query field and the keys that walk it; what fills it and what an option looks
  like belong to whoever opens it.
- The production CSP allows no inline scripts. `style-src 'unsafe-inline'` and
  `worker-src blob:` are there for libraries that inject styles and spawn web workers, and
  `connect-src ipc: http://ipc.localhost` is Tauri's IPC transport.
