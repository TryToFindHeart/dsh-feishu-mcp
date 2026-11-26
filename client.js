// dsh-feishu-mcp — client half.
//
// Registers one page in the shell's `settings.section` list: the 「飞书通知」 tab.
// The page talks to its own Host half through the authenticated exact Fetch
// routes the Host registers below `/api`; the browser cookie is the credential,
// so this file never sees the App Secret.
//
// Loaded as a classic script and registered on the DSH client module loader.
(function () {
  'use strict';

  var PLUGIN_ID = 'dsh-feishu-mcp';
  var API = '/api/feishu-mcp';
  // Bumped on every installed build: the page prints it, so a stale artifact is
  // visible instead of being mistaken for a code bug.
  var BUILD = '0.3.5';

  // Kept in sync with lib/permissions.js; the Host validates whatever is saved.
  var PERMISSION_ORDER = ['readonly', 'workspace', 'auto', 'full'];
  var PERMISSION_LABELS = {
    readonly: '只读',
    workspace: '工作区读写',
    auto: 'Auto Review',
    full: '完全权限',
  };
  var PERMISSION_HINTS = {
    readonly: '只能读，不能改文件；越界操作会来找你确认。',
    workspace: '可在工作区目录内读写，越界操作会来找你确认。',
    auto: '由宿主装的 Auto Review 逐次评估：放行即完全权限执行，危险的才来问你。',
    full: '不做沙箱限制，也不再向你询问。',
  };

  var CSS = [
    '.fsmcp-page{display:flex;flex-direction:column;gap:20px;max-width:760px;color:var(--dsw-alias-label-primary,#1a1a1a);}',
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
    '.fsmcp-value{font-size:13px;}',
    '.fsmcp-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:6px;}',
    '.fsmcp-dot-on{background:var(--dsw-alias-state-success-primary);}',
    '.fsmcp-dot-off{background:var(--dsw-alias-state-idle-primary);}',
    '.fsmcp-btn{appearance:none;-webkit-appearance:none;height:32px;padding:0 14px;border-radius:8px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;border:1px solid transparent;white-space:nowrap;transition:opacity .12s ease;display:inline-flex;align-items:center;justify-content:center;}',
    '.fsmcp-btn:disabled{opacity:.5;cursor:default;}',
    '.fsmcp-btn-primary{background:#2f7cf6;color:#fff;-webkit-text-fill-color:#fff;border-color:#2f7cf6;}',
    '.fsmcp-btn-ghost{background:#f2f3f5;border-color:#d0d3d9;color:#1a1a1a;-webkit-text-fill-color:#1a1a1a;}',
    '.fsmcp-btn-danger{background:#fff;border-color:#d0d3d9;color:#d92d20;-webkit-text-fill-color:#d92d20;}',
    '.fsmcp-actions{display:flex;gap:8px;flex-wrap:wrap;}',
    '.fsmcp-input{height:34px;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;padding:0 10px;outline:none;}',
    '.fsmcp-input:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.fsmcp-textarea{width:100%;box-sizing:border-box;min-height:64px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;padding:8px 10px;outline:none;resize:vertical;font-family:inherit;}',
    '.fsmcp-field{display:flex;flex-direction:column;gap:6px;}',
    '.fsmcp-field-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);}',
    '.fsmcp-switch{position:relative;width:44px;height:24px;border-radius:999px;border:1px solid #b9bec7;background:#e3e6eb;cursor:pointer;flex:none;transition:background .15s ease;padding:0;}',
    '.fsmcp-switch[aria-checked="true"]{background:#2f7cf6;border-color:#2f7cf6;}',
    '.fsmcp-switch-thumb{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease;}',
    '.fsmcp-switch[aria-checked="true"] .fsmcp-switch-thumb{transform:translateX(20px);}',
    '.fsmcp-row-control{display:flex;align-items:center;gap:8px;flex:none;}',
    '.fsmcp-switch-status{font-size:12px;min-width:20px;color:var(--dsw-alias-label-secondary);}',
    '.fsmcp-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);}',
    '.fsmcp-ok{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);}',
    '.fsmcp-qr-wrap{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;}',
    '.fsmcp-qr{width:200px;height:200px;border-radius:12px;background:#fff;padding:8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);}',
    '.fsmcp-qr-side{display:flex;flex-direction:column;gap:8px;min-width:220px;flex:1;}',
    '.fsmcp-wait{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary);}',
    '.fsmcp-pulse{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:fsmcp-pulse 1.2s ease-in-out infinite;}',
    '@keyframes fsmcp-pulse{0%,100%{opacity:.25}50%{opacity:1}}',
    '.fsmcp-divider{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;}',
    '.fsmcp-divider::before,.fsmcp-divider::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1);}',
    '.fsmcp-list{display:flex;flex-direction:column;}',
    '.fsmcp-list-item{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
    '.fsmcp-list-item:last-child{border-bottom:none;}',
    '.fsmcp-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px;color:var(--dsw-alias-label-secondary);}',
    '.fsmcp-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
    '.fsmcp-inline .fsmcp-input{width:96px;flex:none;}',
    '.fsmcp-warn{border:1px solid var(--dsw-alias-state-warn-primary,#b54708);border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.55;color:var(--dsw-alias-state-warn-primary,#b54708);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b54708) 8%,transparent);}',
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
      try { data = JSON.parse(text); } catch (error) { data = {}; }
    }
    if (!response.ok) {
      var message = data.error || ('请求失败（HTTP ' + response.status + '）');
      if (response.status === 404) {
        message = '新版插件路由尚未加载：请完全退出 DSH 应用后重新启动，再打开此页面（HTTP 404）';
      }
      var failure = new Error(message);
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  function errorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  /** 兼容旧版 Host 返回的状态：老版本可能没有 notify 对象。 */
  function normalizeState(value) {
    var next = value && typeof value === 'object' ? value : {};
    var notify = next.notify && typeof next.notify === 'object' ? next.notify : {};
    return Object.assign({}, next, {
      notify: {
        turnEnd: notify.turnEnd !== undefined ? notify.turnEnd : next.notifyTurnEnd !== false,
        approval: notify.approval !== false,
        question: notify.question !== false,
      },
      allowedOpenIds: Array.isArray(next.allowedOpenIds) ? next.allowedOpenIds : [],
      chatSessions: next.chatSessions && typeof next.chatSessions === 'object' ? next.chatSessions : {},
      chatPermissions: next.chatPermissions && typeof next.chatPermissions === 'object' ? next.chatPermissions : {},
      stateFile: next.stateFile || '~/.dsh/dsh-feishu-mcp/state.json',
    });
  }

  function formatRemaining(expiresAt) {
    var left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    var minutes = Math.floor(left / 60);
    var seconds = left % 60;
    return minutes + ':' + (seconds < 10 ? '0' + seconds : String(seconds));
  }

  function createComponents(React, t) {
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;

    /**
     * Renders the message instead of letting a throw blank the settings panel.
     * The stack is shown too: this page is the only surface the operator has.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[feishu-mcp] render crashed:', error, info);
        }
      }
      render() {
        if (this.state.error) {
          var error = this.state.error;
          return h('div', { className: 'fsmcp-page' },
            h('div', { className: 'fsmcp-error' },
              '飞书通知页面渲染失败：', String((error && error.message) || error),
              h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px', margin: '8px 0 0' } },
                String((error && error.stack) || '').slice(0, 1500))));
        }
        return this.props.children;
      }
    }

    function Button(props) {
      var variant = props.variant || 'ghost';
      return h('button', {
        type: 'button',
        className: 'fsmcp-btn fsmcp-btn-' + variant,
        disabled: props.disabled,
        onClick: props.onClick,
      }, props.children);
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        title: (props.label || '开关') + (props.checked ? '：已开启，点击关闭' : '：已关闭，点击开启'),
        className: 'fsmcp-switch',
        onClick: function () { if (!props.disabled) props.onChange(!props.checked); },
      }, h('span', { className: 'fsmcp-switch-thumb' }));
    }

    function Row(props) {
      var child = props.children;
      var isSwitch = child && child.props && child.props.role === 'switch';
      return h('div', { className: 'fsmcp-row' },
        h('div', { className: 'fsmcp-row-text' },
          h('div', { className: 'fsmcp-label' }, props.label),
          props.hint ? h('div', { className: 'fsmcp-hint' }, props.hint) : null),
        h('div', { className: 'fsmcp-row-control' },
          child,
          isSwitch ? h('span', { className: 'fsmcp-switch-status' }, child.props.checked ? '开' : '关') : null));
    }

    function Card(props) {
      return h('section', { className: 'fsmcp-card' },
        props.title ? h('header', { className: 'fsmcp-card-head' },
          props.dot ? h('span', { className: 'fsmcp-dot ' + (props.dot === 'on' ? 'fsmcp-dot-on' : 'fsmcp-dot-off') }) : null,
          h('h3', { className: 'fsmcp-card-title' }, props.title),
          props.extra || null) : null,
        h('div', { className: 'fsmcp-card-body' }, props.children));
    }

    function Field(props) {
      return h('label', { className: 'fsmcp-field' },
        h('span', { className: 'fsmcp-field-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'fsmcp-hint' }, props.hint) : null);
    }

    /** 扫码创建：设备码流程 + 轮询。 */
    function ScanCard(props) {
      var qrState = useState(null);
      var qr = qrState[0];
      var setQr = qrState[1];
      var statusState = useState('idle');
      var status = statusState[0];
      var setStatus = statusState[1];
      var messageState = useState('');
      var message = messageState[0];
      var setMessage = messageState[1];
      var tickState = useState(0);
      var tick = tickState[0];
      var setTick = tickState[1];
      var alive = useRef(true);

      useEffect(function () {
        alive.current = true;
        return function () { alive.current = false; };
      }, []);

      var begin = useCallback(function () {
        setStatus('loading');
        setMessage('');
        api('/onboarding/begin', { method: 'POST', body: { domain: props.domain || 'feishu' } })
          .then(function (result) {
            if (!alive.current) return;
            setQr(result);
            setStatus('waiting');
          })
          .catch(function (error) {
            if (!alive.current) return;
            setStatus('idle');
            setMessage(errorMessage(error));
          });
      }, [props.domain]);

      // 轮询：设备码授权完成后，Host 已经把凭据写入状态文件。
      useEffect(function () {
        if (status !== 'waiting' || !qr) return undefined;
        var timer = setInterval(function () {
          api('/onboarding/poll?id=' + encodeURIComponent(qr.id))
            .then(function (result) {
              if (!alive.current) return;
              if (result.status === 'ready') {
                setStatus('ready');
                props.onConnected(result.state);
              } else if (result.status === 'expired') {
                setStatus('expired');
                setMessage('二维码已过期，请重新生成。');
              } else if (result.status === 'denied') {
                setStatus('idle');
                setMessage('授权被拒绝，可以重新生成二维码再试一次。');
              } else if (result.status === 'unknown') {
                setStatus('idle');
                setMessage('这次连接请求已失效，请重新生成二维码。');
              }
            })
            .catch(function (error) {
              if (!alive.current) return;
              setStatus('idle');
              setMessage(errorMessage(error));
            });
        }, 2500);
        return function () { clearInterval(timer); };
      }, [status, qr]);

      // 倒计时只影响显示。
      useEffect(function () {
        if (status !== 'waiting' || !qr) return undefined;
        var timer = setInterval(function () { setTick(function (value) { return value + 1; }); }, 1000);
        return function () { clearInterval(timer); };
      }, [status, qr]);

      function cancel() {
        var current = qr;
        setQr(null);
        setStatus('idle');
        if (current) api('/onboarding/cancel', { method: 'POST', body: { id: current.id } }).catch(function () {});
      }

      if (status === 'idle' || status === 'loading') {
        return h(Card, { title: '扫码创建飞书应用' },
          h('p', { className: 'fsmcp-sub' },
            '用飞书扫一下，自动创建一个只属于 DSH 的机器人应用，并带上收发消息所需的权限。'),
          h('div', { className: 'fsmcp-actions' },
            h(Button, { variant: 'primary', disabled: status === 'loading', onClick: begin },
              status === 'loading' ? '正在生成二维码…' : '生成连接二维码')),
          message ? h('div', { className: 'fsmcp-error' }, message) : null);
      }

      if (!qr) return null;

      return h(Card, { title: '扫码创建飞书应用' },
        h('div', { className: 'fsmcp-qr-wrap' },
          qr.qrDataUrl
            ? h('img', { className: 'fsmcp-qr', src: qr.qrDataUrl, alt: '飞书扫码创建应用' })
            : h('div', { className: 'fsmcp-qr fsmcp-hint', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '16px' } },
                '二维码组件未安装，请直接点开下面的链接。'),
          h('div', { className: 'fsmcp-qr-side' },
            h('div', { className: 'fsmcp-wait' },
              h('span', { className: 'fsmcp-pulse' }),
              h('span', null, '等待在飞书中确认…（' + formatRemaining(qr.expiresAt) + ' 后过期）')),
            h('div', { className: 'fsmcp-hint' },
              '手机上打开飞书扫左边二维码，按提示确认创建即可。这个页面会自动完成后续配置。'),
            qr.userCode ? h('div', { className: 'fsmcp-hint' }, '配对码：', h('span', { className: 'fsmcp-code' }, qr.userCode)) : null,
            qr.qrUrl ? h('a', { className: 'fsmcp-hint', href: qr.qrUrl, target: '_blank', rel: 'noreferrer' }, '点不开二维码时，用飞书打开这个链接') : null,
            h('div', { className: 'fsmcp-actions' },
              h(Button, { onClick: cancel }, '取消'),
              h(Button, { onClick: begin }, '重新生成'))),
        ),
        message ? h('div', { className: 'fsmcp-error' }, message) : null);
    }

    /** 手动填写凭据。 */
    function ManualCard(props) {
      var appIdState = useState('');
      var appId = appIdState[0];
      var setAppId = appIdState[1];
      var secretState = useState('');
      var secret = secretState[0];
      var setSecret = secretState[1];
      var domainState = useState('feishu');
      var domain = domainState[0];
      var setDomain = domainState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var messageState = useState('');
      var message = messageState[0];
      var setMessage = messageState[1];

      function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setBusy(true);
        setMessage('');
        api('/credentials', { method: 'POST', body: { appId: appId, appSecret: secret, domain: domain } })
          .then(function (result) { props.onConnected(result.state); })
          .catch(function (error) { setMessage(errorMessage(error)); })
          .then(function () { setBusy(false); });
      }

      return h(Card, { title: '已有飞书应用？手动连接' },
        h('p', { className: 'fsmcp-sub' },
          '在飞书开放平台创建应用并开启机器人能力，把 App ID / App Secret 填在这里。权限与事件订阅需要自行配置，扫码创建会替你完成这些。'),
        h(Field, { label: 'App ID' },
          h('input', {
            className: 'fsmcp-input', value: appId, placeholder: 'cli_xxxxxxxxxxxxxxxx',
            onChange: function (event) { setAppId(event.target.value); },
          })),
        h(Field, { label: 'App Secret' },
          h('input', {
            className: 'fsmcp-input', type: 'password', value: secret, placeholder: '••••••••',
            onChange: function (event) { setSecret(event.target.value); },
          })),
        h(Field, { label: '开放平台域' },
          h('select', {
            className: 'fsmcp-input', value: domain,
            onChange: function (event) { setDomain(event.target.value); },
          },
            h('option', { value: 'feishu' }, '飞书（feishu.cn）'),
            h('option', { value: 'lark' }, 'Lark（larksuite.com）'))),
        h('div', { className: 'fsmcp-actions' },
          h(Button, { variant: 'primary', disabled: busy || !appId || !secret, onClick: submit },
            busy ? '正在校验…' : '连接')),
        message ? h('div', { className: 'fsmcp-error' }, message) : null);
    }

    /** 已连接视图。 */
    function ConnectedView(props) {
      var state = props.state;
      var setState = props.setState;
      var onOnboard = props.onOnboard;
      var busyState = useState('');
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var noticeState = useState('');
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var allowDraftState = useState((state.allowedOpenIds || []).join('\n'));
      var allowDraft = allowDraftState[0];
      var setAllowDraft = allowDraftState[1];
      var cwdDraftState = useState(state.sessionCwd || '~/dsh-feishu-mcp');
      var cwdDraft = cwdDraftState[0];
      var setCwdDraft = cwdDraftState[1];
      var wsTitleDraftState = useState(state.workspaceTitle || '飞书 DSH');
      var wsTitleDraft = wsTitleDraftState[0];
      var setWsTitleDraft = wsTitleDraftState[1];
      var timeoutDraftState = useState(String(state.answerTimeoutMinutes || 5));
      var timeoutDraft = timeoutDraftState[0];
      var setTimeoutDraft = timeoutDraftState[1];
      var never = state.answerTimeoutMinutes === 0;
      var webhookDraftState = useState('');
      var webhookDraft = webhookDraftState[0];
      var setWebhookDraft = webhookDraftState[1];
      var cardTitleDraftState = useState(state.cardTitle || 'DSH 任务结束提醒');
      var cardTitleDraft = cardTitleDraftState[0];
      var setCardTitleDraft = cardTitleDraftState[1];
      var maxCharsDraftState = useState(String(state.maxChars || 1200));
      var maxCharsDraft = maxCharsDraftState[0];
      var setMaxCharsDraft = maxCharsDraftState[1];

      useEffect(function () {
        setAllowDraft((state.allowedOpenIds || []).join('\n'));
      }, [state.allowedOpenIds.join('|')]);

      useEffect(function () {
        setTimeoutDraft(String(state.answerTimeoutMinutes || 5));
      }, [state.answerTimeoutMinutes]);

      useEffect(function () {
        setCwdDraft(state.sessionCwd || '~/dsh-feishu-mcp');
      }, [state.sessionCwd]);

      useEffect(function () {
        setWsTitleDraft(state.workspaceTitle || '飞书 DSH');
      }, [state.workspaceTitle]);

      function run(key, task, success) {
        setBusy(key);
        setError('');
        setNotice('');
        task()
          .then(function (result) {
            if (result && result.state) setState(normalizeState(result.state));
            if (success) setNotice(success);
          })
          .catch(function (failure) { setError(errorMessage(failure)); })
          .then(function () { setBusy(''); });
      }

      var serviceState = useState(null);
      var service = serviceState[0];
      var setService = serviceState[1];

      function loadService() {
        api('/service', { method: 'GET' })
          .then(function (result) { setService(result); })
          .catch(function () { setService(null); });
      }

      function installService() {
        setBusy('service');
        setError('');
        setNotice('');
        api('/service', { method: 'POST', body: { action: 'install' } })
          .then(function (result) {
            if (result && result.ok === false) setError(result.error || '安装失败');
            else setNotice(result.note || '已写入用户级服务。');
            setTimeout(loadService, 800);
          })
          .catch(function (failure) { setError(errorMessage(failure)); })
          .then(function () { setBusy(''); });
      }

      function restartNow() {
        setBusy('restart');
        setError('');
        setNotice('');
        api('/service', { method: 'POST', body: { action: 'restart-now' } })
          .then(function (result) {
            if (result && result.ok === false) setError(result.error || '未能重启');
            else setNotice('正在重启…页面会断开几秒，刷新即可。');
          })
          .catch(function (failure) { setError(errorMessage(failure)); })
          .then(function () { setBusy(''); });
      }

      useEffect(function () { loadService(); }, []);

      function savePrefs(patch) {
        var previous = state;
        setState(function (current) {
          var merged = {};
          for (var key in current) merged[key] = current[key];
          for (var field in patch) merged[field] = patch[field];
          return merged;
        });
        api('/prefs', { method: 'POST', body: patch })
          .then(function (result) { setState(normalizeState(result.state)); })
          .catch(function (failure) { setState(previous); setError(errorMessage(failure)); });
      }

      function toggleNotify(key) {
        var next = {};
        for (var name in state.notify) next[name] = state.notify[name];
        next[key] = !state.notify[key];
        savePrefs({ notify: next });
      }

      return h(React.Fragment, null,
        h(Card, { title: '连接状态', dot: 'on', extra: h('span', { className: 'fsmcp-hint' }, state.botName || state.appId) },
          h('div', { className: 'fsmcp-list' },
            h('div', { className: 'fsmcp-list-item' },
              h('div', { className: 'fsmcp-row-text' },
                h('div', { className: 'fsmcp-label' }, '机器人'),
                h('div', { className: 'fsmcp-hint' }, state.botName || '（未获取到机器人名称，可点“重新校验”）')),
              null),
            h('div', { className: 'fsmcp-list-item' },
              h('div', { className: 'fsmcp-row-text' },
                h('div', { className: 'fsmcp-label' }, 'App ID'),
                h('div', { className: 'fsmcp-mono' }, state.appId)),
              h('span', { className: 'fsmcp-hint' }, state.domain === 'lark' ? 'Lark' : '飞书')),
            h('div', { className: 'fsmcp-list-item' },
              h('div', { className: 'fsmcp-row-text' },
                h('div', { className: 'fsmcp-label' }, '我的飞书 open_id'),
                h('div', { className: 'fsmcp-mono' }, state.ownerOpenId || '（扫码授权后自动填写）')))),
          h('div', { className: 'fsmcp-actions' },
            h(Button, { variant: 'primary', disabled: busy !== '', onClick: function () {
              run('test', function () { return api('/test', { method: 'POST', body: {} }); }, '测试消息已发出，去飞书里看一下。');
            } }, busy === 'test' ? '正在发送…' : '发送测试消息'),
            h(Button, { disabled: busy !== '', onClick: function () {
              run('verify', function () { return api('/verify', { method: 'POST', body: {} }); }, '凭据有效。');
            } }, busy === 'verify' ? '校验中…' : '重新校验'),
            h(Button, { disabled: busy !== '', onClick: function () { if (onOnboard) onOnboard(); } }, '扫码创建 / 重新授权'),
            h(Button, { variant: 'danger', disabled: busy !== '', onClick: function () {
              if (typeof window !== 'undefined' && !window.confirm('断开后 DSH 不再向飞书推送消息，凭据会从本机删除。继续？')) return;
              run('disconnect', function () { return api('/disconnect', { method: 'POST', body: {} }); });
            } }, '断开连接')),
          error ? h('div', { className: 'fsmcp-error' }, error) : null,
          notice ? h('div', { className: 'fsmcp-ok' }, notice) : null),

        h(Card, { title: '群 Webhook 强提醒' },
          h('p', { className: 'fsmcp-sub' },
            '任何会话一轮结束时，都会向这个自定义机器人 webhook 推一张结果卡片。'),
          h(Field, {
            label: 'Webhook 地址',
            hint: '出于安全考虑，页面只显示掩码：' + (state.webhookMasked || '（未配置）') + '。留空保存表示保留原地址。',
          },
            h('input', {
              className: 'fsmcp-input',
              value: webhookDraft,
              placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
              onChange: function (event) { setWebhookDraft(event.target.value); },
            })),
          h('div', { className: 'fsmcp-actions' },
            h(Button, { variant: 'primary', disabled: busy !== '', onClick: function () {
              run('webhook', function () {
                return api('/prefs', { method: 'POST', body: { webhookUrl: webhookDraft } });
              }, 'Webhook 已保存。');
            } }, busy === 'webhook' ? '保存中…' : '保存 Webhook')),
          h(Row, { label: '@all 强提醒', hint: '推送卡片前先发一条 @all 文本消息。' },
            h(Switch, {
              label: '@all 强提醒', checked: state.webhookAtAll,
              onChange: function () { savePrefs({ webhookAtAll: !state.webhookAtAll }); },
            })),
          h(Row, { label: '任务完成通知', hint: '关闭后任何会话结束都不再推送卡片。' },
            h(Switch, {
              label: '任务完成通知', checked: state.notify.turnEnd,
              onChange: function () {
                var next = !state.notify.turnEnd;
                savePrefs({ notifyTurnEnd: next, notify: Object.assign({}, state.notify, { turnEnd: next }) });
              },
            })),
          h(Field, { label: '卡片标题', hint: '默认「DSH 任务结束提醒」。' },
            h('input', {
              className: 'fsmcp-input', value: cardTitleDraft,
              onChange: function (event) { setCardTitleDraft(event.target.value); },
              onBlur: function () {
                if (cardTitleDraft !== state.cardTitle) savePrefs({ cardTitle: cardTitleDraft });
              },
            })),
          h(Field, { label: '结论摘要长度', hint: '200–8000 字符，避免卡片过长。' },
            h('input', {
              className: 'fsmcp-input', type: 'number', min: 200, max: 8000, step: 100,
              value: maxCharsDraft,
              onChange: function (event) { setMaxCharsDraft(event.target.value); },
              onBlur: function () {
                var value = Math.round(Number(maxCharsDraft));
                if (isFinite(value) && value >= 200 && value <= 8000 && value !== state.maxChars) {
                  savePrefs({ maxChars: value });
                }
              },
            })),

        h(Card, { title: '推送内容' },
          h('p', { className: 'fsmcp-sub' }, '所有会话都会推送。'),
          h(Row, { label: '任务完成', hint: '一轮对话结束后，把结论和用时推过来。' },
            h(Switch, { label: '任务完成通知', checked: state.notify.turnEnd, onChange: function () { toggleNotify('turnEnd'); } })),
          h(Row, { label: '需要授权', hint: '工具要执行受限操作时，推一张带“允许 / 拒绝”按钮的卡片。' },
            h(Switch, { label: '授权通知', checked: state.notify.approval, onChange: function () { toggleNotify('approval'); } })),
          h(Row, { label: '需要你回答', hint: 'DSH 向你提问时，问题会变成可选按钮。' },
            h(Switch, { label: '提问通知', checked: state.notify.question, onChange: function () { toggleNotify('question'); } }))),

        h(Card, { title: '飞书会话的位置' },
          h('p', { className: 'fsmcp-sub' },
            '在飞书里发起的对话会新建在下面这个文件夹，并在工作区列表里归到同一个名字下。'),
          h(Field, {
            label: '工作文件夹',
            hint: '绝对路径或以 ~/ 开头；不存在会自动创建。默认 ~/dsh-feishu-mcp。',
          },
            h('input', {
              className: 'fsmcp-input',
              value: cwdDraft,
              placeholder: '~/dsh-feishu-mcp',
              onChange: function (event) { setCwdDraft(event.target.value); },
              onBlur: function () {
                if (cwdDraft !== state.sessionCwd) savePrefs({ sessionCwd: cwdDraft });
              },
            })),
          h(Field, {
            label: '工作区名称',
            hint: '工作区里显示的分组名，默认「飞书 DSH」。改名会在下一次新建对话时同步。',
          },
            h('input', {
              className: 'fsmcp-input',
              value: wsTitleDraft,
              placeholder: '飞书 DSH',
              onChange: function (event) { setWsTitleDraft(event.target.value); },
              onBlur: function () {
                if (wsTitleDraft !== state.workspaceTitle) savePrefs({ workspaceTitle: wsTitleDraft });
              },
            }))),

        h(Card, { title: '会话权限' },
          h('p', { className: 'fsmcp-sub' },
            '飞书里新建的会话默认用哪种权限；单个对话可以随时用 /permission 覆盖。'),
          h(Field, {
            label: '默认权限',
            hint: PERMISSION_HINTS[state.defaultPermission || 'workspace'] || '',
          },
            h('div', { className: 'fsmcp-row fsmcp-wrap' },
              PERMISSION_ORDER.map(function (key) {
                var active = (state.defaultPermission || 'workspace') === key;
                return h('button', {
                  key: key,
                  type: 'button',
                  className: 'fsmcp-btn' + (active ? ' fsmcp-btn-primary' : ''),
                  disabled: Boolean(busy) || active,
                  onClick: function () { savePrefs({ defaultPermission: key }); },
                }, PERMISSION_LABELS[key]);
              })))),

        h(Card, { title: '部署方式' },
          (function () {
            var info = service || {};
            var supported = Boolean(info.supported);
            var mode = info.mode || 'unknown';
            var canInstall = Boolean(info.canInstall);
            var label =
              mode === 'system-service' ? '已托管：系统级 systemd'
              : mode === 'user-service' ? '已托管：用户级 systemd'
              : mode === 'unsupported' ? '当前系统不支持'
              : '未托管（非服务模式）';
            return h(React.Fragment, null,
              h('p', { className: 'fsmcp-sub' },
                '把 DSH 做成服务后，进程退出或机器重启都会自动拉起；这里只用用户级服务，不需要 sudo。'),
              h(Field, { label: '当前状态', hint: label },
                h('div', { className: 'fsmcp-row' },
                  h('button', {
                    type: 'button',
                    className: 'fsmcp-btn fsmcp-btn-primary',
                    disabled: Boolean(busy) || !supported || !canInstall,
                    onClick: installService,
                  }, busy === 'service'
                    ? '正在安装…'
                    : !supported ? '不可用'
                    : canInstall ? '做成服务（无需 sudo）' : '已是服务模式'),
                  h('button', {
                    type: 'button',
                    className: 'fsmcp-btn',
                    disabled: Boolean(busy),
                    onClick: restartNow,
                  }, busy === 'restart' ? '正在重启…' : '立即重启 DSH'))),
              info.warnings && info.warnings.length
                ? h('div', { className: 'fsmcp-warn' }, info.warnings.map(function (line, index) {
                    return h('p', { key: index }, line);
                  }))
                : null,
              info.hint ? h('p', { className: 'fsmcp-hint' }, info.hint) : null,
              info.installed && info.unit
                ? h('details', null,
                  h('summary', { className: 'fsmcp-hint' }, '查看生成的 ' + info.unitPath),
                  h('pre', { className: 'fsmcp-pre' }, info.unit))
                : null);
          })()),

        h(Card, { title: '指挥与安全' },
          h(Row, { label: '允许在飞书里指挥 DSH', hint: '关闭后，飞书只用来接收通知，收到的消息不会变成对话。' },
            h(Switch, {
              label: '允许指挥', checked: state.allowCommands,
              onChange: function () { savePrefs({ allowCommands: !state.allowCommands }); },
            })),
          h(Row, { label: '启用飞书私聊入站', hint: '用应用机器人长连接接收私聊消息；需要已配置 App ID / App Secret。' },
            h(Switch, {
              label: '启用入站', checked: state.enableInbound,
              onChange: function () { savePrefs({ enableInbound: !state.enableInbound }); },
            })),
          h(Row, { label: '结果回原私聊', hint: '由飞书发起的轮次结束时，卡片回原对话，不再重复发群 webhook。' },
            h(Switch, {
              label: '结果回原私聊', checked: state.inboundReply !== false,
              onChange: function () { savePrefs({ inboundReply: state.inboundReply === false }); },
            })),
          h(Field, { label: '会话定位方式', hint: 'perChat：每个飞书私聊绑定一个会话；fixed：固定会话；active：当前活跃会话。' },
            h('div', { className: 'fsmcp-row fsmcp-wrap' },
              ['perChat', 'fixed', 'active'].map(function (mode) {
                var active = (state.sessionMode || 'perChat') === mode;
                return h('button', {
                  key: mode,
                  type: 'button',
                  className: 'fsmcp-btn' + (active ? ' fsmcp-btn-primary' : ''),
                  disabled: Boolean(busy) || active,
                  onClick: function () { savePrefs({ sessionMode: mode }); },
                }, mode);
              })))),
          h(Row, {
            label: '网页与飞书同时询问',
            hint: state.answerMode === 'both'
              ? '现在两边都会弹出：谁先回答就用谁，另一边可能在本轮结束前一直显示。'
              : '默认只通过飞书询问：网页不会再弹同一个请求，所以在飞书答完就是最终结果。',
          },
            h(Switch, {
              label: '网页与飞书同时询问',
              checked: state.answerMode === 'both',
              onChange: function () { savePrefs({ answerMode: state.answerMode === 'both' ? 'feishu' : 'both' }); },
            })),
          h(Field, {
            label: '飞书等待上限（分钟）',
            hint: '1–120 分钟，或选择永不超时。超时后卡片失效，请求转回 DSH 网页。',
          },
            h('div', { className: 'fsmcp-inline' },
              h('input', {
                className: 'fsmcp-input',
                type: 'number',
                min: 1,
                max: 120,
                step: 1,
                value: never ? '0' : timeoutDraft,
                disabled: never,
                onChange: function (event) { setTimeoutDraft(event.target.value); },
                onBlur: function () {
                  if (never) return;
                  var minutes = Math.round(Number(timeoutDraft));
                  if (!isFinite(minutes) || minutes < 1 || minutes > 120) {
                    setTimeoutDraft(String(state.answerTimeoutMinutes || 5));
                    return;
                  }
                  if (minutes !== state.answerTimeoutMinutes) savePrefs({ answerTimeoutMinutes: minutes });
                },
              }),
              h('span', { className: 'fsmcp-hint' }, never ? '永不超时' : '分钟'),
              h(Switch, {
                label: '永不超时',
                checked: never,
                onChange: function () {
                  savePrefs({ answerTimeoutMinutes: never ? 5 : 0 });
                },
              }),
              h('span', { className: 'fsmcp-hint' }, '永不超时'))),
          h('div', { className: 'fsmcp-warn' },
            '注意：超时之前，DSH 网页不会弹出原生的选择窗口——这条请求只在飞书里等你。',
            never
              ? '当前设为永不超时，网页端会一直保持静默，直到你在飞书作答。'
              : '超过等待上限才会转回网页；期间即使网页开着也不会提示。'),
          h(Field, {
            label: '允许的飞书用户（open_id，每行一个）',
            hint: '留空表示沿用扫码授权的人。只接受列表里的用户发来的消息。',
          },
            h('textarea', {
              className: 'fsmcp-textarea', value: allowDraft,
              onChange: function (event) { setAllowDraft(event.target.value); },
              placeholder: 'ou_xxxxxxxxxxxxxxxx',
            })),
          h('div', { className: 'fsmcp-actions' },
            h(Button, { disabled: busy !== '', onClick: function () {
              run('allow', function () {
                return api('/prefs', { method: 'POST', body: { allowedOpenIds: allowDraft.split(/[\s,;]+/).filter(Boolean) } });
              }, '允许列表已保存。');
            } }, busy === 'allow' ? '保存中…' : '保存允许列表')),
          h('p', { className: 'fsmcp-hint' }, '状态文件：', h('span', { className: 'fsmcp-mono' }, state.stateFile))));
    }

    /** Slot entry: the boundary sits outside the page so a render throw is visible. */
    function Page() {
      return h(Boundary, null, h(FeishuMcpSection));
    }

    function FeishuMcpSection() {
      var stateRes = useState(null);
      var state = stateRes[0];
      var setState = stateRes[1];
      var loadingRes = useState(true);
      var loading = loadingRes[0];
      var setLoading = loadingRes[1];
      var errorRes = useState('');
      var error = errorRes[0];
      var setError = errorRes[1];
      var probeRes = useState('');
      var probe = probeRes[0];
      var setProbe = probeRes[1];
      var onboardRes = useState(false);
      var showOnboard = onboardRes[0];
      var setShowOnboard = onboardRes[1];

      var load = useCallback(function () {
        setLoading(true);
        api('/state')
          .then(function (result) {
            setState(normalizeState(result.state));
            setError('');
            setProbe('ok');
          })
          .catch(function (failure) {
            setError(errorMessage(failure));
            setProbe(failure && failure.status ? ('HTTP ' + failure.status) : 'network');
          })
          .then(function () { setLoading(false); });
      }, []);

      useEffect(function () { load(); }, [load]);

      var body;
      if (loading && !state) {
        body = h('p', { className: 'fsmcp-sub' }, '正在读取连接状态…');
      } else if (!state) {
        body = h('div', { className: 'fsmcp-error' },
          (error || '读取连接状态失败。') + ' ',
          h(Button, { onClick: load }, '重试'));
      } else {
        var onConnected = function (next) {
          setState(normalizeState(next));
          setError('');
          setShowOnboard(false);
        };
        var hasApp = state.appConfigured === true || Boolean(state.appId && state.appSecretConfigured);
        var needOnboard = !hasApp || showOnboard;
        body = h(React.Fragment, null,
          needOnboard ? h(React.Fragment, null,
            h(ScanCard, { onConnected: onConnected }),
            h('div', { className: 'fsmcp-divider' }, '或'),
            h(ManualCard, { onConnected: onConnected })) : null,
          h(ConnectedView, {
            state: state,
            setState: setState,
            onOnboard: function () { setShowOnboard(true); },
          }),
          error ? h('div', { className: 'fsmcp-error' }, error) : null);
      }

      return h('div', { className: 'fsmcp-page' },
        h('header', { className: 'fsmcp-head' },
          h('h2', { className: 'fsmcp-title' }, t('title')),
          h('p', { className: 'fsmcp-sub' },
            '把 DSH 的工作进展推送到飞书，也可以在飞书里直接下达指令。所有消息都经过 DSH 处理后再回复。')),
        body,
        h('p', { className: 'fsmcp-hint', style: { opacity: 0.7 } },
          'dsh-feishu-mcp v' + BUILD + ' · /api/feishu-mcp/state: ' + (probe || '…')));
    }

    // Exposed for the render tests (scripts/render-ssr.mjs); the shell only
    // renders Page.
    return {
      FeishuMcpSection: FeishuMcpSection,
      Page: Page,
      Boundary: Boundary,
      ScanCard: ScanCard,
      ManualCard: ManualCard,
      ConnectedView: ConnectedView,
    };
  }

  function createPlugin(require, ctx) {
    var React = require('react');
    var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
    var language = 'zh';
    try {
      var current = locale && typeof locale.current === 'function' ? locale.current() : undefined;
      var value = current && typeof current === 'object' ? current.locale || current.language || current.id : current;
      if (typeof value === 'string' && value.toLowerCase().indexOf('zh') !== 0) language = 'en';
    } catch (error) { /* keep Chinese */ }

    var dictionary = {
      zh: { title: '飞书通知与私聊入站', nav: '飞书通知', description: '结束卡片强提醒、扫码创建应用、私聊指挥、审批/提问卡片与会话路由。' },
      en: { title: 'Feishu Notify & Inbound', nav: 'Feishu Notify', description: 'Turn-end cards, scan-to-create app, private-chat control, approval/question cards and session routing.' },
    };
    var t = function (key) { return (dictionary[language] || dictionary.zh)[key]; };

    var components = createComponents(React, t);

    return {
      components: components,
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
        }, 'feishu-mcp: stylesheet');

        app.slots.inject('settings.section', function () {
          return app.slots.register({
            name: 'settings.section',
            id: 'feishu-mcp',
            order: 18,
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
        // The factory itself stays free of side effects: the component tree is
        // built lazily and the slot is registered inside apply().
        var holder = {};
        var plugin = {
          inject: ['slots'],
          apply: function (ctx) {
            var built = createPlugin(require, ctx);
            holder.plugin = built;
            return built.apply(ctx);
          },
        };
        return plugin;
      },
    });
  }
})();
