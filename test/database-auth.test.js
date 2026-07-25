import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccessRepository, openDatabase } from '../src/database.js';
import { seedUser } from './fixtures.js';

test('API Key 只保存哈希，并可鉴权、吊销和绑定用户', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-db-'));
  const database = openDatabase(path.join(directory, 'access.sqlite'));
  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new AccessRepository(database, { keyPepper: 'test-pepper' });

  seedUser(repository);
  const created = repository.createApiKey({ uid: 7, label: 'Alice Codex' });
  assert.match(created.apiKey, /^lxmcp_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);

  const stored = database.prepare('SELECT secret_hash FROM api_keys WHERE id = ?').get(created.id);
  assert.ok(stored.secret_hash);
  assert.equal(JSON.stringify(stored).includes(created.apiKey), false);

  const principal = repository.authenticateApiKey(created.apiKey);
  assert.equal(principal.uid, 7);
  assert.deepEqual(principal.roles, ['销售专员']);
  assert.deepEqual(principal.allowedSids, [101, 102]);

  repository.revokeApiKey(created.id);
  assert.equal(repository.authenticateApiKey(created.apiKey), null);
});

test('错误格式和未知 API Key 以恒定比较路径拒绝', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-db-'));
  const database = openDatabase(path.join(directory, 'access.sqlite'));
  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new AccessRepository(database);

  assert.equal(repository.authenticateApiKey(''), null);
  assert.equal(repository.authenticateApiKey('not-a-key'), null);
  assert.equal(
    repository.authenticateApiKey(`lxmcp_${'0'.repeat(16)}_${'A'.repeat(43)}`),
    null,
  );
});
