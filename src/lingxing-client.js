import {
  createCipheriv,
  createHash,
} from 'node:crypto';

const SUCCESS_CODES = new Set([0, '0', 1, '1', 200, '200']);
const RESERVED_PARAMETERS = new Set(['access_token', 'app_key', 'timestamp', 'sign']);

export class LingxingApiError extends Error {
  constructor(message, { code = null, path = null, retryable = false } = {}) {
    super(message);
    this.name = 'LingxingApiError';
    this.code = code;
    this.path = path;
    this.retryable = retryable;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const pairs = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

function signValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value && typeof value === 'object') return stableJson(value);
  return String(value);
}

export function buildCanonicalParameters(parameters) {
  return Object.keys(parameters)
    .sort()
    .map((key) => [key, signValue(parameters[key])])
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export function generateSign(parameters, appId) {
  const key = Buffer.from(String(appId), 'utf8');
  if (![16, 24, 32].includes(key.length)) {
    throw new TypeError('LINGXING_APP_ID 必须是 16、24 或 32 字节，才能作为 AES 密钥');
  }
  const md5 = createHash('md5')
    .update(buildCanonicalParameters(parameters), 'utf8')
    .digest('hex')
    .toUpperCase();
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(md5, 'utf8'), cipher.final()]).toString('base64');
}

function assertSafePath(pathname) {
  if (
    typeof pathname !== 'string'
    || !pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('?')
    || pathname.includes('#')
    || /[\u0000-\u001f\\]/.test(pathname)
  ) {
    throw new TypeError('path 必须是目录中以 / 开头的相对 API Path');
  }
}

function assertNoReservedParameters(query, body) {
  for (const source of [query, body]) {
    for (const key of Object.keys(source ?? {})) {
      if (RESERVED_PARAMETERS.has(key)) {
        throw new TypeError(`${key} 是服务端保留参数，调用方不能覆盖`);
      }
    }
  }
}

async function parseResponse(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new LingxingApiError(`上游响应超过 ${maxBytes} 字节限制`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new LingxingApiError(`上游响应超过 ${maxBytes} 字节限制`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('json') || buffer[0] === 0x7b || buffer[0] === 0x5b) {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new LingxingApiError('领星响应不是合法 JSON');
    }
  }
  return {
    code: 0,
    data: {
      binary: true,
      content_type: contentType || 'application/octet-stream',
      size: buffer.length,
      base64: buffer.toString('base64'),
    },
  };
}

export class LingxingClient {
  constructor({
    appId,
    appSecret,
    baseUrl = 'https://openapi.lingxing.com',
    relayToken = '',
    timeoutMs = 30_000,
    maxResponseBytes = 5 * 1024 * 1024,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  }) {
    if (!appId || !appSecret) throw new TypeError('appId 和 appSecret 为必填配置');
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    if (this.baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(this.baseUrl.hostname)) {
      throw new TypeError('LINGXING_BASE_URL 必须使用 HTTPS；仅本机测试允许 HTTP');
    }
    this.relayToken = relayToken;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.token = null;
    this.tokenPromise = null;
  }

  commonHeaders() {
    return this.relayToken ? { 'X-Relay-Token': this.relayToken } : {};
  }

  async fetchToken() {
    const url = new URL('api/auth-server/oauth/access-token', this.baseUrl);
    const form = new FormData();
    form.set('appId', this.appId);
    form.set('appSecret', this.appSecret);
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.commonHeaders(),
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new LingxingApiError(`领星认证 HTTP ${response.status}`, { path: url.pathname });
    const payload = await parseResponse(response, this.maxResponseBytes);
    if (!SUCCESS_CODES.has(payload.code)) {
      throw new LingxingApiError(
        String(payload.message ?? payload.msg ?? '领星认证失败'),
        { code: payload.code, path: url.pathname },
      );
    }
    const data = payload.data ?? {};
    if (!data.access_token) throw new LingxingApiError('领星认证响应缺少 access_token');
    const expiresIn = Math.max(60, Number(data.expires_in) || 7200);
    this.token = {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token ?? ''),
      expiresAt: this.now() + Math.max(60, expiresIn - 120) * 1000,
    };
    return this.token;
  }

  async ensureToken() {
    if (this.token?.accessToken && this.token.expiresAt > this.now() + 60_000) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    return this.tokenPromise;
  }

  invalidateToken() {
    this.token = null;
  }

  async request({ method, path, query = {}, body = {} }, retry = true) {
    assertSafePath(path);
    assertNoReservedParameters(query, body);
    const normalizedMethod = String(method).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) {
      throw new TypeError(`不支持的 HTTP Method：${normalizedMethod}`);
    }
    const token = await this.ensureToken();
    const timestamp = String(Math.floor(this.now() / 1000));
    const businessQuery = structuredClone(query ?? {});
    const businessBody = structuredClone(body ?? {});
    const signParameters = {
      ...businessBody,
      ...businessQuery,
      access_token: token.accessToken,
      app_key: this.appId,
      timestamp,
    };
    const publicQuery = {
      access_token: token.accessToken,
      app_key: this.appId,
      timestamp,
      sign: generateSign(signParameters, this.appId),
    };
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    for (const [key, value] of Object.entries({ ...businessQuery, ...publicQuery })) {
      url.searchParams.set(key, signValue(value));
    }
    const hasBody = normalizedMethod !== 'GET' && normalizedMethod !== 'DELETE';
    const response = await this.fetchImpl(url, {
      method: normalizedMethod,
      headers: {
        ...this.commonHeaders(),
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? stableJson(businessBody) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new LingxingApiError(`领星接口 HTTP ${response.status}`, {
        code: response.status,
        path,
        retryable: response.status >= 500,
      });
    }
    const payload = await parseResponse(response, this.maxResponseBytes);
    const message = String(payload?.message ?? payload?.msg ?? '');
    const tokenMismatch = String(payload?.code) === '3001008'
      || /access\s*token\s*not\s*match/i.test(message);
    if (tokenMismatch && retry) {
      this.invalidateToken();
      return this.request({ method: normalizedMethod, path, query, body }, false);
    }
    if (!SUCCESS_CODES.has(payload?.code)) {
      throw new LingxingApiError(message || '领星接口调用失败', {
        code: payload?.code,
        path,
      });
    }
    return payload;
  }
}
