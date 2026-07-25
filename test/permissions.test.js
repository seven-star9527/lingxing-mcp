import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthorizationError, authorizeEndpoint, filterEndpointResponse } from '../src/permissions.js';
import { TEST_ENDPOINTS } from './fixtures.js';

const principal = {
  uid: 7,
  username: 'alice',
  roles: ['销售专员'],
  allowedSids: [101, 102],
  allowedStores: [
    { sid: 101, name: 'A-US', seller_id: 'SELLER-A' },
    { sid: 102, name: 'A-CA', seller_id: 'SELLER-A-CA' },
  ],
  isMaster: false,
};

const grants = [
  { roleName: '销售专员', module: 'basic', access: 'read', endpointId: null, allowUnscoped: false },
  { roleName: '销售专员', module: 'sales', access: 'read', endpointId: null, allowUnscoped: false },
];

test('店铺范围接口拒绝越权 sid，并为可安全收窄的数组参数注入允许店铺', () => {
  const scalar = TEST_ENDPOINTS[1];
  assert.throws(
    () => authorizeEndpoint({ principal, endpoint: scalar, grants, query: {}, body: { sid: 999 } }),
    (error) => error instanceof AuthorizationError && error.code === 'STORE_FORBIDDEN',
  );

  const array = TEST_ENDPOINTS[2];
  const authorized = authorizeEndpoint({ principal, endpoint: array, grants, query: {}, body: {} });
  assert.deepEqual(authorized.body.sids, [101, 102]);
});

test('多个允许店铺时，缺少标量 sid 必须拒绝而不是扩大查询范围', () => {
  assert.throws(
    () => authorizeEndpoint({
      principal,
      endpoint: TEST_ENDPOINTS[1],
      grants,
      query: {},
      body: {},
    }),
    (error) => error instanceof AuthorizationError && error.code === 'STORE_REQUIRED',
  );
});

test('没有允许店铺时拒绝调用，不向上游注入可能表示全量的空数组', () => {
  const noStorePrincipal = {
    ...principal,
    allowedSids: [],
    allowedStores: [],
  };
  assert.throws(
    () => authorizeEndpoint({
      principal: noStorePrincipal,
      endpoint: TEST_ENDPOINTS[2],
      grants,
      query: {},
      body: {},
    }),
    (error) => error instanceof AuthorizationError && error.code === 'NO_ALLOWED_STORES',
  );
});

test('seller_id 店铺选择器同样执行个人店铺权限校验', () => {
  const endpoint = {
    ...TEST_ENDPOINTS[1],
    id: 'POST /erp/sc/data/by-seller',
    path: '/erp/sc/data/by-seller',
    scope: {
      type: 'store',
      fields: [{
        name: 'seller_ids',
        location: 'body',
        collection: true,
        required: false,
        identity: 'seller_id',
      }],
    },
  };
  const scoped = authorizeEndpoint({
    principal,
    endpoint,
    grants,
    query: {},
    body: {},
  });
  assert.deepEqual(scoped.body.seller_ids, ['SELLER-A', 'SELLER-A-CA']);
  assert.throws(
    () => authorizeEndpoint({
      principal,
      endpoint,
      grants,
      query: {},
      body: { seller_ids: ['SELLER-B'] },
    }),
    (error) => error instanceof AuthorizationError && error.code === 'STORE_FORBIDDEN',
  );
  assert.throws(
    () => authorizeEndpoint({
      principal: {
        ...principal,
        allowedStores: principal.allowedStores.map((store) => ({ ...store, seller_id: '' })),
      },
      endpoint,
      grants,
      query: {},
      body: {},
    }),
    (error) => error instanceof AuthorizationError && error.code === 'NO_ALLOWED_STORES',
  );
});

test('嵌套对象数组中的 sid 逐项校验，缺失或越权均 fail closed', () => {
  const endpoint = {
    ...TEST_ENDPOINTS[1],
    id: 'POST /listing/updatePrincipal',
    path: '/listing/updatePrincipal',
    scope: {
      type: 'store',
      fields: [{
        name: 'sid_asin_list>>sid',
        location: 'body',
        collection: false,
        nested: true,
        required: true,
        identity: 'sid',
      }],
    },
  };
  assert.doesNotThrow(() => authorizeEndpoint({
    principal,
    endpoint,
    grants,
    query: {},
    body: { sid_asin_list: [{ sid: 101, asin: 'A' }, { sid: 102, asin: 'B' }] },
  }));
  assert.throws(
    () => authorizeEndpoint({
      principal,
      endpoint,
      grants,
      query: {},
      body: { sid_asin_list: [{ sid: 999, asin: 'A' }] },
    }),
    (error) => error instanceof AuthorizationError && error.code === 'STORE_FORBIDDEN',
  );
  assert.throws(
    () => authorizeEndpoint({
      principal,
      endpoint,
      grants,
      query: {},
      body: { sid_asin_list: [{ asin: 'A' }] },
    }),
    (error) => error instanceof AuthorizationError && error.code === 'STORE_REQUIRED',
  );
  assert.throws(
    () => authorizeEndpoint({
      principal,
      endpoint,
      grants,
      query: {},
      body: { sid_asin_list: [{ sid: 101, asin: 'A' }, { asin: 'B' }] },
    }),
    (error) => error instanceof AuthorizationError && error.code === 'STORE_REQUIRED',
  );
});

test('写接口默认拒绝，只有角色显式写授权后才允许', () => {
  const endpoint = TEST_ENDPOINTS[3];
  assert.throws(
    () => authorizeEndpoint({
      principal,
      endpoint,
      grants,
      query: {},
      body: { sid: 101 },
    }),
    (error) => error instanceof AuthorizationError && error.code === 'FUNCTION_FORBIDDEN',
  );

  const writeGrants = [
    ...grants,
    { roleName: '销售专员', module: 'warehouse', access: 'write', endpointId: null, allowUnscoped: false },
  ];
  const result = authorizeEndpoint({
    principal,
    endpoint,
    grants: writeGrants,
    query: {},
    body: { sid: 101 },
  });
  assert.equal(result.body.sid, 101);
});

test('无法按店铺收窄的敏感接口要求显式 endpoint grant 和 allow_unscoped', () => {
  const endpoint = TEST_ENDPOINTS[4];
  const financeGrant = {
    roleName: '销售专员',
    module: 'finance',
    access: 'read',
    endpointId: null,
    allowUnscoped: false,
  };
  assert.throws(
    () => authorizeEndpoint({
      principal,
      endpoint,
      grants: [...grants, financeGrant],
      query: {},
      body: {},
    }),
    (error) => error instanceof AuthorizationError && error.code === 'UNSCOPED_FORBIDDEN',
  );

  const exactGrant = {
    roleName: '销售专员',
    module: 'finance',
    access: 'read',
    endpointId: endpoint.id,
    allowUnscoped: true,
  };
  assert.doesNotThrow(() => authorizeEndpoint({
    principal,
    endpoint,
    grants: [...grants, exactGrant],
    query: {},
    body: {},
  }));
});

test('店铺列表和用户列表响应进行二次过滤', () => {
  const sellerResult = filterEndpointResponse({
    principal,
    endpoint: TEST_ENDPOINTS[0],
    payload: {
      code: 0,
      data: [
        { sid: 101, name: 'A-US' },
        { sid: 999, name: 'B-US' },
      ],
    },
  });
  assert.deepEqual(sellerResult.data, [{ sid: 101, name: 'A-US' }]);

  const accountEndpoint = {
    ...TEST_ENDPOINTS[0],
    id: 'GET /erp/sc/data/account/lists',
    path: '/erp/sc/data/account/lists',
    scope: { type: 'account_list', fields: [] },
  };
  const accountResult = filterEndpointResponse({
    principal,
    endpoint: accountEndpoint,
    payload: { code: 0, data: [{ uid: 7 }, { uid: 8 }] },
  });
  assert.deepEqual(accountResult.data, [{ uid: 7 }]);
});
