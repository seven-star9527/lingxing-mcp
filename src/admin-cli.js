#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { EndpointCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { AccessRepository, openDatabase } from './database.js';
import { LingxingClient } from './lingxing-client.js';
import { PrincipalSynchronizer } from './principal-sync.js';

function parseArgs(argv) {
  const [command = 'help', ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    if (tokens[index + 1] && !tokens[index + 1].startsWith('--')) {
      options[name] = tokens[index + 1];
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = String(options[name] ?? '').trim();
  if (!value) throw new Error(`缺少参数 --${name}`);
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  return {
    commands: {
      'generate-pepper': '生成 LINGXING_MCP_KEY_PEPPER，不访问数据库',
      'init-db': '初始化 SQLite：npm run admin -- init-db',
      'sync-user': '同步 ERP 用户：--uid <uid>',
      'create-key': '创建个人 API Key：--uid <uid> --label <客户端名称>',
      'revoke-key': '吊销 API Key：--id <key id>',
      'grant-role': '授权角色：--role <角色> --module <模块> --access read|write [--endpoint-id <id>] [--allow-unscoped]',
      'apply-role-map': '应用角色映射 JSON：--file <文件>',
      'list-users': '列出已同步用户',
      'list-grants': '列出全部角色授权',
      audit: '查看审计日志：[--limit 100]',
    },
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    print(help());
    return;
  }
  if (command === 'generate-pepper') {
    print({ pepper: randomBytes(48).toString('base64url') });
    return;
  }
  const requiresCredentials = command === 'sync-user';
  const config = loadConfig(process.env, { requireCredentials: requiresCredentials });
  const database = openDatabase(config.databaseFile);
  const repository = new AccessRepository(database, { keyPepper: config.keyPepper });
  try {
    if (command === 'init-db') {
      print({ ok: true, database: config.databaseFile });
      return;
    }
    if (command === 'sync-user') {
      const uid = Number(requireOption(options, 'uid'));
      const client = new LingxingClient({
        appId: config.appId,
        appSecret: config.appSecret,
        baseUrl: config.baseUrl,
        relayToken: config.relayToken,
        timeoutMs: config.requestTimeoutMs,
        maxResponseBytes: config.maxResponseBytes,
      });
      const synchronizer = new PrincipalSynchronizer({ repository, lingxingClient: client });
      const user = await synchronizer.syncUser(uid);
      print({
        ok: true,
        user: {
          uid: user.uid,
          username: user.username,
          display_name: user.displayName,
          roles: user.roles,
          allowed_sids: user.allowedSids,
          is_master: user.isMaster,
          status: user.status,
          synced_at: user.syncedAt,
        },
      });
      return;
    }
    if (command === 'create-key') {
      const created = repository.createApiKey({
        uid: Number(requireOption(options, 'uid')),
        label: requireOption(options, 'label'),
      });
      print({
        ok: true,
        id: created.id,
        uid: created.uid,
        label: created.label,
        api_key: created.apiKey,
        warning: 'API Key 只显示这一次，请立即安全保存；不要提交到 Git、日志或截图。',
      });
      return;
    }
    if (command === 'revoke-key') {
      const id = requireOption(options, 'id');
      print({ ok: repository.revokeApiKey(id), id });
      return;
    }
    if (command === 'grant-role') {
      const access = requireOption(options, 'access');
      const module = requireOption(options, 'module');
      const endpointId = String(options['endpoint-id'] ?? '');
      if (endpointId) {
        const catalog = await EndpointCatalog.load(config.catalogFile);
        const endpoint = catalog.get(endpointId);
        if (!endpoint) throw new Error(`接口目录中不存在 endpoint id：${endpointId}`);
        if (module !== '*' && endpoint.module !== module) {
          throw new Error(`endpoint module 是 ${endpoint.module}，与 --module ${module} 不一致`);
        }
        if (access === 'read' && endpoint.operation === 'write') {
          throw new Error('写接口不能授予 read access');
        }
      }
      const grants = repository.upsertRoleGrant({
        roleName: requireOption(options, 'role'),
        module,
        access,
        endpointId,
        allowUnscoped: Boolean(options['allow-unscoped']),
      });
      print({ ok: true, grants });
      return;
    }
    if (command === 'apply-role-map') {
      const file = requireOption(options, 'file');
      const payload = JSON.parse(await readFile(file, 'utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload.roles)) {
        throw new Error('角色映射文件必须是 {"roles": {"角色名": [...]}}');
      }
      const roles = payload.roles;
      if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
        throw new Error('角色映射文件缺少 roles 对象');
      }
      const catalog = await EndpointCatalog.load(config.catalogFile);
      const validModules = new Set(catalog.endpoints.map((endpoint) => endpoint.module));
      validModules.add('*');
      const normalizedRoleMap = new Map();
      for (const [roleName, grants] of Object.entries(roles)) {
        if (!Array.isArray(grants)) throw new Error(`角色 ${roleName} 的授权必须是数组`);
        const normalizedGrants = grants.map((grant) => ({
          module: grant.module,
          access: grant.access,
          endpointId: grant.endpoint_id ?? '',
          allowUnscoped: Boolean(grant.allow_unscoped),
        }));
        for (const grant of normalizedGrants) {
          if (!validModules.has(grant.module)) {
            throw new Error(`角色 ${roleName} 引用了未知模块：${grant.module}`);
          }
          if (!['read', 'write'].includes(grant.access)) {
            throw new Error(`角色 ${roleName} 的 access 必须是 read 或 write`);
          }
          if (grant.endpointId) {
            const endpoint = catalog.get(grant.endpointId);
            if (!endpoint) throw new Error(`接口目录中不存在 endpoint id：${grant.endpointId}`);
            if (grant.module !== '*' && endpoint.module !== grant.module) {
              throw new Error(`接口 ${grant.endpointId} 不属于模块 ${grant.module}`);
            }
            if (grant.access === 'read' && endpoint.operation === 'write') {
              throw new Error(`写接口 ${grant.endpointId} 不能授予 read access`);
            }
            if (grant.allowUnscoped && endpoint.scope?.type !== 'unscoped') {
              throw new Error(`接口 ${grant.endpointId} 不是 unscoped，不能设置 allow_unscoped`);
            }
          } else if (grant.allowUnscoped) {
            throw new Error(`角色 ${roleName} 的 allow_unscoped 必须绑定具体 endpoint_id`);
          }
        }
        normalizedRoleMap.set(roleName, normalizedGrants);
      }
      repository.replaceRoleGrantMap(normalizedRoleMap);
      print({ ok: true, role_count: Object.keys(roles).length });
      return;
    }
    if (command === 'list-users') {
      print({
        users: repository.listUsers().map((user) => ({
          uid: user.uid,
          username: user.username,
          display_name: user.displayName,
          roles: user.roles,
          allowed_sids: user.allowedSids,
          is_master: user.isMaster,
          status: user.status,
          synced_at: user.syncedAt,
        })),
      });
      return;
    }
    if (command === 'list-grants') {
      print({ grants: repository.listAllRoleGrants() });
      return;
    }
    if (command === 'audit') {
      print({ audit: repository.listAudit({ limit: Number(options.limit) || 100 }) });
      return;
    }
    throw new Error(`未知命令：${command}`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
