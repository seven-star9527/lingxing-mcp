#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEndpointRecord, diffCatalogs } from '../src/catalog-builder.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawName, inlineValue] = token.slice(2).split('=', 2);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
    result[rawName] = value;
  }
  return result;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = path.resolve(args.source || process.env.LINGXING_DOC_SNAPSHOT || '');
  if (!args.source && !process.env.LINGXING_DOC_SNAPSHOT) {
    throw new Error('请通过 --source 指定含 api-index.json 和 docs/ 的领星文档快照目录');
  }
  const output = path.resolve(args.output || path.join(projectRoot, 'catalog', 'endpoints.json'));
  const changesFile = path.resolve(args.changes || path.join(projectRoot, 'catalog', 'changes.json'));
  const indexFile = path.join(source, 'api-index.json');
  const index = await readJson(indexFile);
  if (!index || !Array.isArray(index.endpoints) || index.endpoints.length === 0) {
    throw new Error('源快照 api-index.json 无效或端点为空');
  }
  if (Number(index.total) !== index.endpoints.length) {
    throw new Error('源快照 total 与 endpoints.length 不一致');
  }
  const endpoints = [];
  for (const item of index.endpoints) {
    const markdownFile = path.resolve(source, item.file);
    if (!markdownFile.startsWith(`${source}${path.sep}`)) {
      throw new Error(`源文档路径越界：${item.file}`);
    }
    const markdown = await readFile(markdownFile, 'utf8');
    endpoints.push(buildEndpointRecord(item, markdown));
  }
  endpoints.sort((left, right) => left.id.localeCompare(right.id));
  const digest = createHash('sha256').update(JSON.stringify(endpoints)).digest('hex');
  const catalog = {
    schema_version: 1,
    catalog_version: index.generated_at || new Date().toISOString(),
    generated_at: new Date().toISOString(),
    source: 'https://apidoc.lingxing.com',
    source_index_sha256: createHash('sha256').update(await readFile(indexFile)).digest('hex'),
    catalog_sha256: digest,
    endpoint_count: endpoints.length,
    business_endpoint_count: endpoints.filter((endpoint) => !endpoint.internal).length,
    endpoints,
  };
  const previous = args.initial === 'true'
    ? { endpoints: [], catalog_version: null }
    : await readJson(output, { endpoints: [], catalog_version: null });
  const changes = diffCatalogs(previous, catalog);
  await atomicWriteJson(output, catalog);
  await atomicWriteJson(changesFile, changes);
  const summary = {
    catalog_version: catalog.catalog_version,
    endpoint_count: catalog.endpoint_count,
    business_endpoint_count: catalog.business_endpoint_count,
    read: endpoints.filter((item) => item.operation === 'read').length,
    write: endpoints.filter((item) => item.operation === 'write').length,
    store_scoped: endpoints.filter((item) => item.scope.type === 'store').length,
    unscoped: endpoints.filter((item) => item.scope.type === 'unscoped').length,
    changes: {
      added: changes.added.length,
      updated: changes.updated.length,
      removed: changes.removed.length,
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
