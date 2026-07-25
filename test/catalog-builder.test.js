import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEndpointRecord,
  classifyOperation,
  diffCatalogs,
  parseRequestParameters,
} from '../src/catalog-builder.js';

const SALES_DOC = `
# 查询店铺销量

## 接口信息

| API Path | 请求协议 | 请求方式 | 令牌桶容量 |
| :-- | :-- | :-- | :-- |
| \`/erp/sc/data/sales\` | HTTPS | POST | 1 |

## 请求参数

| 参数名 | 说明 | 必填 | 类型 | 示例 |
| :-- | :-- | :-- | :-- | :-- |
|sids|店铺id|否|[array]|[1]|
|start_date|开始日期|是|[string]|2026-01-01|

## 返回结果

| 参数名 | 说明 |
|data>>sid|店铺|
`;

test('解析请求参数时不混入返回字段，并识别店铺选择器', () => {
  const parameters = parseRequestParameters(SALES_DOC, 'POST');
  assert.deepEqual(parameters.map((item) => item.name), ['sids', 'start_date']);
  assert.equal(parameters[0].location, 'body');
  assert.equal(parameters[0].required, false);
  const endpoint = buildEndpointRecord({
    title: '查询店铺销量',
    method: 'POST',
    path: '/erp/sc/data/sales',
    rate_limit: '1',
    file: 'docs/Sales/StoreSales.md',
    source_url: 'https://apidoc.lingxing.com/docs/Sales/StoreSales.md',
  }, SALES_DOC);
  assert.equal(endpoint.operation, 'read');
  assert.equal(endpoint.scope.type, 'store');
  assert.equal(endpoint.scope.fields[0].name, 'sids');
});

test('保留嵌套店铺选择器，并识别加粗格式的返回结果边界', () => {
  const markdown = `
## 请求参数

| 参数名 | 说明 | 必填 | 类型 |
| :-- | :-- | :-- | :-- |
|sid_asin_list|店铺商品列表|是|array|
|sid_asin_list>>sid|店铺id|是|int|
|sid_asin_list>>asin|ASIN|是|string|

**返回结果**<br>

| 参数名 | 说明 | 类型 |
| :-- | :-- | :-- |
|code|响应码|int|
|data>>sid|响应店铺|int|
`;
  const endpoint = buildEndpointRecord({
    title: '更新负责人',
    method: 'POST',
    path: '/listing/updatePrincipal',
    file: 'docs/Product/UpdatePrincipal.md',
    source_url: 'https://apidoc.lingxing.com/docs/Product/UpdatePrincipal.md',
  }, markdown);

  assert.deepEqual(
    endpoint.request.parameters.map((parameter) => parameter.name),
    ['sid_asin_list', 'sid_asin_list>>sid', 'sid_asin_list>>asin'],
  );
  assert.equal(endpoint.scope.type, 'store');
  assert.deepEqual(endpoint.scope.fields[0], {
    name: 'sid_asin_list>>sid',
    location: 'body',
    collection: false,
    nested: true,
    required: true,
    identity: 'sid',
  });
});

test('副作用关键词识别为 write，无法确认的标题也默认 write', () => {
  assert.equal(classifyOperation('查询订单列表', '/orders/list'), 'read');
  assert.equal(classifyOperation('删除出库单', '/outbound/delete'), 'write');
  assert.equal(classifyOperation('神秘操作', '/mystery/run'), 'write');
});

test('目录差异按 METHOD + path 标识新增、修改和移除', () => {
  const previous = {
    catalog_version: 'v1',
    endpoints: [
      { id: 'GET /a', title: 'A', method: 'GET', path: '/a' },
      { id: 'GET /removed', title: 'R', method: 'GET', path: '/removed' },
    ],
  };
  const current = {
    catalog_version: 'v2',
    endpoints: [
      { id: 'GET /a', title: 'A2', method: 'GET', path: '/a' },
      { id: 'POST /new', title: 'N', method: 'POST', path: '/new' },
    ],
  };
  const changes = diffCatalogs(previous, current);
  assert.deepEqual(changes.added.map((item) => item.id), ['POST /new']);
  assert.deepEqual(changes.updated.map((item) => item.id), ['GET /a']);
  assert.deepEqual(changes.removed.map((item) => item.id), ['GET /removed']);
});
