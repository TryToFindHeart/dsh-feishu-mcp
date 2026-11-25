# 设计细节

## 模块划分

- `index.js`：Host 装配。持有状态、注册 `connection.fetch` 精确路由、装配 gateway / inbound / notifier / answers / permissions / sessions，并监听 `session/event`。
- `client.js`：设置页。只通过同源 `/api/feishu-mcp/*` 与 Host 通信，不接触密钥原文。
- `lib/state.js`：`$DSH_HOME/dsh-feishu-mcp/state.json`，`0600` + 原子替换；`publicState()` 只回掩码。
- `lib/webhook.js`、`lib/card.js`：群 webhook 出站，Card 2.0 构造与分页。
- `lib/feishu.js`：租户 token、机器人信息、应用消息、 reactions、卡片更新、扫码注册等飞书 API。
- `lib/gateway-full.js`：`WSClient` 长连接；配置变化时重连。
- `lib/inbound-full.js`：私聊消息解析、去重、白名单、命令、会话路由、`sessionController.prompt`。
- `lib/notify-full.js`：`turn/end` 结果卡片、Typing 反应清理、失败 CrossMark、私聊回执。
- `lib/answers.js`：审批 / 提问卡片与按钮回调。
- `lib/permissions.js`：四种权限模式。
- `lib/sessions.js`、`lib/captures.js`、`lib/labels.js`、`lib/restart.js`、`lib/service.js`：会话绑定、消息捕获、标签、重启与服务管理。

原有 `lib/inbound.js`、`lib/notifier.js`、`lib/gateway.js` 保留用于现有单测；正式装配使用 `*-full.js` 版本。

## 一次飞书私聊的生命周期

1. 用户私聊机器人 → 飞书通过长连接推送 `im.message.receive_v1`。
2. `inbound-full.js` 过滤机器人消息、校验白名单、按 `message_id` 去重。
3. 解析 `/help`、`/sessions`、`/resume`、`/new`、`/queue`、`/permission`、`/stop` 等命令；普通文本走 `sessionController.prompt`。
4. 忙时默认 `steer`（插话引导当前轮），显式 `/queue` 才 `queue`。
5. `pending` 记录 `{sessionId -> chatId}`；`turn/end` 时 notifier 先 `takeReply`，有回执就只回原私聊，否则走群 webhook。
6. Typing 反应在收到消息时添加，结束时移除；失败改为 CrossMark。

## 审批与提问

- `answers.js` 监听 `approval/request`、`user-questions/request`，通过 `sendCard` 推送卡片。
- 审批卡按钮：`allow_once` / `deny`；提问卡把单选题变成按钮，另有「输入你的答案」让文本回复进入 `captures`。
- 卡片回调通过长连接的 `card.action.trigger` 事件回传（参考实现同款）。

## 渲染

- 飞书应用消息使用 `markdown.js` 的 `buildContentCards`：Card 2.0，原生 table，代码围栏保护，超长按 `CARD_CHAR_BUDGET=6000` 分页，最多 6 张。
- 群 webhook 使用 `card.js`：相同卡片语义，但表格默认用 markdown table，避免部分自定义机器人客户端拒绝原生 table 元素。

## 安全边界

- Webhook 与 App Secret 都不进 cordis 配置，不进浏览器；`publicState()` 仅回末 4 位掩码和布尔值。
- 状态文件 `0600`，目录 `0700`；写入先写临时文件再 `rename`。
- 入站只接受白名单用户（为空时认领首个私聊用户），只处理 `p2p`，忽略群聊与机器人消息。
- 权限模式按飞书对话隔离，`auto` 模式优先使用宿主的 Auto Review。
