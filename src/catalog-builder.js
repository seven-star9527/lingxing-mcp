import { createHash } from 'node:crypto';

const WRITE_WORDS = [
  '新增', '添加', '创建', '修改', '编辑', '删除', '作废', '取消', '确认',
  '提交', '更新', '设置', '启用', '禁用', '上传', '分配', '释放', '发货',
  '收货', '入库', '出库', '撤销', '同步', '重算', '绑定', '解绑', '锁定',
  '解锁', '保存', '调整', '续约', '生成', '标记', '执行', '导入', '刊登',
  '下单', '审核', '驳回', '归档', '重置', '开启', '关闭', '替换',
];
const READ_PREFIXES = ['查询', '获取', '下载', '查看', '检索', '校验', '预览', '统计'];
const INTERNAL_PATH_PREFIXES = ['/api/auth-server/oauth/'];

const MODULE_MAP = Object.freeze({
  Authorization: 'authorization',
  BasicData: 'basic',
  FBA: 'fba',
  FBASug: 'replenishment',
  Finance: 'finance',
  MultiPlatform: 'multiplatform',
  NewAd: 'advertising',
  newAd: 'advertising',
  Product: 'product',
  Purchase: 'purchase',
  Sale: 'sales',
  Sales: 'sales',
  SourceData: 'source-data',
  Statistics: 'statistics',
  VC: 'vc',
  Warehouse: 'warehouse',
});

function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s*[`*]+|[`*]+\s*$/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

function parseRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map(stripMarkdown);
}

function normalizeType(value) {
  const normalized = stripMarkdown(value).replace(/[\[\]]/g, '').toLowerCase();
  if (/array|list|数组|集合/.test(normalized)) return 'array';
  if (/int|number|long|float|double|decimal|数字|整数/.test(normalized)) return 'number';
  if (/bool/.test(normalized)) return 'boolean';
  if (/object|map|json/.test(normalized)) return 'object';
  return 'string';
}

export function classifyOperation(title, path) {
  const text = `${title ?? ''} ${path ?? ''}`;
  if (WRITE_WORDS.some((word) => text.includes(word))) return 'write';
  if (READ_PREFIXES.some((prefix) => String(title ?? '').trim().startsWith(prefix))) return 'read';
  return 'write';
}

export function parseRequestParameters(markdown, method) {
  const beforeResponse = String(markdown).split(
    /^(?:#{1,6}\s*)?(?:\*{1,2})?(?:返回|响应)(?:结果|参数|数据)?(?:\*{1,2})?(?:<br\s*\/?>)?\s*$/mi,
    1,
  )[0];
  const lines = beforeResponse.split(/\r?\n/);
  let header = null;
  let inTable = false;
  const parameters = [];
  for (const line of lines) {
    const cells = parseRow(line);
    if (!cells) {
      if (inTable && parameters.length > 0) break;
      continue;
    }
    if (cells.some((cell) => /参数名|字段名/.test(cell))) {
      header = cells;
      inTable = true;
      continue;
    }
    if (!inTable || !header || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const nameIndex = header.findIndex((cell) => /参数名|字段名/.test(cell));
    const descriptionIndex = header.findIndex((cell) => /说明|描述/.test(cell));
    const requiredIndex = header.findIndex((cell) => /必填|是否必/.test(cell));
    const typeIndex = header.findIndex((cell) => /类型/.test(cell));
    const name = stripMarkdown(cells[nameIndex]);
    if (!name || /\s/.test(name)) continue;
    parameters.push({
      name,
      description: descriptionIndex >= 0 ? stripMarkdown(cells[descriptionIndex]) : '',
      required: requiredIndex >= 0 && /^是|yes|required$/i.test(stripMarkdown(cells[requiredIndex])),
      type: typeIndex >= 0 ? normalizeType(cells[typeIndex]) : 'string',
      location: String(method).toUpperCase() === 'GET' ? 'query' : 'body',
    });
  }
  return parameters;
}

function moduleFromFile(file) {
  const segment = String(file).replaceAll('\\', '/').split('/')[1] ?? 'Other';
  return MODULE_MAP[segment] ?? segment.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function storeField(parameter) {
  const name = parameter.name;
  const leafName = name.split('>>').at(-1);
  const description = parameter.description;
  if (/^(?:sid|sids|sid_list|sidlist|shop_id|shop_ids)$/i.test(leafName)) {
    return {
      name,
      location: parameter.location,
      collection: parameter.type === 'array' || /s$|list/i.test(leafName),
      nested: name.includes('>>'),
      required: parameter.required,
      identity: 'sid',
    };
  }
  if (
    /^(?:seller_id|seller_ids|seller_id_list)$/i.test(leafName)
    && /店铺|卖家|seller/i.test(description)
  ) {
    return {
      name,
      location: parameter.location,
      collection: parameter.type === 'array' || /s$|list/i.test(leafName),
      nested: name.includes('>>'),
      required: parameter.required,
      identity: 'seller_id',
    };
  }
  return null;
}

function scopeForEndpoint(endpoint, parameters) {
  if (endpoint.path === '/erp/sc/data/account/lists') return { type: 'account_list', fields: [] };
  if (endpoint.path === '/erp/sc/data/seller/lists') return { type: 'seller_list', fields: [] };
  const fields = parameters.map(storeField).filter(Boolean);
  if (fields.length > 0) return { type: 'store', fields };
  if (
    endpoint.path === '/erp/sc/data/seller/allMarketplace'
    || endpoint.path === '/erp/sc/data/worldState/lists'
  ) {
    return { type: 'global', fields: [] };
  }
  return { type: 'unscoped', fields: [] };
}

function normalizeRateLimit(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function buildEndpointRecord(endpoint, markdown) {
  const method = String(endpoint.method).toUpperCase();
  const path = String(endpoint.path);
  const parameters = parseRequestParameters(markdown, method);
  const record = {
    id: `${method} ${path}`,
    title: String(endpoint.title ?? '').trim(),
    method,
    path,
    module: moduleFromFile(endpoint.file),
    operation: classifyOperation(endpoint.title, path),
    rate_limit: normalizeRateLimit(endpoint.rate_limit),
    file: String(endpoint.file),
    source_url: String(endpoint.source_url),
    request: { parameters },
    scope: null,
    internal: INTERNAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
  };
  record.scope = scopeForEndpoint(record, parameters);
  return record;
}

function endpointDigest(endpoint) {
  return createHash('sha256').update(JSON.stringify(endpoint)).digest('hex');
}

function compactChange(endpoint) {
  return {
    id: endpoint.id,
    title: endpoint.title,
    method: endpoint.method,
    path: endpoint.path,
    module: endpoint.module,
    operation: endpoint.operation,
    scope: endpoint.scope,
    rate_limit: endpoint.rate_limit,
    source_url: endpoint.source_url,
    internal: Boolean(endpoint.internal),
  };
}

export function diffCatalogs(previous, current) {
  const previousMap = new Map((previous?.endpoints ?? []).map((item) => [item.id, item]));
  const currentMap = new Map((current?.endpoints ?? []).map((item) => [item.id, item]));
  const added = [];
  const updated = [];
  const removed = [];
  for (const endpoint of currentMap.values()) {
    const old = previousMap.get(endpoint.id);
    if (!old) added.push(compactChange(endpoint));
    else if (endpointDigest(old) !== endpointDigest(endpoint)) updated.push(compactChange(endpoint));
  }
  for (const endpoint of previousMap.values()) {
    if (!currentMap.has(endpoint.id)) removed.push(compactChange(endpoint));
  }
  const sort = (left, right) => left.id.localeCompare(right.id);
  return {
    schema_version: 1,
    previous_version: previous?.catalog_version ?? null,
    current_version: current.catalog_version,
    generated_at: new Date().toISOString(),
    added: added.sort(sort),
    updated: updated.sort(sort),
    removed: removed.sort(sort),
  };
}
