import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LingxingClient,
  buildCanonicalParameters,
  generateSign,
} from '../src/lingxing-client.js';

test('签名规范化稳定处理对象、数组、布尔值和空字符串', () => {
  const canonical = buildCanonicalParameters({
    z: '',
    b: [2, 1],
    a: { z: 2, a: 1 },
    enabled: true,
  });
  assert.equal(canonical, 'a={"a":1,"z":2}&b=[2,1]&enabled=true');
  const sign = generateSign({ a: 1 }, '1234567890abcdef');
  assert.match(sign, /^[A-Za-z0-9+/]+=*$/);
});

test('access token not match 时只清理缓存、重新认证并重试一次', async () => {
  const calls = [];
  let tokenNumber = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/oauth/access-token')) {
      tokenNumber += 1;
      return Response.json({
        code: 0,
        data: {
          access_token: `token-${tokenNumber}`,
          refresh_token: `refresh-${tokenNumber}`,
          expires_in: 7200,
        },
      });
    }
    const requestUrl = new URL(url);
    if (requestUrl.searchParams.get('access_token') === 'token-1') {
      return Response.json({ code: 3001008, message: 'access token not match' });
    }
    return Response.json({ code: 0, data: [{ sid: 101 }] });
  };

  const client = new LingxingClient({
    appId: '1234567890abcdef',
    appSecret: 'secret',
    baseUrl: 'https://openapi.example.test',
    fetchImpl,
  });
  const result = await client.request({
    method: 'GET',
    path: '/erp/sc/data/seller/lists',
    query: {},
    body: {},
  });

  assert.equal(result.code, 0);
  assert.equal(tokenNumber, 2);
  assert.equal(calls.filter((call) => call.url.includes('/seller/lists')).length, 2);
});

test('用户不能覆盖公共鉴权参数或调用目录外 URL', async () => {
  const client = new LingxingClient({
    appId: '1234567890abcdef',
    appSecret: 'secret',
    baseUrl: 'https://openapi.example.test',
    fetchImpl: async () => Response.json({ code: 0, data: {} }),
  });
  await assert.rejects(
    () => client.request({
      method: 'GET',
      path: 'https://evil.example.test',
      query: {},
      body: {},
    }),
    /path/,
  );
  await assert.rejects(
    () => client.request({
      method: 'GET',
      path: '/safe',
      query: { access_token: 'attacker' },
      body: {},
    }),
    /保留参数/,
  );
});
