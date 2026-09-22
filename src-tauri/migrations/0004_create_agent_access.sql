-- What an agent may reach the app through. One row: the app either answers
-- agents or it does not. The token an agent presents is not here — it is in
-- the keychain, because presenting it is worth more than reading this file:
-- what it buys is the running app, which holds the keys to the databases.
CREATE TABLE agent_access (
    only_row INTEGER PRIMARY KEY CHECK (only_row = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    -- Kept once the system has given one, so that an agent configured with an
    -- address is not told a new one after every restart.
    port INTEGER NOT NULL DEFAULT 0
);

INSERT INTO agent_access (only_row) VALUES (1);
