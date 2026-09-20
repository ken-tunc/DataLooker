CREATE TABLE connections (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    -- The driver-specific settings as a serde-tagged JSON object, so adding a
    -- driver needs no schema change.
    config     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
