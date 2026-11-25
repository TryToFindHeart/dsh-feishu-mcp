# dsh-feishu-mcp

DSH 飞书插件：**任务结束卡片强提醒** + **飞书私聊消息转发到 DSH**。

## 功能

### 出站（群机器人 webhook）

- 监听 `turn/end`，任务完成 / 出错 / 达到 max-tokens 时推送结果卡片。
- 取消的轮次、子代理轮次静默，避免刷屏。
- 可选在卡片内 `@all` 强提醒，只发卡片，不额外发文本。
- 长文按块分页，最多 6 张卡片；表格默认用 Markdown 形式兼容老客户端。
- 失败时降级为纯文本，保证消息不丢。

### 入站（企业自建应用机器人）

- 通过飞书 Node SDK 的 WebSocket 长连接订阅 `im.message.receive_v1`，**不需要公网 IP、域名或回调地址**。
- 只处理私聊 `p2p`；按 `message_id` 去重，重试事件不会重复进入 DSH。
- 一个飞书私聊绑定一个 DSH 会话，支持会话列表、切换、新会话、停止、插话/排队。
- 由飞书发起的轮次，结果回到原私聊；没有回执目标时仍走群 webhook 强提醒。
- App Secret 只写不回读，浏览器只能看到掩码；状态文件权限 0600。

## 前置条件

出站只需要一个群自定义机器人 webhook 地址。

入站需要你在飞书开放平台创建**企业自建应用**：

1. 创建应用，开启「机器人」能力。
2. 开通权限 `im:message.p2p_msg:readonly`（如需读取用户信息再加 `contact:user.base:readonly`）。
3. 事件订阅添加 `im.message.receive_v1`，订阅方式选择**使用长连接接收事件**。
4. 发布应用版本；拿到 App ID / App Secret，填到插件设置页。
5. 在 DSH 设置页点「验证飞书应用」，确认机器人身份可用。

## 安装与更新

```pwsh
# 首次安装或更新后都要安装依赖（WebSocket 长连接需要 SDK）
npm install

# 在 DSH 里安装/更新本地 bundle
plugin_manager install_bundle(target = <本目录绝对路径>)
```

安装后在侧栏 Settings →「飞书通知」配置。改动配置后长连接会自动重连。

## 测试

```pwsh
# 全部单测（含入站去重、会话路由、回执不重复发 webhook）
npm test

# 只发一条 webhook 测试卡片
node scripts/webhook-smoke.mjs --url https://open.feishu.cn/open-apis/bot/v2/hook/...

# 顺带把地址写入本地 state.json
node scripts/webhook-smoke.mjs --url https://open.feishu.cn/open-apis/bot/v2/hook/... --save
```

## 飞书私聊命令

| 命令 | 作用 |
| --- | --- |
| 直接发消息 | 送入当前绑定的 DSH 会话；忙时默认插话 |
| `/queue <内容>` | 明确排队，不插话 |
| `/sessions [关键字]` | 列出可选会话 |
| `/resume <编号\|id\|标题>` | 切换当前会话 |
| `/current`、`/id` | 查看当前绑定 |
| `/new` | 开一个新会话 |
| `/stop` | 停止当前会话 |
| `/help` | 命令说明 |

## 目录

- `index.js`：Host 端，订阅 `session/event`、装配长连接、注册 `/api/feishu-mcp/*` 精确路由。
- `client.js`：Client 端设置页分区。
- `lib/state.js`：0600 状态文件与脱敏投影。
- `lib/card.js`：Markdown → Card 2.0 构造与分页。
- `lib/webhook.js`：出站 webhook 发送。
- `lib/notifier.js`：结束通知与回执路由。
- `lib/feishu.js`：tenant token、机器人身份、应用消息/卡片 API。
- `lib/gateway.js`：WebSocket 长连接生命周期。
- `lib/sessions.js`：飞书对话 ↔ DSH 会话绑定与切换。
- `lib/inbound.js`：私聊消息解析、去重、命令与入站提交。
- `scripts/webhook-smoke.mjs`：独立 webhook 连通性脚本。

## 安全

webhook 与 App Secret 都只保存在 `~/.dsh/dsh-feishu-mcp/state.json`（0600），不写进 `cordis.patch.yml`，也不回传原文给浏览器。不要把真实地址或密钥提交到仓库。
