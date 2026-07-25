# Agent 接入指南

## 通用配置

支持 Streamable HTTP 的 MCP Client 使用：

```json
{
  "mcpServers": {
    "LingXing-MCP": {
      "type": "streamableHttp",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Mcp-Key": "lxmcp_个人Key"
      }
    }
  }
}
```

不同 Agent 产品的配置文件位置可能不同，但协议地址和请求头一致。

## 推荐调用顺序

1. `list_my_permissions`：确认 uid、角色、店铺和权限同步时间；
2. `search_endpoints`：按标题、路径、模块和读写类型搜索；
3. `get_endpoint_schema`：确认参数、店铺范围和官方文档；
4. `call_read_endpoint` 或 `call_write_endpoint`；
5. `get_api_changes`：检查版本新增接口。

示例：

```text
调用 list_my_permissions，确认我能访问哪些店铺。
搜索 sales 模块中标题包含“订单”的只读接口。
读取 GET /... 的参数定义。
仅查询 sid=101，不要调用任何写接口。
```

## curl 协议验收

```bash
export MCP_URL='https://mcp.example.com/mcp'
export MCP_KEY='替换为个人Key'

curl --fail-with-body -i "$MCP_URL" \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Mcp-Key: $MCP_KEY" \
  --data '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"initialize",
    "params":{
      "protocolVersion":"2025-11-25",
      "capabilities":{},
      "clientInfo":{"name":"curl-check","version":"1.0.0"}
    }
  }'
```

预期 HTTP 200，并返回 `Mcp-Session-Id`。不要把命令历史或终端截图中的真实 Key 发到群聊。

## 常见错误

| HTTP/工具错误 | 含义 |
| --- | --- |
| 401 | `X-Mcp-Key` 缺失、格式错误、未知或已吊销 |
| 403 | 当前会话绑定了另一个 Key，或 Origin 不允许 |
| 404 + `MCP 会话不存在` | 会话过期，客户端应重新 initialize |
| 503 | ERP 权限同步失败，服务按 fail closed 拒绝 |
| `FUNCTION_FORBIDDEN` | 当前 ERP 角色没有对应本地功能授权 |
| `STORE_FORBIDDEN` | 请求包含不属于当前用户的店铺 |
| `STORE_REQUIRED` | 多店铺用户必须显式选择标量 `sid` |
| `UNSCOPED_FORBIDDEN` | 接口无法可靠按店铺收窄，缺少精确授权 |
| `OPERATION_MISMATCH` | 读写工具选错，或接口被安全地归类为写操作 |
