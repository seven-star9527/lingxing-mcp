import { randomUUID } from 'node:crypto';
import { watchFile, unwatchFile } from 'node:fs';

import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

import { createLingxingMcpServer } from './mcp.js';
import { EndpointRateLimiter } from './rate-limiter.js';

function jsonRpcError(res, status, code, message) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

function apiKeyFromRequest(req) {
  const value = req.get('X-Mcp-Key') ?? '';
  return value.length <= 256 ? value : '';
}

function principalFingerprint(principal) {
  return JSON.stringify({
    uid: principal.uid,
    roles: principal.roles,
    allowedSids: principal.allowedSids,
    allowedStores: principal.allowedStores,
    isMaster: principal.isMaster,
    status: principal.status,
  });
}

export function createHttpApp({
  repository,
  catalog,
  changesFile,
  lingxingClient,
  serverVersion = '0.1.0',
  allowedOrigins = [],
  sessionTtlMs = 30 * 60 * 1000,
  maxSessions = 500,
  maxSessionsPerKey = 5,
  watchChanges = false,
  principalResolver = async (principal) => principal,
  rateLimiter = new EndpointRateLimiter(),
}) {
  if (!repository || !catalog || !lingxingClient) {
    throw new TypeError('repository、catalog 和 lingxingClient 为必填参数');
  }
  const app = express();
  const sessions = new Map();
  let pendingSessionCount = 0;
  const pendingSessionsByKey = new Map();
  const originSet = new Set(allowedOrigins.filter(Boolean));
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    const origin = req.get('Origin');
    if (origin && !originSet.has(origin)) {
      res.status(403).json({ error: 'origin_forbidden' });
      return;
    }
    if (origin) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
      });
    }
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      server: 'lingxing-mcp',
      version: serverVersion,
      catalog_version: catalog.version,
      endpoint_count: catalog.count,
    });
  });

  async function authenticate(req, res) {
    const principal = repository.authenticateApiKey(apiKeyFromRequest(req));
    if (!principal) {
      res.set('WWW-Authenticate', 'ApiKey realm="lingxing-mcp"');
      jsonRpcError(res, 401, -32001, '缺少或无效的 X-Mcp-Key');
      return null;
    }
    try {
      const resolved = await principalResolver(principal);
      if (!resolved || resolved.status !== 'active') {
        jsonRpcError(res, 403, -32007, '领星 ERP 用户已禁用');
        return null;
      }
      return resolved;
    } catch {
      jsonRpcError(res, 503, -32004, '领星 ERP 用户权限同步失败，已按 fail closed 拒绝访问');
      return null;
    }
  }

  async function handlePost(req, res) {
    const principal = await authenticate(req, res);
    if (!principal) return;
    const sessionId = req.get('Mcp-Session-Id');
    let session = sessionId ? sessions.get(sessionId) : null;

    if (sessionId && !session) {
      jsonRpcError(res, 404, -32002, 'MCP 会话不存在或已过期');
      return;
    }
    if (session && session.keyId !== principal.keyId) {
      jsonRpcError(res, 403, -32003, 'MCP 会话已绑定其他 X-Mcp-Key');
      return;
    }
    if (session && session.principalFingerprint !== principalFingerprint(principal)) {
      jsonRpcError(res, 409, -32005, '领星 ERP 权限已变化，请重新建立 MCP 会话');
      return;
    }
    if (!session) {
      if (sessionId || !isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, '缺少有效会话；请先发送 initialize');
        return;
      }
      const keySessionCount = [...sessions.values()]
        .filter((item) => item.keyId === principal.keyId).length
        + (pendingSessionsByKey.get(principal.keyId) ?? 0);
      if (
        sessions.size + pendingSessionCount >= maxSessions
        || keySessionCount >= maxSessionsPerKey
      ) {
        jsonRpcError(res, 429, -32006, 'MCP 会话数量已达上限，请关闭旧会话后重试');
        return;
      }
      pendingSessionCount += 1;
      pendingSessionsByKey.set(
        principal.keyId,
        (pendingSessionsByKey.get(principal.keyId) ?? 0) + 1,
      );
      let reservationReleased = false;
      const releaseReservation = () => {
        if (reservationReleased) return;
        reservationReleased = true;
        pendingSessionCount -= 1;
        const remaining = (pendingSessionsByKey.get(principal.keyId) ?? 1) - 1;
        if (remaining > 0) pendingSessionsByKey.set(principal.keyId, remaining);
        else pendingSessionsByKey.delete(principal.keyId);
      };
      let transport;
      try {
        const mcpServer = createLingxingMcpServer({
          principal,
          repository,
          catalog,
          changesFile,
          lingxingClient,
          rateLimiter,
          serverVersion,
        });
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (newSessionId) => {
            releaseReservation();
            sessions.set(newSessionId, {
              id: newSessionId,
              keyId: principal.keyId,
              uid: principal.uid,
              principalFingerprint: principalFingerprint(principal),
              transport,
              mcpServer,
              lastSeenAt: Date.now(),
            });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } finally {
        releaseReservation();
      }
      return;
    }
    session.lastSeenAt = Date.now();
    await session.transport.handleRequest(req, res, req.body);
  }

  async function handleSessionRequest(req, res) {
    const principal = await authenticate(req, res);
    if (!principal) return;
    const sessionId = req.get('Mcp-Session-Id');
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) {
      jsonRpcError(res, 404, -32002, 'MCP 会话不存在或已过期');
      return;
    }
    if (session.keyId !== principal.keyId) {
      jsonRpcError(res, 403, -32003, 'MCP 会话已绑定其他 X-Mcp-Key');
      return;
    }
    if (session.principalFingerprint !== principalFingerprint(principal)) {
      jsonRpcError(res, 409, -32005, '领星 ERP 权限已变化，请重新建立 MCP 会话');
      return;
    }
    session.lastSeenAt = Date.now();
    await session.transport.handleRequest(req, res);
  }

  app.post('/mcp', (req, res) => {
    void handlePost(req, res).catch(() => {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'MCP 服务内部错误');
    });
  });
  app.get('/mcp', (req, res) => {
    void handleSessionRequest(req, res).catch(() => {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'MCP 服务内部错误');
    });
  });
  app.delete('/mcp', (req, res) => {
    void handleSessionRequest(req, res).catch(() => {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'MCP 服务内部错误');
    });
  });
  app.options('/mcp', (_req, res) => {
    res.set({
      'Access-Control-Allow-Headers': 'Content-Type, X-Mcp-Key, Mcp-Session-Id, Last-Event-ID',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    }).status(204).end();
  });

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeenAt < cutoff) {
        sessions.delete(sessionId);
        void session.transport.close();
      }
    }
  }, Math.min(sessionTtlMs, 60_000));
  cleanupTimer.unref();

  const notifyChanges = async () => {
    if (typeof catalog.reload === 'function') {
      try {
        const changed = await catalog.reload();
        if (!changed) return;
      } catch {
        return;
      }
    }
    for (const session of sessions.values()) {
      try {
        if (session.mcpServer.resourceSubscriptions.has('lingxing://catalog/changes')) {
          await session.mcpServer.server.sendResourceUpdated({ uri: 'lingxing://catalog/changes' });
        }
        if (session.mcpServer.resourceSubscriptions.has('lingxing://catalog/version')) {
          await session.mcpServer.server.sendResourceUpdated({ uri: 'lingxing://catalog/version' });
        }
      } catch {
        // 断开的会话由 transport.onclose 或 TTL 清理。
      }
    }
  };
  if (watchChanges) watchFile(changesFile, { interval: 2000 }, notifyChanges);

  app.locals.sessions = sessions;
  app.locals.notifyCatalogChanged = notifyChanges;
  app.locals.close = async () => {
    clearInterval(cleanupTimer);
    if (watchChanges) unwatchFile(changesFile, notifyChanges);
    await Promise.allSettled([...sessions.values()].map((session) => session.transport.close()));
    sessions.clear();
  };
  return app;
}
