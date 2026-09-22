-- Who ran it. A reader's own runs and an agent's runs are both the record of
-- what was asked of a database, and telling them apart is the point of keeping
-- either. Everything already here was the reader's: agents could not run
-- anything before this.
ALTER TABLE query_history ADD COLUMN source TEXT NOT NULL DEFAULT 'reader';
