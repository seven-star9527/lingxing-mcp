import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { EndpointCatalog } from '../src/catalog.js';
import { AccessRepository, openDatabase } from '../src/database.js';
import { createHttpApp } from '../src/http-app.js';
import { TEST_CATALOG, TEST_ENDPOINTS, seedUser } from './fixtures.js';

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('标准 Streamable HTTP 使用 X-Mcp-Key 鉴权并绑定会话身份', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-http-'));
  const catalogFile = path.join(directory, 'endpoints.json');
  const changesFile = path.join(directory, 'changes.json');
  await writeFile(catalogFile, JSON.stringify(TEST_CATALOG), 'utf8');
  await writeFile(changesFile, JSON.stringify({
    previous_version: null,
    current_version: TEST_CATALOG.catalog_version,
    added: [
      TEST_ENDPOINTS[1],
      {
        id: 'POST /api/auth-server/oauth/access-token',
        title: '认证',
        method: 'POST',
        path: '/api/auth-server/oauth/access-token',
        module: 'authorization',
        operation: 'write',
        internal: true,
        scope: { type: 'unscoped', fields: [] },
      },
    ],
    updated: [],
    removed: [],
  }), 'utf8');

  const database = openDatabase(path.join(directory, 'access.sqlite'));
  const repository = new AccessRepository(database, { keyPepper: 'test' });
  seedUser(repository);
  repository.replaceRoleGrants('销售专员', [
    { module: 'basic', access: 'read' },
    { module: 'sales', access: 'read' },
  ]);
  const { apiKey } = repository.createApiKey({ uid: 7, label: 'test client' });
  const catalog = await EndpointCatalog.load(catalogFile);
  const upstreamCalls = [];
  const lingxingClient = {
    request: async (request) => {
      upstreamCalls.push(request);
      return { code: 0, data: [{ sid: request.body.sid, amount: 10 }] };
    },
  };
  const app = createHttpApp({
    repository,
    catalog,
    changesFile,
    lingxingClient,
    serverVersion: '0.1.0-test',
  });
  const server = await listen(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  assert.equal(unauthorized.status, 401);

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { 'X-Mcp-Key': apiKey } },
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await app.locals.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      'call_read_endpoint',
      'call_write_endpoint',
      'get_api_changes',
      'get_endpoint_schema',
      'list_my_permissions',
      'search_endpoints',
    ],
  );

  const notification = new Promise((resolve) => {
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, resolve);
  });
  await client.subscribeResource({ uri: 'lingxing://catalog/changes' });
  const changesResource = await client.readResource({ uri: 'lingxing://catalog/changes' });
  const visibleChanges = JSON.parse(changesResource.contents[0].text);
  assert.deepEqual(visibleChanges.added.map((item) => item.id), ['POST /erp/sc/data/sales']);
  await app.locals.notifyCatalogChanged();
  assert.equal((await notification).params.uri, 'lingxing://catalog/changes');

  const permissions = await client.callTool({ name: 'list_my_permissions', arguments: {} });
  assert.equal(permissions.structuredContent.uid, 7);
  assert.deepEqual(permissions.structuredContent.allowed_sids, [101, 102]);

  const called = await client.callTool({
    name: 'call_read_endpoint',
    arguments: {
      endpoint_id: 'POST /erp/sc/data/sales',
      body: { sid: 101 },
    },
  });
  assert.equal(called.isError, false);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].body.sid, 101);

  const wrongSessionKey = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': transport.sessionId,
      'X-Mcp-Key': `lxmcp_${'0'.repeat(16)}_${'A'.repeat(43)}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
  });
  assert.equal(wrongSessionKey.status, 401);

  const originalPrincipal = repository.getUser(7);
  repository.upsertUser({
    uid: 7,
    username: originalPrincipal.username,
    displayName: originalPrincipal.displayName,
    roles: originalPrincipal.roles,
    stores: originalPrincipal.allowedStores.slice(0, 1),
    isMaster: originalPrincipal.isMaster,
    status: originalPrincipal.status,
  });
  const staleSession = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': transport.sessionId,
      'X-Mcp-Key': apiKey,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }),
  });
  assert.equal(staleSession.status, 409);
  repository.upsertUser({
    uid: 7,
    username: originalPrincipal.username,
    displayName: originalPrincipal.displayName,
    roles: originalPrincipal.roles,
    stores: originalPrincipal.allowedStores,
    isMaster: originalPrincipal.isMaster,
    status: originalPrincipal.status,
    syncedAt: originalPrincipal.syncedAt,
  });
});

test('同一会话不能切换到另一个有效 API Key', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-session-'));
  const catalogFile = path.join(directory, 'endpoints.json');
  const changesFile = path.join(directory, 'changes.json');
  await writeFile(catalogFile, JSON.stringify(TEST_CATALOG), 'utf8');
  await writeFile(changesFile, JSON.stringify({ added: [], updated: [], removed: [] }), 'utf8');
  const database = openDatabase(path.join(directory, 'access.sqlite'));
  const repository = new AccessRepository(database);
  seedUser(repository);
  repository.upsertUser({
    uid: 8,
    username: 'bob',
    displayName: 'Bob',
    roles: ['销售专员'],
    stores: [{ sid: 999, name: 'B-US', seller_id: 'SELLER-B' }],
    isMaster: false,
    status: 'active',
  });
  const alice = repository.createApiKey({ uid: 7, label: 'alice' });
  const bob = repository.createApiKey({ uid: 8, label: 'bob' });
  const catalog = await EndpointCatalog.load(catalogFile);
  const app = createHttpApp({
    repository,
    catalog,
    changesFile,
    lingxingClient: { request: async () => ({ code: 0, data: [] }) },
  });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { 'X-Mcp-Key': alice.apiKey } },
  });
  const client = new Client({ name: 'alice', version: '1' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await app.locals.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Session-Id': transport.sessionId,
      'X-Mcp-Key': bob.apiKey,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });
  assert.equal(response.status, 403);
});

test('并发 initialize 会预留 per-key 会话槽位，不能绕过上限', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-session-limit-'));
  const catalogFile = path.join(directory, 'endpoints.json');
  const changesFile = path.join(directory, 'changes.json');
  await writeFile(catalogFile, JSON.stringify(TEST_CATALOG), 'utf8');
  await writeFile(changesFile, JSON.stringify({ added: [], updated: [], removed: [] }), 'utf8');
  const database = openDatabase(path.join(directory, 'access.sqlite'));
  const repository = new AccessRepository(database);
  seedUser(repository);
  const { apiKey } = repository.createApiKey({ uid: 7, label: 'parallel' });
  const catalog = await EndpointCatalog.load(catalogFile);
  const app = createHttpApp({
    repository,
    catalog,
    changesFile,
    lingxingClient: { request: async () => ({ code: 0, data: [] }) },
    maxSessionsPerKey: 1,
  });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await app.locals.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const initialize = () => fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'X-Mcp-Key': apiKey,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'parallel-test', version: '1' },
      },
    }),
  });
  const responses = await Promise.all([initialize(), initialize()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
});
