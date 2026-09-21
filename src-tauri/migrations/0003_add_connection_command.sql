-- A shell command the reader runs before connecting — a port forward or an SSH
-- tunnel. It is the reader's command rather than the driver's, so it sits in a
-- column of its own rather than in `config`: every driver can want one, and
-- nothing about it is driver-specific.
ALTER TABLE connections ADD COLUMN command TEXT;
