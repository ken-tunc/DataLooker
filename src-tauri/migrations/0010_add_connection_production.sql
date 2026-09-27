-- Whether the reader marked the connection as production: it is drawn apart,
-- and every statement that writes asks before it runs. Like `time_zone`, it
-- is the reader's rather than the driver's.
ALTER TABLE connections ADD COLUMN production INTEGER NOT NULL DEFAULT 0;
