-- Whether the connection's command runs only while the connection is the one
-- in front: started when it is selected, stopped when another is. A tunnel
-- the reader keeps for one connection need not outlive their looking at it.
ALTER TABLE connections ADD COLUMN command_while_selected INTEGER NOT NULL DEFAULT 0;
