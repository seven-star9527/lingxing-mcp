import path from 'node:path';

import { DEFAULT_DOC_ACCESS_CHECK_URL } from '../src/snapshot-fetcher.js';

export function createSnapshotTestConfig(overrides = {}) {
  const projectDir = path.resolve(overrides.projectDir ?? process.cwd());
  const snapshotDir = path.resolve(overrides.snapshotDir ?? path.join(projectDir, 'snapshot'));
  return {
    sourceUrl: 'https://apidoc.lingxing.com',
    docAccessCheckUrl: DEFAULT_DOC_ACCESS_CHECK_URL,
    docAccess: process.env.LINGXING_DOC_ACCESS,
    projectDir,
    snapshotDir,
    ...overrides,
  };
}
