import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccessRepository, openDatabase } from '../src/database.js';
import { PermissionSyncError, PrincipalSynchronizer } from '../src/principal-sync.js';

test('按 ERP uid 同步角色和店铺名称到 sid，且不保存手机号和邮箱', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-sync-'));
  const database = openDatabase(path.join(directory, 'access.sqlite'));
  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new AccessRepository(database);
  const client = {
    request: async ({ path: requestPath }) => {
      if (requestPath.endsWith('/account/lists')) {
        return {
          code: 0,
          data: [{
            uid: 7,
            username: 'alice',
            realname: 'Alice',
            role: '销售专员,广告专员',
            seller: 'A-US, A-CA',
            is_master: 0,
            status: 1,
            mobile: 'should-not-store',
            email: 'should-not-store@example.test',
          }],
        };
      }
      return {
        code: 0,
        data: [
          { sid: 101, name: 'A-US', seller_id: 'SELLER-A' },
          { sid: 102, name: 'A-CA', seller_id: 'SELLER-A-CA' },
          { sid: 999, name: 'B-US', seller_id: 'SELLER-B' },
        ],
      };
    },
  };
  const synchronizer = new PrincipalSynchronizer({ repository, lingxingClient: client });
  const user = await synchronizer.syncUser(7);

  assert.deepEqual(user.roles, ['广告专员', '销售专员']);
  assert.deepEqual(user.allowedSids, [101, 102]);
  const row = database.prepare('SELECT * FROM users WHERE uid = 7').get();
  assert.equal(JSON.stringify(row).includes('should-not-store'), false);
});

test('店铺名称重复或用户权限指向未知店铺时 fail closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-sync-'));
  const database = openDatabase(path.join(directory, 'access.sqlite'));
  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new AccessRepository(database);
  const client = {
    request: async ({ path: requestPath }) => (
      requestPath.endsWith('/account/lists')
        ? {
          code: 0,
          data: [{
            uid: 8,
            username: 'bob',
            role: '销售专员',
            seller: '重复店铺',
            is_master: 0,
            status: 1,
          }],
        }
        : {
          code: 0,
          data: [
            { sid: 1, name: '重复店铺', seller_id: 'A' },
            { sid: 2, name: '重复店铺', seller_id: 'B' },
          ],
        }
    ),
  };
  const synchronizer = new PrincipalSynchronizer({ repository, lingxingClient: client });
  await assert.rejects(
    () => synchronizer.syncUser(8),
    (error) => error instanceof PermissionSyncError && error.code === 'AMBIGUOUS_STORE',
  );
  assert.equal(repository.getUser(8), null);
});

test('主账号在 seller 字段为空时同步全部店铺', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-sync-'));
  const database = openDatabase(path.join(directory, 'access.sqlite'));
  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new AccessRepository(database);
  const client = {
    request: async ({ path: requestPath }) => (
      requestPath.endsWith('/account/lists')
        ? {
          code: 0,
          data: [{
            uid: 1,
            username: 'admin',
            role: '超级管理员',
            seller: '',
            is_master: 1,
            status: 1,
          }],
        }
        : {
          code: 0,
          data: [
            { sid: 101, name: 'A-US', seller_id: 'A' },
            { sid: 999, name: 'B-US', seller_id: 'B' },
          ],
        }
    ),
  };
  const synchronizer = new PrincipalSynchronizer({ repository, lingxingClient: client });
  const user = await synchronizer.syncUser(1);
  assert.equal(user.isMaster, true);
  assert.deepEqual(user.allowedSids, [101, 999]);
});
