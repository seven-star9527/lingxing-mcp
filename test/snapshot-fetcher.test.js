import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  extractRoutes,
  fetchSnapshot,
  parseEndpoint,
  replaceSnapshot,
  cleanupStagedSnapshots,
} from '../src/snapshot-fetcher.js';
import { createSnapshotTestConfig as createConfig } from './snapshot-test-config.js';

test('route parser normalizes docs links and removes duplicate, query, and hash variants', () => {
  const sidebar = [
    '[查询](docs/Product/List)',
    '[重复](docs/Product/List.md#request)',
    '[带查询](docs/Product/List?locale=zh-CN)',
    '[另一个](docs/Product/Detail.md)',
  ].join('\n');

  assert.deepEqual(extractRoutes(sidebar, 'docs'), [
    { route: 'docs/Product/List', file: 'docs/Product/List.md' },
    { route: 'docs/Product/Detail', file: 'docs/Product/Detail.md' },
  ]);
});

test('route parser accepts map navigation and rejects broken or out-of-scope links', () => {
  const sidebar = [
    '[地图](map/Order/Overview.md#top)',
    '[外部](https://example.com/map/External)',
    '[绝对](/map/Absolute)',
    '[上级](../map/Parent)',
    '[错类](docs/Product/List)',
    '[脚本](javascript:alert(1))',
    '[损坏](map/%E0%A4%A)',
    '[空]()',
  ].join('\n');

  assert.deepEqual(extractRoutes(sidebar, 'map'), [
    { route: 'map/Order/Overview', file: 'map/Order/Overview.md' },
  ]);
});

test('route parser rejects repeatedly encoded traversal and decoded unsafe file characters', () => {
  const sidebar = [
    '[双重上级](docs/%252e%252e/secret)',
    '[解码查询](docs/Product/List%253Fadmin=true)',
    '[解码锚点](docs/Product/List%2523private)',
    '[反斜杠穿越](docs\\..\\secret)',
    '[编码反斜杠](docs/Product%255cList)',
    '[Windows 冒号](docs/Product/List%253Aprivate)',
    '[Windows 星号](docs/Product/List%252Aprivate)',
    '[Windows 竖线](docs/Product/List%257Cprivate)',
  ].join('\n');

  assert.deepEqual(extractRoutes(sidebar, 'docs'), []);
});

test('route parser normalizes official leading slash, Windows separators, and hash routes', () => {
  const docsSidebar = [
    '[下载定制化附件](/docs/BasicData/CustomAttachmentDownload)',
    '[Temu修改库存](docs\\MultiPlatform\\V2\\CreatePublishQueue)',
    '<a href="#docs/MultiPlatform/V2/SheinCreatePublishQueue.md">Shein修改库存</a>',
  ].join('\n');
  const mapSidebar = '<a href="#map/sales/target_manage.md">目标管理</a>';

  assert.deepEqual(extractRoutes(docsSidebar, 'docs'), [
    {
      route: 'docs/BasicData/CustomAttachmentDownload',
      file: 'docs/BasicData/CustomAttachmentDownload.md',
    },
    {
      route: 'docs/MultiPlatform/V2/CreatePublishQueue',
      file: 'docs/MultiPlatform/V2/CreatePublishQueue.md',
    },
    {
      route: 'docs/MultiPlatform/V2/SheinCreatePublishQueue',
      file: 'docs/MultiPlatform/V2/SheinCreatePublishQueue.md',
    },
  ]);
  assert.deepEqual(extractRoutes(mapSidebar, 'map'), [
    { route: 'map/sales/target_manage', file: 'map/sales/target_manage.md' },
  ]);
});

test('official route normalization still rejects protocols, repeated leading slash, and traversal', () => {
  const docsSidebar = [
    '[外部](https://example.test/docs/Product/List)',
    '[协议相对](//docs/Product/List)',
    '[反斜杠穿越](docs\\..\\secret)',
    '<a href="#docs/%252e%252e/secret">编码穿越</a>',
  ].join('\n');

  assert.deepEqual(extractRoutes(docsSidebar, 'docs'), []);
});

test('route parser accepts official hash-route HTML anchors while retaining route safety checks', () => {
  const sidebar = [
    '<a href="#/map/Order/Overview">订单地图</a>',
    '<a href="#/map/Order/Overview.md#node">重复地图</a>',
    '<a href="#/map/%252e%252e/secret">越界</a>',
    '<a href="https://example.test/map/External">外部</a>',
    '<a href="#/docs/Product/List">错误分类</a>',
  ].join('\n');

  assert.deepEqual(extractRoutes(sidebar, 'map'), [
    { route: 'map/Order/Overview', file: 'map/Order/Overview.md' },
  ]);
});

test('endpoint parser reads the real API information table', () => {
  const markdown = `# 查询账号列表

| API Path | 请求协议 | 请求方式 | 令牌桶容量 |
| :-- | :-- | :-- | :-- |
| \`/erp/sc/data/account/lists\` | HTTPS | GET | 1 |
`;

  assert.deepEqual(parseEndpoint(markdown), {
    path: '/erp/sc/data/account/lists',
    protocol: 'HTTPS',
    method: 'GET',
    rate_limit: '1',
  });
});

test('endpoint parser normalizes complete Markdown links in API table headers', () => {
  const markdown = `# 查询账号列表

| API Path | 请求协议 | 请求方式 | [令牌桶容量](https://apidoc.lingxing.com/reference/rate-limit) |
| :-- | :-- | :-- | :-- |
| \`/erp/sc/data/account/lists\` | HTTPS | GET | 1 |
`;

  assert.deepEqual(parseEndpoint(markdown), {
    path: '/erp/sc/data/account/lists',
    protocol: 'HTTPS',
    method: 'GET',
    rate_limit: '1',
  });
});

test('endpoint parser normalizes official POST ss and safe API paths without a leading slash', () => {
  const malformedMethod = `# 分页查询店铺报告列表

| API Path | 请求协议 | 请求方式 | 令牌桶容量 |
| :-- | :-- | :-- | :-- |
| \`/basicOpen/multiplatform/ads/shopee/store/report/list\` | HTTPS | POST ss | 1 |
`;
  const missingLeadingSlash = `# 调整sp关键词

| API Path | 请求协议 | 请求方式 | 令牌桶容量 |
| :-- | :-- | :-- | :-- |
| \`basicOpen/adReport/manage/putSpKeyword\` | HTTPS | POST | 1 |
`;

  assert.deepEqual(parseEndpoint(malformedMethod), {
    path: '/basicOpen/multiplatform/ads/shopee/store/report/list',
    protocol: 'HTTPS',
    method: 'POST',
    rate_limit: '1',
  });
  assert.deepEqual(parseEndpoint(missingLeadingSlash), {
    path: '/basicOpen/adReport/manage/putSpKeyword',
    protocol: 'HTTPS',
    method: 'POST',
    rate_limit: '1',
  });
});

test('endpoint parser rejects empty, external-style, traversal, and unsafe API paths', () => {
  const unsafePaths = [
    '',
    'https://example.test/basicOpen/report',
    '//example.test/basicOpen/report',
    '../basicOpen/report',
    'basicOpen/../secret',
    'basicOpen\\report',
  ];

  for (const unsafePath of unsafePaths) {
    const markdown = `# 不安全接口

| API Path | 请求协议 | 请求方式 | 令牌桶容量 |
| :-- | :-- | :-- | :-- |
| \`${unsafePath}\` | HTTPS | POST | 1 |
`;
    assert.equal(parseEndpoint(markdown), null, unsafePath || '空路径');
  }
});

test('endpoint parser rejects unconfirmed ss suffixes for methods other than POST', () => {
  for (const unsafeMethod of ['GET ss', 'DELETE ss']) {
    const markdown = `# 未确认方法异常

| API Path | 请求协议 | 请求方式 | 令牌桶容量 |
| :-- | :-- | :-- | :-- |
| \`/basicOpen/report/list\` | HTTPS | ${unsafeMethod} | 1 |
`;
    assert.equal(parseEndpoint(markdown), null, unsafeMethod);
  }
});

test('endpoint parser ignores unrelated tables and returns null for incomplete API data', () => {
  const markdown = `# 示例

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | string | 是 | 编号 |

| API Path | 请求协议 | 请求方式 | 令牌桶容量 |
| --- | --- | --- | --- |
| /only/path | HTTPS | | 1 |
`;

  assert.equal(parseEndpoint(markdown), null);
});

const endpointMarkdown = `# 查询账号列表

| API Path | 请求协议 | 请求方式 | 令牌桶容量 |
| :-- | :-- | :-- | :-- |
| \`/erp/sc/data/account/lists\` | HTTPS | GET | 1 |
`;

async function startMockSite(options = {}) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    calls.push({ method: request.method, url: request.url, body, headers: request.headers });

    const send = (status, value, contentType = 'text/markdown; charset=utf-8') => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(value);
    };

    if (request.url === '/') return send(200, '# mock');
    if (request.url === '/api/openapi-manage/account/check/doc_access') {
      if (options.rejectAuth) {
        return send(401, `invalid secret: ${JSON.parse(body).docAccess}`, 'application/json');
      }
      return send(
        options.authStatus ?? 200,
        options.authBody ?? JSON.stringify({
          code: '1',
          data: { can_access: options.canAccessToken ?? 'scoped-cookie-token' },
        }),
        'application/json',
      );
    }
    if (request.url === '/_sidebar.md') {
      return send(
        options.docsSidebarStatus ?? 200,
        options.docsSidebar ?? '[账号列表](docs/Account/List)',
      );
    }
    if (request.url === '/_sidebar_map.md') {
      return send(200, options.mapSidebar ?? '[账号地图](map/Account/Overview.md#top)');
    }
    if (request.url === '/docs/Account/List.md') {
      return send(options.docsPageStatus ?? 200, options.docsPageBody ?? endpointMarkdown);
    }
    if (request.url === '/map/Account/Overview.md') {
      return send(
        options.mapPageStatus ?? 200,
        options.mapPageBody ?? '# 账号地图\n\n地图正文',
      );
    }
    return send(404, 'not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    sourceUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

async function withSnapshotFixture(siteOptions, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-snapshot-test-'));
  const site = await startMockSite(siteOptions);
  const config = {
    sourceUrl: site.sourceUrl,
    docAccessCheckUrl: `${site.sourceUrl}/api/openapi-manage/account/check/doc_access`,
    snapshotDir: path.join(root, 'lingxing-api-docs'),
    docAccess: 'top-secret-doc-access',
  };
  try {
    return await callback({ config, site, root });
  } finally {
    await site.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('默认配置将访问密钥校验固定到领星网关', () => {
  assert.equal(
    createConfig().docAccessCheckUrl,
    'https://gw.umaicloud.com/api/openapi-manage/account/check/doc_access',
  );
});

test('fetch integration creates a complete staged snapshot and safe progress events', async () => {
  await withSnapshotFixture({}, async ({ config, site }) => {
    const progress = [];
    const result = await fetchSnapshot(config, {
      fetchImpl: fetch,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(result.successfulPages, 2);
    assert.equal(result.failedPages, 0);
    assert.notEqual(result.stagedDir, config.snapshotDir);

    const manifest = JSON.parse(await readFile(path.join(result.stagedDir, 'manifest.json'), 'utf8'));
    const index = JSON.parse(await readFile(path.join(result.stagedDir, 'api-index.json'), 'utf8'));
    assert.equal(manifest.pages.length, 2);
    assert.equal(manifest.docs_pages, 1);
    assert.equal(manifest.map_pages, 1);
    assert.match(manifest.pages[0].sha256, /^[a-f\d]{64}$/);
    assert.equal(index.total, 1);
    assert.equal(Object.hasOwn(index, 'count'), false);
    assert.equal(index.endpoints[0].method, 'GET');
    assert.equal(progress.at(-1).phase, 'completed');
    assert.deepEqual(Object.keys(progress.at(-1)).sort(), [
      'completed', 'failed', 'phase', 'successful', 'total',
    ]);
    assert.doesNotMatch(JSON.stringify(progress), /top-secret-doc-access/);

    const authCall = site.calls.find((call) => call.url.includes('/check/doc_access'));
    assert.equal(authCall.method, 'PUT');
    assert.deepEqual(JSON.parse(authCall.body), { docAccess: 'top-secret-doc-access' });
    const documentCalls = site.calls.filter((call) => (
      call.url === '/_sidebar.md'
      || call.url === '/_sidebar_map.md'
      || call.url === '/docs/Account/List.md'
      || call.url === '/map/Account/Overview.md'
    ));
    assert.ok(documentCalls.length > 0);
    assert.ok(documentCalls.every((call) => call.headers.cookie === 'doc_access_token=scoped-cookie-token'));
    const publicState = JSON.stringify({ result, progress, manifest, index });
    assert.doesNotMatch(publicState, /top-secret-doc-access|scoped-cookie-token/);
  });
});

test('fetch integration downloads map pages from official hash-route HTML navigation', async () => {
  await withSnapshotFixture({
    mapSidebar: '<li><a href="#/map/Account/Overview">账号地图</a></li>',
  }, async ({ config }) => {
    const result = await fetchSnapshot(config, { fetchImpl: fetch });
    const manifest = JSON.parse(await readFile(path.join(result.stagedDir, 'manifest.json'), 'utf8'));

    assert.equal(result.successfulPages, 2);
    assert.equal(manifest.map_pages, 1);
    assert.equal(
      manifest.pages.find((page) => page.file === 'map/Account/Overview.md')?.navigation_title,
      '账号地图',
    );
  });
});

test('fetch integration rejects invalid credentials without exposing the credential', async () => {
  await withSnapshotFixture({ rejectAuth: true }, async ({ config }) => {
    await assert.rejects(
      fetchSnapshot(config, { fetchImpl: fetch }),
      (error) => error.code === 'DOC_ACCESS_REJECTED'
        && !error.message.includes(config.docAccess),
    );
  });
});

test('fetch 将 HTTP 200 但缺少可访问 token 的校验响应归类为校验失败', async () => {
  await withSnapshotFixture({ authBody: JSON.stringify({ code: '1', data: {} }) }, async ({ config }) => {
    await assert.rejects(
      fetchSnapshot(config, { fetchImpl: fetch }),
      (error) => error.code === 'DOC_ACCESS_CHECK_FAILED'
        && !error.message.includes(config.docAccess),
    );
  });
});

test('fetch 将 HTTP 200 的明确业务拒绝归类为密钥拒绝', async () => {
  await withSnapshotFixture({
    authBody: JSON.stringify({ code: '0', data: { can_access: 'unexpected-token' } }),
  }, async ({ config }) => {
    await assert.rejects(
      fetchSnapshot(config, { fetchImpl: fetch }),
      (error) => error.code === 'DOC_ACCESS_REJECTED'
        && !error.message.includes(config.docAccess),
    );
  });
});

test('fetch 将 HTTP 200 的明确业务拒绝且无 token 归类为密钥拒绝', async () => {
  await withSnapshotFixture({ authBody: JSON.stringify({ code: '0', data: {} }) }, async ({ config }) => {
    await assert.rejects(
      fetchSnapshot(config, { fetchImpl: fetch }),
      (error) => error.code === 'DOC_ACCESS_REJECTED'
        && !error.message.includes(config.docAccess),
    );
  });
});

test('fetch 将网关 5xx 归类为访问密钥校验失败而非密钥拒绝', async () => {
  await withSnapshotFixture({ authStatus: 503, authBody: 'temporary upstream failure' }, async ({ config }) => {
    await assert.rejects(
      fetchSnapshot(config, { fetchImpl: fetch }),
      (error) => error.code === 'DOC_ACCESS_CHECK_FAILED'
        && !error.message.includes(config.docAccess),
    );
  });
});

test('fetch integration fails when navigation is unreachable', async () => {
  await withSnapshotFixture({ docsSidebarStatus: 503 }, async ({ config, site }) => {
    await assert.rejects(
      fetchSnapshot(config, { fetchImpl: fetch }),
      (error) => error.code === 'NAVIGATION_FETCH_FAILED',
    );
    assert.equal(site.calls.filter((call) => call.url === '/_sidebar.md').length, 3);
  });
});

test('fetch integration records a page failure and completes with remaining pages', async () => {
  await withSnapshotFixture({ mapPageStatus: 503 }, async ({ config, site }) => {
    const progress = [];
    const result = await fetchSnapshot(config, {
      fetchImpl: fetch,
      onProgress: (event) => progress.push(event),
    });
    const failures = JSON.parse(await readFile(path.join(result.stagedDir, 'failures.json'), 'utf8'));

    assert.equal(result.successfulPages, 1);
    assert.equal(result.failedPages, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].route, 'map/Account/Overview');
    assert.doesNotMatch(failures[0].error, /top-secret-doc-access/);
    assert.equal(site.calls.filter((call) => call.url === '/map/Account/Overview.md').length, 3);
    assert.deepEqual(progress.at(-1), {
      phase: 'completed', completed: 2, total: 2, successful: 1, failed: 1,
    });
  });
});

test('fetch never requests or writes a route that escapes after repeated decoding', async () => {
  await withSnapshotFixture({
    docsSidebar: [
      '[恶意](docs/%252e%252e/secret)',
      '[合法](docs/Account/List)',
    ].join('\n'),
    mapSidebar: '',
  }, async ({ config, site }) => {
    const result = await fetchSnapshot(config, { fetchImpl: fetch });
    const manifest = JSON.parse(await readFile(path.join(result.stagedDir, 'manifest.json'), 'utf8'));

    assert.equal(result.successfulPages, 1);
    assert.deepEqual(manifest.pages.map((page) => page.file), ['docs/Account/List.md']);
    assert.equal(site.calls.some((call) => call.url.includes('secret')), false);
    await assert.rejects(readFile(path.join(result.stagedDir, 'secret.md')), { code: 'ENOENT' });
  });
});

test('fetch timeout uses 30 seconds and aborts each of three attempts without waiting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-timeout-test-'));
  const delays = [];
  let aborts = 0;
  let cleared = 0;
  const setTimeoutImpl = (callback, delay) => {
    delays.push(delay);
    queueMicrotask(callback);
    return Symbol('timer');
  };
  const clearTimeoutImpl = () => { cleared += 1; };
  const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
    const rejectForAbort = () => {
      aborts += 1;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal.aborted) return rejectForAbort();
    signal.addEventListener('abort', rejectForAbort, { once: true });
    queueMicrotask(() => {
      if (delays.length === 0) reject(new Error('controllable timer was not used'));
    });
  });
  try {
    await assert.rejects(
      fetchSnapshot({
        sourceUrl: 'https://example.test',
        snapshotDir: path.join(root, 'lingxing-api-docs'),
        docAccess: 'timeout-test-access',
      }, { fetchImpl, setTimeoutImpl, clearTimeoutImpl }),
      (error) => error.code === 'DOC_ACCESS_CHECK_FAILED',
    );
    assert.deepEqual(delays, [30_000, 30_000, 30_000]);
    assert.equal(aborts, 3);
    assert.equal(cleared, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fetch treats fatal UTF-8 decoding as a page failure without writing the page', async () => {
  await withSnapshotFixture({ mapPageBody: Buffer.from([0xc3, 0x28]) }, async ({ config }) => {
    const result = await fetchSnapshot(config, { fetchImpl: fetch });
    const manifest = JSON.parse(await readFile(path.join(result.stagedDir, 'manifest.json'), 'utf8'));
    const failures = JSON.parse(await readFile(path.join(result.stagedDir, 'failures.json'), 'utf8'));

    assert.equal(result.successfulPages, 1);
    assert.equal(result.failedPages, 1);
    assert.equal(manifest.pages.some((page) => page.file === 'map/Account/Overview.md'), false);
    assert.deepEqual(failures, [{
      route: 'map/Account/Overview',
      source_url: `${config.sourceUrl}/map/Account/Overview.md`,
      error: '页面下载或解码失败',
    }]);
    await assert.rejects(
      readFile(path.join(result.stagedDir, 'map/Account/Overview.md')),
      { code: 'ENOENT' },
    );
  });
});

test('fetch retries a network exception twice for a total of three attempts', async () => {
  await withSnapshotFixture({}, async ({ config }) => {
    let attempts = 0;
    const fetchImpl = (url, init) => {
      if (String(url).endsWith('/map/Account/Overview.md')) {
        attempts += 1;
        throw new TypeError('simulated network failure');
      }
      return fetch(url, init);
    };

    const result = await fetchSnapshot(config, { fetchImpl });

    assert.equal(attempts, 3);
    assert.equal(result.successfulPages, 1);
    assert.equal(result.failedPages, 1);
  });
});

test('fetch limits more than eight blocked page downloads to eight concurrent workers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-concurrency-test-'));
  const links = Array.from({ length: 12 }, (_, index) => (
    `[页面 ${index}](docs/Batch/Page${index})`
  )).join('\n');
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/check/doc_access')) {
      assert.equal(init.method, 'PUT');
      return new Response(JSON.stringify({ code: '1', data: { can_access: 'worker-cookie' } }), { status: 200 });
    }
    if (pathname === '/_sidebar.md') return new Response(links, { status: 200 });
    if (pathname === '/_sidebar_map.md') return new Response('', { status: 200 });
    if (pathname.startsWith('/docs/Batch/Page')) {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 8) release();
      await gate;
      active -= 1;
      return new Response(`# ${pathname}`, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const result = await fetchSnapshot({
      sourceUrl: 'https://example.test',
      snapshotDir: path.join(root, 'lingxing-api-docs'),
      docAccess: 'concurrency-test-access',
    }, { fetchImpl });

    assert.equal(result.successfulPages, 12);
    assert.equal(peak, 8);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test('fetch hashes the exact original multibyte UTF-8 bytes', async () => {
  const markdown = '# 多字节中文🙂\n';
  await withSnapshotFixture({ docsPageBody: Buffer.from(markdown, 'utf8') }, async ({ config }) => {
    const result = await fetchSnapshot(config, { fetchImpl: fetch });
    const manifest = JSON.parse(await readFile(path.join(result.stagedDir, 'manifest.json'), 'utf8'));
    const page = manifest.pages.find((entry) => entry.file === 'docs/Account/List.md');

    assert.equal(page.bytes, 22);
    assert.equal(page.sha256, '1556f4d0ab3a30274d58abc311385b713792d2cfe717bcee7760d80acc259b15');
  });
});

async function createValidStagedSnapshot(stagedDir, pageFile = 'docs/Product/List.md') {
  await mkdir(stagedDir, { recursive: true });
  await mkdir(path.join(stagedDir, path.dirname(pageFile)), { recursive: true });
  await writeFile(path.join(stagedDir, pageFile), '# 新快照', 'utf8');
  await writeFile(path.join(stagedDir, 'new-marker.txt'), 'new', 'utf8');
  await writeFile(path.join(stagedDir, 'manifest.json'), JSON.stringify({
    successful_pages: 1,
    pages: [{ file: pageFile }],
  }), 'utf8');
  await writeFile(path.join(stagedDir, 'api-index.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    total: 1,
    endpoints: [{
      title: '新快照接口',
      method: 'GET',
      path: '/erp/example/list',
      protocol: 'HTTPS',
      rate_limit: '1',
      file: pageFile,
      source_url: `https://apidoc.lingxing.com/${pageFile}`,
    }],
  }), 'utf8');
}

test('replace integration atomically switches a validated staged snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-replace-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
  try {
    await mkdir(currentDir);
    await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
    await createValidStagedSnapshot(stagedDir);

    await replaceSnapshot({ currentDir, stagedDir });

    assert.equal(await readFile(path.join(currentDir, 'new-marker.txt'), 'utf8'), 'new');
    await assert.rejects(readFile(path.join(currentDir, 'old-marker.txt'), 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(await readdir(root), ['lingxing-api-docs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace integration rejects a snapshot that declares map routes but has no map pages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-map-semantic-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
  try {
    await mkdir(currentDir);
    await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
    await createValidStagedSnapshot(stagedDir);
    await writeFile(
      path.join(stagedDir, '_sidebar_map.md'),
      '<a href="#/map/Account/Overview">账号地图</a>',
      'utf8',
    );
    const manifestPath = path.join(stagedDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.map_pages = 0;
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    await assert.rejects(
      replaceSnapshot({ currentDir, stagedDir }),
      (error) => error.code === 'SNAPSHOT_VALIDATION_FAILED',
    );
    assert.equal(await readFile(path.join(currentDir, 'old-marker.txt'), 'utf8'), 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace integration preserves an existing map snapshot when staged map pages regress to zero', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-map-baseline-regression-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
  try {
    await mkdir(currentDir);
    await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
    await writeFile(path.join(currentDir, 'manifest.json'), JSON.stringify({ map_pages: 1 }), 'utf8');
    await createValidStagedSnapshot(stagedDir);
    await writeFile(path.join(stagedDir, '_sidebar_map.md'), '[退化导航](docs/Product/List)', 'utf8');
    const manifestPath = path.join(stagedDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.map_pages = 0;
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    await assert.rejects(
      replaceSnapshot({ currentDir, stagedDir }),
      (error) => error.code === 'SNAPSHOT_VALIDATION_FAILED',
    );
    assert.equal(await readFile(path.join(currentDir, 'old-marker.txt'), 'utf8'), 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace integration rejects a snapshot whose parsed API table produced no endpoints', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-endpoint-semantic-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
  try {
    await mkdir(currentDir);
    await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
    await createValidStagedSnapshot(stagedDir);
    await writeFile(path.join(stagedDir, 'docs/Product/List.md'), endpointMarkdown, 'utf8');
    await writeFile(path.join(stagedDir, 'api-index.json'), JSON.stringify({
      generated_at: new Date().toISOString(), total: 0, endpoints: [],
    }), 'utf8');

    await assert.rejects(
      replaceSnapshot({ currentDir, stagedDir }),
      (error) => error.code === 'SNAPSHOT_VALIDATION_FAILED',
    );
    assert.equal(await readFile(path.join(currentDir, 'old-marker.txt'), 'utf8'), 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace integration permits a genuine document-only snapshot with no parseable endpoints', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-no-endpoint-semantic-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
  try {
    await mkdir(currentDir);
    await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
    await createValidStagedSnapshot(stagedDir);
    await writeFile(path.join(stagedDir, 'api-index.json'), JSON.stringify({
      generated_at: new Date().toISOString(), total: 0, endpoints: [],
    }), 'utf8');

    await replaceSnapshot({ currentDir, stagedDir });

    assert.equal(await readFile(path.join(currentDir, 'new-marker.txt'), 'utf8'), 'new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace integration restores the old snapshot when the staged rename fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-rollback-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
  try {
    await mkdir(currentDir);
    await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
    await createValidStagedSnapshot(stagedDir);
    let renameCalls = 0;
    const renameImpl = async (from, to) => {
      renameCalls += 1;
      if (renameCalls === 2) throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' });
      await rename(from, to);
    };

    await assert.rejects(
      replaceSnapshot({ currentDir, stagedDir, renameImpl }),
      (error) => error.code === 'SNAPSHOT_REPLACE_FAILED',
    );

    assert.equal(await readFile(path.join(currentDir, 'old-marker.txt'), 'utf8'), 'old');
    assert.equal(await readFile(path.join(stagedDir, 'new-marker.txt'), 'utf8'), 'new');
    assert.equal(renameCalls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace integration rejects paths escaping the staged directory before switching', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-validation-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
  try {
    await mkdir(currentDir);
    await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
    await createValidStagedSnapshot(stagedDir, '../outside.md');

    await assert.rejects(
      replaceSnapshot({ currentDir, stagedDir }),
      (error) => error.code === 'SNAPSHOT_VALIDATION_FAILED',
    );
    assert.equal(await readFile(path.join(currentDir, 'old-marker.txt'), 'utf8'), 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace integration 在切换前拒绝不符合语义契约的 api-index', async () => {
  const validEndpoint = {
    title: '新快照接口',
    method: 'GET',
    path: '/erp/example/list',
    protocol: 'HTTPS',
    rate_limit: '1',
    file: 'docs/Product/List.md',
    source_url: 'https://apidoc.lingxing.com/docs/Product/List.md',
  };
  const invalidIndexes = [
    { endpoints: [validEndpoint] },
    { count: 1, endpoints: [validEndpoint] },
    { total: '1', endpoints: [validEndpoint] },
    { total: -1, endpoints: [validEndpoint] },
    { total: 0.5, endpoints: [validEndpoint] },
    { total: 2, endpoints: [validEndpoint] },
    { total: 1, endpoints: [{ ...validEndpoint, title: '' }] },
    { total: 1, endpoints: [{ ...validEndpoint, method: 'get' }] },
    { total: 1, endpoints: [{ ...validEndpoint, path: 'erp/example/list' }] },
    { total: 1, endpoints: [{ ...validEndpoint, protocol: 'FTP' }] },
    { total: 1, endpoints: [{ ...validEndpoint, rate_limit: 0 }] },
    { total: 1, endpoints: [{ ...validEndpoint, file: '../Product/List.md' }] },
    { total: 1, endpoints: [{ ...validEndpoint, source_url: 'not-a-url' }] },
    ...['title', 'method', 'path', 'protocol', 'rate_limit', 'file', 'source_url']
      .map((field) => {
        const endpoint = { ...validEndpoint };
        delete endpoint[field];
        return { total: 1, endpoints: [endpoint] };
      }),
  ];

  for (const [index, invalidIndex] of invalidIndexes.entries()) {
    const root = await mkdtemp(path.join(os.tmpdir(), `lingxing-contract-${index}-`));
    const currentDir = path.join(root, 'lingxing-api-docs');
    const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
    try {
      await mkdir(currentDir);
      await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
      await createValidStagedSnapshot(stagedDir);
      await writeFile(
        path.join(stagedDir, 'api-index.json'),
        JSON.stringify(invalidIndex),
        'utf8',
      );

      await assert.rejects(
        replaceSnapshot({ currentDir, stagedDir }),
        (error) => error.code === 'SNAPSHOT_VALIDATION_FAILED',
        JSON.stringify(invalidIndex),
      );
      assert.equal(await readFile(path.join(currentDir, 'old-marker.txt'), 'utf8'), 'old');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('replace integration rejects a successful file that is a symbolic link', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-symlink-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const stagedDir = path.join(root, '.lingxing-api-docs.staged-test');
  const stagedPage = path.join(stagedDir, 'docs/Product/List.md');
  const outsideFile = path.join(root, 'outside.md');
  try {
    await mkdir(currentDir);
    await writeFile(path.join(currentDir, 'old-marker.txt'), 'old', 'utf8');
    await createValidStagedSnapshot(stagedDir);
    await writeFile(outsideFile, '# 外部文件', 'utf8');
    await rm(stagedPage);
    await symlink(outsideFile, stagedPage, 'file');

    await assert.rejects(
      replaceSnapshot({ currentDir, stagedDir }),
      (error) => error.code === 'SNAPSHOT_VALIDATION_FAILED',
    );
    assert.equal(await readFile(path.join(currentDir, 'old-marker.txt'), 'utf8'), 'old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanupStagedSnapshots 仅删除整名匹配 randomUUID 输出的 staged 目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-cleanup-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const validUuid = '0f9c1b84-b28d-4aa1-9a68-55004809b608';
  const stagedSnapshot = path.join(root, `.lingxing-api-docs.staged-${validUuid}`);
  const stagedOne = path.join(root, '.lingxing-api-docs.staged-one');
  const stagedTwo = path.join(root, '.lingxing-api-docs.staged-two');
  const nearUuid = path.join(root, '.lingxing-api-docs.staged-0f9c1b84-b28d-4aa1-9a68-55004809b60');
  const extraSuffix = path.join(root, `.lingxing-api-docs.staged-${validUuid}-extra`);
  const nonRandomUuid = path.join(root, '.lingxing-api-docs.staged-0f9c1b84-b28d-1aa1-9a68-55004809b608');
  const unrelated = path.join(root, '.another-snapshot.staged-one');
  try {
    await Promise.all([
      currentDir,
      stagedSnapshot,
      stagedOne,
      stagedTwo,
      nearUuid,
      extraSuffix,
      nonRandomUuid,
      unrelated,
    ].map((dir) => mkdir(dir)));

    await cleanupStagedSnapshots(currentDir);

    assert.deepEqual((await readdir(root)).sort(), [
      '.another-snapshot.staged-one',
      `.lingxing-api-docs.staged-${validUuid}-extra`,
      '.lingxing-api-docs.staged-0f9c1b84-b28d-1aa1-9a68-55004809b608',
      '.lingxing-api-docs.staged-0f9c1b84-b28d-4aa1-9a68-55004809b60',
      '.lingxing-api-docs.staged-one',
      '.lingxing-api-docs.staged-two',
      'lingxing-api-docs',
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanupStagedSnapshots 不跟随同名前缀的符号链接或 junction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lingxing-cleanup-link-test-'));
  const currentDir = path.join(root, 'lingxing-api-docs');
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'lingxing-cleanup-outside-'));
  const stagedLink = path.join(
    root,
    '.lingxing-api-docs.staged-9ceda64b-0a69-4809-b18f-2d0979fbcd4a',
  );
  try {
    await mkdir(currentDir);
    await writeFile(path.join(outsideDir, 'marker.txt'), 'keep', 'utf8');
    await symlink(outsideDir, stagedLink, process.platform === 'win32' ? 'junction' : 'dir');

    await cleanupStagedSnapshots(currentDir);

    assert.equal(await readFile(path.join(outsideDir, 'marker.txt'), 'utf8'), 'keep');
    assert.equal((await lstat(stagedLink)).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
