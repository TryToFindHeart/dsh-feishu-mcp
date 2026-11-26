# dsh-feishu-mcp

A full-featured Feishu plugin for DeepSeek Harness: turn-end webhook reminders plus a Feishu self-built app bot for private-chat control. Keeps the original group webhook path and adds scan-to-create, chat control, approval and question cards.

## Features

- Scan-to-create a dedicated Feishu app, or enter App ID / App Secret manually.
- Turn-end cards with conclusion, duration and failure reason; `@all` reminder before the card.
- Approval cards with "allow once / deny"; question cards with option buttons and free-text answer.
- Typing reaction while processing, removed on success, replaced by CrossMark on failure.
- Private messages drive DSH sessions and the result returns to the same chat.
- Busy turns default to `steer` (inline guidance); `/queue` switches to queued delivery.
- Session commands: `/sessions`, `/resume`, `/new`, `/current`, `/id`.
- Four permission modes: readonly / workspace / Auto Review / full.
- Card 2.0 rendering with native tables for app messages and markdown tables for webhook; long content is paginated.

## Prerequisites

1. Create an enterprise self-built app in the Feishu Open Platform and enable the bot capability.
2. Grant `im:message.p2p_msg:readonly` (and `im:message` for sending messages).
3. Under event subscriptions, choose "use long connection to receive events" and add `im.message.receive_v1`.
4. Publish a version so permissions and events take effect.
5. Create a custom bot webhook in a Feishu group for outbound strong reminders.

## Settings

Open the "飞书通知" section in DSH settings. Webhook, scan-to-create, manual credentials, push toggles, session location, permissions, inbound toggles and service management are all there. Secrets are stored in `$DSH_HOME/dsh-feishu-mcp/state.json` with mode `0600`; the browser only ever sees masked tails.

## Routes

`GET /api/feishu-mcp/state`, `POST /api/feishu-mcp/{onboarding/begin,onboarding/poll,onboarding/cancel,credentials,prefs,verify,test,disconnect,clear}`, `GET|POST /api/feishu-mcp/service`.

## Status

- `npm test`: 12/12 passing; `node --check` clean.
- Outbound webhook verified against a real Feishu bot (`StatusCode:0`, `code:0`).
- Inbound long connection is implemented and unit-tested; real verification needs your Feishu App ID / App Secret and event subscription.
