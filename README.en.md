# dsh-feishu-mcp

A DSH plugin for **turn-end card reminders** and **forwarding Feishu private messages into DSH**.

## Features

### Outbound (custom-bot webhook)

- Sends a result card on `turn/end` when a turn is completed, errors, or hits max-tokens.
- Stays silent for cancelled turns and subagent turns.
- Optional `@all` mention inside the card only; no extra text message.
- Block-based pagination (max 6 cards) and Markdown tables for older clients.
- Falls back to plain text if a card is rejected.

### Inbound (self-built Feishu app bot)

- Subscribes to `im.message.receive_v1` over the Node SDK WebSocket long connection: **no public IP, domain, or callback URL required**.
- Handles private `p2p` chats only; deduplicates by `message_id` so Feishu retries do not re-enter DSH.
- Binds one Feishu chat to one DSH session, with session list, resume, new, stop, steer and queue commands.
- Turns started from a private chat reply in that chat; otherwise the group webhook reminder is used.
- App Secret is write-only; the browser only sees a masked value and the state file is mode 0600.

## Prerequisites

Create a self-built app in the Feishu Open Platform:

1. Create the app and enable the bot capability.
2. Grant `im:message.p2p_msg:readonly`.
3. Subscribe to `im.message.receive_v1` using **long connection** mode.
4. Publish a release and copy the App ID / App Secret into the plugin settings.
5. Click "Verify app" in settings to confirm the bot identity.

## Install / update

```pwsh
npm install
plugin_manager install_bundle(target = <absolute path to this directory>)
```

Then open Settings → Feishu Notify in the DSH sidebar. Config changes reconnect the long connection automatically.

## Test

```pwsh
npm test
node scripts/webhook-smoke.mjs --url https://open.feishu.cn/open-apis/bot/v2/hook/...
```

## Security

The webhook URL and App Secret are stored only in `~/.dsh/dsh-feishu-mcp/state.json` (mode 0600), never in `cordis.patch.yml`, and never returned in plaintext to the browser.
