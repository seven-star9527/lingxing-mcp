import { readFile } from 'node:fs/promises';

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function scoreEndpoint(endpoint, query) {
  if (!query) return 0;
  const title = normalizeText(endpoint.title);
  const path = normalizeText(endpoint.path);
  const method = normalizeText(endpoint.method);
  if (path === query || `${method} ${path}` === query) return 100;
  if (title === query) return 90;
  let score = 0;
  if (title.startsWith(query)) score += 50;
  else if (title.includes(query)) score += 30;
  if (path.includes(query)) score += 25;
  if (method === query) score += 10;
  return score;
}

function validateCatalog(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('接口目录必须是 JSON 对象');
  }
  if (!Array.isArray(payload.endpoints)) throw new Error('接口目录缺少 endpoints 数组');
  if (!Number.isInteger(payload.endpoint_count) || payload.endpoint_count !== payload.endpoints.length) {
    throw new Error('接口目录 endpoint_count 与 endpoints.length 不一致');
  }
  const ids = new Set();
  for (const endpoint of payload.endpoints) {
    if (
      typeof endpoint?.id !== 'string'
      || typeof endpoint?.method !== 'string'
      || typeof endpoint?.path !== 'string'
      || typeof endpoint?.module !== 'string'
      || !['read', 'write'].includes(endpoint?.operation)
      || !endpoint.path.startsWith('/')
      || endpoint.id !== `${endpoint.method} ${endpoint.path}`
    ) {
      throw new Error(`接口目录包含无效端点：${endpoint?.id ?? 'unknown'}`);
    }
    if (ids.has(endpoint.id)) throw new Error(`接口目录存在重复端点：${endpoint.id}`);
    ids.add(endpoint.id);
  }
}

export class EndpointCatalog {
  constructor(payload) {
    validateCatalog(payload);
    this.payload = Object.freeze(payload);
    this.endpoints = Object.freeze([...payload.endpoints]);
    this.byId = new Map(this.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  }

  static async load(file) {
    const raw = await readFile(file, 'utf8');
    const payload = JSON.parse(raw);
    return new EndpointCatalog(payload);
  }

  get count() {
    return this.endpoints.length;
  }

  get version() {
    return this.payload.catalog_version;
  }

  get digest() {
    return this.payload.catalog_sha256 ?? '';
  }

  get(id) {
    return this.byId.get(String(id)) ?? null;
  }

  search({
    query = '',
    module = '',
    operation = '',
    limit = 20,
    filter = () => true,
  } = {}) {
    const normalizedQuery = normalizeText(query);
    const normalizedModule = normalizeText(module);
    const normalizedOperation = normalizeText(operation);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const matches = this.endpoints
      .map((endpoint) => ({ endpoint, score: scoreEndpoint(endpoint, normalizedQuery) }))
      .filter(({ endpoint, score }) => (
        (!normalizedQuery || score > 0)
        && (!normalizedModule || normalizeText(endpoint.module) === normalizedModule)
        && (!normalizedOperation || normalizeText(endpoint.operation) === normalizedOperation)
        && filter(endpoint)
      ))
      .sort((left, right) => (
        right.score - left.score
        || left.endpoint.module.localeCompare(right.endpoint.module)
        || left.endpoint.path.localeCompare(right.endpoint.path)
        || left.endpoint.method.localeCompare(right.endpoint.method)
      ));
    return {
      total: matches.length,
      returned: Math.min(matches.length, safeLimit),
      items: matches.slice(0, safeLimit).map(({ endpoint }) => endpoint),
    };
  }
}

export class ReloadableCatalog {
  constructor(file, catalog) {
    this.file = file;
    this.current = catalog;
  }

  static async load(file) {
    return new ReloadableCatalog(file, await EndpointCatalog.load(file));
  }

  async reload() {
    const next = await EndpointCatalog.load(this.file);
    if (next.version === this.current.version && next.digest === this.current.digest) return false;
    this.current = next;
    return true;
  }

  get count() {
    return this.current.count;
  }

  get version() {
    return this.current.version;
  }

  get digest() {
    return this.current.digest;
  }

  get(id) {
    return this.current.get(id);
  }

  search(options) {
    return this.current.search(options);
  }
}
