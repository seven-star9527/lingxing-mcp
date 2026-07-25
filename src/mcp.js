import { readFile } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

import {
  AuthorizationError,
  authorizeEndpoint,
  filterEndpointResponse,
  hasFunctionalGrant,
} from './permissions.js';
import { EndpointRateLimiter } from './rate-limiter.js';

const TOOL_NAMES = Object.freeze([
  'search_endpoints',
  'get_endpoint_schema',
  'list_my_permissions',
  'call_read_endpoint',
  'call_write_endpoint',
  'get_api_changes',
]);

function jsonToolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(error) {
  const known = error instanceof AuthorizationError;
  const value = {
    code: known ? error.code : 'TOOL_FAILED',
    message: known ? error.message : '工具执行失败，请联系管理员查看服务端审计日志',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

async function readChanges(changesFile) {
  try {
    const payload = JSON.parse(await readFile(changesFile, 'utf8'));
    return {
      previous_version: payload.previous_version ?? null,
      current_version: payload.current_version ?? null,
      added: Array.isArray(payload.added) ? payload.added : [],
      updated: Array.isArray(payload.updated) ? payload.updated : [],
      removed: Array.isArray(payload.removed) ? payload.removed : [],
    };
  } catch {
    return {
      previous_version: null,
      current_version: null,
      added: [],
      updated: [],
      removed: [],
    };
  }
}

function publicEndpoint(endpoint) {
  return {
    id: endpoint.id,
    title: endpoint.title,
    method: endpoint.method,
    path: endpoint.path,
    module: endpoint.module,
    operation: endpoint.operation,
    scope_type: endpoint.scope?.type ?? 'unscoped',
    rate_limit: endpoint.rate_limit,
    source_url: endpoint.source_url,
  };
}

function grantsForPrincipal(repository, principal) {
  return repository.getGrantsForRoles(principal.roles);
}

function canDiscover(endpoint, grants, principal) {
  if (endpoint.internal) return false;
  if (!hasFunctionalGrant(endpoint, grants)) return false;
  if (endpoint.scope?.type !== 'unscoped' || principal.isMaster) return true;
  return grants.some((grant) => (
    grant.endpointId === endpoint.id
    && grant.allowUnscoped
    && (grant.access === endpoint.operation || grant.access === 'write')
  ));
}

export function createLingxingMcpServer({
  principal,
  repository,
  catalog,
  changesFile,
  lingxingClient,
  rateLimiter = new EndpointRateLimiter(),
  serverVersion = '0.1.0',
}) {
  const server = new McpServer(
    {
      name: 'lingxing-mcp',
      title: '领星 OpenAPI MCP',
      version: serverVersion,
    },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: false },
      },
      instructions: [
        '先使用 search_endpoints 搜索当前账号有权访问的接口，再使用 get_endpoint_schema 获取参数。',
        '只读接口必须通过 call_read_endpoint 调用；写接口必须通过 call_write_endpoint 调用。',
        '店铺和功能权限来自当前 X-Mcp-Key 绑定的领星 ERP 用户，无法确认权限时服务端会拒绝。',
      ].join(' '),
    },
  );
  const resourceSubscriptions = new Set();
  const subscribableResources = new Set([
    'lingxing://catalog/version',
    'lingxing://catalog/changes',
  ]);
  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    if (!subscribableResources.has(params.uri)) {
      throw new Error('资源不存在或不支持订阅');
    }
    resourceSubscriptions.add(params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    resourceSubscriptions.delete(params.uri);
    return {};
  });
  server.resourceSubscriptions = resourceSubscriptions;

  const callEndpoint = async (expectedOperation, args, extra) => {
    const endpoint = catalog.get(args.endpoint_id);
    const requestId = extra?.requestId ? String(extra.requestId) : null;
    if (!endpoint) {
      return toolError(new AuthorizationError('ENDPOINT_NOT_FOUND', '接口不在当前版本目录中'));
    }
    if (endpoint.internal) {
      return toolError(new AuthorizationError(
        'INTERNAL_ENDPOINT',
        '认证和续约端点仅供服务端内部使用，不能暴露给 Agent',
      ));
    }
    if (endpoint.operation !== expectedOperation) {
      return toolError(new AuthorizationError(
        'OPERATION_MISMATCH',
        expectedOperation === 'read'
          ? '该接口被归类为有副作用操作，必须使用 call_write_endpoint'
          : '该接口是只读操作，请使用 call_read_endpoint',
      ));
    }
    const grants = grantsForPrincipal(repository, principal);
    try {
      if (expectedOperation === 'write' && repository.writeAuditHealthy === false) {
        throw new AuthorizationError(
          'AUDIT_UNAVAILABLE',
          '写操作审计暂不可用，已按 fail closed 拒绝调用',
        );
      }
      const scoped = authorizeEndpoint({
        principal,
        endpoint,
        grants,
        query: args.query ?? {},
        body: args.body ?? {},
      });
      if (expectedOperation === 'write') {
        try {
          repository.appendAudit({
            keyId: principal.keyId,
            uid: principal.uid,
            action: 'call_write_endpoint_attempt',
            endpointId: endpoint.id,
            allowed: true,
            requestId,
            details: {
              query_keys: Object.keys(scoped.query),
              body_keys: Object.keys(scoped.body),
            },
          });
        } catch {
          repository.writeAuditHealthy = false;
          throw new AuthorizationError(
            'AUDIT_UNAVAILABLE',
            '写操作审计暂不可用，未向领星发送请求',
          );
        }
      }
      await rateLimiter.schedule(endpoint.id, endpoint.rate_limit);
      const payload = await lingxingClient.request({
        method: endpoint.method,
        path: endpoint.path,
        query: scoped.query,
        body: scoped.body,
      });
      const filtered = filterEndpointResponse({ principal, endpoint, payload });
      let auditPersisted = true;
      try {
        repository.appendAudit({
          keyId: principal.keyId,
          uid: principal.uid,
          action: expectedOperation === 'write' ? 'call_write_endpoint' : 'call_read_endpoint',
          endpointId: endpoint.id,
          allowed: true,
          requestId,
          details: {
            query_keys: Object.keys(scoped.query),
            body_keys: Object.keys(scoped.body),
          },
        });
      } catch {
        auditPersisted = false;
        if (expectedOperation === 'write') repository.writeAuditHealthy = false;
      }
      return jsonToolResult({
        endpoint: publicEndpoint(endpoint),
        result: filtered,
        audit_persisted: auditPersisted,
        ...(auditPersisted ? {} : {
          warning: '上游操作已返回结果，但本地完成审计写入失败；请勿自动重试写操作，并联系管理员',
        }),
      });
    } catch (error) {
      try {
        repository.appendAudit({
          keyId: principal.keyId,
          uid: principal.uid,
          action: expectedOperation === 'write' ? 'call_write_endpoint' : 'call_read_endpoint',
          endpointId: endpoint.id,
          allowed: false,
          requestId,
          details: {
            error_code: error?.code ?? 'UPSTREAM_OR_INTERNAL_ERROR',
            error_name: error?.name ?? 'Error',
          },
        });
      } catch {
        if (expectedOperation === 'write') repository.writeAuditHealthy = false;
      }
      return toolError(error);
    }
  };

  server.registerTool('search_endpoints', {
    title: '搜索领星 API',
    description: '搜索当前个人账号有权访问的领星 OpenAPI。结果稳定排序，最多返回 100 条。',
    inputSchema: {
      query: z.string().max(200).optional().describe('标题、HTTP Method 或 API Path 关键词'),
      module: z.string().max(80).optional().describe('功能模块，例如 finance、warehouse、advertising'),
      operation: z.enum(['read', 'write']).optional().describe('只读或写操作'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (args) => {
    const grants = grantsForPrincipal(repository, principal);
    const matches = catalog.search({
      ...args,
      filter: (endpoint) => canDiscover(endpoint, grants, principal),
    });
    return jsonToolResult({
      catalog_version: catalog.version,
      total_matches: matches.total,
      returned: matches.items.length,
      endpoints: matches.items.map(publicEndpoint),
    });
  });

  server.registerTool('get_endpoint_schema', {
    title: '读取领星 API 参数定义',
    description: '读取接口目录中的请求参数、权限范围、操作风险和官方文档地址。',
    inputSchema: {
      endpoint_id: z.string().min(1).max(500),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ endpoint_id: endpointId }) => {
    const endpoint = catalog.get(endpointId);
    const grants = grantsForPrincipal(repository, principal);
    if (!endpoint || !canDiscover(endpoint, grants, principal)) {
      return toolError(new AuthorizationError('ENDPOINT_FORBIDDEN', '接口不存在或当前角色无权查看'));
    }
    return jsonToolResult(endpoint);
  });

  server.registerTool('list_my_permissions', {
    title: '查看我的领星权限',
    description: '返回当前 X-Mcp-Key 绑定的 ERP 用户、角色、允许店铺和 MCP 角色授权，不返回任何密钥。',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => jsonToolResult({
    uid: principal.uid,
    username: principal.username,
    display_name: principal.displayName,
    roles: principal.roles,
    is_master: principal.isMaster,
    allowed_sids: principal.allowedSids,
    allowed_stores: principal.allowedStores,
    grants: grantsForPrincipal(repository, principal).map((grant) => ({
      module: grant.module,
      access: grant.access,
      endpoint_id: grant.endpointId,
      allow_unscoped: grant.allowUnscoped,
    })),
    permissions_synced_at: principal.syncedAt,
  }));

  const callInputSchema = {
    endpoint_id: z.string().min(1).max(500).describe('search_endpoints 返回的 id，格式为 METHOD /path'),
    query: z.record(z.string(), z.unknown()).optional().describe('业务 URL Query 参数；不得传公共鉴权参数'),
    body: z.record(z.string(), z.unknown()).optional().describe('业务 JSON Body 参数'),
  };

  server.registerTool('call_read_endpoint', {
    title: '调用领星只读接口',
    description: '调用目录中归类为 read 的接口。服务端自动签名、限流，并强制执行角色与店铺权限。',
    inputSchema: callInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (args, extra) => callEndpoint('read', args, extra));

  server.registerTool('call_write_endpoint', {
    title: '调用领星写接口',
    description: '调用创建、修改、删除、入库、出库、发货等有副作用接口；必须拥有显式写授权。',
    inputSchema: callInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (args, extra) => callEndpoint('write', args, extra));

  server.registerTool('get_api_changes', {
    title: '查看领星 API 版本变化',
    description: '返回最近一次目录更新新增、修改和移除的接口，支持 Agent 重连后补查。',
    inputSchema: {
      type: z.enum(['all', 'added', 'updated', 'removed']).default('all'),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ type, limit }) => {
    const changes = await readChanges(changesFile);
    const grants = grantsForPrincipal(repository, principal);
    const filterItems = (items) => items
      .map((item) => catalog.get(item.id) ?? item)
      .filter((endpoint) => canDiscover(endpoint, grants, principal))
      .slice(0, limit)
      .map(publicEndpoint);
    const result = {
      previous_version: changes.previous_version,
      current_version: changes.current_version,
      type,
    };
    if (type === 'all' || type === 'added') result.added = filterItems(changes.added);
    if (type === 'all' || type === 'updated') result.updated = filterItems(changes.updated);
    if (type === 'all' || type === 'removed') result.removed = filterItems(changes.removed);
    result.counts = {
      added: result.added?.length ?? 0,
      updated: result.updated?.length ?? 0,
      removed: result.removed?.length ?? 0,
    };
    return jsonToolResult(result);
  });

  server.registerResource(
    'catalog-version',
    'lingxing://catalog/version',
    {
      title: '领星 API 目录版本',
      description: '当前接口目录版本和端点数量',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          catalog_version: catalog.version,
          endpoint_count: catalog.count,
        }),
      }],
    }),
  );

  server.registerResource(
    'catalog-changes',
    'lingxing://catalog/changes',
    {
      title: '领星 API 最近变更',
      description: '最近一次目录更新的新增、修改和移除接口',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(await (async () => {
          const changes = await readChanges(changesFile);
          const grants = grantsForPrincipal(repository, principal);
          const filterItems = (items) => items
            .map((item) => catalog.get(item.id) ?? item)
            .filter((endpoint) => canDiscover(endpoint, grants, principal))
            .map(publicEndpoint);
          const added = filterItems(changes.added);
          const updated = filterItems(changes.updated);
          const removed = filterItems(changes.removed);
          return {
            previous_version: changes.previous_version,
            current_version: changes.current_version,
            counts: {
              added: added.length,
              updated: updated.length,
              removed: removed.length,
            },
            added,
            updated,
            removed,
          };
        })()),
      }],
    }),
  );

  return server;
}

export { TOOL_NAMES };
