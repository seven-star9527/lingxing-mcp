export const TEST_ENDPOINTS = [
  {
    id: 'GET /erp/sc/data/seller/lists',
    title: '查询亚马逊店铺列表',
    method: 'GET',
    path: '/erp/sc/data/seller/lists',
    module: 'basic',
    operation: 'read',
    rate_limit: 1,
    file: 'docs/BasicData/SellerLists.md',
    source_url: 'https://apidoc.lingxing.com/docs/BasicData/SellerLists.md',
    request: { parameters: [] },
    scope: { type: 'seller_list', fields: [] },
  },
  {
    id: 'POST /erp/sc/data/sales',
    title: '查询店铺销量',
    method: 'POST',
    path: '/erp/sc/data/sales',
    module: 'sales',
    operation: 'read',
    rate_limit: 1,
    file: 'docs/Sales/StoreSales.md',
    source_url: 'https://apidoc.lingxing.com/docs/Sales/StoreSales.md',
    request: {
      parameters: [{ name: 'sid', location: 'body', required: true, type: 'integer' }],
    },
    scope: {
      type: 'store',
      fields: [{ name: 'sid', location: 'body', collection: false, required: true }],
    },
  },
  {
    id: 'POST /erp/sc/data/promotions',
    title: '查询促销列表',
    method: 'POST',
    path: '/erp/sc/data/promotions',
    module: 'sales',
    operation: 'read',
    rate_limit: 1,
    file: 'docs/Sales/Promotions.md',
    source_url: 'https://apidoc.lingxing.com/docs/Sales/Promotions.md',
    request: {
      parameters: [{ name: 'sids', location: 'body', required: false, type: 'array' }],
    },
    scope: {
      type: 'store',
      fields: [{ name: 'sids', location: 'body', collection: true, required: false }],
    },
  },
  {
    id: 'POST /erp/sc/routing/storage/orderAdd',
    title: '添加入库单',
    method: 'POST',
    path: '/erp/sc/routing/storage/orderAdd',
    module: 'warehouse',
    operation: 'write',
    rate_limit: 1,
    file: 'docs/Warehouse/OrderAdd.md',
    source_url: 'https://apidoc.lingxing.com/docs/Warehouse/OrderAdd.md',
    request: {
      parameters: [{ name: 'sid', location: 'body', required: true, type: 'integer' }],
    },
    scope: {
      type: 'store',
      fields: [{ name: 'sid', location: 'body', collection: false, required: true }],
    },
  },
  {
    id: 'POST /erp/sc/data/all-profit',
    title: '查询全企业利润',
    method: 'POST',
    path: '/erp/sc/data/all-profit',
    module: 'finance',
    operation: 'read',
    rate_limit: 1,
    file: 'docs/Finance/AllProfit.md',
    source_url: 'https://apidoc.lingxing.com/docs/Finance/AllProfit.md',
    request: { parameters: [] },
    scope: { type: 'unscoped', fields: [] },
  },
];

export const TEST_CATALOG = {
  schema_version: 1,
  catalog_version: '2026-07-25T00:00:00.000Z',
  endpoint_count: TEST_ENDPOINTS.length,
  endpoints: TEST_ENDPOINTS,
};

export function seedUser(repository, overrides = {}) {
  repository.upsertUser({
    uid: 7,
    username: 'alice',
    displayName: 'Alice',
    roles: ['销售专员'],
    stores: [
      { sid: 101, name: 'A-US', seller_id: 'SELLER-A' },
      { sid: 102, name: 'A-CA', seller_id: 'SELLER-A-CA' },
    ],
    isMaster: false,
    status: 'active',
    ...overrides,
  });
}
