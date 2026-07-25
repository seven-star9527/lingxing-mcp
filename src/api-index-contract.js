const HTTP_METHOD_PATTERN = /^[A-Z]+$/;
const API_PATH_PATTERN = /^\/\S+$/;
const RATE_LIMIT_PATTERN = /^[1-9]\d*$/;
const ALLOWED_PROTOCOLS = new Set(['HTTP', 'HTTPS']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAllowedDocumentFile(value) {
  if (!isNonEmptyString(value) || value.includes('\\')) return false;
  const segments = value.split('/');
  return (segments[0] === 'docs' || segments[0] === 'map')
    && segments.length >= 2
    && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    && segments.at(-1).endsWith('.md');
}

function isHttpUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.length > 0
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function isValidEndpoint(value) {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.title)
    && typeof value.method === 'string'
    && HTTP_METHOD_PATTERN.test(value.method)
    && typeof value.path === 'string'
    && API_PATH_PATTERN.test(value.path)
    && typeof value.protocol === 'string'
    && ALLOWED_PROTOCOLS.has(value.protocol)
    && typeof value.rate_limit === 'string'
    && RATE_LIMIT_PATTERN.test(value.rate_limit)
    && isAllowedDocumentFile(value.file)
    && isHttpUrl(value.source_url);
}

export function isValidApiIndex(value) {
  return isRecord(value)
    && Number.isInteger(value.total)
    && value.total >= 0
    && Array.isArray(value.endpoints)
    && value.total === value.endpoints.length
    && value.endpoints.every(isValidEndpoint);
}
