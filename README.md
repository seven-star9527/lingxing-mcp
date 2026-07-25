# Lingxing MCP

面向领星 ERP OpenAPI 的生产型远程 MCP Server。使用标准 **Streamable HTTP**，通过 `X-Mcp-Key` 将每个 Agent 绑定到具体 ERP 用户，并同时执行：

- ERP 用户店铺权限隔离；
- ERP 角色名称同步；
- 本地“角色 → 功能模块/接口读写权限”映射；
- 写接口默认拒绝、显式授权；
- 接口目录检索、版本差异和 MCP resource update notification；
- 服务端统一管理 App ID/App Secret、token、签名、限流和审计。

当前目录基于领星官方快照收录 **614 个 OpenAPI 端点**，其中 2 个认证端点仅供服务内部使用，Agent 可调用 612 个业务端点。为避免给模型加载数百个 Tool，本项目用 6 个稳定 Tool 覆盖全部业务接口。

## 为什么不生成 614 个 Tool

大量动态 Tool 会放大客户端初始化上下文、降低选择准确率，并在官方新增接口时破坏 Tool 列表稳定性。本项目采用：

1. `search_endpoints` 检索当前用户有权限的接口；
2. `get_endpoint_schema` 读取接口参数与风险分类；
3. `call_read_endpoint` 调用只读接口；
4. `call_write_endpoint` 调用有副作用接口；
5. `list_my_permissions` 查看当前身份、店铺和功能授权；
6. `get_api_changes` 查询新增、变更、移除接口。

认证和续约端点不会暴露给 Agent；App Secret、access token 和签名不会进入 MCP 输出。

## 权限模型

领星官方 MCP 的 `X-Mcp-Key` 与当前 ERP 账号绑定，官方服务能直接使用内部账号权限。公开 OpenAPI 只能读取 `/erp/sc/data/account/lists` 返回的角色名称和店铺权限，不能读取角色的菜单/功能明细。

因此本项目采用可审计的等价边界：

- API Key → ERP `uid`；
- 自动同步 `uid` 的 `role` 和 `seller`；
- 店铺名称严格映射到 `/erp/sc/data/seller/lists` 的 `sid`；
- 角色名称映射到本地模块/端点授权；
- 未知角色、未知店铺、重复店铺名、无法收窄范围的接口默认拒绝；
- 无法按店铺参数约束的接口必须有精确 `endpoint_id + allow_unscoped` 授权；
- 角色或店铺权限缓存默认 5 分钟，过期后同步失败则 fail closed。

详见 [权限与安全模型](docs/permission-model.md)。

## 与现有方案的区别

| 方案 | 工具覆盖 | 远程协议 | 多人鉴权 | 店铺隔离 | 功能角色隔离 | 写操作治理 | 版本更新 |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| 领星官方 MCP | 官方精选工具 | Streamable HTTP | ERP 账号绑定 Key | 官方内部权限 | 官方内部权限 | 官方控制 | 官方维护 |
| `zach22-1999/lingxing-mcp` 当前公开版 | 约 84 个工具/规格 | 自定义 HTTP JSON-RPC + stdio | Bearer 成员令牌 | 多个令牌共用同一 OpenAPI Service，未按令牌限制 `sid` | 未实现 | 主要只读 | 文档同步脚本 |
| 本项目 | 612 个业务端点，6 个稳定 Tool | 标准 Streamable HTTP | `X-Mcp-Key` | 按 ERP 用户同步和强制校验 | 角色名称同步 + 管理员映射 | 默认只读，写权限显式授权 | `changes.json` + resource notification + SemVer |

参考：

- [领星官方 MCP 文档](https://www.lingxing.com/help/article/mcp)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [`zach22-1999/lingxing-mcp`](https://github.com/zach22-1999/lingxing-mcp)

## 快速开始

生产部署请直接阅读 [腾讯云 Ubuntu 部署指南](docs/deployment-ubuntu.md)。

本地开发需要 Node.js 22.5+：

```powershell
npm.cmd install
Copy-Item .env.example .env
```

配置 `.env` 后，将变量注入当前进程，再初始化数据库：

```powershell
$env:LINGXING_APP_ID = "你的 App ID"
$env:LINGXING_APP_SECRET = "你的 App Secret"
$env:LINGXING_MCP_KEY_PEPPER = "至少32字符的随机值"
npm.cmd run admin -- init-db
npm.cmd run admin -- sync-user --uid 你的ERP用户UID
npm.cmd run admin -- apply-role-map --file config/role-mapping.example.json
npm.cmd run admin -- create-key --uid 你的ERP用户UID --label "Codex"
npm.cmd start
```

创建 Key 时只显示一次明文。

## Agent 配置

```json
{
  "mcpServers": {
    "LingXing-MCP": {
      "type": "streamableHttp",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Mcp-Key": "替换为个人API-Key"
      }
    }
  }
}
```

每个用户、每台 Agent 客户端建议使用独立 Key，便于单独吊销和审计。更多示例与验收方式见 [Agent 接入指南](docs/agent-clients.md)。

## 管理命令

```bash
# 生成数据库哈希 Pepper
docker compose -f deploy/compose.yaml run --rm lingxing-mcp \
  node src/admin-cli.js generate-pepper

# 同步 ERP 用户角色和店铺
docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js sync-user --uid 123

# 应用角色映射
docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js apply-role-map --file /config/role-mapping.json

# 创建、吊销个人 Key
docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js create-key --uid 123 --label "Alice Codex"
docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js revoke-key --id KEY_ID

# 审计
docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js audit --limit 100
```

## 接口目录更新

```bash
export LINGXING_DOC_ACCESS='服务端文档访问密钥'
npm run catalog:update
git diff -- catalog/endpoints.json catalog/changes.json
```

更新流程先下载和校验完整官方快照，任一页面失败都会拒绝覆盖当前目录。目录文件原子替换后，运行中的 MCP 会话收到：

- `lingxing://catalog/version`
- `lingxing://catalog/changes`

对应的 resource updated notification。Agent 重连后也可用 `get_api_changes` 补查。详见 [版本与目录更新](docs/catalog-updates.md)。

## 测试

```bash
npm test
npm run check
npm audit --omit=dev --audit-level=high
docker build -t lingxing-mcp:test .
```

## 安全提示

- 不要把 App ID、App Secret、`X-Mcp-Key`、领星 access token 或真实 `.env` 提交到仓库。
- 用户曾在聊天或截图中暴露的 Key 应立即撤销并重建。
- 生产环境必须使用 HTTPS，不应直接公网暴露 8099。
- `allow_unscoped` 代表该端点不能可靠按店铺收窄，仅应授予经过审查的管理员角色。
- 角色映射示例不是你的生产权限定义；上线前必须逐项审核。

安全问题请参阅 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
