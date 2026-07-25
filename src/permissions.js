const ACCESS_RANK = { read: 1, write: 2 };

export class AuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

function getAtPath(object, dottedPath) {
  const parts = dottedPath.split('.');
  let current = object;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function setAtPath(object, dottedPath, value) {
  const parts = dottedPath.split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function getNestedValues(object, nestedPath) {
  const parts = nestedPath.split('>>');
  let current = [object];
  for (const part of parts) {
    current = current.flatMap((value) => {
      if (!value || typeof value !== 'object') return [undefined];
      const next = value[part];
      if (Array.isArray(next)) return next.length > 0 ? next : [undefined];
      return [next];
    });
  }
  return current;
}

export function hasFunctionalGrant(endpoint, grants) {
  const requiredRank = ACCESS_RANK[endpoint.operation];
  return grants.some((grant) => (
    (grant.module === endpoint.module || grant.module === '*')
    && (!grant.endpointId || grant.endpointId === endpoint.id)
    && ACCESS_RANK[grant.access] >= requiredRank
  ));
}

function hasUnscopedGrant(endpoint, grants) {
  return grants.some((grant) => (
    grant.endpointId === endpoint.id
    && grant.allowUnscoped
    && ACCESS_RANK[grant.access] >= ACCESS_RANK[endpoint.operation]
  ));
}

function normalizedIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0);
}

function normalizedSellerIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

export function authorizeEndpoint({
  principal,
  endpoint,
  grants,
  query = {},
  body = {},
}) {
  if (!principal || !endpoint) throw new TypeError('principal 和 endpoint 为必填参数');
  if (!hasFunctionalGrant(endpoint, grants)) {
    throw new AuthorizationError(
      'FUNCTION_FORBIDDEN',
      `当前领星角色无权调用 ${endpoint.module} 模块的${endpoint.operation === 'write' ? '写' : '读'}接口`,
    );
  }
  if (endpoint.scope?.type === 'unscoped' && !principal.isMaster && !hasUnscopedGrant(endpoint, grants)) {
    throw new AuthorizationError(
      'UNSCOPED_FORBIDDEN',
      '该接口无法可靠按店铺收窄，仅主账号或拥有该端点显式 allow_unscoped 授权的角色可以调用',
    );
  }

  const safeQuery = structuredClone(query ?? {});
  const safeBody = structuredClone(body ?? {});
  if (endpoint.scope?.type !== 'store') return { query: safeQuery, body: safeBody };

  const allowed = new Set(principal.allowedSids.map(Number));
  const allowedSellerIds = new Set(
    principal.allowedStores.map((store) => String(store.seller_id)).filter(Boolean),
  );
  const fields = Array.isArray(endpoint.scope.fields) ? endpoint.scope.fields : [];
  if (allowed.size === 0) {
    throw new AuthorizationError(
      'NO_ALLOWED_STORES',
      '当前账号没有可验证的店铺权限，服务端不会以空店铺条件调用上游接口',
    );
  }
  if (fields.length === 0) {
    throw new AuthorizationError('STORE_SCOPE_UNKNOWN', '接口缺少可验证的店铺参数定义');
  }
  for (const field of fields) {
    const target = field.location === 'query' ? safeQuery : safeBody;
    const nested = field.nested || field.name.includes('>>');
    const nestedValues = nested ? getNestedValues(target, field.name) : null;
    const current = nested ? nestedValues : getAtPath(target, field.name);
    const usesSellerId = field.identity === 'seller_id';
    const allowedValues = usesSellerId ? allowedSellerIds : allowed;
    if (allowedValues.size === 0) {
      throw new AuthorizationError(
        'NO_ALLOWED_STORES',
        `当前账号没有可验证的 ${usesSellerId ? 'seller_id' : 'sid'} 店铺权限`,
      );
    }
    if (
      current === undefined
      || current === null
      || current === ''
      || (nested && (
        current.length === 0
        || current.some((value) => value === undefined || value === null || value === '')
      ))
    ) {
      if (nested) {
        throw new AuthorizationError(
          'STORE_REQUIRED',
          `必须在每个业务对象中显式提供店铺参数 ${field.name}`,
        );
      }
      if (field.collection) {
        setAtPath(
          target,
          field.name,
          usesSellerId
            ? [...allowedValues].sort()
            : [...allowedValues].sort((a, b) => a - b),
        );
        continue;
      }
      if (allowedValues.size === 1) {
        setAtPath(target, field.name, [...allowedValues][0]);
        continue;
      }
      throw new AuthorizationError(
        'STORE_REQUIRED',
        `必须显式提供店铺参数 ${field.name}；当前账号拥有多个店铺，服务端不会扩大查询范围`,
      );
    }
    const ids = usesSellerId ? normalizedSellerIds(current) : normalizedIds(current);
    if (ids.length === 0 || ids.some((sid) => !allowedValues.has(sid))) {
      throw new AuthorizationError('STORE_FORBIDDEN', `参数 ${field.name} 包含当前账号无权访问的店铺`);
    }
  }
  return { query: safeQuery, body: safeBody };
}

function filterRowsByStores(value, principal) {
  if (!Array.isArray(value)) return value;
  const allowedSids = new Set(principal.allowedSids.map(Number));
  const allowedSellerIds = new Set(
    principal.allowedStores.map((store) => String(store.seller_id)).filter(Boolean),
  );
  return value.filter((row) => {
    if (!row || typeof row !== 'object') return true;
    if ('sid' in row) return allowedSids.has(Number(row.sid));
    if ('seller_id' in row && allowedSellerIds.size > 0) {
      return allowedSellerIds.has(String(row.seller_id));
    }
    return true;
  });
}

export function filterEndpointResponse({ principal, endpoint, payload }) {
  const result = structuredClone(payload);
  if (!result || typeof result !== 'object') return result;
  if (endpoint.scope?.type === 'account_list') {
    result.data = Array.isArray(result.data)
      ? result.data.filter((row) => Number(row?.uid) === Number(principal.uid))
      : result.data;
    if (typeof result.total === 'number') result.total = result.data?.length ?? 0;
    return result;
  }
  if (endpoint.scope?.type === 'seller_list') {
    result.data = filterRowsByStores(result.data, principal);
    if (typeof result.total === 'number') result.total = result.data?.length ?? 0;
    return result;
  }
  if (endpoint.scope?.type === 'store' && Array.isArray(result.data)) {
    result.data = filterRowsByStores(result.data, principal);
  }
  return result;
}
