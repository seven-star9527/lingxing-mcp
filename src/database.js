import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const KEY_PATTERN = /^lxmcp_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;
const DUMMY_HASH = Buffer.alloc(32);

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hashApiKey(apiKey, pepper = '') {
  return createHash('sha256').update(pepper).update('\0').update(apiKey).digest();
}

function normalizeStores(stores) {
  const seen = new Set();
  return (Array.isArray(stores) ? stores : [])
    .map((store) => ({
      sid: Number(store.sid),
      name: String(store.name ?? '').trim(),
      seller_id: String(store.seller_id ?? '').trim(),
    }))
    .filter((store) => Number.isSafeInteger(store.sid) && store.sid > 0 && !seen.has(store.sid))
    .map((store) => {
      seen.add(store.sid);
      return store;
    })
    .sort((left, right) => left.sid - right.sid);
}

export function openDatabase(databasePath) {
  const resolved = path.resolve(databasePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const database = new DatabaseSync(resolved);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;

    CREATE TABLE IF NOT EXISTS users (
      uid INTEGER PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      roles_json TEXT NOT NULL,
      stores_json TEXT NOT NULL,
      is_master INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      uid INTEGER NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      label TEXT NOT NULL,
      secret_hash BLOB NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS role_grants (
      role_name TEXT NOT NULL,
      module TEXT NOT NULL,
      access TEXT NOT NULL CHECK (access IN ('read', 'write')),
      endpoint_id TEXT NOT NULL DEFAULT '',
      allow_unscoped INTEGER NOT NULL DEFAULT 0 CHECK (allow_unscoped IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (role_name, module, access, endpoint_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      key_id TEXT,
      uid INTEGER,
      action TEXT NOT NULL,
      endpoint_id TEXT,
      allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
      request_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_uid ON api_keys(uid);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_uid ON audit_logs(uid);
  `);
  return database;
}

export class AccessRepository {
  constructor(database, { keyPepper = process.env.LINGXING_MCP_KEY_PEPPER ?? '' } = {}) {
    this.database = database;
    this.keyPepper = keyPepper;
  }

  upsertUser({
    uid,
    username = '',
    displayName = '',
    roles = [],
    stores = [],
    isMaster = false,
    status = 'active',
    syncedAt = nowIso(),
  }) {
    if (!Number.isSafeInteger(Number(uid)) || Number(uid) <= 0) {
      throw new TypeError('uid 必须是正整数');
    }
    const normalizedRoles = [...new Set(
      (Array.isArray(roles) ? roles : [])
        .flatMap((role) => String(role).split(','))
        .map((role) => role.trim())
        .filter(Boolean),
    )].sort();
    const normalizedStores = normalizeStores(stores);
    const updatedAt = nowIso();
    this.database.prepare(`
      INSERT INTO users (
        uid, username, display_name, roles_json, stores_json,
        is_master, status, synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        roles_json = excluded.roles_json,
        stores_json = excluded.stores_json,
        is_master = excluded.is_master,
        status = excluded.status,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at
    `).run(
      Number(uid),
      String(username),
      String(displayName),
      JSON.stringify(normalizedRoles),
      JSON.stringify(normalizedStores),
      isMaster ? 1 : 0,
      status === 'disabled' ? 'disabled' : 'active',
      syncedAt,
      updatedAt,
    );
    return this.getUser(Number(uid));
  }

  getUser(uid) {
    const row = this.database.prepare('SELECT * FROM users WHERE uid = ?').get(Number(uid));
    if (!row) return null;
    const allowedStores = normalizeStores(parseJson(row.stores_json, []));
    return {
      uid: Number(row.uid),
      username: row.username,
      displayName: row.display_name,
      roles: parseJson(row.roles_json, []),
      allowedStores,
      allowedSids: allowedStores.map((store) => store.sid),
      isMaster: Boolean(row.is_master),
      status: row.status,
      syncedAt: row.synced_at,
      updatedAt: row.updated_at,
    };
  }

  listUsers() {
    return this.database.prepare('SELECT uid FROM users ORDER BY uid').all()
      .map((row) => this.getUser(row.uid));
  }

  createApiKey({ uid, label }) {
    const user = this.getUser(uid);
    if (!user) throw new Error(`用户 uid=${uid} 不存在，请先同步或创建用户`);
    const id = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const apiKey = `lxmcp_${id}_${secret}`;
    this.database.prepare(`
      INSERT INTO api_keys (id, uid, label, secret_hash, status, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(id, Number(uid), String(label || '未命名客户端'), hashApiKey(apiKey, this.keyPepper), nowIso());
    return { id, uid: Number(uid), label: String(label || '未命名客户端'), apiKey };
  }

  authenticateApiKey(apiKey) {
    const value = typeof apiKey === 'string' ? apiKey.trim() : '';
    const match = KEY_PATTERN.exec(value);
    const id = match?.[1] ?? '0000000000000000';
    const row = this.database.prepare(`
      SELECT id, uid, secret_hash, status
      FROM api_keys
      WHERE id = ?
    `).get(id);
    const suppliedHash = hashApiKey(value, this.keyPepper);
    const storedHash = row?.secret_hash ? Buffer.from(row.secret_hash) : DUMMY_HASH;
    const validHash = storedHash.length === suppliedHash.length
      && timingSafeEqual(storedHash, suppliedHash);
    if (!match || !row || row.status !== 'active' || !validHash) return null;
    const user = this.getUser(row.uid);
    if (!user || user.status !== 'active') return null;
    this.database.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
    return { ...user, keyId: row.id };
  }

  revokeApiKey(id) {
    const result = this.database.prepare(`
      UPDATE api_keys
      SET status = 'revoked', revoked_at = ?
      WHERE id = ? AND status = 'active'
    `).run(nowIso(), String(id));
    return Number(result.changes) > 0;
  }

  replaceRoleGrants(roleName, grants) {
    return this.replaceRoleGrantMap(new Map([[roleName, grants]])).get(String(roleName).trim());
  }

  replaceRoleGrantMap(roleGrantMap) {
    const entries = roleGrantMap instanceof Map
      ? [...roleGrantMap.entries()]
      : Object.entries(roleGrantMap ?? {});
    const normalized = entries.map(([roleName, grants]) => {
      const role = String(roleName).trim();
      if (!role) throw new TypeError('roleName 不能为空');
      const items = (Array.isArray(grants) ? grants : []).map((grant) => {
        const module = String(grant.module ?? '').trim();
        const access = String(grant.access ?? '').trim();
        if (!module || !['read', 'write'].includes(access)) {
          throw new TypeError('每条角色授权都需要 module 和 read/write access');
        }
        return {
          module,
          access,
          endpointId: String(grant.endpointId ?? ''),
          allowUnscoped: Boolean(grant.allowUnscoped),
        };
      });
      return [role, items];
    });
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.database.prepare(`
        INSERT INTO role_grants (
          role_name, module, access, endpoint_id, allow_unscoped, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const [role, items] of normalized) {
        this.database.prepare('DELETE FROM role_grants WHERE role_name = ?').run(role);
        for (const grant of items) {
          insert.run(
            role,
            grant.module,
            grant.access,
            grant.endpointId,
            grant.allowUnscoped ? 1 : 0,
            nowIso(),
          );
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return new Map(normalized.map(([role]) => [role, this.getGrantsForRoles([role])]));
  }

  upsertRoleGrant({
    roleName,
    module,
    access,
    endpointId = '',
    allowUnscoped = false,
  }) {
    const role = String(roleName).trim();
    const normalizedModule = String(module).trim();
    const normalizedAccess = String(access).trim();
    if (!role || !normalizedModule || !['read', 'write'].includes(normalizedAccess)) {
      throw new TypeError('roleName、module 和 read/write access 为必填参数');
    }
    this.database.prepare(`
      INSERT INTO role_grants (
        role_name, module, access, endpoint_id, allow_unscoped, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(role_name, module, access, endpoint_id) DO UPDATE SET
        allow_unscoped = excluded.allow_unscoped,
        updated_at = excluded.updated_at
    `).run(
      role,
      normalizedModule,
      normalizedAccess,
      String(endpointId ?? ''),
      allowUnscoped ? 1 : 0,
      nowIso(),
    );
    return this.getGrantsForRoles([role]);
  }

  listAllRoleGrants() {
    return this.database.prepare(`
      SELECT role_name, module, access, endpoint_id, allow_unscoped
      FROM role_grants
      ORDER BY role_name, module, access, endpoint_id
    `).all().map((row) => ({
      roleName: row.role_name,
      module: row.module,
      access: row.access,
      endpointId: row.endpoint_id || null,
      allowUnscoped: Boolean(row.allow_unscoped),
    }));
  }

  listAudit({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.database.prepare(`
      SELECT id, created_at, key_id, uid, action, endpoint_id,
             allowed, request_id, details_json
      FROM audit_logs
      ORDER BY id DESC
      LIMIT ?
    `).all(safeLimit).map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at,
      keyId: row.key_id,
      uid: row.uid === null ? null : Number(row.uid),
      action: row.action,
      endpointId: row.endpoint_id,
      allowed: Boolean(row.allowed),
      requestId: row.request_id,
      details: parseJson(row.details_json, {}),
    }));
  }

  getGrantsForRoles(roles) {
    const normalized = [...new Set((Array.isArray(roles) ? roles : []).map(String).filter(Boolean))];
    if (normalized.length === 0) return [];
    const placeholders = normalized.map(() => '?').join(',');
    return this.database.prepare(`
      SELECT role_name, module, access, endpoint_id, allow_unscoped
      FROM role_grants
      WHERE role_name IN (${placeholders})
      ORDER BY role_name, module, access, endpoint_id
    `).all(...normalized).map((row) => ({
      roleName: row.role_name,
      module: row.module,
      access: row.access,
      endpointId: row.endpoint_id || null,
      allowUnscoped: Boolean(row.allow_unscoped),
    }));
  }

  appendAudit({
    keyId = null,
    uid = null,
    action,
    endpointId = null,
    allowed,
    requestId = null,
    details = {},
  }) {
    this.database.prepare(`
      INSERT INTO audit_logs (
        created_at, key_id, uid, action, endpoint_id,
        allowed, request_id, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowIso(),
      keyId,
      uid,
      String(action),
      endpointId,
      allowed ? 1 : 0,
      requestId,
      JSON.stringify(details ?? {}),
    );
  }
}
