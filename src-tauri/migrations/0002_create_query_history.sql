-- Every run of a statement, in the order they were run. Nothing is collapsed
-- here: the palette shows one entry per distinct statement, but a log that
-- dropped repeats could not answer what was run against a database and when.
CREATE TABLE query_history (
    id            INTEGER PRIMARY KEY,
    -- Deleting a connection takes its history with it: the rows name a database
    -- that can no longer be reached, and nothing lists them but that connection.
    connection_id TEXT    NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    sql           TEXT    NOT NULL,
    ran_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    duration_ms   INTEGER NOT NULL,
    -- Exactly one of these is set: the row count of a statement that returned,
    -- or what the failure said.
    row_count     INTEGER,
    error         TEXT
);

CREATE INDEX query_history_recent ON query_history (connection_id, id DESC);
