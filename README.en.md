# dsh-feishu-mcp

A Feishu notification and control plugin for DeepSeek Harness. It pushes session progress to Feishu and lets you drive DSH from a Feishu chat; every message is processed by DSH before it is returned.

The plugin has two separate channels with separate test buttons:

- **Group webhook reminders**: a custom-bot webhook pushes each turn result to a group, with optional `@all`.
- **Feishu app bot**: connect a self-built app by scanning a QR code or entering credentials manually. It supports private-chat control, approval/question cards, typing reactions and session binding.

## Features

- Turn-end cards with conclusion, duration and failure reason; cancelled and sub-agent turns stay silent.
- Webhook toggle: enabled sends group cards only; disabled sends notifications through the app bot only.
- `@all` mention is embedded in the group card; no separate text message is sent; affects presentation, not whether a notice is sent.
- Scan-to-create a dedicated Feishu app, or enter App ID / App Secret manually if your tenant disables device-code registration.
- Approval cards with "allow once / deny"; question cards with option buttons and a free-text answer.
- Typing reaction while processing, removed on success and replaced by CrossMark on failure.
- Private messages drive DSH sessions and the result returns to the same chat.
- Busy turns default to `steer` (inline guidance); `/queue` switches to queued delivery.
- Session commands: `/sessions`, `/resume <no|id|title>`, `/new`, `/current`, `/id`.
- Follow-notice session switching: when Webhook is off, the Feishu chat that receives a notice is rebound to the notified session immediately, so replies naturally continue in the right session.
- Four permission modes: readonly / workspace / Auto Review / full, scoped per Feishu chat.
- Session location is configurable; the default workspace is `飞书 DSH` under `~/dsh-feishu-mcp`.
- Card 2.0 rendering: native tables for app messages, markdown tables for webhook, long content paginated.

## Notification and session rules

1. Webhook on: normal turn-end notices go to the group webhook only.
2. Webhook off: normal turn-end notices go through the app bot, carry the session title and answer, and are delivered to the bound Feishu chat; if none is bound, they fall back to the home chat or owner chat.
3. Turns started from Feishu always answer in the originating chat and never duplicate to the group webhook.
4. Follow-notice switching is on by default. When Webhook is off, sending a notice immediately binds the receiving Feishu chat to the notified session, overwriting any previous binding. Turn it off to keep the previous session resolution behavior.

> DSH does not expose a Host API for changing the session selected in the web UI. This plugin switches the **Feishu chat → DSH session binding**, so continuing in Feishu lands in the notified session; the web UI selection is not changed.

## Prerequisites

1. Create an enterprise self-built app in the Feishu Open Platform and enable the bot capability.
2. Grant `im:message.p2p_msg:readonly`; grant `im:message` too if the bot must send messages proactively.
3. Under event subscriptions, choose "use long connection to receive events" and add `im.message.receive_v1`. No public IP, domain or callback whitelist is needed.
4. Publish a version so permissions and events take effect.
5. Create a custom-bot webhook in a Feishu group for outbound strong reminders.

## Settings

Open the "飞书通知" section in DSH settings. It contains the webhook settings and test button, connection status and app test button, scan/manual onboarding, push switches (including Webhook enable and follow-notice switching), session location, permission modes and inbound controls.

Secrets are stored in `$DSH_HOME/dsh-feishu-mcp/state.json` with mode `0600`; the browser only ever sees masked tails.

## Routes

`GET /api/feishu-mcp/state`, `POST /api/feishu-mcp/{onboarding/begin,onboarding/poll,onboarding/cancel,credentials,prefs,verify,test,test-app,disconnect,clear}`, `GET|POST /api/feishu-mcp/service`.

## Status

- `npm test`: 19/19 passing; 21 JS files pass `node --check`.
- Outbound webhook verified against a real Feishu bot (`StatusCode:0`, `code:0`).
- App bot connection and test message verified in the UI.
- Inbound long connection is implemented and unit-tested; final live verification needs your Feishu App ID / App Secret and event subscription.

## Install

```bash
npm install
```

Then install the local directory with the DSH plugin manager, or update the installed version in settings. Plugin entry: `include:feishu-mcp`.
