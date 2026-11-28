/**
 * dsh-freedomchat — client half (zero-build browser module, no bundler).
 *
 * 宿主形状：window.__ModuleLoader__.load({ id, factory })
 * factory 拿到 CommonJS 风格的 require（react、宿主预载的 ui 模块），返回 module.exports。
 * 这里只注册「侧边自由对话」tab 及其面板；后端调用全部走文件顶部的 transport 接缝。
 */
window.__ModuleLoader__.load({
  id: 'dsh-freedomchat',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    var TAB_ID = 'dsh-freedomchat'
    var TAB_KIND = 'dsh-freedomchat'
    var DISPLAY = '侧边自由对话'
    // 宿主 tab 条只画 title 文本、不读 icon 字段，所以字形直接进标题。
    var TAB_LABEL = '\u{1F4AC} ' + DISPLAY
    var SERVICE = 'sidebarRightTabs'
    var EMPTY_TEXT = '这是独立的对话：不继承主对话的历史，也没有本地权限。'

    var RUNNING_MS = 350
    var IDLE_MS = 1300
    var MAX_IMAGES = 8
    var MAX_IMAGE_BYTES = 8 * 1024 * 1024
    // Base64 inflates by 4/3; keep the raw total well under the host's 32 MB
    // body cap so a full album never turns into a 413.
    var MAX_IMAGE_TOTAL_BYTES = 18 * 1024 * 1024
    var TEXTAREA_MAX_H = 118 // 约 6 行（13px 字号 × 18px 行高）
    var ALLOWED_TYPES = {
      'image/png': true,
      'image/jpeg': true,
      'image/webp': true,
      'image/gif': true,
    }

    /* ────────────────────────────────────────────────────────────────
     * 传输层接缝 —— 全文件唯一需要替换的地方。
     * UI 只经下面 5 个 api* 薄封装触达后端；接桥接时把 call 换成真实实现即可。
     * 契约（docs/contract.md）：
     *   ensure({ parentSessionId })  -> { threadId, snapshot }
     *   snapshot({ threadId, version }) -> { version, status, messages?, model?, error? }
     *   send({ threadId, parts })    -> { version }
     *   cancel({ threadId })         -> { version }
     *   clear({ threadId })          -> { threadId, snapshot }
     * ──────────────────────────────────────────────────────────────── */
    /**
     * 路由基址：宿主自带插件用的也是这一套——取 document.baseURI（可带反代目录
     * 前缀），去掉 query/hash，补尾斜杠再相对解析，这样自定义 scheme 的桌面外壳
     * 也能同源转发到宿主。
     */
    function apiBase() {
      var fallback = 'http://freedomchat.invalid/'
      var base =
        typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : ''
      try {
        var url = new URL(base === '' ? fallback : base, fallback)
        url.search = ''
        url.hash = ''
        if (url.pathname.charAt(url.pathname.length - 1) !== '/') url.pathname += '/'
        return url.href
      } catch (error) {
        return fallback
      }
    }

    /** POST 一个宿主方法；成功解包 {ok:true,value}，失败抛带 code 的 Error。 */
    function callHost(method, payload) {
      var url
      try {
        url = new URL('freedomchat/api/' + method, apiBase()).href
      } catch (error) {
        return Promise.reject(error)
      }
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload === undefined ? {} : payload),
        credentials: 'same-origin',
      }).then(
        function (response) {
          return response.text().then(function (text) {
            var body
            try {
              body = text === '' ? undefined : JSON.parse(text)
            } catch (error) {
              throw new Error('宿主返回了非 JSON 响应（HTTP ' + response.status + '）')
            }
            if (body !== undefined && body !== null && body.ok === true) return body.value
            var detail = body && body.error
            var failure = new Error(
              (detail && (detail.message || detail.code)) || '请求失败（HTTP ' + response.status + '）',
            )
            failure.code = detail ? detail.code : undefined
            failure.status = response.status
            throw failure
          })
        },
        function (error) {
          throw new Error('连不上宿主：' + ((error && error.message) || error))
        },
      )
    }

    var transport = { call: callHost }

    function apiRevive(parentSessionId) {
      return transport.call('revive', { parentSessionId: parentSessionId })
    }

    function apiPeek(parentSessionId) {
      return transport.call('peek', { parentSessionId: parentSessionId })
    }
    function apiEnsure(parentSessionId) {
      return transport.call('ensure', { parentSessionId: parentSessionId })
    }
    function apiSnapshot(threadId, version) {
      return transport.call('snapshot', { threadId: threadId, version: version })
    }
    function apiSend(threadId, parts) {
      return transport.call('send', { threadId: threadId, parts: parts })
    }
    function apiCancel(threadId) {
      return transport.call('cancel', { threadId: threadId })
    }
    function apiClear(threadId) {
      return transport.call('clear', { threadId: threadId })
    }
    function apiSetSettings(threadId, patch) {
      return transport.call('setSettings', { threadId: threadId, patch: patch })
    }
    function apiResolveApproval(threadId, approvalId, allow) {
      return transport.call('resolveApproval', {
        threadId: threadId,
        approvalId: approvalId,
        allow: allow,
      })
    }
    function apiCatalog() {
      return transport.call('catalog', {})
    }
    function apiSetModel(threadId, provider, model, reasoningEffort) {
      var payload = { threadId: threadId, provider: provider, model: model }
      if (reasoningEffort !== undefined && reasoningEffort !== null && reasoningEffort !== '') {
        payload.reasoningEffort = reasoningEffort
      }
      return transport.call('setModel', payload)
    }

    // primitives 是宿主预载模块；不在 package.json 的 inject 里时 require 会抛，
    // 此时 assistant 正文退化成 pre-wrap 纯文本，面板其余部分照常可用。
    // assistant 正文用宿主共享的 MarkdownText 渲染。它属于预载模块：有的壳层能同步
    // require，有的只暴露 modules 服务（better-sidebar 就是这么取），所以先 require，
    // 失败再异步 import；拿到组件后通过订阅通知面板重渲染（useMarkdownText）。
    var MarkdownText = null
    var markdownSubs = []
    var markdownLoading = false
    var moduleHost = null

    function publishMarkdownText(component) {
      if (!component || component === MarkdownText) return
      MarkdownText = component
      var listeners = markdownSubs.slice()
      for (var index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index](component)
        } catch (error) {
          /* a broken listener must not break the rest */
        }
      }
    }

    function pickMarkdownText(namespace) {
      if (!namespace) return null
      if (typeof namespace.MarkdownText === 'function') return namespace.MarkdownText
      var fallback = namespace.default
      if (fallback) {
        if (typeof fallback.MarkdownText === 'function') return fallback.MarkdownText
        if (typeof fallback === 'function') return fallback
      }
      return null
    }

    function loadMarkdownText() {
      if (MarkdownText || markdownLoading) return
      try {
        var sync = pickMarkdownText(require('@deepseek-ai/dsh-client-ui-primitives'))
        if (sync) {
          publishMarkdownText(sync)
          return
        }
      } catch (error) {
        /* fall through to the modules service */
      }
      // 注入 '@deepseek-ai/dsh-client-modules' 后，它直接挂在插件 ctx 上（ctx.modules），
      // better-sidebar 也是这么拿 UI 模块的；ctx.get 是老壳层的兜底写法。
      var modules = null
      try {
        if (moduleHost && moduleHost.modules) modules = moduleHost.modules
      } catch (error) {
        modules = null
      }
      if (!modules) {
        try {
          modules = moduleHost && typeof moduleHost.get === 'function' ? moduleHost.get('modules') : null
        } catch (error) {
          modules = null
        }
      }
      if (!modules || typeof modules.import !== 'function') return
      markdownLoading = true
      modules.import('@deepseek-ai/dsh-client-ui-primitives').then(
        function (loaded) {
          markdownLoading = false
          var resolved = pickMarkdownText(loaded)
          if (resolved) publishMarkdownText(resolved)
        },
        function (error) {
          markdownLoading = false
          console.warn('[freedomchat] markdown renderer unavailable', error)
        }
      )
    }

    /** Assistant text upgrades in place once the renderer arrives. */
    function useMarkdownText() {
      var state = React.useState(MarkdownText)
      React.useEffect(function () {
        var alive = true
        var listener = function (component) {
          if (alive) state[1](component)
        }
        markdownSubs.push(listener)
        if (MarkdownText) state[1](MarkdownText)
        loadMarkdownText()
        return function () {
          alive = false
          var at = markdownSubs.indexOf(listener)
          if (at >= 0) markdownSubs.splice(at, 1)
        }
      }, [])
      return state[0]
    }

    // 与 MarkdownText 的嵌套 labels 形状一致（见 dsh-better-sidebar 的 cachedLabels）；
    // 模块级只建一次，保持对象标识稳定，避免每次渲染重新解析 markdown。
    var MARKDOWN_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: { codeLabel: '代码', wrapLabel: '换行', unwrapLabel: '不换行' },
      },
      footnotes: '',
    }

    // 主题 token 用本机 DSH 实际存在的 --dsw-alias-*（text-primary 之类并不存在），
    // 全部带 fallback，换主题或变量缺失时仍是可读的中性色。
    var C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      text2: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      text3: 'var(--dsw-alias-label-tertiary, #a3a3a3)',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.14))',
      surface: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.10))',
      surfaceStrong: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.14))',
      error: 'var(--dsw-alias-state-error-primary, #d9534f)',
      accent: 'var(--dsw-alias-state-success-primary, #2f8f5b)',
      accentBorder: 'var(--dsw-alias-state-success-primary, rgba(47,143,91,0.55))',
      inverse: 'var(--dsw-alias-bg-layer-1, #ffffff)',
    }

    var styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        fontSize: 12,
        color: C.text,
        background: 'transparent',
      },
      head: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 10px',
        minHeight: 36,
        boxSizing: 'border-box',
        borderBottom: '1px solid ' + C.borderSoft,
      },
      title: { fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', color: C.text },
      grow: { flex: '1 1 auto', minWidth: 0 },
      model: {
        flex: '0 1 auto',
        maxWidth: 104,
        fontSize: 11,
        color: C.text3,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      modelBtn: {
        flex: '0 1 auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        maxWidth: 120,
        padding: '1px 5px',
        border: '1px solid transparent',
        borderRadius: 6,
        background: 'transparent',
        font: 'inherit',
        cursor: 'pointer',
      },
      caret: { flex: '0 0 auto', fontSize: 9, color: C.text3 },
      menu: {
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '46vh',
        overflowY: 'auto',
        margin: '0 8px',
        padding: '4px 0',
        border: '1px solid ' + C.border,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
      },
      menuGroup: {
        padding: '5px 9px 2px',
        fontSize: 10.5,
        color: C.text3,
        letterSpacing: '0.02em',
      },
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        padding: '3px 9px',
        border: 'none',
        background: 'transparent',
        color: C.text,
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      menuItemOn: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        padding: '3px 9px',
        border: 'none',
        background: C.surfaceStrong,
        color: C.text,
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        fontWeight: 600,
        textAlign: 'left',
        cursor: 'pointer',
      },
      menuLabel: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chipRow: { display: 'flex', gap: 6, padding: '3px 9px' },
      chip: {
        flex: '1 1 0',
        minWidth: 0,
        padding: '7px 6px',
        borderRadius: 10,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: C.text,
        font: 'inherit',
        fontSize: 11.5,
        lineHeight: '15px',
        textAlign: 'center',
        cursor: 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      chipOn: {
        flex: '1 1 0',
        minWidth: 0,
        padding: '7px 6px',
        borderRadius: 10,
        border: '1px solid ' + C.accentBorder,
        background: C.surfaceStrong,
        color: C.text,
        font: 'inherit',
        fontSize: 11.5,
        lineHeight: '15px',
        fontWeight: 600,
        textAlign: 'center',
        cursor: 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      chipPad: { flex: '1 1 0', minWidth: 0, visibility: 'hidden' },
      check: { flex: '0 0 auto', fontSize: 11, color: C.text2 },
      menuEfforts: { display: 'flex', gap: 8, padding: '4px 10px 10px' },
      menuNote: { padding: '6px 9px', fontSize: 11, color: C.text2 },
      menuFoot: { display: 'flex', justifyContent: 'flex-end', padding: '4px 9px 2px' },
      iconBtn: {
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        padding: 0,
        border: 'none',
        borderRadius: 6,
        background: 'transparent',
        color: C.text2,
        cursor: 'pointer',
      },
      trash: { position: 'relative', display: 'inline-block', width: 12, height: 13 },
      trashLid: { position: 'absolute', left: 0, top: 3, width: 12, height: 1, background: 'currentColor' },
      trashTop: { position: 'absolute', left: 4, top: 1, width: 4, height: 1, background: 'currentColor' },
      trashBody: {
        position: 'absolute',
        left: 1,
        top: 4,
        width: 10,
        height: 8,
        boxSizing: 'border-box',
        border: '1px solid currentColor',
        borderTop: 'none',
        borderRadius: '0 0 2px 2px',
      },
      settings: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '7px 10px',
        borderBottom: '1px solid ' + C.borderSoft,
      },
      settingRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 10px' },
      settingLabel: { fontSize: 11, color: C.text2, whiteSpace: 'nowrap' },
      switchBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 0',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        color: C.text2,
        fontSize: 11,
      },
      switchBtnOn: { color: C.text },
      track: {
        position: 'relative',
        display: 'inline-block',
        width: 26,
        height: 15,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-4, rgba(128,128,128,0.32))',
        transition: 'background .15s',
        flex: '0 0 auto',
      },
      trackOn: {
        position: 'relative',
        display: 'inline-block',
        width: 26,
        height: 15,
        borderRadius: 8,
        background: 'var(--dsw-alias-state-success-primary, #2f9e63)',
        transition: 'background .15s',
        flex: '0 0 auto',
      },
      knob: {
        position: 'absolute',
        top: 2,
        left: 2,
        width: 11,
        height: 11,
        borderRadius: 6,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        transition: 'left .15s',
      },
      knobOn: {
        position: 'absolute',
        top: 2,
        left: 13,
        width: 11,
        height: 11,
        borderRadius: 6,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        transition: 'left .15s',
      },
      seg: {
        display: 'inline-flex',
        border: '1px solid ' + C.borderSoft,
        borderRadius: 6,
        overflow: 'hidden',
      },
      segBtn: {
        flex: '1 1 0',
        minWidth: 0,
        padding: '7px 10px',
        border: '1px solid transparent',
        borderRadius: 9,
        background: 'transparent',
        color: C.text2,
        fontSize: 12.5,
        lineHeight: '18px',
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'background .12s, color .12s, border-color .12s',
      },
      segBtnOn: {
        flex: '1 1 0',
        minWidth: 0,
        padding: '7px 10px',
        border: '1px solid ' + C.accentBorder,
        borderRadius: 9,
        background: C.surfaceStrong,
        color: C.text,
        fontWeight: 600,
        fontSize: 12.5,
        lineHeight: '18px',
        textAlign: 'center',
        cursor: 'pointer',
      },
      approve: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        borderBottom: '1px solid ' + C.borderSoft,
        background: 'var(--dsw-alias-state-warning-bg, rgba(214,160,29,0.12))',
      },
      approveText: { flex: '1 1 auto', minWidth: 0, fontSize: 11, lineHeight: 1.45, color: C.text },
      confirm: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '8px 10px 0',
        padding: '6px 8px',
        border: '1px solid ' + C.border,
        borderRadius: 8,
        background: C.surfaceStrong,
        fontSize: 11.5,
      },
      confirmText: { flex: '1 1 auto', minWidth: 0, color: C.text, lineHeight: 1.5 },
      stream: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 10px 6px',
      },
      emptySub: {
        marginTop: 6,
        fontSize: 11,
        color: C.text3,
      },
      empty: {
        flex: '1 1 auto',
        display: 'flex',
        // 空状态的两行必须竖排：默认 row 会把它们并排放成一行。
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px 24px',
        textAlign: 'center',
        color: C.text2,
        fontSize: 12,
        lineHeight: 1.7,
      },
      starting: { padding: '24px 12px', textAlign: 'center', color: C.text3, fontSize: 12 },
      rowUser: { display: 'flex', justifyContent: 'flex-end' },
      rowAssistant: { display: 'flex', justifyContent: 'flex-start' },
      bubbleUser: {
        maxWidth: '88%',
        minWidth: 0,
        padding: '6px 9px',
        borderRadius: 10,
        background: C.surface,
        fontSize: 12.5,
        lineHeight: 1.65,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
      },
      bubbleAssistant: {
        maxWidth: '96%',
        minWidth: 0,
        fontSize: 12.5,
        lineHeight: 1.65,
        color: C.text,
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
      },
      plain: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      mdBody: { whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.62 },
      mdP: { margin: '0 0 6px' },
      mdH1: { margin: '2px 0 6px', fontSize: 14, fontWeight: 600 },
      mdH2: { margin: '2px 0 5px', fontSize: 13, fontWeight: 600 },
      mdItem: { display: 'flex', gap: 6, margin: '0 0 3px', paddingLeft: 2 },
      mdBullet: { flex: '0 0 auto', opacity: 0.55 },
      mdQuote: {
        margin: '0 0 6px',
        paddingLeft: 8,
        borderLeft: '2px solid ' + C.border,
        color: C.text2,
      },
      mdPre: {
        margin: '0 0 6px',
        padding: '8px 10px',
        borderRadius: 8,
        background: C.surface,
        overflowX: 'auto',
        fontSize: 11.5,
        lineHeight: 1.55,
        whiteSpace: 'pre',
      },
      mdTableEl: { width: '100%', borderCollapse: 'collapse', margin: '0 0 8px', fontSize: 11.5 },
      mdTh: {
        textAlign: 'left',
        padding: '5px 8px',
        background: C.surface,
        color: C.text,
        fontWeight: 600,
        borderBottom: '1px solid ' + C.border,
        whiteSpace: 'nowrap',
      },
      mdTd: {
        padding: '5px 8px',
        borderBottom: '1px solid ' + C.borderSoft,
        verticalAlign: 'top',
        color: C.text2,
      },
      mdCode: {
        padding: '1px 4px',
        borderRadius: 4,
        background: C.surface,
        fontSize: 11.5,
      },
      mdLink: { color: 'var(--dsw-alias-state-business-primary, #4d6bfe)', textDecoration: 'none' },
      image: { display: 'block', maxWidth: '100%', maxHeight: 180, borderRadius: 8, margin: '2px 0' },
      imageChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        margin: '2px 0',
        padding: '1px 6px',
        border: '1px solid ' + C.border,
        borderRadius: 6,
        fontSize: 11,
        color: C.text2,
      },
      streaming: {
        display: 'inline-block',
        marginTop: 2,
        fontSize: 11,
        color: C.text3,
        animation: 'dshf-blink 1.2s ease-in-out infinite',
      },
      errorBar: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: '1px solid ' + C.error,
        borderRadius: 8,
        padding: '5px 8px',
        color: C.error,
        fontSize: 11.5,
        lineHeight: 1.5,
      },
      errorText: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' },
      smallBtn: {
        flex: '0 0 auto',
        padding: '1px 8px',
        border: '1px solid ' + C.border,
        borderRadius: 6,
        background: 'transparent',
        color: C.text,
        font: 'inherit',
        fontSize: 11,
        lineHeight: '18px',
        cursor: 'pointer',
      },
      hint: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        margin: '6px 10px 0',
        padding: '4px 8px',
        borderRadius: 6,
        background: C.surface,
        color: C.error,
        fontSize: 11.5,
        lineHeight: 1.5,
      },
      hintText: { flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word' },
      hintClose: {
        flex: '0 0 auto',
        width: 16,
        height: 16,
        padding: 0,
        border: 'none',
        borderRadius: 4,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      composer: {
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px 10px',
        borderTop: '1px solid ' + C.borderSoft,
      },
      thumbs: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      thumb: {
        position: 'relative',
        width: 42,
        height: 42,
        borderRadius: 6,
        overflow: 'hidden',
        border: '1px solid ' + C.border,
        background: C.surface,
      },
      thumbImg: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
      thumbDel: {
        position: 'absolute',
        top: 0,
        right: 0,
        width: 14,
        height: 14,
        padding: 0,
        border: 'none',
        borderRadius: '0 0 0 6px',
        background: 'rgba(0,0,0,0.55)',
        color: '#ffffff',
        font: 'inherit',
        fontSize: 10,
        lineHeight: '14px',
        cursor: 'pointer',
      },
      inputRow: { display: 'flex', alignItems: 'flex-end', gap: 6 },
      textarea: {
        flex: '1 1 auto',
        minWidth: 0,
        minHeight: 28,
        maxHeight: TEXTAREA_MAX_H,
        boxSizing: 'border-box',
        resize: 'none',
        overflowY: 'hidden',
        padding: '4px 8px',
        border: '1px solid ' + C.border,
        borderRadius: 8,
        background: 'transparent',
        color: C.text,
        fontFamily: 'inherit',
        fontSize: 12.5,
        lineHeight: '18px',
        outline: 'none',
      },
      toolBtn: {
        flex: '0 0 auto',
        width: 28,
        height: 28,
        padding: 0,
        border: '1px solid ' + C.border,
        borderRadius: 8,
        background: 'transparent',
        color: C.text2,
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      sendBtn: {
        flex: '0 0 auto',
        minWidth: 46,
        height: 28,
        padding: '0 10px',
        border: '1px solid transparent',
        borderRadius: 8,
        background: C.text,
        color: C.inverse,
        font: 'inherit',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
      },
      sendOff: { opacity: 0.42, cursor: 'default' },
      stopBtn: {
        flex: '0 0 auto',
        minWidth: 46,
        height: 28,
        padding: '0 10px',
        border: '1px solid ' + C.error,
        borderRadius: 8,
        background: 'transparent',
        color: C.error,
        font: 'inherit',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
      },
      hidden: { display: 'none' },
      broken: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        fontSize: 12,
        color: C.error,
      },
    }

    var KEYFRAMES = '@keyframes dshf-blink{0%,100%{opacity:.28}50%{opacity:1}}'
      + '.fc-pill{transition:box-shadow .12s ease,background .12s ease}'
      + '.fc-pill:hover{box-shadow:var(--dsw-shadow-lv2,0 2px 6px rgba(0,0,0,.16));'
      + 'background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))}'
      + '.fc-pill:active{box-shadow:none}'
      + '.fc-seg:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}'

    // ── 纯工具 ─────────────────────────────────────────────────────

    function normalizeStatus(value, fallback) {
      return value === 'idle' || value === 'running' || value === 'error' ? value : fallback || 'idle'
    }

    var SIDE_READ_MODES = ['allow', 'ask', 'deny']

    function normalizeSettings(raw) {
      return {
        open: raw.open === true,
        mainRead: raw.mainRead === true,
        sideRead: SIDE_READ_MODES.indexOf(raw.sideRead) >= 0 ? raw.sideRead : 'deny',
        web: raw.web === true,
      }
    }

    function delayFor(status) {
      return status === 'running' ? RUNNING_MS : IDLE_MS
    }

    function describeError(error) {
      if (!error) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    function readAsDataUrl(file) {
      return new Promise(function (resolve, reject) {
        if (typeof FileReader === 'undefined') {
          reject(new Error('当前环境不支持读取文件'))
          return
        }
        var reader = new FileReader()
        reader.onload = function () {
          var result = typeof reader.result === 'string' ? reader.result : ''
          if (result.indexOf('base64,') < 0) {
            reject(new Error('图片编码失败'))
            return
          }
          resolve(result)
        }
        reader.onerror = function () {
          reject(reader.error || new Error('读取失败'))
        }
        reader.readAsDataURL(file)
      })
    }

    // ── 错误边界：崩在这里，不伤外层会话界面 ─────────────────────────

    function Boundary(props) {
      React.Component.call(this, props)
      this.state = { error: null }
      var self = this
      this.reset = function () {
        self.setState({ error: null })
      }
    }
    Boundary.prototype = Object.create(React.Component.prototype)
    Boundary.prototype.constructor = Boundary
    Boundary.getDerivedStateFromError = function (error) {
      return { error: error }
    }
    Boundary.prototype.componentDidCatch = function (error) {
      console.error('[freedomchat] panel crashed', error)
    }
    Boundary.prototype.render = function () {
      if (!this.state || !this.state.error) return this.props ? this.props.children : null
      var message = (this.state.error && this.state.error.message) || String(this.state.error)
      return h(
        'div',
        { style: styles.broken },
        h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, '面板出错了：' + message),
        h('button', { type: 'button', style: styles.smallBtn, onClick: this.reset }, '重试')
      )
    }

    // ── 控制器：状态 + 轮询 + 动作 ───────────────────────────────────

    function initialServer() {
      return {
        phase: 'starting', // starting | ready | failed
        threadId: null,
        version: 0,
        status: 'idle',
        model: null,
        messages: [],
        settings: { open: false, mainRead: false, sideRead: 'deny', web: false },
        approval: null,
        error: null,
        notice: null,
        pollError: null,
        connectError: null,
      }
    }

    function useFreedomChat(sessionId) {
      var serverPair = React.useState(initialServer)
      var server = serverPair[0]
      var setServer = serverPair[1]

      var draftPair = React.useState('')
      var draft = draftPair[0]
      var setDraft = draftPair[1]

      var attachmentPair = React.useState([])
      var attachments = attachmentPair[0]
      var setAttachments = attachmentPair[1]

      var confirmPair = React.useState(false)
      var confirming = confirmPair[0]
      var setConfirming = confirmPair[1]

      var sendingPair = React.useState(false)
      var sending = sendingPair[0]
      var setSending = sendingPair[1]

      var catalogPair = React.useState(null)
      var catalog = catalogPair[0]
      var setCatalog = catalogPair[1]

      var menuPair = React.useState(false)
      var modelMenu = menuPair[0]
      var setModelMenu = menuPair[1]

      var sideMenuPair = React.useState(false)
      var sideMenu = sideMenuPair[0]
      var setSideMenu = sideMenuPair[1]

      var aliveRef = React.useRef(false)
      var threadRef = React.useRef(null)
      var versionRef = React.useRef(0)
      var restartRef = React.useRef(null)
      var scrollRef = React.useRef(null)
      var stickRef = React.useRef(true)
      var inputRef = React.useRef(null)
      var fileRef = React.useRef(null)
      var pendingSettingsRef = React.useRef(null)

      function patch(updater) {
        setServer(function (prev) {
          return updater(prev) || prev
        })
      }

      function showNotice(text) {
        patch(function (prev) {
          return Object.assign({}, prev, { notice: text })
        })
      }

      // 只有当宿主回了完整 messages 时才认这个 version —— versionRef 代表
      // 「屏幕上这份 messages 对应的版本」，这样 version 不变的只回状态包就不会清空列表。
      function applySnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return
        var messages = Array.isArray(snapshot.messages) ? snapshot.messages : null
        if (messages && typeof snapshot.version === 'number') versionRef.current = snapshot.version
        patch(function (prev) {
          return {
            phase: 'ready',
            threadId: threadRef.current || prev.threadId,
            version: typeof snapshot.version === 'number' ? snapshot.version : prev.version,
            status: normalizeStatus(snapshot.status, prev.status),
            model: snapshot.model && typeof snapshot.model === 'object' ? snapshot.model : prev.model,
            settings:
              snapshot.settings && typeof snapshot.settings === 'object'
                ? normalizeSettings(snapshot.settings)
                : prev.settings,
            approval:
              snapshot.approval && typeof snapshot.approval === 'object' ? snapshot.approval : null,
            messages: messages || prev.messages,
            error:
              snapshot.status === 'error'
                ? snapshot.error
                  ? String(snapshot.error)
                  : prev.error || '生成失败'
                : null,
            notice: prev.notice,
            pollError: null,
            connectError: null,
          }
        })
      }

      function adoptThread(threadId, snapshot, resetMessages) {
        if (threadId) threadRef.current = String(threadId)
        var next = snapshot && typeof snapshot === 'object' ? snapshot : { version: 0, status: 'idle' }
        if (resetMessages) next = Object.assign({ messages: [] }, next)
        applySnapshot(next)
      }

      function enterArchived() {
        threadRef.current = null
        patch(function (prev) {
          return Object.assign({}, prev, {
            phase: 'archived',
            threadId: null,
            version: 0,
            status: 'idle',
            messages: [],
            live: '',
            approval: null,
            connectError: null,
            error: null,
            notice: null,
            pollError: null,
          })
        })
      }

      function enterEmpty() {
        threadRef.current = null
        patch(function (prev) {
          return Object.assign({}, prev, {
            phase: 'empty',
            threadId: null,
            version: 0,
            status: 'idle',
            messages: [],
            live: '',
            approval: null,
            connectError: null,
            error: null,
            notice: null,
            pollError: null,
          })
        })
      }

      // Mounting must not create a child session: an idle open used to leave an
      // empty transcript behind every time. `peek` only resumes what exists.
      function peekNow() {
        var parent = sessionId ? String(sessionId) : ''
        if (parent === '') {
          patch(function (prev) {
            return Object.assign({}, prev, {
              phase: 'failed',
              connectError: '缺少当前会话 id，无法建立独立对话',
            })
          })
          return
        }
        patch(function (prev) {
          return Object.assign({}, prev, { phase: 'starting', connectError: null, error: null })
        })
        apiPeek(parent).then(
          function (result) {
            if (!aliveRef.current) return
            if (result && result.state === 'archived') {
              enterArchived()
              return
            }
            if (result && result.state === 'live' && result.threadId) {
              adoptThread(result.threadId, result.snapshot, false)
              announceOpen()
              if (restartRef.current) restartRef.current()
              return
            }
            enterEmpty()
          },
          function (error) {
            if (!aliveRef.current) return
            patch(function (prev) {
              return Object.assign({}, prev, {
                phase: 'failed',
                connectError: '连接失败：' + describeError(error),
              })
            })
          }
        )
      }

      function ensureNow() {
        var parent = sessionId ? String(sessionId) : ''
        patch(function (prev) {
          return Object.assign({}, prev, { phase: 'starting', connectError: null, error: null })
        })
        if (parent === '') {
          patch(function (prev) {
            return Object.assign({}, prev, {
              phase: 'failed',
              connectError: '缺少当前会话 id，无法建立独立对话',
            })
          })
          return
        }
        apiEnsure(parent).then(
          function (result) {
            if (!aliveRef.current) return
            var snapshot = result && result.snapshot
            if (result && result.state === 'archived') {
              enterArchived()
              return
            }
            threadRef.current = result && result.threadId ? String(result.threadId) : null
            if (!snapshot) {
              patch(function (prev) {
                return Object.assign({}, prev, {
                  phase: 'failed',
                  connectError: '宿主没有返回对话快照',
                })
              })
              return
            }
            adoptThread(threadRef.current, snapshot, true)
            announceOpen()
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            patch(function (prev) {
              return Object.assign({}, prev, {
                phase: 'failed',
                connectError: '连接失败：' + describeError(error),
              })
            })
          }
        )
      }

      // 主对话被归档后，侧边对话已删除；这里让用户从墓碑上直接开一个新的。
      function reviveNow() {
        var parent = sessionId ? String(sessionId) : ''
        if (parent === '') return
        patch(function (prev) {
          return Object.assign({}, prev, { phase: 'starting', connectError: null, error: null })
        })
        apiRevive(parent).then(
          function (result) {
            if (!aliveRef.current) return
            var snapshot = result && result.snapshot
            threadRef.current = result && result.threadId ? String(result.threadId) : null
            if (!snapshot) {
              patch(function (prev) {
                return Object.assign({}, prev, { phase: 'failed', connectError: '宿主没有返回对话快照' })
              })
              return
            }
            adoptThread(threadRef.current, snapshot, true)
            announceOpen()
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            patch(function (prev) {
              return Object.assign({}, prev, { phase: 'failed', connectError: '新建失败：' + describeError(error) })
            })
          }
        )
      }

      // 面板在屏期间持续刷新 open —— 宿主用轮询当心跳，超时即视为已关闭。
      function announceOpen() {
        var threadId = threadRef.current
        if (!threadId) return
        var pending = pendingSettingsRef.current
        pendingSettingsRef.current = null
        var payload = pending ? Object.assign({}, pending, { open: true }) : { open: true }
        apiSetSettings(threadId, payload).then(
          function (snapshot) {
            if (aliveRef.current) applySnapshot(snapshot)
          },
          function () {
            if (pending) pendingSettingsRef.current = pending
            /* the next poll re-announces */
          }
        )
      }

      function announceClosed() {
        var threadId = threadRef.current
        if (!threadId) return
        apiSetSettings(threadId, { open: false }).then(
          function () {},
          function () {}
        )
      }

      function updateSettings(changes) {
        var values = patchValues(changes)
        var before = server.settings
        patch(function (prev) {
          return Object.assign({}, prev, {
            settings: Object.assign({}, prev.settings, values),
          })
        })
        var threadId = threadRef.current
        if (!threadId) {
          // 面板处于 empty/starting（还没有会话）时先记下，等 announceOpen 时一起下发，
          // 否则点击会被静默吞掉、指示灯永远不变。
          pendingSettingsRef.current = Object.assign({}, pendingSettingsRef.current, values)
          return
        }
        apiSetSettings(threadId, values).then(
          function (snapshot) {
            if (!aliveRef.current) return
            if (snapshot) applySnapshot(snapshot)
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            patch(function (prev) {
              return Object.assign({}, prev, {
                settings: before,
                notice: '设置没有保存：' + describeError(error),
              })
            })
          }
        )
      }

      function patchValues(patch) {
        var out = {}
        Object.keys(patch).forEach(function (key) {
          if (key !== 'open') out[key] = patch[key]
        })
        return out
      }

      function resolveApproval(allow) {
        var threadId = threadRef.current
        var approval = server.approval
        if (!threadId || !approval) return
        patch(function (prev) {
          return Object.assign({}, prev, { approval: null })
        })
        apiResolveApproval(threadId, approval.id, allow).then(
          function () {
            if (!aliveRef.current) return
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            showNotice('确认没有送达：' + describeError(error))
          }
        )
      }

      function currentParts() {
        var parts = []
        if (draft && draft.trim() !== '') parts.push({ type: 'text', text: draft })
        for (var index = 0; index < attachments.length; index += 1) {
          var item = attachments[index]
          if (!item || typeof item.url !== 'string') continue
          var comma = item.url.indexOf(',')
          if (comma < 0) continue
          parts.push({
            type: 'image',
            mediaType: item.mediaType,
            name: item.name,
            data: item.url.slice(comma + 1),
          })
        }
        return parts
      }

      function ensureAndSubmit() {
        var parent = sessionId ? String(sessionId) : ''
        if (parent === '') {
          showNotice('缺少当前会话 id')
          return
        }
        setSending(true)
        apiEnsure(parent).then(
          function (result) {
            if (!aliveRef.current) return
            setSending(false)
            if (result && result.state === 'archived') {
              enterArchived()
              return
            }
            if (!result || !result.threadId) {
              showNotice('无法开始对话，请稍后再试')
              return
            }
            adoptThread(result.threadId, result.snapshot, true)
            announceOpen()
            submit()
          },
          function (error) {
            if (!aliveRef.current) return
            setSending(false)
            showNotice('新建失败：' + describeError(error))
          }
        )
      }

      function submit() {
        if (sending) return
        var threadId = threadRef.current
        if (!threadId) {
          if (server.phase === 'empty') {
            ensureAndSubmit()
            return
          }
          showNotice('对话还没准备好，请稍后再试')
          return
        }
        var parts = currentParts()
        if (parts.length === 0) return

        var previousStatus = server.status
        var savedDraft = draft
        var savedAttachments = attachments
        var optimistic = {
          id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          status: 'done',
          parts: parts,
          at: Date.now(),
        }

        setSending(true)
        setDraft('')
        setAttachments([])
        setConfirming(false)
        stickRef.current = true
        patch(function (prev) {
          return Object.assign({}, prev, {
            messages: prev.messages.concat([optimistic]),
            status: 'running',
            error: null,
            pollError: null,
            notice: null,
          })
        })

        apiSend(threadId, parts).then(
          function () {
            if (!aliveRef.current) return
            setSending(false)
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            setSending(false)
            patch(function (prev) {
              return Object.assign({}, prev, {
                messages: prev.messages.filter(function (message) {
                  return !message || message.id !== optimistic.id
                }),
                status: previousStatus,
                notice: '发送失败：' + describeError(error) + '（已撤回这条消息）',
              })
            })
            // 输入内容还在就还回去，别让用户为一次网络失败重打一遍。
            setDraft(function (prev) {
              return prev === '' ? savedDraft : prev
            })
            setAttachments(function (prev) {
              return prev.length === 0 ? savedAttachments : prev
            })
          }
        )
      }

      function cancelNow() {
        var threadId = threadRef.current
        if (!threadId) return
        apiCancel(threadId).then(
          function () {
            if (!aliveRef.current) return
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            showNotice('停止失败：' + describeError(error))
          }
        )
      }

      function clearNow() {
        var threadId = threadRef.current
        setConfirming(false)
        if (!threadId) {
          showNotice('对话还没准备好，请稍后再试')
          return
        }
        apiClear(threadId).then(
          function (result) {
            if (!aliveRef.current) return
            if (!result || result.state === 'empty' || !result.threadId) {
              enterEmpty()
              showNotice('已删除这个侧边对话，下一条消息会开一个新的。')
              return
            }
            adoptThread(result.threadId, result.snapshot, true)
            stickRef.current = true
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            showNotice('清空失败：' + describeError(error))
          }
        )
      }

      function retry() {
        if (sending) return
        var threadId = threadRef.current
        if (!threadId) return
        var list = server.messages || []
        var last = null
        for (var index = list.length - 1; index >= 0; index -= 1) {
          if (list[index] && list[index].role === 'user') {
            last = list[index]
            break
          }
        }
        if (!last || !Array.isArray(last.parts) || last.parts.length === 0) {
          showNotice('没有可重发的消息')
          return
        }
        setSending(true)
        patch(function (prev) {
          return Object.assign({}, prev, { status: 'running', error: null, notice: null })
        })
        apiSend(threadId, last.parts).then(
          function () {
            if (!aliveRef.current) return
            setSending(false)
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            setSending(false)
            patch(function (prev) {
              return Object.assign({}, prev, {
                status: 'error',
                notice: '重发失败：' + describeError(error),
              })
            })
          }
        )
      }

      function pickModel(provider, model, reasoningEffort) {
        var threadId = threadRef.current
        setModelMenu(false)
        if (!threadId) return
        apiSetModel(threadId, provider, model, reasoningEffort).then(
          function (snapshot) {
            if (!aliveRef.current) return
            if (snapshot) applySnapshot(snapshot)
            if (restartRef.current) restartRef.current()
          },
          function (error) {
            if (!aliveRef.current) return
            showNotice('切换模型失败：' + describeError(error))
          }
        )
      }

      function onDraftChange(event) {
        var target = event && event.target
        setDraft(target && typeof target.value === 'string' ? target.value : '')
      }

      function onComposerKeyDown(event) {
        if (!event || event.key !== 'Enter' || event.shiftKey) return
        // 输入法组词中的回车只是选词，不能当发送。
        if (event.isComposing) return
        if (event.nativeEvent && event.nativeEvent.isComposing) return
        event.preventDefault()
        submit()
      }

      function onPickImages() {
        if (fileRef.current) fileRef.current.click()
      }

      function onRemoveAttachment(id) {
        setAttachments(function (prev) {
          return prev.filter(function (item) {
            return item.id !== id
          })
        })
      }

      function onFilesChosen(event) {
        var input = event && event.target
        var files = input && input.files ? Array.prototype.slice.call(input.files) : []
        if (input) input.value = '' // 清空 value，同一张图还能再选一次
        addImages(files)
      }

      // 剪贴板里的图片和选择框里的文件走同一条入库路径。
      function onComposerPaste(event) {
        var data = event && (event.clipboardData || (event.nativeEvent && event.nativeEvent.clipboardData))
        if (!data) return
        var files = []
        if (data.items && data.items.length > 0) {
          for (var index = 0; index < data.items.length; index += 1) {
            var item = data.items[index]
            if (!item || item.kind !== 'file' || !ALLOWED_TYPES[item.type]) continue
            var picked = item.getAsFile ? item.getAsFile() : null
            if (picked) files.push(picked)
          }
        }
        if (files.length === 0 && data.files && data.files.length > 0) {
          files = Array.prototype.slice.call(data.files).filter(function (file) {
            return file && ALLOWED_TYPES[file.type]
          })
        }
        if (files.length === 0) return
        // 有图就不要再把图片粘成 base64 文本。
        event.preventDefault()
        addImages(files)
      }

      function addImages(files) {
        if (!files || files.length === 0) return

        var room = MAX_IMAGES - attachments.length
        if (room <= 0) {
          showNotice('最多 ' + MAX_IMAGES + ' 张图片')
          return
        }

        var problems = []
        var accepted = []
        var totalBytes = 0
        for (var existing = 0; existing < attachments.length; existing += 1) {
          var known = attachments[existing]
          if (known && typeof known.size === 'number') totalBytes += known.size
        }
        for (var index = 0; index < files.length && accepted.length < room; index += 1) {
          var file = files[index]
          var name = file && file.name ? file.name : '图片'
          if (!file || !ALLOWED_TYPES[file.type]) {
            problems.push('「' + name + '」格式不支持')
            continue
          }
          if (file.size > MAX_IMAGE_BYTES) {
            problems.push('「' + name + '」超过 8MB')
            continue
          }
          if (totalBytes + file.size > MAX_IMAGE_TOTAL_BYTES) {
            problems.push('图片总大小不能超过 18MB')
            continue
          }
          totalBytes += file.size
          accepted.push(file)
        }
        if (files.length > room) problems.push('最多 ' + MAX_IMAGES + ' 张图片')

        var chain = Promise.resolve()
        accepted.forEach(function (file) {
          chain = chain.then(function () {
            return readAsDataUrl(file).then(function (url) {
              if (!aliveRef.current) return
              var entry = {
                id: 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                mediaType: file.type,
                name: file.name || '图片',
                size: file.size,
                url: url,
              }
              setAttachments(function (prev) {
                return prev.length >= MAX_IMAGES ? prev : prev.concat([entry])
              })
            })
          })
        })
        chain.then(
          function () {
            if (!aliveRef.current) return
            if (problems.length > 0) showNotice(problems.join('；'))
          },
          function (error) {
            if (!aliveRef.current) return
            showNotice('读取图片失败：' + describeError(error))
          }
        )
      }

      function onStreamScroll(event) {
        var el = event && event.currentTarget
        if (!el || typeof el.scrollTop !== 'number') return
        var distance = (el.scrollHeight || 0) - el.scrollTop - (el.clientHeight || 0)
        stickRef.current = distance < 48
      }

      // 轮询：挂载即 ensure，之后自调度；卸载靠 stopped + aliveRef 双层兜底，
      // 避免 promise 回调落在已卸载组件上。
      React.useEffect(
        function () {
          aliveRef.current = true
          var stopped = false
          var timer = 0

          function stopTimer() {
            if (timer) {
              clearTimeout(timer)
              timer = 0
            }
          }

          function schedule(delay) {
            if (stopped) return
            stopTimer()
            timer = setTimeout(poll, delay)
          }

          function poll() {
            if (stopped) return
            var threadId = threadRef.current
            if (!threadId) return // ensure 没过：让重试按钮驱动，不空转
            apiSnapshot(threadId, versionRef.current).then(
              function (snapshot) {
                if (stopped) return
                if (snapshot && snapshot.state === 'archived') {
                  // The sweep deleted this thread while the panel was idle. Ask
                  // the host what the truth is now: a tombstone if the main
                  // session is still archived, a fresh empty chat if it was
                  // already unarchived.
                  ensureNow()
                  return
                }
                applySnapshot(snapshot)
                // Host may have closed the gate after missing heartbeats; the
                // panel is on screen right now, so claim it back.
                if (snapshot && snapshot.settings && snapshot.settings.open === false) announceOpen()
                schedule(delayFor(snapshot && snapshot.status))
              },
              function (error) {
                if (stopped) return
                if (error && error.code === 'not-found') {
                  // Host restarted (or raced a sweep): re-ensure instead of
                  // showing a sync error the user cannot act on.
                  ensureNow()
                  return
                }
                var text = describeError(error)
                setServer(function (prev) {
                  return prev.pollError === text ? prev : Object.assign({}, prev, { pollError: text })
                })
                schedule(IDLE_MS)
              }
            )
          }

          restartRef.current = function () {
            schedule(0)
          }
          peekNow()
          return function () {
            stopped = true
            aliveRef.current = false
            restartRef.current = null
            stopTimer()
            announceClosed()
          }
        },
        [sessionId]
      )

      // 模型目录是一次性读取；宿主没有 sessionController 时降级成 unavailable。
      React.useEffect(function () {
        var alive = true
        apiCatalog().then(
          function (next) {
            if (alive) setCatalog(next && typeof next === 'object' ? next : { available: false, groups: [] })
          },
          function () {
            if (alive) setCatalog({ available: false, groups: [] })
          }
        )
        return function () {
          alive = false
        }
      }, [])

      // textarea 自增高：先归零再读 scrollHeight，超过 6 行就交给滚动。
      React.useEffect(
        function () {
          var el = inputRef.current
          if (!el || !el.style) return
          el.style.height = 'auto'
          var height = Math.min(el.scrollHeight || 0, TEXTAREA_MAX_H)
          el.style.height = (height > 0 ? height : 18) + 'px'
          el.style.overflowY = (el.scrollHeight || 0) > TEXTAREA_MAX_H ? 'auto' : 'hidden'
        },
        [draft]
      )

      // 贴底时自动跟随新消息；用户往上翻过就不再抢滚动位置。
      React.useEffect(
        function () {
          var el = scrollRef.current
          if (!el || !stickRef.current) return
          el.scrollTop = el.scrollHeight || 0
        },
        [server.messages, server.status, server.phase]
      )

      return {
        server: server,
        draft: draft,
        attachments: attachments,
        confirming: confirming,
        sending: sending,
        scrollRef: scrollRef,
        inputRef: inputRef,
        fileRef: fileRef,
        onDraftChange: onDraftChange,
        onComposerKeyDown: onComposerKeyDown,
        onPickImages: onPickImages,
        onFilesChosen: onFilesChosen,
        onComposerPaste: onComposerPaste,
        onRemoveAttachment: onRemoveAttachment,
        onStreamScroll: onStreamScroll,
        submit: submit,
        cancel: cancelNow,
        setMainRead: function (next) {
          updateSettings({ mainRead: next === true })
        },
        setSideRead: function (next) {
          updateSettings({ sideRead: next })
        },
        setWeb: function (next) {
          updateSettings({ web: next === true })
        },
        resolveApproval: resolveApproval,
        askClear: function () {
          setConfirming(true)
        },
        cancelClear: function () {
          setConfirming(false)
        },
        clearNow: clearNow,
        retry: retry,
        ensureNow: ensureNow,
        reviveNow: reviveNow,
        catalog: catalog,
        modelMenu: modelMenu,
        toggleModelMenu: function () {
          setModelMenu(!modelMenu)
        },
        closeModelMenu: function () {
          setModelMenu(false)
        },
        sideMenu: sideMenu,
        toggleSideMenu: function () {
          setSideMenu(!sideMenu)
        },
        closeSideMenu: function () {
          setSideMenu(false)
        },
        pickModel: pickModel,
        pickEffort: function (effort) {
          var model = server.model
          if (!model || !model.provider || !model.id) return
          pickModel(model.provider, model.id, effort)
        },
        dismissNotice: function () {
          patch(function (prev) {
            return Object.assign({}, prev, { notice: null, pollError: null })
          })
        },
      }
    }

    // ── 呈现 ────────────────────────────────────────────────────────

    function renderImagePart(part, index) {
      if (typeof part.data === 'string' && part.data !== '') {
        var mediaType =
          typeof part.mediaType === 'string' && part.mediaType !== '' ? part.mediaType : 'image/png'
        return h('img', {
          key: 'img' + index,
          src: 'data:' + mediaType + ';base64,' + part.data,
          alt: part.name || '图片',
          style: styles.image,
        })
      }
      // assistant 的图片只带 attachmentId；P1 契约没有取图 URL 的通道，先给占位。
      return h(
        'span',
        { key: 'img' + index, style: styles.imageChip },
        '图片：' + (part.name || part.attachmentId || '未命名')
      )
    }

    /* ── 轻量 markdown 兜底 ─────────────────────────────────────────────────
     * 宿主共享的 MarkdownText 取不到时（老壳层、模块系统未注入），助手正文也不该
     * 把 ** 和 # 当普通字符显示。这里只覆盖常见写法：标题、列表、引用、代码块、
     * 表格、段落，以及行内粗体 / 斜体 / 行内代码 / 链接。 */
    var INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g

    function inlineNodes(text, key) {
      var nodes = []
      var value = String(text)
      var last = 0
      var match
      var seat = 0
      INLINE_RE.lastIndex = 0
      while ((match = INLINE_RE.exec(value)) !== null) {
        if (match.index > last) nodes.push(value.slice(last, match.index))
        var token = match[0]
        var id = key + ':' + (seat += 1)
        if (token.slice(0, 2) === '**') {
          nodes.push(h('strong', { key: id }, token.slice(2, -2)))
        } else if (token.charAt(0) === '`') {
          nodes.push(h('code', { key: id, style: styles.mdCode }, token.slice(1, -1)))
        } else if (token.charAt(0) === '[') {
          var cut = token.indexOf('](')
          nodes.push(
            h(
              'a',
              { key: id, href: token.slice(cut + 2, -1), target: '_blank', rel: 'noreferrer', style: styles.mdLink },
              token.slice(1, cut)
            )
          )
        } else {
          nodes.push(h('em', { key: id }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < value.length) nodes.push(value.slice(last))
      return nodes
    }

    function renderMarkdown(text) {
      var lines = String(text === undefined || text === null ? '' : text).split('\n')
      var nodes = []
      var paragraph = []
      var seat = 0

      function flush() {
        if (paragraph.length === 0) return
        seat += 1
        nodes.push(h('div', { key: 'p' + seat, style: styles.mdP }, inlineNodes(paragraph.join('\n'), 'p' + seat)))
        paragraph = []
      }

      var index = 0
      while (index < lines.length) {
        var line = lines[index]
        if (/^\s*$/.test(line)) {
          flush()
          index += 1
          continue
        }
        if (/^\s*```/.test(line)) {
          flush()
          var code = []
          index += 1
          while (index < lines.length && !/^\s*```/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          seat += 1
          nodes.push(h('pre', { key: 'pre' + seat, style: styles.mdPre }, h('code', null, code.join('\n'))))
          continue
        }
        if (/^\s*\|/.test(line)) {
          flush()
          var raw = []
          while (index < lines.length && /^\s*\|/.test(lines[index])) {
            raw.push(lines[index].trim())
            index += 1
          }
          seat += 1
          var grid = []
          for (var r = 0; r < raw.length; r += 1) {
            var cells = raw[r].replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) {
              return cell.trim()
            })
            var divider = true
            for (var c = 0; c < cells.length; c += 1) {
              if (!/^:?-{2,}:?$/.test(cells[c])) divider = false
            }
            if (!divider) grid.push(cells)
          }
          if (grid.length > 0) {
            var head = grid[0]
            var body = grid.slice(1)
            nodes.push(
              h(
                'table',
                { key: 'tbl' + seat, style: styles.mdTableEl },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    head.map(function (cell, ci) {
                      return h('th', { key: 'h' + ci, style: styles.mdTh }, inlineNodes(cell, 'th' + seat + ci))
                    })
                  )
                ),
                body.length === 0
                  ? null
                  : h(
                      'tbody',
                      null,
                      body.map(function (rowCells, ri) {
                        return h(
                          'tr',
                          { key: 'r' + ri },
                          rowCells.map(function (cell, ci) {
                            return h(
                              'td',
                              { key: 'c' + ci, style: styles.mdTd },
                              inlineNodes(cell, 'td' + seat + ri + ci)
                            )
                          })
                        )
                      })
                    )
              )
            )
          }
          continue
        }
        var heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          flush()
          seat += 1
          nodes.push(
            h(
              'div',
              { key: 'h' + seat, style: heading[1].length <= 2 ? styles.mdH1 : styles.mdH2 },
              inlineNodes(heading[2], 'h' + seat)
            )
          )
          index += 1
          continue
        }
        var quote = /^\s*>\s?(.*)$/.exec(line)
        if (quote) {
          flush()
          seat += 1
          nodes.push(h('div', { key: 'q' + seat, style: styles.mdQuote }, inlineNodes(quote[1], 'q' + seat)))
          index += 1
          continue
        }
        var item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
        if (item) {
          flush()
          seat += 1
          var depth = Math.min(Math.floor(item[1].length / 2), 4)
          nodes.push(
            h(
              'div',
              { key: 'li' + seat, style: { ...styles.mdItem, paddingLeft: 2 + depth * 14 } },
              h('span', { style: styles.mdBullet }, /^\d/.test(item[2]) ? item[2] : '•'),
              h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, inlineNodes(item[3], 'li' + seat))
            )
          )
          index += 1
          continue
        }
        paragraph.push(line)
        index += 1
      }
      flush()
      return nodes
    }

    function renderParts(message) {
      var parts = Array.isArray(message.parts) ? message.parts : []
      var nodes = []
      for (var index = 0; index < parts.length; index += 1) {
        var part = parts[index]
        if (!part || typeof part !== 'object') continue
        if (part.type === 'text') {
          var text = typeof part.text === 'string' ? part.text : ''
          if (text === '') continue
          if (message.role === 'assistant' && MarkdownText) {
            nodes.push(
              h(MarkdownText, {
                key: 'md' + index,
                text: text,
                labels: MARKDOWN_LABELS,
                streaming: message.status === 'streaming',
              })
            )
          } else if (message.role === 'assistant') {
            nodes.push(h('div', { key: 'txt' + index, style: styles.mdBody }, renderMarkdown(text)))
          } else {
            nodes.push(h('div', { key: 'txt' + index, style: styles.plain }, text))
          }
        } else if (part.type === 'image') {
          nodes.push(renderImagePart(part, index))
        }
      }
      return nodes
    }

    function renderMessage(message, index) {
      if (!message || typeof message !== 'object') return null
      var isUser = message.role === 'user'
      var children = renderParts(message)
      if (!isUser && message.status === 'streaming') {
        if (children.length === 0) children.push(h('span', { key: 'wait', style: styles.plain }, '…'))
        children.push(h('div', { key: 'streaming', style: styles.streaming }, '生成中…'))
      }
      return h(
        'div',
        { key: message.id || 'm' + index, style: isUser ? styles.rowUser : styles.rowAssistant },
        h('div', { style: isUser ? styles.bubbleUser : styles.bubbleAssistant }, children)
      )
    }

    function renderMessages(messages) {
      var list = Array.isArray(messages) ? messages : []
      var nodes = []
      for (var index = 0; index < list.length; index += 1) {
        var node = renderMessage(list[index], index)
        if (node) nodes.push(node)
      }
      return nodes
    }

    /* ── 输入区（对齐「侧边对话(beta)」的外形）──────────────────────── */

    // The accent the beta side chat paints its own tab glyph with.
    var ACCENT = 'var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary)))'

    var SIDE_READ_LABEL = { allow: '允许', ask: '询问', deny: '不允许' }

    function iconPaperclip() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M5.1 10.6 10.3 5.4a2.1 2.1 0 0 1 3 3l-6 6a3.3 3.3 0 0 1-4.7-4.7l6.2-6.2' })
      )
    }

    function iconSend() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M8 13V3.6M3.9 7.7 8 3.6l4.1 4.1' })
      )
    }

    function iconStop() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
        h('rect', { x: 4.2, y: 4.2, width: 7.6, height: 7.6, rx: 2 })
      )
    }

    // The tab glyph: the same comment-discussion mark the beta side chat uses.
    function tabIcon(size) {
      var px = typeof size === 'number' && size > 0 ? size : 16
      return h(
        'span',
        { style: { display: 'inline-flex', color: ACCENT } },
        h(
          'svg',
          { width: px, height: px, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
          h('path', {
            d:
              'M14.56 7.44049C14.28 7.16049 13.9 7.00049 13.5 7.00049H13V4.00049C13 2.90049 12.1 2.00049 11 2.00049H3C1.9 2.00049 1 2.90049 1 4.00049V9.00049C1 10.1005 1.9 11.0005 3 11.0005V12.0005C3 12.8205 3.93 13.2905 4.59 12.8105L7 11.0505V11.5005C7 11.9005 7.16 12.2805 7.44 12.5605C7.72 12.8405 8.1 13.0005 8.5 13.0005H10.29L12.15 14.8505C12.19 14.9005 12.25 14.9405 12.31 14.9605C12.37 14.9905 12.43 15.0005 12.5 15.0005C12.57 15.0005 12.63 14.9905 12.69 14.9605C12.78 14.9205 12.86 14.8605 12.92 14.7805C12.97 14.7005 13 14.6005 13 14.5005V13.0005H13.5C13.9 13.0005 14.28 12.8405 14.56 12.5605C14.84 12.2805 15 11.9005 15 11.5005V8.50049C15 8.10049 14.84 7.72049 14.56 7.44049ZM6.75 10.0005L4 12.0005V10.0005H3C2.45 10.0005 2 9.55049 2 9.00049V4.00049C2 3.45049 2.45 3.00049 3 3.00049H11C11.55 3.00049 12 3.45049 12 4.00049V7.00049H8.5C8.1 7.00049 7.72 7.16049 7.44 7.44049C7.16 7.72049 7 8.10049 7 8.50049V10.0005H6.75ZM14 11.5005C14 11.6305 13.95 11.7605 13.85 11.8505C13.76 11.9505 13.63 12.0005 13.5 12.0005H12.5C12.37 12.0005 12.24 12.0505 12.15 12.1505C12.05 12.2405 12 12.3705 12 12.5005V13.2905L10.85 12.1505C10.81 12.1005 10.75 12.0605 10.69 12.0405C10.63 12.0105 10.57 12.0005 10.5 12.0005H8.5C8.37 12.0005 8.24 11.9505 8.15 11.8505C8.05 11.7605 8 11.6305 8 11.5005V8.50049C8 8.37049 8.05 8.24049 8.15 8.15049C8.24 8.05049 8.37 8.00049 8.5 8.00049H13.5C13.63 8.00049 13.76 8.05049 13.85 8.15049C13.95 8.24049 14 8.37049 14 8.50049V11.5005Z',
          })
        )
      )
    }

    var cs = {
      composer: {
        border: '1px solid var(--dsw-alias-border-l2-darkmode-thin,var(--dsw-alias-border-l2))',
        background: 'var(--dsw-specific-input-major,var(--dsw-alias-bg-base))',
        boxShadow: 'var(--dsw-shadow-lv2,none)',
        borderRadius: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        margin: '0 8px 8px',
        padding: '8px 8px 6px 12px',
        flex: 'none',
      },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        color: 'var(--dsw-alias-label-primary)',
        font: 'var(--dsw-font-s-14)',
        resize: 'none',
        background: 'transparent',
        border: 'none',
        outline: 'none',
        maxHeight: 132,
        padding: '2px 0',
        lineHeight: '22px',
      },
      bar: { display: 'flex', alignItems: 'center', gap: 4, minHeight: 28, flex: 'none', flexWrap: 'wrap' },
      tools: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: '1 1 auto', flexWrap: 'wrap' },
      spacer: { flex: 1, minWidth: 0 },
      iconBtn: {
        width: 26,
        height: 26,
        borderRadius: 8,
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        borderRadius: 6,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        flex: 'none',
      },
      // 与主对话的「权限」「AI 控制电脑」同款：无边框，只有悬停时整个圆角矩形浮起阴影；
      // 开关状态只由左侧圆点表示，外框不随状态变色。
      pill: {
        border: '1px solid transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'var(--dsw-font-xxs-12)',
        cursor: 'pointer',
        background: 'transparent',
        borderRadius: 8,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        lineHeight: '18px',
      },
      pillOn: {
        border: '1px solid transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'var(--dsw-font-xxs-12)',
        cursor: 'pointer',
        background: 'transparent',
        borderRadius: 8,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        lineHeight: '18px',
      },
      lampOff: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        border: '1px solid var(--dsw-alias-label-tertiary)',
        background: 'transparent',
        flex: 'none',
      },
      lampOn: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        border: '1px solid ' + ACCENT,
        background: ACCENT,
        boxShadow: '0 0 0 2px color-mix(in srgb, ' + ACCENT + ' 22%, transparent)',
        flex: 'none',
      },
      lampWarn: {
        width: 6,
        height: 6,
        borderRadius: '50%',
        border: '1px solid var(--dsw-alias-state-warn-primary, #d89614)',
        background: 'var(--dsw-alias-state-warn-primary, #d89614)',
        boxShadow: '0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d89614) 22%, transparent)',
        flex: 'none',
      },
      modelPill: {
        border: '1px solid var(--dsw-alias-border-l2)',
        minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)',
        font: 'var(--dsw-font-xxs-12)',
        cursor: 'pointer',
        background: 'transparent',
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        flex: '0 auto',
      },
      modelName: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      caret: { fontSize: 10, lineHeight: 1 },
      sendBtn: {
        background: 'var(--dsw-alias-button-info-fill,var(--dsw-alias-accent,#4d6bfe))',
        width: 28,
        height: 28,
        color: 'var(--dsw-alias-button-info-label,var(--dsw-alias-accent-ink,#fff))',
        cursor: 'pointer',
        border: 'none',
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        flex: 'none',
      },
      sendOff: { opacity: 0.35, cursor: 'default' },
      attachRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 },
      attachChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '3px 6px',
        font: 'var(--dsw-font-xxs-12)',
        color: 'var(--dsw-alias-label-secondary)',
        minWidth: 0,
        maxWidth: '100%',
      },
      attachThumb: { width: 40, height: 40, objectFit: 'cover', borderRadius: 6, display: 'block', flex: 'none' },
      attachName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 },
      attachDel: {
        width: 18,
        height: 18,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'pointer',
        borderRadius: 4,
        padding: 0,
        flex: 'none',
      },
      menu: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        borderRadius: 10,
        padding: 4,
        margin: '0 8px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        boxShadow: 'var(--dsw-elevation-panel,none)',
      },
      menuTitle: { font: 'var(--dsw-font-xxs-12)', color: 'var(--dsw-alias-label-tertiary)', padding: '2px 8px' },
      menuItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: 'none',
        background: 'transparent',
        borderRadius: 6,
        padding: '5px 8px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        font: 'var(--dsw-font-xs-13)',
        textAlign: 'left',
      },
      menuItemOn: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        border: 'none',
        background: 'var(--dsw-alias-interactive-bg-hover)',
        borderRadius: 6,
        padding: '5px 8px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        font: 'var(--dsw-font-xs-13)',
        textAlign: 'left',
      },
      menuLabel: { flex: 1 },
      check: { color: 'var(--dsw-alias-state-success-primary)' },
    }

    function renderPill(key, label, on, onClick, title, tone) {
      var lamp = on ? (tone === 'warn' ? cs.lampWarn : cs.lampOn) : cs.lampOff
      return h(
        'button',
        {
          key: key,
          type: 'button',
          className: 'fc-pill',
          'aria-pressed': on === true,
          title: title,
          style: cs.pill,
          onClick: onClick,
        },
        h('span', { key: 'lamp', style: lamp, 'aria-hidden': 'true' }),
        h('span', { key: 'label' }, label)
      )
    }

    function renderControls(chat, locked) {
      var settings = chat.server.settings
      return h(
        'div',
        { style: cs.tools },
        h(
          'button',
          {
            type: 'button',
            className: 'fc-pill',
            style: cs.iconBtn,
            title: '添加图片（也可以直接粘贴）',
            'aria-label': '添加图片',
            disabled: locked,
            onClick: chat.onPickImages,
          },
          iconPaperclip()
        ),
        renderPill(
          'main',
          '读从对话',
          settings.mainRead,
          function () {
            chat.setMainRead(!settings.mainRead)
          },
          '打开后，主对话里的助手才能读取这条侧边对话；而且只有你在主对话里明确要求时才会读。'
        ),
        renderPill(
          'web',
          '联网',
          settings.web,
          function () {
            chat.setWeb(!settings.web)
          },
          '给这条侧边对话开放网页搜索与网页读取（web_search / web_fetch / research）。'
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-haspopup': 'menu',
            'aria-expanded': chat.sideMenu === true,
            title: '从属读主对话：允许 / 询问 / 不允许',
            className: 'fc-pill',
            style: cs.pill,
            onClick: chat.toggleSideMenu,
          },
          h('span', {
            key: 'lamp',
            'aria-hidden': 'true',
            style:
              settings.sideRead === 'deny'
                ? cs.lampOff
                : settings.sideRead === 'ask'
                  ? cs.lampWarn
                  : cs.lampOn,
          }),
          '读主对话 · ' + (SIDE_READ_LABEL[settings.sideRead] || '不允许')
        )
      )
    }

    function renderSideMenu(chat) {
      if (chat.sideMenu !== true) return null
      var current = chat.server.settings.sideRead
      var options = [
        ['allow', '允许', '侧边对话可以直接读主对话最近的内容'],
        ['ask', '询问', '每次读取前在面板里问一次'],
        ['deny', '不允许', '侧边对话看不到主对话的内容'],
      ]
      return h(
        'div',
        { style: cs.menu },
        h('div', { style: cs.menuTitle }, '从属读主对话'),
        options.map(function (option) {
          var key = option[0]
          var active = current === key
          return h(
            'button',
            {
              key: key,
              type: 'button',
              'aria-pressed': active,
              title: option[2],
              style: active ? cs.menuItemOn : cs.menuItem,
              onClick: function () {
                chat.setSideRead(key)
                chat.closeSideMenu()
              },
            },
            h('span', { style: cs.menuLabel }, option[1]),
            active ? h('span', { style: cs.check }, '✓') : null
          )
        })
      )
    }

    function renderApproval(chat) {
      var approval = chat.server.approval
      if (!approval) return null
      return h(
        'div',
        { style: styles.approve },
        h('span', { style: styles.approveText }, '侧边对话想读取主对话最近的内容'),
        h(
          'button',
          {
            type: 'button',
            style: styles.smallBtn,
            onClick: function () {
              chat.resolveApproval(true)
            },
          },
          '允许'
        ),
        h(
          'button',
          {
            type: 'button',
            style: styles.smallBtn,
            onClick: function () {
              chat.resolveApproval(false)
            },
          },
          '拒绝'
        )
      )
    }

    function renderHeader(chat) {
      return h(
        'div',
        { style: styles.head },
        h('span', { style: styles.title }, DISPLAY),
        h('span', { style: styles.grow }),
        h(
          'button',
          {
            type: 'button',
            style: styles.iconBtn,
            title: '清空这次对话',
            'aria-label': '清空这次对话',
            onClick: chat.askClear,
          },
          h(
            'span',
            { style: styles.trash },
            h('span', { style: styles.trashLid }),
            h('span', { style: styles.trashTop }),
            h('span', { style: styles.trashBody })
          )
        )
      )
    }

    function catalogEntry(catalog, provider, modelId) {
      if (!catalog || catalog.available !== true || !Array.isArray(catalog.groups) || !modelId) return null
      for (var g = 0; g < catalog.groups.length; g += 1) {
        var group = catalog.groups[g]
        if (!group) continue
        if (typeof provider === 'string' && provider !== '' && group.id !== provider) continue
        var models = Array.isArray(group.models) ? group.models : []
        for (var m = 0; m < models.length; m += 1) {
          var item = models[m]
          if (item && item.id === modelId) return item
        }
      }
      return null
    }

    function renderModelMenu(chat) {
      if (chat.modelMenu !== true) return null
      var catalog = chat.catalog
      var current = chat.server.model
      var groups = catalog && catalog.available === true && Array.isArray(catalog.groups) ? catalog.groups : []
      var rows = []

      if (groups.length === 0) {
        rows.push(
          h('div', { key: 'none', style: styles.menuNote }, '读不到模型列表（宿主没有提供目录）')
        )
      } else {
        groups.forEach(function (group) {
          if (!group) return
          rows.push(
            h('div', { key: 'g:' + group.id, style: styles.menuGroup }, String(group.name || group.id))
          )
          var models = Array.isArray(group.models) ? group.models : []
          // 三个一行的小卡片：长名字截断，悬停看全名。
          for (var offset = 0; offset < models.length; offset += 3) {
            var slice = models.slice(offset, offset + 3)
            var cells = []
            for (var slot = 0; slot < 3; slot += 1) {
              var entry = slice[slot]
              if (!entry) {
                cells.push(h('span', { key: 'pad:' + group.id + ':' + offset + ':' + slot, style: styles.chipPad }))
                continue
              }
              var active = current && current.provider === group.id && current.id === entry.id
              cells.push(
                h(
                  'button',
                  {
                    key: 'm:' + group.id + ':' + entry.id,
                    type: 'button',
                    title: String(entry.name || entry.id),
                    'aria-pressed': active === true,
                    style: active ? styles.chipOn : styles.chip,
                    onClick: function (modelId, effort) {
                      return function () {
                        chat.pickModel(group.id, modelId, effort)
                      }
                    }(entry.id, entry.reasoning && entry.reasoning.defaultEffort),
                  },
                  String(entry.name || entry.id)
                )
              )
            }
            rows.push(h('div', { key: 'row:' + group.id + ':' + offset, style: styles.chipRow }, cells))
          }
        })
      }

      var entry = catalogEntry(catalog, current && current.provider, current && current.id)
      var efforts = entry && entry.reasoning && Array.isArray(entry.reasoning.efforts) ? entry.reasoning.efforts : []
      if (efforts.length > 0) {
        rows.push(h('div', { key: 'e:label', style: styles.menuGroup }, '推理强度'))
        rows.push(
          h(
            'div',
            { key: 'e:row', style: styles.menuEfforts },
            efforts.map(function (effort) {
              var on = current && current.reasoningEffort === effort.id
              return h(
                'button',
                {
                  key: 'e:' + effort.id,
                  type: 'button',
                  'aria-pressed': on === true,
                  className: on === true ? undefined : 'fc-seg',
                  style: on ? styles.segBtnOn : styles.segBtn,
                  onClick: function () {
                    chat.pickEffort(effort.id)
                  },
                },
                String(effort.name || effort.id)
              )
            })
          )
        )
      }

      return h(
        'div',
        { style: styles.menu, role: 'menu' },
        rows,
        h(
          'div',
          { key: 'close', style: styles.menuFoot },
          h('button', { type: 'button', style: styles.smallBtn, onClick: chat.closeModelMenu }, '收起')
        )
      )
    }

    function renderConfirm(chat) {
      return h(
        'div',
        { style: styles.confirm },
        h('span', { style: styles.confirmText }, '清空这次对话？历史不可恢复'),
        h('button', { type: 'button', style: styles.smallBtn, onClick: chat.clearNow }, '清空'),
        h('button', { type: 'button', style: styles.smallBtn, onClick: chat.cancelClear }, '取消')
      )
    }

    function renderArchived(chat) {
      return h(
        'div',
        { style: styles.empty },
        h('div', null, '主对话已归档，这个侧边对话已随之删除。'),
        h('div', { style: { opacity: 0.66, marginTop: 8, lineHeight: 1.65 } }, '取消归档后，可以从这里开一个新的。'),
        h('button', { type: 'button', style: styles.smallBtn, onClick: chat.reviveNow }, '新建对话')
      )
    }

    function renderFailure(chat) {
      if (chat.server.phase !== 'failed') return null
      return h(
        'div',
        { style: styles.errorBar },
        h(
          'span',
          { style: styles.errorText },
          chat.server.connectError || '未能建立独立对话'
        ),
        h('button', { type: 'button', style: styles.smallBtn, onClick: chat.ensureNow }, '重试')
      )
    }

    function renderErrorBar(chat) {
      if (chat.server.status !== 'error') return null
      return h(
        'div',
        { style: styles.errorBar },
        h('span', { style: styles.errorText }, '生成出错：' + (chat.server.error || '未知错误')),
        h('button', { type: 'button', style: styles.smallBtn, onClick: chat.retry }, '重试')
      )
    }

    function renderHint(chat) {
      var notice = chat.server.notice
      var text = notice ? notice : chat.server.pollError ? '同步失败：' + chat.server.pollError : null
      if (!text) return null
      return h(
        'div',
        { style: styles.hint },
        h('span', { style: styles.hintText }, text),
        h(
          'button',
          {
            type: 'button',
            style: styles.hintClose,
            title: '关闭提示',
            'aria-label': '关闭提示',
            onClick: chat.dismissNotice,
          },
          '×'
        )
      )
    }

    function renderComposer(chat) {
      var busy = chat.server.status === 'running'
      // 空面板也能直接发：第一条消息会先把线程建出来。
      var locked = chat.sending || (chat.server.phase !== 'ready' && chat.server.phase !== 'empty')
      var ready = !locked && (chat.draft.trim() !== '' || chat.attachments.length > 0)
      var model = chat.server.model
      var modelEntry = catalogEntry(chat.catalog, model && model.provider, model && model.id)
      var effortLabel = ''
      if (modelEntry && modelEntry.reasoning && Array.isArray(modelEntry.reasoning.efforts)) {
        for (var e = 0; e < modelEntry.reasoning.efforts.length; e += 1) {
          var effortItem = modelEntry.reasoning.efforts[e]
          if (effortItem && effortItem.id === (model && model.reasoningEffort)) {
            effortLabel = String(effortItem.name || effortItem.id)
            break
          }
        }
      }
      var modelLabel = modelEntry
        ? String(modelEntry.name || modelEntry.id)
        : model && (model.label || model.id)
          ? String(model.label || model.id)
          : '选择模型'
      if (effortLabel !== '') modelLabel += ' ' + effortLabel

      // 图片标签排在控件行下面，和 beta 侧边对话一样贴着输入框。
      var chips = null
      if (chat.attachments.length > 0) {
        chips = h(
          'div',
          { style: cs.attachRow },
          chat.attachments.map(function (item) {
            return h(
              'span',
              { key: item.id, style: cs.attachChip },
              h('img', { src: item.url, alt: item.name || '图片', style: cs.attachThumb }),
              h('span', { style: cs.attachName }, item.name || '图片'),
              h(
                'button',
                {
                  type: 'button',
                  style: cs.attachDel,
                  title: '移除这张图片',
                  'aria-label': '移除这张图片',
                  onClick: function () {
                    chat.onRemoveAttachment(item.id)
                  },
                },
                '×'
              )
            )
          })
        )
      }

      return h(
        'div',
        { style: cs.composer },
        h('input', {
          ref: chat.fileRef,
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp,image/gif',
          multiple: true,
          style: styles.hidden,
          onChange: chat.onFilesChosen,
        }),
        h('textarea', {
          ref: chat.inputRef,
          style: cs.input,
          rows: 1,
          value: chat.draft,
          placeholder: '问点什么…（Enter 发送，Shift+Enter 换行）',
          onChange: chat.onDraftChange,
          onKeyDown: chat.onComposerKeyDown,
          onPaste: chat.onComposerPaste,
        }),
        h(
          'div',
          { style: cs.bar },
          renderControls(chat, locked),
          h('span', { style: cs.spacer }),
          h(
            'button',
            {
              type: 'button',
              style: cs.modelPill,
              title: '选择模型与推理强度',
              'aria-haspopup': 'menu',
              'aria-expanded': chat.modelMenu === true,
              onClick: chat.toggleModelMenu,
            },
            h('span', { style: cs.modelName }, modelLabel),
            h('span', { style: cs.caret }, '▾')
          ),
          busy
            ? h(
                'button',
                { type: 'button', style: cs.sendBtn, title: '停止生成', 'aria-label': '停止生成', onClick: chat.cancel },
                iconStop()
              )
            : h(
                'button',
                {
                  type: 'button',
                  style: ready ? cs.sendBtn : Object.assign({}, cs.sendBtn, cs.sendOff),
                  title: '发送（Enter）',
                  'aria-label': '发送',
                  disabled: !ready,
                  onClick: chat.submit,
                },
                iconSend()
              )
        ),
        chips
      )
    }

    function ChatPanel(props) {
      var chat = useFreedomChat(props && props.sessionId ? String(props.sessionId) : '')
      var stream = chat.server.messages
      // MarkdownText 到货后要重排一次（先按纯文本渲染，随后升级为 markdown）。
      var markdown = useMarkdownText()
      // 消息列表按数组标识缓存：打字只重渲染输入区，不重排 200 条消息。
      var rows = React.useMemo(
        function () {
          return renderMessages(stream)
        },
        [stream, markdown]
      )

      var placeholder = null
      if (stream.length === 0) {
        if (chat.server.phase === 'starting') {
          placeholder = h('div', { style: styles.starting }, '正在准备独立的对话…')
        } else if (chat.server.phase === 'ready') {
          placeholder = h('div', { style: styles.empty }, h('div', null, EMPTY_TEXT))
        } else if (chat.server.phase === 'empty') {
          placeholder = h(
            'div',
            { style: styles.empty },
            h('div', null, '还没有侧边对话。'),
            h('div', { style: styles.emptySub }, '发一条消息就会创建；清空等于删掉它。')
          )
        } else if (chat.server.phase === 'archived') {
          placeholder = renderArchived(chat)
        }
      }

      return h(
        'div',
        { style: styles.root },
        h('style', { key: 'dshf-keyframes' }, KEYFRAMES),
        renderHeader(chat),
        renderApproval(chat),
        chat.confirming ? renderConfirm(chat) : null,
        h(
          'div',
          { ref: chat.scrollRef, style: styles.stream, onScroll: chat.onStreamScroll },
          placeholder,
          rows,
          renderFailure(chat),
          renderErrorBar(chat)
        ),
        chat.server.phase === 'archived' ? null : renderHint(chat),
        chat.server.phase === 'archived' ? null : renderComposer(chat),
        chat.server.phase === 'archived' ? null : renderModelMenu(chat),
        chat.server.phase === 'archived' ? null : renderSideMenu(chat)
      )
    }

    // Panel 自身不用 hooks：宿主 smoke 会直接调用它（不经 React 渲染），
    // 真正的状态都在 ChatPanel 里，且整体包在错误边界内。
    function Panel(props) {
      return h(Boundary, null, h(ChatPanel, props || {}))
    }

    /** The tab type descriptor, mirroring the shape the host accepts. */
    var tabType = {
      id: TAB_ID,
      kind: TAB_KIND,
      keepMounted: true,
      priority: 'extension',
      title: function () {
        return TAB_LABEL
      },
      icon: tabIcon,
      guide: [
        {
          id: TAB_ID,
          order: 40,
          title: function () {
            return DISPLAY
          },
          description: function () {
            return '与主对话隔离的纯聊天窗口'
          },
          // 宿主把 guide.icon 画在标题左侧，形状与 tab 条上的字形同源。
          icon: function (props) {
            return tabIcon((props && props.size) || 16)
          },
        },
      ],
    }

    /** Register the tab type on a ready registry; returns a disposer or null. */
    function registerTabType(registry) {
      if (!registry || typeof registry.register !== 'function') return null
      try {
        var dispose = registry.register(tabType)
        return typeof dispose === 'function' ? dispose : function () {}
      } catch (error) {
        console.error('[freedomchat] tab type registration failed', error)
        return null
      }
    }

    function apply(ctx) {
      var disposers = []
      moduleHost = ctx
      loadMarkdownText()

      // The tab registry is a host service. It is normally up by the time the
      // bundle's client module applies, but inject() covers the slower case.
      var direct = registerTabType(ctx.get(SERVICE))
      if (direct) {
        disposers.push(direct)
      } else {
        try {
          if (typeof ctx.inject === 'function') {
            var seat = ctx.inject([SERVICE], function (injected) {
              var dispose = registerTabType(injected.get(SERVICE))
              if (dispose) disposers.push(dispose)
              return dispose || undefined
            })
            if (typeof seat === 'function') disposers.push(seat)
          }
        } catch (error) {
          console.warn('[freedomchat] tab registry service unavailable', error)
        }
      }

      try {
        disposers.push(
          ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                inject: function (sessionId) {
                  return { sessionId: sessionId }
                },
              },
              Panel
            )
          })
        )
      } catch (error) {
        console.error('[freedomchat] pane body slot registration failed', error)
      }

       return function () {
        for (var index = disposers.length - 1; index >= 0; index -= 1) {
          try {
            var dispose = disposers[index]
            if (typeof dispose === 'function') dispose()
          } catch {
            /* teardown is best-effort */
          }
        }
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 运行时替换 transport.call 的入口（测试与宿主桥接用）；不改 UI 逻辑。
    exports.transport = transport
    return module.exports
  },
})
