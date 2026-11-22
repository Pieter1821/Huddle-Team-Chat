-- Full-text search over message bodies.
-- External-content FTS5: the index stores tokens only and reads text back from `message`,
-- keyed on message.row_id (an INTEGER PRIMARY KEY, so rowids never change under VACUUM).
-- Kept out of the Drizzle schema on purpose: drizzle-kit does not understand virtual tables.
CREATE VIRTUAL TABLE message_fts USING fts5(
  body,
  content='message',
  content_rowid='row_id',
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- New, live messages are indexed.
CREATE TRIGGER message_fts_insert AFTER INSERT ON message WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO message_fts(rowid, body) VALUES (new.row_id, new.body);
END;
--> statement-breakpoint
-- An edit or a soft delete removes the old tokens; only a live message is indexed again.
CREATE TRIGGER message_fts_update AFTER UPDATE OF body, deleted_at ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, body)
    SELECT 'delete', old.row_id, old.body WHERE old.deleted_at IS NULL;
  INSERT INTO message_fts(rowid, body)
    SELECT new.row_id, new.body WHERE new.deleted_at IS NULL;
END;
--> statement-breakpoint
-- A hard delete (export cleanup, workspace reset) also leaves no stale tokens behind.
CREATE TRIGGER message_fts_delete AFTER DELETE ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, body)
    SELECT 'delete', old.row_id, old.body WHERE old.deleted_at IS NULL;
END;
