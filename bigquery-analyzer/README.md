# bigquery-analyzer

A helper process that reads BigQuery SQL with GoogleSQL, the parser and analyzer
BigQuery's dialect is defined by, and says what could go where the cursor is. The
app starts it, sends it requests on stdin, and reads the answers on stdout.

It never reaches BigQuery. What a table holds is the app's to say, because the
app holds the credentials: the helper names the tables a statement refers to,
the app looks them up, and asks again with them. A request carries everything
the answer needs, so nothing is cached here and nothing can go stale.

What is decided here is what depends on GoogleSQL's rules: where a statement
ends, what the cursor is in, and what the analyzer resolved around it. What
depends on the editor or on BigQuery — which tables a project has, what to offer
when the helper cannot say, the order candidates are shown in, UTF-16 positions —
is the app's.

## Building

Bazel builds it, pinned by `.bazelversion`; [bazelisk](https://github.com/bazelbuild/bazelisk)
reads that file and fetches the version. The first build compiles GoogleSQL and
takes a long time; the app does not need it to be built, and
fetches the build CI publishes.

```bash
bazel test //:complete_test
bazel build -c opt //:datalooker-bigquery-analyzer
bazel cquery -c opt --output=files //:datalooker-bigquery-analyzer
```

The last line prints where the binary is: `.bazelrc` keeps Bazel's `bazel-*`
links out of the tree. `DATALOOKER_BQ_ANALYZER_BIN` hands a build of your own to
the app.

`.github/workflows/analyzer.yml` tests it and publishes the Apple silicon build
as `analyzer-v<version>`. A change to the helper is therefore a change to
`kVersion` in `main.cc`: one version is one binary.

## Protocol

JSON-RPC 2.0, each message framed as a language server's is: a
`Content-Length` header, a blank line, and that many bytes. One request is
answered before the next is read.

Positions are byte offsets into the UTF-8 text. A table is a path of three
names, `[project, dataset, table]`; a name the statement wrote with fewer parts
is completed with `default_project`, and `` `a.b.c` `` in backquotes is split at
its dots, as BigQuery does.

### `hello`

Returns `{"version", "googlesql"}`. The app expects exactly the version it was
built with.

### `complete`

```json
{
  "text": "SELECT o. FROM sales.orders o",
  "cursor": 9,
  "default_project": "shop",
  "catalog": {
    "tables": [
      {
        "path": ["shop", "sales", "orders"],
        "columns": [{ "name": "order_id", "type": "INT64" }]
      }
    ],
    "absent": [["shop", "sales", "ordrs"]]
  }
}
```

`text` is the whole document; the statement the cursor is in is found here.
A column's `type` is written as `INFORMATION_SCHEMA.COLUMNS.data_type` has it. A
table in `absent` is one the app looked for and BigQuery does not have, so it is
not asked for again.

The answer is one of these:

- `{"needs": [path, ...]}` — tables the statement names that the request did not
  bring. Look them up and send the same request with them.
- `{"context": "member", "replace", "expected_type", "fields": [{name, type}]}` —
  the cursor follows `a.b.`, and these are the fields of what `a.b` is.
- `{"context": "name", "replace", "expected_type", "scopes": [{columns, range_variables}]}`
  — a name on its own. Each scope is what one query can see, the innermost
  first; an inner query can name what its outer queries see too. A column
  carries the `qualifier` it can be written after where it has one.
- `{"context": "table", "replace", "path": [...]}` — a table name after `FROM`
  or `JOIN`, of which `path` has been typed. Which tables there are is the
  app's to list.
- `{"context": "none"}` — the cursor is in a string or a comment.
- `{"unresolved": message}` — GoogleSQL cannot say, most often because the
  statement has no `FROM` yet. The app decides what to offer instead.

`replace` is the span a candidate replaces: the word being typed, or an empty
span where none has begun. `expected_type` is the type the place wants where
that is known, which is what a candidate can be ranked by.

A request the protocol cannot read — a missing field, a cursor past the text —
is a JSON-RPC error, `-32602`. What the statement says is never an error: it is
an answer. Nor is a column of a type GoogleSQL does not know: it is left out of
its table, and the rest of the catalog is read as usual.

## How a name is resolved

The word under the cursor, and the `a.b.` before it, are replaced by an
expression that holds an undeclared query parameter, and the statement is
analyzed:

- after `a.b.`, `IF(FALSE, a.b, @__cursor__)` makes the parameter take the type
  of `a.b`, whose fields are the candidates;
- on its own, the parameter is found in the resolved statement, and the scans
  above it say what it can see.

A parameter takes its type from an operand beside it, but not from the clause
it is in or the function it is passed to. The probe is therefore tried as
something that adapts, then as a `BOOL`, a `TIMESTAMP`, a `DATE`, a `STRING` and
a `FLOAT64`, and the first the statement accepts is the answer — and says which
type the place wanted.

A `GROUP BY` is not answered: grouping by the probe leaves the select list
naming columns that are no longer grouped.
