import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';

const db = env.DB;

// Storage is isolated per test file, not per test, so each test starts from empty tables and then
// adds the minimal rows every message needs: a user, a workspace and a conversation.
async function seed() {
  await db.batch([
    db.prepare('DELETE FROM message'),
    db.prepare('DELETE FROM workspace_member'),
    db.prepare('DELETE FROM conversation'),
    db.prepare('DELETE FROM workspace'),
    db.prepare('DELETE FROM user'),
    db.prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'Thandi Nkosi', 'thandi@example.test')"),
    db.prepare("INSERT INTO workspace (id, name) VALUES ('w1', 'Brightwater Studio')"),
    db.prepare(
      "INSERT INTO conversation (id, workspace_id, kind, name, created_by) VALUES ('c1', 'w1', 'public', 'general', 'u1')",
    ),
  ]);
}

const addMessage = (id: string, seq: number, body: string, clientMsgId: string | null = null) =>
  db
    .prepare(
      'INSERT INTO message (id, conversation_id, seq, author_id, client_msg_id, body) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, 'c1', seq, 'u1', clientMsgId, body)
    .run();

const search = async (term: string) => {
  const { results } = await db
    .prepare(
      'SELECT m.id FROM message_fts JOIN message m ON m.row_id = message_fts.rowid WHERE message_fts MATCH ? ORDER BY m.seq',
    )
    .bind(term)
    .all<{ id: string }>();
  return results.map((r) => r.id);
};

beforeEach(seed);

describe('message search index', () => {
  it('finds new messages, ignoring accents and case', async () => {
    await addMessage('m1', 1, 'The boundary wall is 1.8 m on the site plan');
    await addMessage('m2', 2, 'Café meeting moved to Tuesday');
    expect(await search('boundary')).toEqual(['m1']);
    expect(await search('cafe')).toEqual(['m2']);
  });

  it('re-indexes an edited message so old words stop matching', async () => {
    await addMessage('m1', 1, 'Section through the kitchen');
    await db.prepare("UPDATE message SET body = 'Section through the scullery' WHERE id = 'm1'").run();
    expect(await search('kitchen')).toEqual([]);
    expect(await search('scullery')).toEqual(['m1']);
  });

  it('drops a soft-deleted message from results', async () => {
    await addMessage('m1', 1, 'Gate code is 4471');
    await db.prepare("UPDATE message SET body = '', deleted_at = 1 WHERE id = 'm1'").run();
    expect(await search('gate')).toEqual([]);
  });
});

describe('database constraints', () => {
  it('rejects a duplicate client_msg_id from the same author (retried send)', async () => {
    await addMessage('m1', 1, 'Hello', 'client-123');
    await expect(addMessage('m2', 2, 'Hello', 'client-123')).rejects.toThrow(/UNIQUE/);
  });

  it('rejects two messages with the same seq in one conversation', async () => {
    await addMessage('m1', 1, 'First');
    await expect(addMessage('m2', 1, 'Also first')).rejects.toThrow(/UNIQUE/);
  });

  it('rejects an unknown workspace role', async () => {
    const insert = db.prepare(
      "INSERT INTO workspace_member (workspace_id, user_id, role) VALUES ('w1', 'u1', 'superuser')",
    );
    await expect(insert.run()).rejects.toThrow(/CHECK/);
  });

  it('rejects a channel without a name', async () => {
    const insert = db.prepare(
      "INSERT INTO conversation (id, workspace_id, kind, created_by) VALUES ('c2', 'w1', 'private', 'u1')",
    );
    await expect(insert.run()).rejects.toThrow(/CHECK/);
  });
});
