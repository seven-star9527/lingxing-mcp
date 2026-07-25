import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name, environment) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function positiveInteger(value, fallback, name) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} 必须是正整数`);
  return number;
}

export function loadConfig(environment = process.env, { requireCredentials = true } = {}) {
  const dataDir = path.resolve(environment.LINGXING_MCP_DATA_DIR || path.join(projectRoot, 'data'));
  const appId = requireCredentials ? required('LINGXING_APP_ID', environment) : String(environment.LINGXING_APP_ID ?? '');
  const appSecret = requireCredentials
    ? required('LINGXING_APP_SECRET', environment)
    : String(environment.LINGXING_APP_SECRET ?? '');
  const keyPepper = required('LINGXING_MCP_KEY_PEPPER', environment);
  if (keyPepper.length < 32) throw new Error('LINGXING_MCP_KEY_PEPPER 至少需要 32 个字符');
  return {
    projectRoot,
    host: environment.LINGXING_MCP_HOST || '127.0.0.1',
    port: positiveInteger(environment.LINGXING_MCP_PORT, 8099, 'LINGXING_MCP_PORT'),
    dataDir,
    databaseFile: path.resolve(environment.LINGXING_MCP_DB_PATH || path.join(dataDir, 'access.sqlite')),
    catalogFile: path.resolve(
      environment.LINGXING_CATALOG_FILE || path.join(projectRoot, 'catalog', 'endpoints.json'),
    ),
    changesFile: path.resolve(
      environment.LINGXING_CHANGES_FILE || path.join(projectRoot, 'catalog', 'changes.json'),
    ),
    allowedOrigins: String(environment.LINGXING_MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    sessionTtlMs: positiveInteger(
      environment.LINGXING_MCP_SESSION_TTL_SECONDS,
      1800,
      'LINGXING_MCP_SESSION_TTL_SECONDS',
    ) * 1000,
    maxSessions: positiveInteger(
      environment.LINGXING_MCP_MAX_SESSIONS,
      500,
      'LINGXING_MCP_MAX_SESSIONS',
    ),
    maxSessionsPerKey: positiveInteger(
      environment.LINGXING_MCP_MAX_SESSIONS_PER_KEY,
      5,
      'LINGXING_MCP_MAX_SESSIONS_PER_KEY',
    ),
    permissionSyncTtlMs: positiveInteger(
      environment.LINGXING_PERMISSION_SYNC_TTL_SECONDS,
      300,
      'LINGXING_PERMISSION_SYNC_TTL_SECONDS',
    ) * 1000,
    appId,
    appSecret,
    keyPepper,
    baseUrl: environment.LINGXING_BASE_URL || 'https://openapi.lingxing.com',
    relayToken: environment.LINGXING_RELAY_TOKEN || '',
    requestTimeoutMs: positiveInteger(
      environment.LINGXING_REQUEST_TIMEOUT_MS,
      30_000,
      'LINGXING_REQUEST_TIMEOUT_MS',
    ),
    maxResponseBytes: positiveInteger(
      environment.LINGXING_MAX_RESPONSE_BYTES,
      5 * 1024 * 1024,
      'LINGXING_MAX_RESPONSE_BYTES',
    ),
  };
}
