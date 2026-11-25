# dsh-feishu-mcp

DSH 任务结束时向飞书自定义机器人 webhook 推送结果卡片的插件。当前版本只实现**出站通知**；入站私聊监听订阅留待下一阶段。

## 功能

- 监听 `turn/end`，在任务完成 / 出错 / 达到 max-tokens 时发送卡片。
- 取消的轮次、子代理轮次静默，避免刷屏。
- 可选先发一条带 `@all` 的文本强提醒，再发结果卡片。
- 设置页（侧栏 Settings → 飞书通知）配置 webhook、卡片标题、正文长度、开关。
- webhook 视作密钥：只写到 `~/.dsh/dsh-feishu-mcp/state.json`（0600），浏览器只能看到掩码。
- 卡片基于 Card JSON 2.0，长文按块分页，最多 6 张；表格默认用 Markdown 形式兼容老客户端。

## 快速验证

```pwsh
# 只发一条测试消息，不写配置
node scripts/webhook-smoke.mjs --url https://open.feishu.cn/open-apis/bot/v2/hook/...

# 同时把地址写入本地 state.json
node scripts/webhook-smoke.mjs --url https://open.feishu.cn/open-apis/bot/v2/hook/... --save

# 单元测试
npm test
```

## 安装

用 Plugin Manager 安装本地 bundle：

```
plugin_manager install_bundle(target = <本目录绝对路径>)
```

安装后在侧栏 Settings →「飞书通知」中填写 webhook，点击“发送测试消息”确认连通。

## 目录

- `index.js`：Host 端，订阅 `session/event` 并注册 `/api/feishu-mcp/*` 精确路由。
- `client.js`：Client 端，注册设置页分区。
- `lib/state.js`：0600 状态文件读写与脱敏投影。
- `lib/card.js`：Markdown → 飞书 Card 2.0 构造与分页。
- `lib/webhook.js`：webhook 请求、返回码校验、文本/卡片/@all 发送。
- `lib/notifier.js`：从 durable 事件折叠出结束通知并投递。
- `scripts/webhook-smoke.mjs`：独立连通性测试脚本。

## 下一阶段

接入飞书企业自建应用机器人的 `im.message.receive_v1` 长连接，把私聊消息转发到 DSH；本阶段不做。
