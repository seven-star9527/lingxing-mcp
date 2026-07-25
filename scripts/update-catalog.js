#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DOC_ACCESS_CHECK_URL,
  fetchSnapshot,
} from '../src/snapshot-fetcher.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCatalogBuilder(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(projectRoot, 'scripts', 'build-catalog.js'),
      '--source',
      source,
    ], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`catalog builder 退出码 ${code}`));
    });
  });
}

async function main() {
  const docAccess = String(process.env.LINGXING_DOC_ACCESS ?? '').trim();
  if (!docAccess) throw new Error('缺少环境变量 LINGXING_DOC_ACCESS');
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lingxing-mcp-update-'));
  const snapshotDir = path.join(temporaryRoot, 'snapshot');
  try {
    const result = await fetchSnapshot({
      sourceUrl: 'https://apidoc.lingxing.com',
      docAccessCheckUrl: process.env.LINGXING_DOC_ACCESS_CHECK_URL || DEFAULT_DOC_ACCESS_CHECK_URL,
      docAccess,
      snapshotDir,
    }, {
      onProgress: (progress) => {
        process.stdout.write(`${JSON.stringify({ event: 'catalog_download', ...progress })}\n`);
      },
    });
    if (result.failedPages > 0) {
      throw new Error(`官方文档下载有 ${result.failedPages} 个失败页面，拒绝更新目录`);
    }
    await runCatalogBuilder(result.stagedDir);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    event: 'catalog_update_failed',
    message: error.message,
  })}\n`);
  process.exitCode = 1;
});
