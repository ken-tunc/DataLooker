-- The tabs each connection had open, so that a restart finds the reader's
-- drafts where they left them. What a tab showed is not kept: a result would
-- have to be run again, and an unsaved edit would fail its row's check
-- against rows read before the restart.
CREATE TABLE open_tabs (
    -- A connection that is deleted has no workspace to reopen.
    connection_id TEXT    NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    kind          TEXT    NOT NULL CHECK (kind IN ('sql', 'table')),
    -- Set for a SQL tab; a table tab is titled by the table it names.
    title         TEXT,
    sql           TEXT,
    -- Set for a table tab, which reopens by name.
    schema_name   TEXT,
    table_name    TEXT,
    active        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (connection_id, position)
);
