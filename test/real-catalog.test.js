import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { EndpointCatalog } from '../src/catalog.js';

test('随版本发布的真实目录不低于首版基线，认证端点标记为 internal', async () => {
  const catalog = await EndpointCatalog.load(path.resolve('catalog/endpoints.json'));
  assert.ok(catalog.count >= 614);
  const tokenEndpoint = catalog.get('POST /api/auth-server/oauth/access-token');
  assert.equal(tokenEndpoint.internal, true);
  assert.equal(
    catalog.endpoints.filter((endpoint) => !endpoint.internal).length,
    catalog.count - catalog.endpoints.filter((endpoint) => endpoint.internal).length,
  );
});
