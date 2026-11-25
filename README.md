# dsh-feishu-mcp

飞书全能力插件：`webhook` 结束强提醒 + 飞书自建应用私聊指挥。基于 `dsh-plugin-feishu-im` 的实现合并而来，并保留原有群 webhook 链路。

## 能力对照

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 扫码创建专属飞书应用 | 已合入 | 设置页「扫码创建飞书应用」；也可手动填 App ID / App Secret |
| 任务通知 | 已合入 | 每轮结束推卡片：结论 + 用时；失败带原因；取消静默 |
| 审批卡片 | 已合入 | 工具需授权时推「允许一次 / 拒绝」，点完 DSH 继续跑 |
| 提问卡片 | 已合入 | `ask_user_question` 选项变按钮，另有「输入你的答案」 |
| 进度 Typing | 已合入 | 收到消息加 Typing 反应，处理完撤掉，失败换 CrossMark |
| 私聊指挥 | 已合入 | 飞书私聊消息进入 DSH 会话，结果回同一个对话 |
| 插话 / 排队 | 已合入 | 忙时默认插话引导本轮；`/queue` 改为排队 |
| 会话切换 | 已合入 | `/sessions`、`/resume <编号｜id｜标题>` |
| 权限模式 | 已合入 | 只读 / 工作区读写 / Auto Review / 完全权限 |
| 会话位置 | 已合入 | 默认新建在 `~/dsh-plugin-feishu-im`，工作区名「飞书IM」，设置里可改 |
| 渲染 | 已合入 | Card JSON 2.0；应用消息用原生 table，webhook 用 markdown table；超长按段分页 |

## 两条链路

1. **出站（群 webhook 强提醒）**：监听 `session/event` 的 `turn/end`；`completed` / `error` / `max-tokens` 才发送，取消和子代理轮次静默。先发 `@all` 文本（可关），再发结果卡片。
2. **入站（飞书私聊 → DSH）**：`@larksuiteoapi/node-sdk` 的 `WSClient` 长连接订阅 `im.message.receive_v1`，无需公网回调地址。消息经白名单校验、去重后进入 DSH 会话；由飞书发起的轮次结束时只回原私聊，不重复发群 webhook。

## 飞书应用前置条件

1. 在飞书开放平台创建企业自建应用，开启「机器人」能力。
2. 开通权限 `im:message.p2p_msg:readonly`（接收私聊消息）；如需要主动发消息，还需 `im:message`。
3. 在「事件订阅」里选择 **使用长连接接收事件**，添加事件 `im.message.receive_v1`。
4. 发布应用版本，使权限与事件订阅生效。
5. 出站强提醒另外需要一个自定义机器人 webhook（群设置 → 机器人 → 添加自定义机器人）。

扫码创建使用的是飞书开放平台的设备码注册流程；如果企业租户禁用了该入口，用「手动连接」填 App ID / App Secret 即可，功能一致。

## 设置界面

刷新 Web GUI 后进入设置页的「飞书通知」分区：

- **群 Webhook 强提醒**：Webhook 地址、`@all`、任务完成开关、卡片标题、摘要长度；提供「保存 Webhook」与「测试消息」。
- **扫码创建飞书应用 / 已有飞书应用？手动连接**：二维码、轮询状态、App ID / App Secret / 域名、校验、断开。
- **推送内容**：任务完成 / 需要授权 / 需要你回答 三类开关。
- **飞书会话的位置**：工作文件夹与工作区名称。
- **会话权限**：默认权限四种模式。
- **指挥与安全**：允许指挥、启用飞书私聊入站、结果回原私聊、会话定位方式（`perChat` / `fixed` / `active`）、网页与飞书同时询问、等待上限、允许的 open_id。
- **部署方式**：可选把 DSH 做成用户级服务（Linux/systemd），Windows 上显示不可用。

密钥只保存在 `$DSH_HOME/dsh-feishu-mcp/state.json`，权限 `0600`；浏览器只拿到末 4 位掩码，不会接触 webhook 原文或 App Secret。

## Host 路由

全部挂在 `connection.fetch` 的精确路由下，浏览器用同源 cookie 调用：

- `GET /api/feishu-mcp/state`
- `POST /api/feishu-mcp/onboarding/begin`、`/onboarding/poll`、`/onboarding/cancel`
- `POST /api/feishu-mcp/credentials`、`/prefs`、`/verify`、`/test`、`/disconnect`、`/clear`
- `GET|POST /api/feishu-mcp/service`

## 验证状态

- `npm test`：12/12 通过；`node --check` 全部脚本通过。
- 出站 webhook：已用真实地址发送文本 + 卡片，返回 `StatusCode:0 / code:0`。
- 入站：代码与单测已就绪；真实长连接需要你提供飞书自建应用的 App ID / App Secret，并在飞书完成事件订阅后验证。

## 安装

```bash
npm install
```

然后用 DSH 的插件管理器安装本地目录，或在设置页更新已安装版本。
