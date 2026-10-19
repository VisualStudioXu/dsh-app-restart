/**
 * dsh-app-restart — Client 半。
 *
 * 落点：`shell.bottom`（外壳底部横条，`AppFrame` 里 `data-shell-bottom` 那一行）。
 *
 * 为什么从 `sidebar.footer.action` 换过来：那个槽是 `kind: "list"`，本来以为能
 * 与 Cordis 角标并存就够用了，但实际同时挤着 5 个占用者（mcp-connector order 0、
 * 本插件 order 20、session-manager order 30、remote-web-ui、ui-cordis），
 * 28×28 的纯图标在其中根本无法辨认；而且 `footArea` 是纵向两段，按钮落在
 * 设置齿轮**上方**单独一行，与最初示意图不符。
 *
 * `shell.bottom` 是 `grid-column: 1/-1` 的全宽行，当前**无人占用**
 * （唯一占用者 experimental-inspector 未启用），因此不与任何插件争位，
 * 也足够宽到能放下文字与状态。
 *
 * 注意：该槽由占用方自己控制高度与显隐，空内容不预留空间
 * （见 dsh-client-ui-layout/README.zh.md:34）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-app-restart',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useCallback, useEffect } = React

    const API = '/app-restart/api/restart'
    const NS = 'app-restart'

    /* ---------------------------------------------------------------- */
    /* 文案（插件自带，不依赖宿主 locale 服务）                            */
    /* ---------------------------------------------------------------- */

    const TEXT = {
      label: '重启 DeepSeek Harness',
      busy: '正在重启…',
      title: '确认重启 DeepSeek Harness？',
      body1: '正在执行的轮次会被立即中断，尚未落盘的会话状态可能丢失。',
      body2: '重启通常需要几秒，之后窗口会自动重新打开。',
      cancel: '取消',
      confirm: '确认重启',
      failed: '重启请求失败：',
    }

    /* ---------------------------------------------------------------- */
    /* 样式                                                              */
    /* ---------------------------------------------------------------- */

    const CSS = `
.ars-bar{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;
  padding:0 12px;height:26px;font-size:11.5px;line-height:1;
  color:var(--dsw-alias-label-secondary,#5b636d);
  background:var(--dsw-alias-bg-layer-2,#f2f4f7);
  border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.ars-bar .ars-spacer{flex:1}
.ars-bar-btn{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 9px;
  border:none;border-radius:5px;background:transparent;color:inherit;cursor:pointer;
  font-family:inherit;font-size:11.5px;line-height:1}
.ars-bar-btn:hover{background:rgba(128,128,128,.18);color:var(--dsw-alias-label-primary,#1f2329)}
.ars-bar-btn:disabled{cursor:default;opacity:.6}
.ars-bar-btn[data-busy="true"]{background:rgba(128,128,128,.14)}
.ars-ico{display:inline-block;font-size:12px;line-height:1;transform:translateY(-.5px)}
.ars-overlay{position:fixed;inset:0;background:rgba(28,34,44,.34);display:flex;
  align-items:center;justify-content:center;z-index:9999}
.ars-dlg{width:min(420px,calc(100vw - 48px));background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-primary,#1f2329);border-radius:11px;
  box-shadow:0 10px 34px rgba(16,24,40,.26);padding:18px 20px 16px;
  font-size:13px;line-height:1.65}
.ars-dlg h3{margin:0 0 9px;font-size:14.5px;font-weight:700}
.ars-dlg p{margin:0 0 6px;color:var(--dsw-alias-label-secondary,#5b636d)}
.ars-dlg .err{color:#b3272c;margin-top:8px}
.ars-foot{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}
.ars-foot button{padding:5px 15px;border-radius:6px;font-size:12.5px;cursor:pointer;font-family:inherit}
.ars-cancel{border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}
.ars-ok{border:none;background:#e5484d;color:#fff;font-weight:600}
.ars-ok:disabled{opacity:.6;cursor:default}
`

    /* ---------------------------------------------------------------- */
    /* 组件                                                              */
    /* ---------------------------------------------------------------- */

    function RestartBar() {
      const [asking, setAsking] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      // 弹窗打开时支持 Esc 关闭
      useEffect(() => {
        if (!asking) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) setAsking(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [asking, busy])

      const doRestart = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const response = await fetch(API, { method: 'POST' })
          if (!response.ok) {
            const detail = await response.text().catch(() => '')
            throw new Error(detail || `HTTP ${response.status}`)
          }
          // 请求已受理，宿主会在延时后自杀；保持 busy 直到页面被重启带走。
        } catch (reason) {
          setBusy(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }, [])

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'ars-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'ars-bar-btn',
              title: TEXT.label,
              'aria-label': TEXT.label,
              'data-busy': busy ? 'true' : 'false',
              disabled: busy,
              onClick: () => setAsking(true),
            },
            h('span', { className: 'ars-ico', 'aria-hidden': true }, '⟳'),
            h('span', null, busy ? TEXT.busy : TEXT.label),
          ),
          h('span', { className: 'ars-spacer' }),
        ),
        asking
          ? h(
              'div',
              {
                className: 'ars-overlay',
                role: 'dialog',
                'aria-modal': 'true',
                onClick: (event) => {
                  if (event.target === event.currentTarget && !busy) setAsking(false)
                },
              },
              h(
                'div',
                { className: 'ars-dlg' },
                h('h3', null, TEXT.title),
                h('p', null, TEXT.body1),
                h('p', null, TEXT.body2),
                error ? h('p', { className: 'err' }, TEXT.failed + error) : null,
                h(
                  'div',
                  { className: 'ars-foot' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ars-cancel',
                      disabled: busy,
                      onClick: () => setAsking(false),
                    },
                    TEXT.cancel,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ars-ok',
                      disabled: busy,
                      onClick: doRestart,
                    },
                    busy ? TEXT.busy : TEXT.confirm,
                  ),
                ),
              ),
            )
          : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* 插件入口                                                          */
    /* ---------------------------------------------------------------- */

    return {
      name: NS,
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-app-restart: styles')

        ctx.slots.inject('shell.bottom', () => ctx.slots.register({
          name: 'shell.bottom',
          id: NS,
          order: 10,
        }, RestartBar))
      },
    }
  },
})
