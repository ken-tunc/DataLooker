CREATE TABLE connections (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    -- The driver-specific settings as a serde-tagged JSON object, so adding a
    -- driver needs no schema change. Text rather than JSONB: serde reads the
    -- whole value, no SQL touches its fields, and SQLite documents JSONB as
    -- internal to itself.
    config     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
