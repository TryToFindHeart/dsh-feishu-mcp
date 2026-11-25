# dsh-feishu-mcp

A DSH plugin that pushes result cards to a Feishu custom-bot webhook when a turn ends. This version is outbound-only; inbound private-chat subscription comes later.

## Features

- Listens to `turn/end` and sends a card on completed / error / max-tokens.
- Stays silent for cancelled turns and subagent turns.
- Optional `@all` text before the card for strong reminders.
- Settings page for webhook URL, card title, body limit and toggles.
- The webhook URL is treated as a secret: stored only in `~/.dsh/dsh-feishu-mcp/state.json` (mode 0600); the browser only receives a masked value.
- Card JSON 2.0 with block-based pagination (max 6 cards) and Markdown tables for compatibility.

## Test

```pwsh
node scripts/webhook-smoke.mjs --url https://open.feishu.cn/open-apis/bot/v2/hook/...
npm test
```
