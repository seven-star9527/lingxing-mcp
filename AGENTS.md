# AGENTS.md

## 语言

- 用户沟通、设计、测试和交付说明使用中文。
- 代码标识、协议字段、文件名和命令可保留英文。

## 安全边界

- 不得提交 App ID、App Secret、文档访问密钥、API Key、access token、签名或真实业务响应。
- 所有 Agent 请求必须从 `X-Mcp-Key` 恢复服务端身份，不接受调用方传入 `uid` 或角色。
- 不确定的接口默认标记为 `write`；不确定的店铺范围默认标记为 `unscoped`。
- 写操作必须与只读工具分离，并保留 destructive annotation。
- 认证端点只供服务内部调用。

## 架构

- MCP Tool 保持少而稳定，不为每个领星接口生成一个 Tool。
- 接口能力由 `catalog/endpoints.json` 驱动。
- 角色、店铺、Key 哈希和审计使用 SQLite；企业 App 凭据只从环境变量读取。
- 单实例部署使用进程内限流和会话；多实例前必须重新设计共享状态。

## 测试

缺陷修复先添加失败测试。完成前运行：

```bash
npm test
npm run check
npm audit --omit=dev --audit-level=high
docker build -t lingxing-mcp:test .
```
