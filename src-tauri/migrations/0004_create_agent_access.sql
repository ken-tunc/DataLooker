-- What an agent may reach the app through. One row: the app either answers
-- agents or it does not, and the token and the port are how it does.
CREATE TABLE agent_access (
    only_row INTEGER PRIMARY KEY CHECK (only_row = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    -- Made when the reader first turns this on, and kept, so that an agent
    -- configured once keeps working.
    token TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 0
);

INSERT INTO agent_access (only_row) VALUES (1);
