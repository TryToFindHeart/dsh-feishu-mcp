# 设计细节

## 模块划分

- `index.js`：Host 装配。持有状态、注册 `connection.fetch` 精确路由、装配 gateway / inbound / notifier / answers / permissions / sessions，并监听 `session/event`。
- `client.js`：设置页。只通过同源 `/api/feishu-mcp/*` 与 Host 通信，不接触密钥原文。
- `lib/state.js`：`$DSH_HOME/dsh-feishu-mcp/state.json`，`0600` + 原子替换；`publicState()` 只回掩码与布尔值。
- `lib/webhook.js`、`lib/card.js`：群 webhook 出站，Card 2.0 构造与分页。
- `lib/feishu.js`：租户 token、机器人信息、应用消息、reactions、卡片更新、扫码注册等飞书 API。
- `lib/gateway-full.js`：`WSClient` 长连接；配置变化时重连。
- `lib/inbound-full.js`：私聊消息解析、去重、白名单、命令、会话路由、`sessionController.prompt`，以及静默跟随通知会话。
- `lib/notify-full.js`：`turn/end` 结果卡片、Typing 反应清理、失败 CrossMark、私聊回执，以及 Webhook 通道选择。
- `lib/answers.js`：审批 / 提问卡片与按钮回调。
- `lib/permissions.js`：四种权限模式。
- `lib/sessions.js`、`lib/captures.js`、`lib/labels.js`、`lib/restart.js`、`lib/service.js`：会话绑定、消息捕获、标签、重启与服务管理。
- `lib/constants.js`：统一的 `FSMCP_*` 自有常量；飞书平台要求的官方权限与事件标识只在此处映射，业务代码和文档不散写官方前缀。

`lib/inbound.js`、`lib/notifier.js`、`lib/gateway.js` 是早期通道实现，保留给原有单测；正式装配使用 `*-full.js` 版本。

## 两条通道

1. **群 Webhook**：监听 `session/event` 的 `turn/end`，只对 `completed` / `error` / `max-tokens` 播报；取消和子代理轮次静默。先发可选 `@all` 文本，再发结果卡片。
2. **飞书应用机器人**：`WSClient` 长连接订阅 `FSMCP_EVENT_MESSAGE_RECEIVE` 对应的飞书消息事件，无需公网回调地址。消息经白名单校验、按 `message_id` 去重后进入 DSH 会话；由飞书发起的轮次结束时只回原私聊，不再发群 webhook。

两个测试入口分开：`/test` 只测群 Webhook，`/test-app` 只测应用机器人，避免一次点击收到两条消息。

## 一次飞书私聊的生命周期

1. 用户私聊机器人 → 飞书通过长连接推送 `FSMCP_EVENT_MESSAGE_RECEIVE` 对应的消息事件。
2. `inbound-full.js` 过滤机器人消息、校验白名单、按 `message_id` 去重。
3. 解析 `/help`、`/sessions`、`/resume`、`/new`、`/queue`、`/permission`、`/stop` 等命令；普通文本走 `sessionController.prompt`。发送「切换会话」时直接返回按 `1. 会话标题` 序号排列、每个按钮独占一行的卡片，按钮 `value.k='resume'` 复用既有会话切换回调，不进入 prompt，也不影响其他命令；数量默认不限（硬上限 20），归档会话由 `sessions.list` 排除。
4. 忙时默认 `steer`（插话引导当前轮），显式 `/queue` 才 `queue`。
5. `pending` 记录 `{sessionId -> chatId}`；`turn/end` 时 notifier 先 `takeReply`，有回执就只回原私聊。
6. Typing 反应在收到消息时添加，结束时移除；失败改为 CrossMark。

## 通知路由与静默跟随

- Webhook 开启时，普通轮次只发群卡片；Webhook 关闭时，普通轮次改由应用机器人发送，不会两边都发。
- 应用机器人卡片会带上 `会话：工作区 › 会话标题` 和本轮正文，目标优先级为：该会话绑定的飞书对话 → 首页会话 → 主人私聊。
- 「跟随通知切换会话」默认开启：Webhook 关闭时，通知器在发出通知的同一刻就把收到通知的飞书对话（优先 `chat_id`）绑定到通知所属 `sessionId`，即使它此前绑定过别的会话也直接覆盖，并清空暂存的 `lastNoticeSessionId`。用户接着回复时自然进入正确会话；只有拿不到 `chat_id`、只能按 `open_id` 发通知时，才暂存 `lastNoticeSessionId`，由入站链路在下一条消息静默认领。
- DSH 没有 Host 端切换网页当前选中会话的接口，所以这里切换的是飞书对话与 DSH 会话的绑定；网页当前选中会话不变。

## 审批与提问

- `answers.js` 监听 `approval/request`、`user-questions/request`，通过 `sendCard` 推送卡片。
- 审批卡按钮：`allow_once` / `deny`；提问卡把单选题变成按钮，另有「输入你的答案」让文本回复进入 `captures`。
- 卡片回调通过长连接的 `card.action.trigger` 事件回传。

## 渲染

- 飞书应用消息使用 `markdown.js` 的 `buildContentCards`：Card 2.0，原生 table，代码围栏保护，超长按 `CARD_CHAR_BUDGET=6000` 分页，最多 6 张。
- 群 webhook 使用 `card.js`：相同卡片语义，但表格默认用 markdown table，避免部分自定义机器人客户端拒绝原生 table 元素。

## 安全边界

- Webhook 与 App Secret 都不进 cordis 配置，不进浏览器；`publicState()` 仅回末 4 位掩码和布尔值。
- 状态文件 `0600`，目录 `0700`；写入先写临时文件再 `rename`。
- 入站只接受白名单用户（为空时认领首个私聊用户），只处理 `p2p`，忽略群聊与机器人消息。
- 权限模式按飞书对话隔离，`auto` 模式优先使用宿主的 Auto Review。
