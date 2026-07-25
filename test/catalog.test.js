import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EndpointCatalog } from '../src/catalog.js';
import { TEST_CATALOG } from './fixtures.js';

test('接口目录稳定搜索、限制数量并按精确度排序', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'endpoints.json');
  await writeFile(file, JSON.stringify(TEST_CATALOG), 'utf8');

  const catalog = await EndpointCatalog.load(file);
  assert.equal(catalog.count, TEST_CATALOG.endpoint_count);
  assert.equal(catalog.get('POST /erp/sc/data/sales').module, 'sales');
  const result = catalog.search({ query: '销量', module: 'sales', operation: 'read', limit: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].path, '/erp/sc/data/sales');
});

test('损坏或端点数量不一致的目录拒绝启动', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'endpoints.json');
  await writeFile(file, JSON.stringify({ ...TEST_CATALOG, endpoint_count: 99 }), 'utf8');
  await assert.rejects(() => EndpointCatalog.load(file), /endpoint_count/);
});

test('权限过滤先于 limit 执行，不会被无权端点挤占结果窗口', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-catalog-filter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'endpoints.json');
  await writeFile(file, JSON.stringify(TEST_CATALOG), 'utf8');

  const catalog = await EndpointCatalog.load(file);
  const result = catalog.search({
    limit: 1,
    filter: (endpoint) => endpoint.module === 'warehouse',
  });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, 'POST /erp/sc/routing/storage/orderAdd');
});
