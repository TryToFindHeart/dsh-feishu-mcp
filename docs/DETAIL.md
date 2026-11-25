# 飞书通知与私聊入站 · 插件详情

## 解决什么

DSH 在后台跑完一轮任务后，用户不一定盯着界面；同时用户也希望能在飞书私聊里直接给 DSH 派活，而不用切回电脑。插件把这两件事接起来：结果以卡片推到群里做强提醒，私聊消息则作为用户输入送进 DSH 会话。

## 出站：为什么用自定义机器人 webhook

出站只需要一个 URL，不需要公网回调、不需要应用凭证，实现和运维成本最低。webhook 本身即为密钥，因此：

- 不写进 `cordis.patch.yml` 或普通 Config；
- 不回传浏览器原文，只回末 4 位掩码；
- 落盘到 `~/.dsh/dsh-feishu-mcp/state.json`，写入时 0600 + 原子替换。

事件只消费 durable 事件：

| 事件 | 作用 |
| --- | --- |
| `turn/start` | 记录开始时间 |
| `assistant/message` | 记录最后一段助手正文 |
| `turn/end` | 汇总并投递 |

取消的轮次不播报，子代理轮次跳过，由父会话统一汇报。

## 入站：为什么用长连接

飞书自定义机器人 webhook 只能发不能收。要接收私聊必须用企业自建应用机器人。传统 Webhook 事件订阅需要公网 HTTPS 地址；飞书 Node SDK 的 `WSClient` 支持长连接，由客户端主动连出去，所以本地 DSH 不需要暴露端口或配置域名。

`lib/gateway.js` 负责生命周期：配置变化时按 `domain/appId/appSecret/enableInbound` 生成 key，key 变了就关闭旧连接再启动新连接；启动失败不缓存为“运行中”，下次配置保存会重试。

## 入站消息如何进 DSH

1. `im.message.receive_v1` 事件进入 `lib/inbound.js`。
2. 过滤 bot / app 发送者，只接受 `chat_type === 'p2p'`。
3. 用 `message_id` 去重（最多记 500 条），再用同一个 id 作为 `requestId` 提交，Feishu 重发也只算一次。
4. 白名单为空时认领第一个私聊者，之后锁定；避免把 DSH 暴露给任意飞书用户。
5. `sessionMode` 决定用哪个会话：`perChat` 每个私聊一个会话，`fixed` 用 `homeChatId` 绑定，`active` 跟随 DSH 当前会话。
6. `sessionController.prompt({ requestId, sessionId, mode, content })` 把文本送进去；忙时默认 `steer` 插话，显式 `/queue` 才排队。
7. `pending.set(sessionId, { chatId, messageId })` 记住等待回执的对话。

## 结果回哪

`lib/notifier.js` 在 `turn/end` 时先通过 `takeReply(sessionId)` 取出等待中的飞书回执：

- 有回执且开启 `inboundReply`：结果卡片通过应用机器人 API 回到原私聊，不再重复发 webhook。
- 没有回执：走原来的群 webhook，保持强提醒语义。
- 取消 / 子代理轮次：消费掉悬挂回执但不播报。

这样既能在飞书里连续对话，又不会同一轮收到两张卡。

## 设置页与路由

通过 `settings.section` 插槽注册到侧栏 Settings。页面只通过同源 Fetch 调用 Host 精确路由：

| 路由 | 用途 |
| --- | --- |
| `GET /state` | 读取脱敏后的配置 |
| `POST /config` | 保存全部配置，凭据留空表示保留 |
| `POST /verify` | 校验 App ID / Secret 并读取机器人身份，随后重连 |
| `POST /test` | 发送群 webhook 测试卡片 |
| `POST /disconnect` | 清除应用凭据，保留 webhook |
| `POST /clear` | 清空全部配置并停止长连接 |

App Secret 只写不回读；浏览器从不接触应用 token。

## 当前边界

- 只处理私聊文本；群聊、图片/文件消息不转发。
- 不做流式回写；只在轮次结束时发一条最终结果。
- 长连接依赖 `@larksuiteoapi/node-sdk`，安装/更新插件后需在插件目录 `npm install`。
