-- Where a connection sits in the rail, which the reader decides. Connections
-- already here keep the order they were listed in, the order they were made.
ALTER TABLE connections ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE connections
SET position = (
    SELECT COUNT(*)
    FROM connections AS earlier
    WHERE (earlier.created_at, earlier.id) < (connections.created_at, connections.id)
);
