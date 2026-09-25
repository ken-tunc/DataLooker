-- The zone the reader reads a connection's points in time in, as an IANA name
-- (`Asia/Tokyo`). NULL is UTC. Like `command`, it is the reader's rather than
-- the driver's: it changes what is shown, never what is asked.
ALTER TABLE connections ADD COLUMN time_zone TEXT;
