-- Statements the reader keeps under a name, with `@name` blanks filled in each
-- time one is used. They belong to no connection: the same statement is run
-- against production and staging alike, on whichever connection is in front.
CREATE TABLE query_templates (
    id         TEXT PRIMARY KEY,
    -- The name is how a template is found, so two that read the same would
    -- leave the reader guessing which is which.
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sql        TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
