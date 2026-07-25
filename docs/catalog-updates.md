# 版本与目录更新

## 两种版本

- Server 使用 SemVer，例如 `0.1.0`；
- API 目录使用官方快照生成时间，例如 `2026-07-16T03:08:17.108Z`。

代码功能变化发布 Git tag；官方新增接口只需更新 `catalog/endpoints.json` 和 `catalog/changes.json`。

## 更新官方目录

维护者在安全环境中设置文档访问密钥：

```bash
export LINGXING_DOC_ACCESS='文档访问密钥'
npm run catalog:update
```

更新器执行：

1. 服务端验证文档访问密钥；
2. 下载 `_sidebar.md`、`_sidebar_map.md` 和全部文档；
3. 校验路由、UTF-8、SHA-256、页面数量和端点索引；
4. 任一页面失败时拒绝发布；
5. 生成 614+ 端点的结构化目录；
6. 按 `HTTP Method + API Path` 生成 added/updated/removed；
7. 原子替换目录文件。

不要把 `LINGXING_DOC_ACCESS` 写入仓库、Workflow 输出或构建产物。

## Agent 获得更新

运行中的 Server 监视 `catalog/changes.json`。有效的新目录写入后：

- 热加载 `catalog/endpoints.json`；
- 向活动会话发送 `lingxing://catalog/version` resource updated；
- 向活动会话发送 `lingxing://catalog/changes` resource updated。

不支持资源订阅或曾离线的 Agent 可以调用 `get_api_changes` 补查。

## 发布流程

```bash
npm test
npm run check
git diff -- catalog/endpoints.json catalog/changes.json
git add catalog/endpoints.json catalog/changes.json
git commit -m "catalog: update Lingxing OpenAPI snapshot"
git push
```

Server 功能变化：

```bash
npm version patch   # 或 minor / major
git push --follow-tags
```

Tag `v*` 会触发 GitHub Release 和 GHCR 镜像构建。
