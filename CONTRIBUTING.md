# 贡献指南

1. 不要提交任何真实凭据、token、店铺名称或业务响应。
2. 缺陷修复先添加失败测试，再实现修复。
3. 新接口不新增 MCP Tool；更新结构化目录和通用调用能力。
4. 无法确定读写性质时归类为 `write`。
5. 无法确定店铺范围时归类为 `unscoped`。
6. 提交前运行：

```bash
npm ci
npm test
npm run check
npm audit --omit=dev --audit-level=high
docker build -t lingxing-mcp:test .
```

涉及权限、认证、签名、目录更新或部署的 PR 必须说明威胁模型和回滚方式。
