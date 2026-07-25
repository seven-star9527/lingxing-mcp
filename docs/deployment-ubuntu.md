# 腾讯云 Ubuntu 生产部署指南

以下流程适用于腾讯云 Ubuntu 24.04 LTS 单机部署，使用 Docker Compose、Caddy 自动 HTTPS 和 SQLite。

## 1. 准备资源

需要：

- 一台具有固定公网 IPv4 的腾讯云 CVM；
- 建议 Ubuntu 24.04 LTS；
- 一个域名，例如 `mcp.example.com`；
- 将域名 A 记录指向 CVM 公网 IP；
- 领星后台的 App ID/App Secret；
- 在领星开放接口 IP 白名单中加入该 CVM 公网出口 IP。

如果 CVM 位于中国大陆，域名必须先完成 ICP 备案；域名原先在其他服务商备案的，还需完成腾讯云接入备案。境外地域不走中国大陆 ICP 流程，但应遵守实例所在地要求。

腾讯云安全组只开放：

- TCP 22：限制为管理员固定 IP；
- TCP 80：Caddy 申请和续期证书；
- TCP/UDP 443：MCP HTTPS。

不要开放 8099。

## 2. 安装 Docker

以下命令来自 [Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

## 3. 下载项目

```bash
sudo mkdir -p /opt/lingxing-mcp
sudo chown "$USER":"$USER" /opt/lingxing-mcp
git clone https://github.com/seven-star9527/lingxing-mcp.git /opt/lingxing-mcp
cd /opt/lingxing-mcp
cp deploy/.env.example deploy/.env
cp deploy/role-mapping.example.json deploy/role-mapping.json
mkdir -p deploy/data
sudo chown -R 1000:1000 deploy/data
chmod 700 deploy/data
chmod 600 deploy/.env
```

## 4. 生成 Pepper

先用一次性容器生成：

```bash
sudo docker run --rm node:24-bookworm-slim \
  node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

把输出填入 `deploy/.env` 的 `LINGXING_MCP_KEY_PEPPER`。该值用于 API Key 哈希，部署后不要随意更换；更换后所有现有 Key 都会失效。

编辑配置：

```bash
nano deploy/.env
```

至少填写：

```dotenv
MCP_DOMAIN=mcp.example.com
LINGXING_APP_ID=你的AppID
LINGXING_APP_SECRET=你的AppSecret
LINGXING_BASE_URL=https://openapi.lingxing.com
LINGXING_MCP_KEY_PEPPER=刚生成的随机值
```

## 5. 构建并启动

```bash
sudo docker compose -f deploy/compose.yaml config
sudo docker compose -f deploy/compose.yaml build --pull
sudo docker compose -f deploy/compose.yaml up -d
sudo docker compose -f deploy/compose.yaml ps
sudo docker compose -f deploy/compose.yaml logs --tail=100 lingxing-mcp
sudo docker compose -f deploy/compose.yaml logs --tail=100 caddy
```

Caddy 会自动申请 HTTPS 证书。验证：

```bash
curl --fail --silent --show-error \
  https://mcp.example.com/healthz | jq
```

应返回 `ok: true`、Server 版本、目录版本和端点数量。

## 6. 同步用户与角色

先同步 ERP 用户。`uid` 可从领星“查询 ERP 用户信息列表”或管理员账号确认：

```bash
sudo docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js sync-user --uid 123
```

复制并审查角色映射：

```bash
cp config/role-mapping.example.json deploy/role-mapping.json
nano deploy/role-mapping.json
```

示例不能直接当作生产权限。确认每个领星角色允许访问的模块和读写范围后：

```bash
sudo docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js apply-role-map \
  --file /config/role-mapping.json
```

`deploy/role-mapping.json` 已由 Compose 只读挂载；仓库中的空映射默认不授予任何权限。也可使用单条 `grant-role`：

```bash
sudo docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js grant-role \
  --role "销售专员" --module sales --access read
```

对于无法按店铺收窄的接口，必须精确授权：

```bash
sudo docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js grant-role \
  --role "财务主管" \
  --module finance \
  --access read \
  --endpoint-id "POST /精确/API/Path" \
  --allow-unscoped
```

## 7. 创建个人 API Key

```bash
sudo docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js create-key \
  --uid 123 \
  --label "Alice Codex"
```

Key 只显示一次。每个用户、每台 Agent 建议创建独立 Key。

## 8. Agent 接入

```json
{
  "mcpServers": {
    "LingXing-MCP": {
      "type": "streamableHttp",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Mcp-Key": "个人API-Key"
      }
    }
  }
}
```

接入后首先让 Agent 调用 `list_my_permissions`，核对 uid、角色和店铺，随后调用 `search_endpoints`。

## 9. 更新

```bash
cd /opt/lingxing-mcp
target_version=v0.1.0
git fetch --tags origin
sudo ./deploy/backup.sh
git checkout "$target_version"
sudo sed -i \
  "s/^LINGXING_MCP_VERSION=.*/LINGXING_MCP_VERSION=${target_version#v}/" \
  deploy/.env
sudo docker compose -f deploy/compose.yaml build --pull
sudo docker compose -f deploy/compose.yaml up -d --force-recreate
sudo docker compose -f deploy/compose.yaml ps
```

更新前后都应运行健康检查，并通过个人 Key 初始化 MCP 会话。

若新版本健康检查或 MCP 验收失败，切回上一个已知正常 tag，并恢复升级前备份：

```bash
previous_version=v上一个版本
git checkout "$previous_version"
sudo sed -i \
  "s/^LINGXING_MCP_VERSION=.*/LINGXING_MCP_VERSION=${previous_version#v}/" \
  deploy/.env
sudo docker compose -f deploy/compose.yaml build --pull
sudo sh deploy/restore.sh \
  /opt/lingxing-mcp-backups/access-升级前时间.sqlite \
  /opt/lingxing-mcp
```

## 10. 备份与恢复

备份：

```bash
sudo mkdir -p /opt/lingxing-mcp-backups
sudo sh deploy/backup.sh /opt/lingxing-mcp /opt/lingxing-mcp-backups
```

建议用 root crontab 每天执行，并把备份同步到启用服务端加密和生命周期规则的腾讯云 COS。脚本默认清理 30 天前本地备份。`LINGXING_MCP_KEY_PEPPER` 不在数据库内，应另存到腾讯云密钥管理系统或加密的离线备份；恢复演练必须同时验证旧 Key 仍可认证。

恢复前先确认备份文件：

```bash
sudo sh deploy/restore.sh \
  /opt/lingxing-mcp-backups/access-YYYYMMDDTHHMMSSZ.sqlite \
  /opt/lingxing-mcp
```

## 11. 运维检查

```bash
sudo docker compose -f deploy/compose.yaml ps
sudo docker compose -f deploy/compose.yaml logs --since=30m lingxing-mcp
sudo docker stats --no-stream
df -h
sudo ss -lntup
```

确认公网只监听 22、80、443；8099 只能存在于 Docker 内部网络。

查看拒绝记录：

```bash
sudo docker compose -f deploy/compose.yaml exec lingxing-mcp \
  node src/admin-cli.js audit --limit 100
```

## 12. 密钥轮换

- 个人离职或设备丢失：立即 `revoke-key --id ...`，不影响其他用户；
- `X-Mcp-Key` 泄露：吊销并为该客户端创建新 Key；
- App Secret 泄露：在领星后台重置 App Secret，更新 `deploy/.env`，再执行 `sudo docker compose up -d --force-recreate lingxing-mcp`；
- Pepper 泄露：生成新 Pepper，并重新签发全部个人 Key。
