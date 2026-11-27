# dsh-feishu-mcp

DeepSeek Harness 的飞书通知与指挥插件。把会话进展推送到飞书，也能在飞书里直接给 DSH 下达指令；所有消息都经过 DSH 处理后再回复。

[![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-blue?labelColor=555555&color=1f6feb)](https://github.com/deepseek-ai/deepseek-harness) [![Node.js](https://img.shields.io/badge/Node.js-22%2B-blue?labelColor=555555&color=1f6feb)](https://nodejs.org/) ![JavaScript](https://img.shields.io/badge/JavaScript-ESM-blue?labelColor=555555&color=6f42c1) ![Cordis](https://img.shields.io/badge/Cordis-plugin-orange?labelColor=555555&color=e3632d) ![tests](https://img.shields.io/badge/tests-32%2F32-green?labelColor=555555&color=2ea043) ![license](https://img.shields.io/badge/license-MIT-green?labelColor=555555&color=2ea043)

插件同时支持两条通道，并且分开测试、互不混淆：

- **群 Webhook 强提醒**：通过自定义机器人 webhook 把每轮结果推送到群里，支持 `@all`。（配置简单，仅有基础通知功能）
- **飞书应用机器人**：通过扫码创建或手动填写凭据连接自建应用，支持私聊指挥（文本、图片与文件）、审批/提问卡片、Typing 反应和会话绑定。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 任务结束通知 | 每轮结束时推送卡片：结论、用时、失败原因；取消和子代理轮次静默 |
| 双通道切换 | 「启用 Webhook 推送」开启走群卡片，关闭改由应用机器人发送；首次配置应用机器人时套用模板默认（关闭 Webhook、开启私聊长连接入站，并套用 `@all`、会话数量、等待上限等偏好），密钥、白名单和会话绑定仍是你自己的，之后以用户显式选择为准 |
| 模型可见与切换 | 每一轮回复/通知卡片都在底部小字显示当前模型，提醒确认付费模型；会话切换回执同样显示；私聊发 `/model` 打开模型按钮卡片，点一下即为该会话切换模型 |
| @all 强提醒 | `@all` 内嵌在群卡片正文，不额外发文本消息，只影响展示不影响是否推送 |
| 扫码创建应用 | 设置页生成二维码，用飞书扫码自动创建应用并回填 App ID / App Secret |
| 手动连接 | 租户禁用扫码时，直接填写 App ID / App Secret 即可，功能一致 |
| 审批卡片 | 工具需要授权时推「允许一次 / 拒绝」，点完 DSH 继续跑 |
| 提问卡片 | `ask_user_question` 的选项变按钮，另可点「输入你的答案」用文字回答 |
| Typing 反应 | 收到消息加 Typing 反应，处理完撤掉，失败换成 CrossMark |
| 私聊指挥 | 飞书私聊文本、图片或文件进入 DSH 会话，结果回到同一个对话；图片下载真实字节交给模型识别 |
| 文件识别 | 私聊收到 `file` 消息后下载真实字节，按目标会话上传并取得回执，模型按原文件名处理；能力缺失时明确提示 |
| 插话 / 排队 | 任务运行中的消息默认作为插话引导本轮；`/queue` 改为排队 |
| 会话切换 | `/sessions` 列会话，`/resume <编号｜id｜标题>` 切换 |
| 按钮切换会话 | 飞书私聊发「切换会话」返回按序号排列的会话按钮，按钮带会话 ID 短码，点一下即切换；默认不限（最多 20） |
| 跟随通知切换会话 | 关闭 Webhook 后，发通知时就把收信的飞书对话重绑到通知所属会话，后续回复自然跟过去 |
| 权限模式 | 只读 / 工作区读写 / Auto Review / 完全权限，按飞书对话隔离 |
| 会话位置 | 默认新建在 `~/dsh-feishu-mcp`，工作区名「飞书 DSH」，设置里可改 |
| 卡片渲染 | Card JSON 2.0；应用消息用原生 table，webhook 用 markdown table；超长按段分页 |

## 通知与会话规则

1. **Webhook 开启**：普通任务结束只发群 webhook 卡片，不重复发应用机器人。
2. **Webhook 关闭**：普通任务结束改由应用机器人发送，卡片带上会话标题和正文，并回到该会话绑定的飞书对话；没有绑定时回退到首页会话或主人私聊。
3. **由飞书发起的轮次**：结果始终回原来的飞书对话，不受 Webhook 开关影响，避免同一轮收到两份消息。
4. **跟随通知切换会话**：默认开启。关闭 Webhook 后，通知发出的同时就把收到通知的飞书对话绑定到通知所属会话（即使之前绑定过别的会话也会被覆盖），用户接着回复自然进入正确会话；关闭这个开关则保持原有会话定位逻辑。
5. **按钮切换会话**：飞书私聊发送「切换会话」会收到一张按 `1. 会话标题 · #短码` 排列的全按钮卡片，短码来自会话 ID 末 8 位，自动重命名后仍可定位；每个按钮独占一行，点一下即切换；默认不限制数量，最多 20 个（设置里可填 0 表示不限），归档会话不显示，按钮复用已有的会话切换回调，不影响其他命令。

> 说明：DSH 没有提供 Host 插件切换网页当前选中会话的接口，所以这里切换的是「飞书对话 → DSH 会话」的绑定。效果是你在飞书里接着通知回复会回到通知那个会话，网页当前选中的会话不会自动跳。

## 飞书前置条件

1. 在飞书开放平台创建企业自建应用，开启「机器人」能力。
2. 开通私聊消息接收、发送消息、读取机器人所在会话、下载消息资源等权限；代码里统一引用自有常量 `FSMCP_SCOPE_P2P_READ`、`FSMCP_SCOPE_MESSAGE_SEND`、`FSMCP_SCOPE_CHAT_READ`、`FSMCP_SCOPE_RESOURCE_READ`，不在业务代码和文档中散写官方前缀。
3. 在「事件订阅」中选择 **使用长连接接收事件**，添加消息接收事件；代码里统一引用自有常量 `FSMCP_EVENT_MESSAGE_RECEIVE`。长连接无需公网 IP、域名或回调白名单。
4. 发布应用版本，让权限与事件订阅生效。
5. 群 Webhook 强提醒另外需要一个自定义机器人地址（群设置 → 机器人 → 添加自定义机器人）。

以上飞书平台标识只在 `lib/constants.js` 中集中定义，业务代码与文档不散写官方前缀。

扫码创建使用飞书开放平台的设备码注册流程；如果企业租户禁用了该入口，用「手动连接」填 App ID / App Secret 即可，功能一致。

## 设置界面

刷新 Web GUI 后进入设置页的「飞书通知」分区，界面按三块组织：

- **全局设置**：任务完成 / 需要授权 / 需要你回答三类通知开关、卡片标题、摘要长度、会话工作文件夹、工作区名称、默认权限；并说明每轮卡片底部会显示当前模型、私聊 `/model` 可切换本会话模型。
- **飞书应用机器人**：连接状态、扫码创建 / 手动连接、测试 / 校验 / 断开、允许指挥、启用私聊入站、结果回原私聊、跟随通知切会话、会话定位方式、切换会话按钮数量、双端询问、等待上限、允许的 open_id。
- **群 Webhook（可选）**：Webhook 地址、`@all`、启用开关、保存 / 测试；这里只放 Webhook 专属项，不再重复全局开关。

密钥只保存在 `$DSH_HOME/dsh-feishu-mcp/state.json`，权限 `0600`；浏览器只拿到末 4 位掩码，不会接触 Webhook 原文或 App Secret。

## Host 路由

全部挂在 `connection.fetch` 的精确路由下，浏览器用同源 cookie 调用：

- `GET /api/feishu-mcp/state`
- `POST /api/feishu-mcp/onboarding/begin`、`/onboarding/poll`、`/onboarding/cancel`
- `POST /api/feishu-mcp/credentials`、`/prefs`、`/verify`
- `POST /api/feishu-mcp/test`、`/test-app`、`/disconnect`、`/clear`

## 验证状态

- `npm test`：32/32 通过（9 个测试文件）；全部 JS/MJS 脚本 `node --check` 通过。
- 出站 Webhook：已用真实地址发送卡片（内嵌 `@all`），返回 `StatusCode:0 / code:0`。
- 应用机器人：扫码连接与测试消息已通过界面验证。
- 跟随通知切换会话：已用真实通知与 `state.json` 变更验证。
- 文件识别：已用模拟飞书 `file` 消息验证下载、按会话上传回执与提示分支。
- 模型可见与切换：已用单测验证每张卡片底部显示当前模型；`/model` 按钮卡片与会话切换回执同样带模型信息。
- 入站真实链路：代码与单测已就绪；打开「启用飞书私聊入站」并完成事件订阅后可联调。

## 安装

```bash
npm install
```

然后用 DSH 的插件管理器安装本地目录，或在设置页更新已安装版本。插件入口为 `include:feishu-mcp`。

> **首次安装或更新后**：请**完全退出整个 DeepSeek Harness 进程再重新启动**（不是只关闭设置窗口或 DSH 窗口），Host 模块和新路由才会加载；重启后再打开「设置 → 飞书通知」。只关窗口不重启，插件不会生效，页面会出现 `HTTP 404` 或仍显示旧版本。
