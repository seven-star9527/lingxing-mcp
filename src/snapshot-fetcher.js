import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { isValidApiIndex } from './api-index-contract.js';

export const DEFAULT_DOC_ACCESS_CHECK_URL = 'https://gw.umaicloud.com/api/openapi-manage/account/check/doc_access';

const decoder = new TextDecoder('utf-8', { fatal: true });
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_WORKERS = 8;
const RANDOM_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

function normalizeCell(value) {
  return value
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/\[([^\]]+)\]\((?:[^()\\]|\\.)*\)/g, '$1')
    .trim();
}

function parseMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map(normalizeCell);
}

function normalizeRoute(rawTarget, kind) {
  if (kind !== 'docs' && kind !== 'map') return null;
  const trimmed = rawTarget.trim();
  const hashRoute = /^#\/?(.+)$/.exec(trimmed);
  const withoutSuffix = (hashRoute ? hashRoute[1] : trimmed).split(/[?#]/, 1)[0];
  if (!withoutSuffix) return null;

  let decoded = withoutSuffix;
  try {
    for (let depth = 0; depth < 5; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return null;
  }

  if (/%[\da-f]{2}/i.test(decoded)) return null;
  if (decoded.includes('\\') && !withoutSuffix.includes('\\')) return null;
  let normalized = decoded.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/docs/')) normalized = normalized.slice(1);
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/')
    || /^[a-z][a-z\d+.-]*:/i.test(normalized)
    || /[<>:"|?#*\u0000-\u001f]/.test(normalized)
    || segments.some((segment) => (
      !segment
      || segment === '..'
      || segment === '.'
      || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
    ))
  ) {
    return null;
  }

  const prefix = `${kind}/`;
  if (!normalized.startsWith(prefix)) return null;
  const route = normalized.replace(/\.md$/i, '');
  if (route === kind || route.endsWith('/') || route.includes('\0')) return null;
  return { route, file: `${route}.md` };
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function normalizeHttpMethod(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const direct = trimmed.toUpperCase();
  if (HTTP_METHODS.has(direct)) return direct;

  return /^POST\s+ss$/i.test(trimmed) ? 'POST' : null;
}

function normalizeApiPath(value) {
  const trimmed = value?.trim();
  if (
    !trimmed
    || trimmed.startsWith('//')
    || /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    || /[\\?#\s\u0000-\u001f]/.test(trimmed)
  ) {
    return null;
  }

  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const segments = normalized.slice(1).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return normalized;
}

function extractNavigationLinks(sidebar) {
  const links = [];
  const markdownPattern = /\[([^\]]*)\]\(([^\s)]+)(?:\s+['"][^'"]*['"])?\)/g;
  for (const match of sidebar.matchAll(markdownPattern)) {
    links.push({ index: match.index, target: match[2], title: match[1] });
  }
  const htmlAnchorPattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (const match of sidebar.matchAll(htmlAnchorPattern)) {
    links.push({
      index: match.index,
      target: match[2],
      title: match[3].replace(/<[^>]*>/g, ''),
    });
  }
  return links.sort((left, right) => left.index - right.index);
}

export function extractRoutes(sidebar, kind) {
  const routes = [];
  const seen = new Set();

  for (const link of extractNavigationLinks(sidebar)) {
    const entry = normalizeRoute(link.target, kind);
    if (!entry || seen.has(entry.route)) continue;
    seen.add(entry.route);
    routes.push(entry);
  }

  return routes;
}

function extractNavigationEntries(sidebar, kind) {
  const entries = new Map(extractRoutes(sidebar, kind).map((entry) => [entry.route, entry]));
  const titles = new Map();
  for (const link of extractNavigationLinks(sidebar)) {
    const entry = normalizeRoute(link.target, kind);
    if (entry && !titles.has(entry.route)) titles.set(entry.route, normalizeCell(link.title));
  }
  return [...entries.values()].map((entry) => ({
    ...entry,
    navigation_title: titles.get(entry.route) || entry.route.split('/').at(-1),
  }));
}

export function parseEndpoint(markdown) {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headers = parseMarkdownRow(lines[index]);
    if (!headers) continue;

    const pathIndex = headers.indexOf('API Path');
    const protocolIndex = headers.indexOf('请求协议');
    const methodIndex = headers.indexOf('请求方式');
    const rateLimitIndex = headers.indexOf('令牌桶容量');
    if ([pathIndex, protocolIndex, methodIndex, rateLimitIndex].some((value) => value < 0)) continue;

    const separator = parseMarkdownRow(lines[index + 1]);
    if (!separator?.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;

    const values = parseMarkdownRow(lines[index + 2]);
    if (!values) continue;
    const endpoint = {
      path: normalizeApiPath(values[pathIndex]),
      protocol: values[protocolIndex]?.trim(),
      method: normalizeHttpMethod(values[methodIndex]),
      rate_limit: values[rateLimitIndex]?.trim(),
    };
    if (!endpoint.path || !endpoint.protocol || !endpoint.method || !endpoint.rate_limit) return null;
    return endpoint;
  }

  return null;
}

function progressEvent(onProgress, phase, completed, total, successful, failed) {
  onProgress({ phase, completed, total, successful, failed });
}

async function requestWithRetry(
  fetchImpl,
  url,
  init = {},
  { setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (response.status < 500 || attempt === 2) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    } finally {
      clearTimeoutImpl(timer);
    }
  }
  throw lastError;
}

async function readResponseText(response) {
  return decoder.decode(await response.arrayBuffer());
}

function remoteUrl(sourceUrl, pathname) {
  return new URL(pathname, `${sourceUrl.replace(/\/$/, '')}/`).href;
}

async function verifyAccess(config, fetchImpl, requestOptions) {
  if (!config.docAccess) {
    throw new SnapshotError('DOC_ACCESS_REQUIRED', '未配置文档访问密钥。');
  }

  let response;
  try {
    response = await requestWithRetry(
      fetchImpl,
      config.docAccessCheckUrl ?? DEFAULT_DOC_ACCESS_CHECK_URL,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docAccess: config.docAccess }),
      },
      requestOptions,
    );
  } catch {
    throw new SnapshotError('DOC_ACCESS_CHECK_FAILED', '文档访问密钥校验请求失败。');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SnapshotError('DOC_ACCESS_REJECTED', '文档访问密钥无效或已失效。');
    }
    throw new SnapshotError('DOC_ACCESS_CHECK_FAILED', '文档访问密钥校验服务暂时不可用。');
  }

  try {
    const result = JSON.parse(await readResponseText(response));
    if (result.code !== '1') {
      throw new SnapshotError('DOC_ACCESS_REJECTED', '文档访问密钥无效或已失效。');
    }
    const canAccess = result?.data?.can_access;
    if (typeof canAccess !== 'string' || !canAccess.trim()) throw new Error('missing token');
    return `doc_access_token=${encodeURIComponent(canAccess)}`;
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError('DOC_ACCESS_CHECK_FAILED', '文档访问密钥校验响应无效。');
  }
}

async function fetchNavigation(config, fetchImpl, pathname, requestOptions, cookie) {
  try {
    const response = await requestWithRetry(
      fetchImpl,
      remoteUrl(config.sourceUrl, pathname),
      { headers: { cookie } },
      requestOptions,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await readResponseText(response);
  } catch {
    throw new SnapshotError('NAVIGATION_FETCH_FAILED', `无法获取官方导航 ${pathname}。`);
  }
}

function firstHeading(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match ? normalizeCell(match[1]) : fallback;
}

function safeFailureMessage(error) {
  if (error?.code === 'INVALID_UTF8') return '页面下载或解码失败';
  if (error instanceof TypeError) return '网络请求失败';
  if (error?.name === 'AbortError') return '远端请求超时';
  const httpStatus = /HTTP\s+(\d{3})/.exec(error?.message ?? '');
  return httpStatus ? `远端返回 HTTP ${httpStatus[1]}` : '页面下载或解码失败';
}

function categoryFor(file) {
  return file.split('/')[1] || '其他';
}

function renderApiIndex(endpoints) {
  const groups = new Map();
  for (const endpoint of endpoints) {
    const category = categoryFor(endpoint.file);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(endpoint);
  }
  const lines = ['# API 索引', ''];
  for (const category of [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    lines.push(`## ${category}`, '', '| 标题 | Method | API Path |', '| --- | --- | --- |');
    for (const endpoint of groups.get(category)) {
      lines.push(`| ${endpoint.title.replaceAll('|', '\\|')} | ${endpoint.method} | \`${endpoint.path}\` |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function renderReadme(manifest) {
  return `# 领星 API 文档快照

- 更新时间：${manifest.generated_at}
- 路由总数：${manifest.total_routes}
- 成功页面：${manifest.successful_pages}
- 失败页面：${manifest.failed_pages}
- docs 页面：${manifest.docs_pages}
- map 页面：${manifest.map_pages}

请通过本地文档中心的“获取最新文档”按钮执行更新。访问密钥仅由服务端环境变量读取。
`;
}

async function downloadPage({ config, fetchImpl, entry, stagedDir, requestOptions, cookie }) {
  const sourceUrl = remoteUrl(config.sourceUrl, entry.file);
  try {
    const response = await requestWithRetry(
      fetchImpl,
      sourceUrl,
      { headers: { cookie } },
      requestOptions,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let markdown;
    try {
      markdown = decoder.decode(bytes);
    } catch {
      throw new SnapshotError('INVALID_UTF8', '页面不是有效的 UTF-8。');
    }
    const outputFile = path.resolve(stagedDir, entry.file);
    const relative = path.relative(stagedDir, outputFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe path');
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, bytes);
    return {
      page: {
        route: entry.route,
        title: firstHeading(markdown, entry.navigation_title),
        navigation_title: entry.navigation_title,
        file: entry.file,
        source_url: sourceUrl,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        endpoint: parseEndpoint(markdown),
      },
    };
  } catch (error) {
    return {
      failure: { route: entry.route, source_url: sourceUrl, error: safeFailureMessage(error) },
    };
  }
}

export async function fetchSnapshot(config, {
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数。');
  await cleanupStagedSnapshots(config.snapshotDir);
  const sourceUrl = config.sourceUrl.replace(/\/$/, '');
  const stagedDir = path.join(
    path.dirname(config.snapshotDir),
    `.${path.basename(config.snapshotDir)}.staged-${randomUUID()}`,
  );

  progressEvent(onProgress, 'authorizing', 0, 0, 0, 0);
  const requestOptions = { setTimeoutImpl, clearTimeoutImpl };
  const documentAccessCookie = await verifyAccess(config, fetchImpl, requestOptions);
  progressEvent(onProgress, 'navigation', 0, 0, 0, 0);
  const [docsSidebar, mapSidebar] = await Promise.all([
    fetchNavigation({ ...config, sourceUrl }, fetchImpl, '_sidebar.md', requestOptions, documentAccessCookie),
    fetchNavigation({ ...config, sourceUrl }, fetchImpl, '_sidebar_map.md', requestOptions, documentAccessCookie),
  ]);
  const entries = [
    ...extractNavigationEntries(docsSidebar, 'docs'),
    ...extractNavigationEntries(mapSidebar, 'map'),
  ];
  if (entries.length === 0) {
    throw new SnapshotError('NAVIGATION_EMPTY', '官方导航中没有可下载的文档路由。');
  }

  await mkdir(stagedDir, { recursive: true });
  try {
    await writeFile(path.join(stagedDir, '_sidebar.md'), docsSidebar, 'utf8');
    await writeFile(path.join(stagedDir, '_sidebar_map.md'), mapSidebar, 'utf8');

    const pages = [];
    const failures = [];
    let cursor = 0;
    let completed = 0;
    progressEvent(onProgress, 'downloading', completed, entries.length, 0, 0);
    const worker = async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor];
        cursor += 1;
        const result = await downloadPage({
          config: { ...config, sourceUrl },
          fetchImpl,
          entry,
          stagedDir,
          requestOptions,
          cookie: documentAccessCookie,
        });
        if (result.page) pages.push(result.page);
        else failures.push(result.failure);
        completed += 1;
        progressEvent(onProgress, 'downloading', completed, entries.length, pages.length, failures.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_WORKERS, entries.length) }, worker));
    if (pages.length === 0) {
      throw new SnapshotError('NO_SUCCESSFUL_PAGES', '未成功下载任何官方文档页面。');
    }

    pages.sort((a, b) => a.file.localeCompare(b.file));
    failures.sort((a, b) => a.route.localeCompare(b.route));
    const generatedAt = new Date().toISOString();
    const endpoints = pages
      .filter((page) => page.endpoint)
      .map((page) => ({
        title: page.title,
        method: page.endpoint.method,
        path: page.endpoint.path,
        protocol: page.endpoint.protocol,
        rate_limit: page.endpoint.rate_limit,
        file: page.file,
        source_url: page.source_url,
      }))
      .sort((a, b) => categoryFor(a.file).localeCompare(categoryFor(b.file), 'zh-CN')
        || a.title.localeCompare(b.title, 'zh-CN'));
    const manifest = {
      source: sourceUrl,
      generated_at: generatedAt,
      total_routes: entries.length,
      successful_pages: pages.length,
      failed_pages: failures.length,
      docs_pages: pages.filter((page) => page.file.startsWith('docs/')).length,
      map_pages: pages.filter((page) => page.file.startsWith('map/')).length,
      pages,
    };
    const index = { generated_at: generatedAt, total: endpoints.length, endpoints };

    progressEvent(onProgress, 'generating', completed, entries.length, pages.length, failures.length);
    await Promise.all([
      writeFile(path.join(stagedDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      writeFile(path.join(stagedDir, 'api-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8'),
      writeFile(path.join(stagedDir, 'API_INDEX.md'), renderApiIndex(endpoints), 'utf8'),
      writeFile(path.join(stagedDir, 'failures.json'), `${JSON.stringify(failures, null, 2)}\n`, 'utf8'),
      writeFile(path.join(stagedDir, 'README.md'), renderReadme(manifest), 'utf8'),
    ]);
    progressEvent(onProgress, 'completed', completed, entries.length, pages.length, failures.length);
    return {
      stagedDir,
      generatedAt,
      totalRoutes: entries.length,
      successfulPages: pages.length,
      failedPages: failures.length,
    };
  } catch (error) {
    await rm(stagedDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupStagedSnapshots(currentDir) {
  if (typeof currentDir !== 'string' || currentDir.length === 0) {
    throw new TypeError('currentDir 为必填参数。');
  }
  const resolvedCurrent = path.resolve(currentDir);
  const parentDir = path.dirname(resolvedCurrent);
  const stagedPrefix = `.${path.basename(resolvedCurrent)}.staged-`;
  let parentRealDir;
  let entries;
  try {
    [parentRealDir, entries] = await Promise.all([
      realpath(parentDir),
      readdir(parentDir, { withFileTypes: true }),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const stagedSuffix = entry.name.startsWith(stagedPrefix)
      ? entry.name.slice(stagedPrefix.length)
      : '';
    if (
      !RANDOM_UUID_PATTERN.test(stagedSuffix)
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) {
      continue;
    }
    const candidate = path.join(parentDir, entry.name);
    let candidateInfo;
    let candidateRealDir;
    try {
      [candidateInfo, candidateRealDir] = await Promise.all([lstat(candidate), realpath(candidate)]);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const relative = path.relative(parentRealDir, candidateRealDir);
    if (
      !candidateInfo.isDirectory()
      || candidateInfo.isSymbolicLink()
      || !relative
      || relative.startsWith(`..${path.sep}`)
      || relative === '..'
      || path.isAbsolute(relative)
      || path.dirname(relative) !== '.'
      || path.basename(candidateRealDir) !== entry.name
    ) {
      continue;
    }
    await rm(candidateRealDir, { recursive: true, force: true });
  }
}

async function readJsonForValidation(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', `${label} 缺失或不是有效 JSON。`);
  }
}

async function validateStagedFile(stagedDir, stagedRealDir, relativeFile) {
  if (typeof relativeFile !== 'string' || !relativeFile || path.isAbsolute(relativeFile)) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照包含无效文件路径。');
  }
  const resolved = path.resolve(stagedDir, relativeFile);
  const relative = path.relative(path.resolve(stagedDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照文件路径越界。');
  }
  let fileInfo;
  let realFile;
  try {
    [fileInfo, realFile] = await Promise.all([lstat(resolved), realpath(resolved)]);
  } catch {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', `暂存快照缺少成功文件：${relativeFile}`);
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', `暂存快照成功文件不能是链接：${relativeFile}`);
  }
  const realRelative = path.relative(stagedRealDir, realFile);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照实际文件路径越界。');
  }
}

async function readOptionalStagedText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照无法读取语义校验文件。');
  }
}

async function validateSnapshotSemantics(stagedDir, manifest, index, currentDir) {
  if (manifest.map_pages === 0 && currentDir) {
    const currentManifestText = await readOptionalStagedText(path.join(currentDir, 'manifest.json'));
    if (currentManifestText) {
      try {
        const currentManifest = JSON.parse(currentManifestText);
        if (Number.isInteger(currentManifest.map_pages) && currentManifest.map_pages > 0) {
          throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照的 API 地图页面归零，不能覆盖当前快照。');
        }
      } catch (error) {
        if (error instanceof SnapshotError) throw error;
      }
    }
  }

  const mapSidebar = await readOptionalStagedText(path.join(stagedDir, '_sidebar_map.md'));
  if (mapSidebar && extractRoutes(mapSidebar, 'map').length > 0 && manifest.map_pages === 0) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照声明了 API 地图路由，但没有成功地图页面。');
  }

  if (index.endpoints.length > 0) return;
  const documentPages = manifest.pages.filter((page) => page?.file?.startsWith('docs/'));
  for (const page of documentPages) {
    const markdown = await readFile(path.join(stagedDir, page.file), 'utf8');
    if (parseEndpoint(markdown)) {
      throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照包含可解析接口表，但端点索引为空。');
    }
  }
}

async function validateStagedSnapshot(stagedDir, currentDir) {
  let stagedInfo;
  let stagedRealDir;
  try {
    [stagedInfo, stagedRealDir] = await Promise.all([lstat(stagedDir), realpath(stagedDir)]);
  } catch {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照目录不存在。');
  }
  if (!stagedInfo.isDirectory() || stagedInfo.isSymbolicLink()) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照目录不能是链接。');
  }
  const manifest = await readJsonForValidation(path.join(stagedDir, 'manifest.json'), 'manifest.json');
  const index = await readJsonForValidation(path.join(stagedDir, 'api-index.json'), 'api-index.json');
  if (!Number.isInteger(manifest.successful_pages) || manifest.successful_pages <= 0) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照没有成功页面。');
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length !== manifest.successful_pages) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存快照页面统计不一致。');
  }
  if (!isValidApiIndex(index)) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存端点索引结构无效。');
  }
  await Promise.all([
    ...manifest.pages.map((page) => validateStagedFile(stagedDir, stagedRealDir, page?.file)),
    ...index.endpoints.map((endpoint) => validateStagedFile(stagedDir, stagedRealDir, endpoint?.file)),
  ]);
  await validateSnapshotSemantics(stagedDir, manifest, index, currentDir);
}

export async function replaceSnapshot({ currentDir, stagedDir, renameImpl = rename }) {
  if (!currentDir || !stagedDir) throw new TypeError('currentDir 和 stagedDir 为必填参数。');
  const resolvedCurrent = path.resolve(currentDir);
  const resolvedStaged = path.resolve(stagedDir);
  if (resolvedCurrent === resolvedStaged) {
    throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', '暂存目录不能与当前快照目录相同。');
  }
  await validateStagedSnapshot(resolvedStaged, resolvedCurrent);

  const backupDir = path.join(
    path.dirname(resolvedCurrent),
    `.${path.basename(resolvedCurrent)}.backup-${randomUUID()}`,
  );
  try {
    await renameImpl(resolvedCurrent, backupDir);
  } catch {
    throw new SnapshotError('SNAPSHOT_REPLACE_FAILED', '无法创建当前快照备份。');
  }

  try {
    await renameImpl(resolvedStaged, resolvedCurrent);
  } catch {
    try {
      await renameImpl(backupDir, resolvedCurrent);
    } catch {
      throw new SnapshotError('SNAPSHOT_ROLLBACK_FAILED', '快照切换失败，且旧快照自动恢复失败。');
    }
    throw new SnapshotError('SNAPSHOT_REPLACE_FAILED', '快照切换失败，已恢复旧快照。');
  }

  await rm(backupDir, { recursive: true, force: true });
}
