function normalizeName(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function splitCsv(value) {
  return [...new Set(
    String(value ?? '')
      .split(',')
      .map(normalizeName)
      .filter(Boolean),
  )].sort();
}

export class PermissionSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PermissionSyncError';
    this.code = code;
  }
}

function buildStoreNameIndex(stores) {
  const index = new Map();
  for (const store of stores) {
    const name = normalizeName(store?.name);
    if (!name) continue;
    const existing = index.get(name) ?? [];
    existing.push(store);
    index.set(name, existing);
  }
  return index;
}

export class PrincipalSynchronizer {
  constructor({
    repository,
    lingxingClient,
    ttlMs = 5 * 60 * 1000,
    now = () => Date.now(),
  }) {
    this.repository = repository;
    this.lingxingClient = lingxingClient;
    this.ttlMs = ttlMs;
    this.now = now;
    this.inFlight = new Map();
  }

  async syncUser(uid) {
    const numericUid = Number(uid);
    if (!Number.isSafeInteger(numericUid) || numericUid <= 0) {
      throw new PermissionSyncError('INVALID_UID', 'uid 必须是正整数');
    }
    if (this.inFlight.has(numericUid)) return this.inFlight.get(numericUid);
    const promise = this.#performSync(numericUid).finally(() => {
      this.inFlight.delete(numericUid);
    });
    this.inFlight.set(numericUid, promise);
    return promise;
  }

  async #performSync(uid) {
    const [accountsPayload, storesPayload] = await Promise.all([
      this.lingxingClient.request({
        method: 'GET',
        path: '/erp/sc/data/account/lists',
        query: {},
        body: {},
      }),
      this.lingxingClient.request({
        method: 'GET',
        path: '/erp/sc/data/seller/lists',
        query: {},
        body: {},
      }),
    ]);
    const account = (Array.isArray(accountsPayload?.data) ? accountsPayload.data : [])
      .find((item) => Number(item?.uid) === uid);
    if (!account) {
      throw new PermissionSyncError('USER_NOT_FOUND', `领星 ERP 中不存在 uid=${uid}`);
    }
    const allStores = (Array.isArray(storesPayload?.data) ? storesPayload.data : [])
      .map((store) => ({
        sid: Number(store?.sid),
        name: normalizeName(store?.name),
        seller_id: normalizeName(store?.seller_id),
      }))
      .filter((store) => Number.isSafeInteger(store.sid) && store.sid > 0 && store.name);
    const isMaster = Number(account.is_master) === 1;
    let allowedStores;
    if (isMaster && splitCsv(account.seller).length === 0) {
      allowedStores = allStores;
    } else {
      const index = buildStoreNameIndex(allStores);
      allowedStores = splitCsv(account.seller).map((name) => {
        const matches = index.get(name) ?? [];
        if (matches.length === 0) {
          throw new PermissionSyncError(
            'UNKNOWN_STORE',
            `用户 uid=${uid} 的店铺权限“${name}”无法映射到 seller list，已拒绝更新`,
          );
        }
        if (matches.length > 1) {
          throw new PermissionSyncError(
            'AMBIGUOUS_STORE',
            `用户 uid=${uid} 的店铺权限“${name}”对应多个 sid，已拒绝更新`,
          );
        }
        return matches[0];
      });
    }
    return this.repository.upsertUser({
      uid,
      username: normalizeName(account.username),
      displayName: normalizeName(account.realname),
      roles: splitCsv(account.role),
      stores: allowedStores,
      isMaster,
      status: Number(account.status) === 1 ? 'active' : 'disabled',
      syncedAt: new Date(this.now()).toISOString(),
    });
  }

  async ensureFresh(principal) {
    const syncedAt = Date.parse(principal?.syncedAt ?? '');
    if (Number.isFinite(syncedAt) && this.now() - syncedAt < this.ttlMs) return principal;
    return this.syncUser(principal.uid);
  }
}
