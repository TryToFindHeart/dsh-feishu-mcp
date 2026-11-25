// dsh-feishu-mcp — client half.
//
// 在设置页注册「飞书通知」分区。页面只通过同源 Fetch 调用 Host 注册的
// /api/feishu-mcp/* 精确路由；浏览器永远拿不到 webhook 原文。
// 以 classic script 加载，注册到 DSH client module loader。
(function () {
  'use strict';

  var PLUGIN_ID = 'dsh-feishu-mcp';
  var API = '/api/feishu-mcp';
  var BUILD = '0.1.0';

  var CSS = [
    '.fsmcp-page{display:flex;flex-direction:column;gap:18px;max-width:760px;color:var(--dsw-alias-label-primary,#1a1a1a);}',
    '.fsmcp-head{display:flex;flex-direction:column;gap:6px;}',
    '.fsmcp-title{font-size:20px;font-weight:600;line-height:1.3;margin:0;}',
    '.fsmcp-sub{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0;}',
    '.fsmcp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
    '.fsmcp-card-head{padding:14px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:10px;}',
    '.fsmcp-card-title{font-size:14px;font-weight:600;margin:0;}',
    '.fsmcp-card-body{padding:16px;display:flex;flex-direction:column;gap:14px;}',
    '.fsmcp-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}',
    '.fsmcp-row-text{display:flex;flex-direction:column;gap:3px;min-width:0;}',
    '.fsmcp-label{font-size:13px;font-weight:500;}',
    '.fsmcp-hint{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);}',
    '.fsmcp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
    '.fsmcp-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:6px;}',
    '.fsmcp-dot-on{background:var(--dsw-alias-state-success-primary);}',
    '.fsmcp-dot-off{background:var(--dsw-alias-state-idle-primary);}',
    '.fsmcp-btn{appearance:none;-webkit-appearance:none;height:32px;padding:0 14px;border-radius:8px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;border:1px solid transparent;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;}',
    '.fsmcp-btn:disabled{opacity:.5;cursor:default;}',
    '.fsmcp-btn-primary{background:var(--dsw-alias-brand-primary,#2f7cf6);color:var(--dsw-alias-bg-base,#fff);-webkit-text-fill-color:var(--dsw-alias-bg-base,#fff);}',
    '.fsmcp-btn-ghost{background:var(--dsw-alias-bg-layer-2,#f2f3f5);border-color:var(--dsw-alias-border-l2,#d0d3d9);color:var(--dsw-alias-label-primary,#1a1a1a);-webkit-text-fill-color:currentColor;}',
    '.fsmcp-btn-danger{background:transparent;border-color:var(--dsw-alias-border-l2,#d0d3d9);color:var(--dsw-alias-state-error-primary,#d92d20);-webkit-text-fill-color:currentColor;}',
    '.fsmcp-actions{display:flex;gap:8px;flex-wrap:wrap;}',
    '.fsmcp-input{height:34px;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;padding:0 10px;outline:none;}',
    '.fsmcp-input:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.fsmcp-field{display:flex;flex-direction:column;gap:6px;}',
    '.fsmcp-field-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);}',
    '.fsmcp-switch{position:relative;width:40px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#2a2a2a);cursor:pointer;flex:none;}',
    '.fsmcp-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#2f7cf6);border-color:var(--dsw-alias-brand-primary,#2f7cf6);}',
    '.fsmcp-switch::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);}',
    '.fsmcp-switch[aria-checked="true"]::after{transform:translateX(18px);}',
    '.fsmcp-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-state-error-primary);}',
    '.fsmcp-ok{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-state-success-primary);}',
    '.fsmcp-warn{border:1px solid var(--dsw-alias-state-warn-primary,#b54708);border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.55;color:var(--dsw-alias-state-warn-primary,#b54708);}',
    '.fsmcp-footer{font-size:11px;color:var(--dsw-alias-label-secondary);}'
  ].join('');

  async function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    var response = await fetch(API + path, init);
    var text = await response.text();
    var data = {};
    if (text) {
      try { data = JSON.parse(text); }
      catch (error) { throw new Error('服务返回了无法解析的响应（HTTP ' + response.status + '）'); }
    }
    if (!response.ok) throw new Error(data.error || ('请求失败（HTTP ' + response.status + '）'));
    return data;
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function createComponents(React, t) {
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      render() {
        if (this.state.error) {
          return h('div', { className: 'fsmcp-page' },
            h('div', { className: 'fsmcp-error' },
              '飞书通知页面渲染失败：', String((this.state.error && this.state.error.message) || this.state.error)));
        }
        return this.props.children;
      }
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'fsmcp-switch',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        title: props.label,
        onClick: function () { props.onChange(!props.checked); },
      });
    }

    function Row(props) {
      return h('div', { className: 'fsmcp-row' },
        h('div', { className: 'fsmcp-row-text' },
          h('div', { className: 'fsmcp-label' }, props.label),
          props.hint ? h('div', { className: 'fsmcp-hint' }, props.hint) : null),
        props.control);
    }

    function Card(props) {
      return h('div', { className: 'fsmcp-card' },
        h('div', { className: 'fsmcp-card-head' },
          h('h3', { className: 'fsmcp-card-title' }, props.title)),
        h('div', { className: 'fsmcp-card-body' }, props.children));
    }

    function Page() {
      var statePair = useState(null);
      var saved = statePair[0];
      var setSaved = statePair[1];
      var formPair = useState({ webhookUrl: '', webhookAtAll: true, notifyTurnEnd: true, cardTitle: 'DSH 任务结束提醒', maxChars: 1200, trace: false });
      var form = formPair[0];
      var setForm = formPair[1];
      var busyPair = useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var messagePair = useState(null);
      var message = messagePair[0];
      var setMessage = messagePair[1];

      function applyState(value) {
        setSaved(value);
        setForm({
          webhookUrl: '',
          webhookAtAll: value.webhookAtAll,
          notifyTurnEnd: value.notifyTurnEnd,
          cardTitle: value.cardTitle,
          maxChars: value.maxChars,
          trace: value.trace,
        });
      }

      useEffect(function () {
        var alive = true;
        api('/state').then(function (result) {
          if (alive) applyState(result.state);
        }).catch(function (error) {
          if (alive) setMessage({ kind: 'error', text: errorMessage(error) });
        });
        return function () { alive = false; };
      }, []);

      function update(key, value) {
        var next = {};
        Object.keys(form).forEach(function (item) { next[item] = form[item]; });
        next[key] = value;
        setForm(next);
      }

      async function save() {
        setBusy(true);
        setMessage(null);
        try {
          var body = {
            webhookAtAll: form.webhookAtAll,
            notifyTurnEnd: form.notifyTurnEnd,
            cardTitle: form.cardTitle,
            maxChars: form.maxChars,
            trace: form.trace,
          };
          // 留空表示保留已保存的 webhook（Host 侧也做了同样处理）。
          if (form.webhookUrl) body.webhookUrl = form.webhookUrl;
          var result = await api('/config', { method: 'POST', body: body });
          applyState(result.state);
          setMessage({ kind: 'ok', text: '配置已保存。' });
        } catch (error) {
          setMessage({ kind: 'error', text: errorMessage(error) });
        } finally {
          setBusy(false);
        }
      }

      async function test() {
        setBusy(true);
        setMessage(null);
        try {
          var result = await api('/test', { method: 'POST', body: {} });
          setMessage({ kind: result.ok ? 'ok' : 'error', text: result.ok ? '测试消息已发送，请到飞书群确认。' : '部分发送失败：' + JSON.stringify(result.results) });
        } catch (error) {
          setMessage({ kind: 'error', text: errorMessage(error) });
        } finally {
          setBusy(false);
        }
      }

      async function clear() {
        setBusy(true);
        setMessage(null);
        try {
          var result = await api('/clear', { method: 'POST', body: {} });
          applyState(result.state);
          setMessage({ kind: 'ok', text: '配置已清空。' });
        } catch (error) {
          setMessage({ kind: 'error', text: errorMessage(error) });
        } finally {
          setBusy(false);
        }
      }

      return h('div', { className: 'fsmcp-page' },
        h('div', { className: 'fsmcp-head' },
          h('h2', { className: 'fsmcp-title' }, t('title')),
          h('p', { className: 'fsmcp-sub' }, t('description'))),

        message ? h('div', { className: 'fsmcp-' + (message.kind === 'ok' ? 'ok' : 'error') }, message.text) : null,

        h(Card, { title: t('webhookCard') },
          h(Row, {
            label: t('status'),
            hint: t('statusHint'),
            control: h('span', { className: 'fsmcp-inline' },
              h('span', { className: 'fsmcp-dot ' + (saved && saved.configured ? 'fsmcp-dot-on' : 'fsmcp-dot-off') }),
              h('span', { className: 'fsmcp-value' }, saved && saved.configured ? t('connected') : t('notConnected'))),
          }),
          saved && saved.configured
            ? h(Row, { label: t('currentWebhook'), hint: t('maskHint'), control: h('span', { className: 'fsmcp-mono' }, saved.webhookMasked) })
            : null,
          h('div', { className: 'fsmcp-field' },
            h('span', { className: 'fsmcp-field-label' }, t('webhook')),
            h('input', {
              className: 'fsmcp-input',
              type: 'url',
              value: form.webhookUrl,
              placeholder: saved && saved.configured ? t('keepCurrent') : 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
              onChange: function (event) { update('webhookUrl', event.target.value); },
            }),
            h('span', { className: 'fsmcp-hint' }, t('webhookHint')))),

        h(Card, { title: t('behaviorCard') },
          h(Row, {
            label: t('notifyTurnEnd'),
            hint: t('notifyTurnEndHint'),
            control: h(Switch, { label: t('notifyTurnEnd'), checked: form.notifyTurnEnd, onChange: function (value) { update('notifyTurnEnd', value); } }),
          }),
          h(Row, {
            label: t('atAll'),
            hint: t('atAllHint'),
            control: h(Switch, { label: t('atAll'), checked: form.webhookAtAll, onChange: function (value) { update('webhookAtAll', value); } }),
          }),
          h('div', { className: 'fsmcp-field' },
            h('span', { className: 'fsmcp-field-label' }, t('cardTitle')),
            h('input', {
              className: 'fsmcp-input',
              type: 'text',
              value: form.cardTitle,
              onChange: function (event) { update('cardTitle', event.target.value); },
            })),
          h('div', { className: 'fsmcp-field' },
            h('span', { className: 'fsmcp-field-label' }, t('maxChars')),
            h('input', {
              className: 'fsmcp-input',
              type: 'number',
              min: '200',
              max: '8000',
              value: String(form.maxChars),
              onChange: function (event) { update('maxChars', Number(event.target.value)); },
            }),
            h('span', { className: 'fsmcp-hint' }, t('maxCharsHint'))),
          h(Row, {
            label: t('trace'),
            hint: t('traceHint'),
            control: h(Switch, { label: t('trace'), checked: form.trace, onChange: function (value) { update('trace', value); } }),
          })),

        h('div', { className: 'fsmcp-actions' },
          h('button', { type: 'button', className: 'fsmcp-btn fsmcp-btn-primary', disabled: busy, onClick: save }, t('save')),
          h('button', { type: 'button', className: 'fsmcp-btn fsmcp-btn-ghost', disabled: busy || !saved || !saved.configured, onClick: test }, t('test')),
          h('button', { type: 'button', className: 'fsmcp-btn fsmcp-btn-danger', disabled: busy || !saved || !saved.configured, onClick: clear }, t('clear'))),

        h('div', { className: 'fsmcp-warn' }, t('warning')),
        h('div', { className: 'fsmcp-footer' }, 'dsh-feishu-mcp · build ' + BUILD));
    }

    return { Boundary: Boundary, Page: Page };
  }

  function createPlugin(require, ctx) {
    var React = require('react');
    var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
    var language = 'zh';
    try {
      var current = locale && typeof locale.current === 'function' ? locale.current() : undefined;
      var value = current && typeof current === 'object' ? current.locale || current.language || current.id : current;
      if (typeof value === 'string' && value.toLowerCase().indexOf('zh') !== 0) language = 'en';
    } catch (error) { /* 默认中文 */ }

    var dictionary = {
      zh: {
        nav: '飞书通知', title: '飞书结束通知',
        description: '每轮任务结束时向飞书群机器人推送结果卡片。当前阶段只做出站通知。',
        webhookCard: 'Webhook 配置', status: '连接状态', statusHint: '出站 webhook 是否配置。',
        connected: '已配置', notConnected: '未配置', currentWebhook: '当前地址', maskHint: '出于安全考虑只显示末 8 位。',
        webhook: '飞书 webhook 地址', keepCurrent: '留空则保留当前地址',
        webhookHint: '在飞书群 → 设置 → 群机器人 → 添加自定义机器人后复制 Webhook 地址。该地址视为密钥，不要提交到代码库。',
        behaviorCard: '通知行为', notifyTurnEnd: '任务结束时推送', notifyTurnEndHint: '关闭后不再发送任何通知。',
        atAll: '@所有人 强提醒', atAllHint: '先发一条带 @all 的文本，再发结果卡片。',
        cardTitle: '卡片标题', maxChars: '正文最大字数', maxCharsHint: '超过此长度的结果会自动截断，范围 200–8000。',
        trace: '诊断日志', traceHint: '在控制台记录发送结果，排障用。',
        save: '保存配置', test: '发送测试消息', clear: '清空配置',
        warning: '入站私聊监听订阅尚未启用；本插件目前只负责把 DSH 的结果推送到飞书。',
      },
      en: {
        nav: 'Feishu Notify', title: 'Feishu turn-end notification',
        description: 'Push a result card to a Feishu group bot when each turn ends. Outbound only for now.',
        webhookCard: 'Webhook', status: 'Status', statusHint: 'Whether the outbound webhook is configured.',
        connected: 'Configured', notConnected: 'Not configured', currentWebhook: 'Current URL', maskHint: 'Only the last 8 characters are shown.',
        webhook: 'Feishu webhook URL', keepCurrent: 'Leave blank to keep current',
        webhookHint: 'Create a custom bot in Feishu group settings and copy its webhook URL. Treat it as a secret.',
        behaviorCard: 'Behavior', notifyTurnEnd: 'Notify on turn end', notifyTurnEndHint: 'Turn off to stop all notifications.',
        atAll: 'Mention @all', atAllHint: 'Send an @all text before the result card.',
        cardTitle: 'Card title', maxChars: 'Max body chars', maxCharsHint: 'Long results are truncated. Range: 200–8000.',
        trace: 'Diagnostics', traceHint: 'Log delivery results to the console.',
        save: 'Save', test: 'Send test', clear: 'Clear',
        warning: 'Inbound private-chat subscription is not enabled yet; this plugin only pushes DSH results to Feishu.',
      },
    };
    var t = function (key) { return (dictionary[language] || dictionary.zh)[key] || key; };
    var components = createComponents(React, t);

    return {
      inject: ['slots'],
      apply: function (app) {
        app.effect(function () {
          var style = document.createElement('style');
          style.setAttribute('data-plugin', PLUGIN_ID);
          style.textContent = CSS;
          document.head.appendChild(style);
          return function () {
            if (style.parentNode) style.parentNode.removeChild(style);
          };
        }, 'dsh-feishu-mcp: stylesheet');

        app.slots.inject('settings.section', function () {
          return app.slots.register({
            name: 'settings.section',
            id: 'feishu-mcp',
            order: 19,
            label: function () { return t('nav'); },
          }, components.Page);
        });
      },
    };
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__FEISHU_MCP_INTERNALS__ = { createPlugin: createPlugin, createComponents: createComponents, BUILD: BUILD };
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: function (require) {
        var holder = {};
        return {
          inject: ['slots'],
          apply: function (ctx) {
            var built = createPlugin(require, ctx);
            holder.plugin = built;
            return built.apply(ctx);
          },
        };
      },
    });
  }
})();
