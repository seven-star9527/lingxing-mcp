#!/usr/bin/env node

import http from 'node:http';

import { ReloadableCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { AccessRepository, openDatabase } from './database.js';
import { createHttpApp } from './http-app.js';
import { LingxingClient } from './lingxing-client.js';
import { PrincipalSynchronizer } from './principal-sync.js';
import packageJson from '../package.json' with { type: 'json' };

async function main() {
  const config = loadConfig();
  const database = openDatabase(config.databaseFile);
  const repository = new AccessRepository(database, { keyPepper: config.keyPepper });
  const catalog = await ReloadableCatalog.load(config.catalogFile);
  const lingxingClient = new LingxingClient({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
    relayToken: config.relayToken,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  });
  const synchronizer = new PrincipalSynchronizer({
    repository,
    lingxingClient,
    ttlMs: config.permissionSyncTtlMs,
  });
  const app = createHttpApp({
    repository,
    catalog,
    changesFile: config.changesFile,
    lingxingClient,
    serverVersion: packageJson.version,
    allowedOrigins: config.allowedOrigins,
    sessionTtlMs: config.sessionTtlMs,
    maxSessions: config.maxSessions,
    maxSessionsPerKey: config.maxSessionsPerKey,
    watchChanges: true,
    principalResolver: (principal) => synchronizer.ensureFresh(principal),
  });
  const server = http.createServer(app);
  server.requestTimeout = config.requestTimeoutMs + 5000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  process.stdout.write(`${JSON.stringify({
    level: 'info',
    event: 'server_started',
    host: config.host,
    port: config.port,
    version: packageJson.version,
    catalog_version: catalog.version,
    endpoint_count: catalog.count,
  })}\n`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'server_stopping', signal })}\n`);
    const serverClosed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();
    await Promise.race([
      serverClosed,
      new Promise((resolve) => setTimeout(resolve, config.requestTimeoutMs + 1000)),
    ]);
    await app.locals.close();
    await serverClosed;
    database.close();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    level: 'error',
    event: 'startup_failed',
    message: error.message,
  })}\n`);
  process.exitCode = 1;
});
