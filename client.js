/**
 * dsh-think-guard · Client 半边
 *
 * 两样东西，都不写 session 事件、她那边完全看不到：
 *   1. 「清洗」视图：管理投影层清洗的词表（写回 mask.json，下一轮生效）。
 *   2. 全局横幅：宿主检测到自动压缩后提示「需要手动清创」。
 *
 * 数据走宿主进程自己注册的 HTTP 接口（/think-guard/mask、/think-guard/cleanup），
 * 和界面同源，不需要额外的 RPC 通道。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-think-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-think-guard'
    const zh = {
      'view.title': '清洗',
      'panel.heading': '投影层清洗词表',
      'panel.note': '这些词单独成行时会被从「发给模型的思考」里删掉。只改请求，不改会话日志；她那边看不到这次清洗。',
      'panel.words': '仪式句词表',
      'panel.wordsHint': '一行一个词。改完立即保存，下一轮请求生效，不需要重启。',
      'panel.add': '添加',
      'panel.placeholder': '例如：嗯。',
      'panel.remove': '移除',
      'panel.drop': '检查点删除规则',
      'panel.dropHint': '压缩摘要里命中的行会被整行删掉（通常是「关于她怎么想」的描述）。',
      'panel.saved': '已保存 · 下一轮生效',
      'panel.saving': '保存中…',
      'panel.error': '保存失败',
      'panel.loading': '读取中…',
      'panel.empty': '词表是空的——清洗不会生效。',
      'banner.title': '本会话已自动压缩',
      'banner.body': '摘要和保留段需要手动清创：仪式句、括号外壳、以及「关于她思考」的段落。',
      'banner.dismiss': '知道了',
      'banner.dismissing': '处理中…',
    }
    const en = {
      'view.title': 'Cleanup',
      'panel.heading': 'Projection mask words',
      'panel.note': 'Bare ritual lines made only of these words are removed from the thinking sent to the model. Requests only — the session log is untouched.',
      'panel.words': 'Ritual words',
      'panel.wordsHint': 'One per line. Saved immediately; applies to the next request, no restart.',
      'panel.add': 'Add',
      'panel.placeholder': 'e.g. OK.',
      'panel.remove': 'Remove',
      'panel.drop': 'Checkpoint drop rules',
      'panel.dropHint': 'Summary lines containing these are removed (usually notes about how she thinks).',
      'panel.saved': 'Saved · next request',
      'panel.saving': 'Saving…',
      'panel.error': 'Save failed',
      'panel.loading': 'Loading…',
      'panel.empty': 'Empty word list — masking does nothing.',
      'banner.title': 'This session was auto-compacted',
      'banner.body': 'The summary and retained tail need manual cleanup.',
      'banner.dismiss': 'Dismiss',
      'banner.dismissing': 'Working…',
    }

    const getJson = async (path) => {
      const res = await fetch(path, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    }
    const postJson = async (path, body) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? String(res.status))
      return data
    }

    const chipStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '2px 8px', margin: '0 6px 6px 0', borderRadius: 999,
      background: 'rgba(127,127,127,0.16)', fontSize: 13,
    }
    const btnStyle = {
      border: '1px solid rgba(127,127,127,0.4)', borderRadius: 6, background: 'transparent',
      color: 'inherit', cursor: 'pointer', fontSize: 13, padding: '2px 8px',
    }

    function CleanupPanel(props) {
      const t = props.t ?? ((k) => k)
      const [words, setWords] = React.useState(null)
      const [drop, setDrop] = React.useState([])
      const [input, setInput] = React.useState('')
      const [state, setState] = React.useState('loading')
      const [error, setError] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const data = await getJson('/think-guard/mask')
          setWords(Array.isArray(data.words) ? data.words : [])
          setDrop(Array.isArray(data.checkpointDrop) ? data.checkpointDrop : [])
          setState('idle')
        } catch (e) {
          setError(String(e?.message ?? e))
          setState('error')
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      const save = async (nextWords, nextDrop) => {
        setState('saving')
        setError('')
        try {
          const data = await postJson('/think-guard/mask', { words: nextWords, checkpointDrop: nextDrop })
          setWords(Array.isArray(data.words) ? data.words : nextWords)
          setDrop(Array.isArray(data.checkpointDrop) ? data.checkpointDrop : nextDrop)
          setState('saved')
        } catch (e) {
          setError(String(e?.message ?? e))
          setState('error')
        }
      }

      const add = () => {
        const w = input.trim()
        if (!w || words === null) return
        if (words.includes(w)) { setInput(''); return }
        setInput('')
        save([...words, w], drop)
      }
      const remove = (w) => {
        if (words === null) return
        save(words.filter((x) => x !== w), drop)
      }

      const status = state === 'saving' ? t('panel.saving') : state === 'saved' ? t('panel.saved') : state === 'error' ? `${t('panel.error')}: ${error}` : ''

      return h('div', { style: { padding: '18px 20px', maxWidth: 760, lineHeight: 1.6 } },
        h('h3', { style: { margin: '0 0 6px' } }, t('panel.heading')),
        h('p', { style: { margin: '0 0 16px', opacity: 0.72, fontSize: 13 } }, t('panel.note')),

        h('div', { style: { fontWeight: 600, margin: '0 0 6px' } }, t('panel.words')),
        h('div', { style: { opacity: 0.6, fontSize: 12, marginBottom: 10 } }, t('panel.wordsHint')),
        words === null
          ? h('div', { style: { opacity: 0.6 } }, t('panel.loading'))
          : words.length === 0
            ? h('div', { style: { color: '#c55' } }, t('panel.empty'))
            : h('div', null, words.map((w) => h('span', { key: w, style: chipStyle },
                h('span', null, w),
                h('button', {
                  type: 'button', title: t('panel.remove'), onClick: () => remove(w),
                  style: { ...btnStyle, padding: '0 6px', border: 'none', opacity: 0.7 },
                }, '×'),
              ))),

        h('div', { style: { display: 'flex', gap: 8, margin: '6px 0 18px' } },
          h('input', {
            value: input,
            placeholder: t('panel.placeholder'),
            onChange: (e) => setInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add() } },
            style: { flex: '0 0 220px', padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit' },
          }),
          h('button', { type: 'button', onClick: add, style: btnStyle }, t('panel.add')),
          status ? h('span', { style: { opacity: 0.65, fontSize: 12, alignSelf: 'center' } }, status) : null,
        ),

        h('div', { style: { fontWeight: 600, margin: '0 0 6px' } }, t('panel.drop')),
        h('div', { style: { opacity: 0.6, fontSize: 12, marginBottom: 10 } }, t('panel.dropHint')),
        h('div', null, drop.map((w) => h('span', { key: w, style: { ...chipStyle, opacity: 0.85 } },
          h('span', null, w),
          h('button', {
            type: 'button', title: t('panel.remove'),
            onClick: () => save(words ?? [], drop.filter((x) => x !== w)),
            style: { ...btnStyle, padding: '0 6px', border: 'none', opacity: 0.7 },
          }, '×'),
        ))),
      )
    }

    function CleanupBanner() {
      const [pending, setPending] = React.useState([])
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const data = await getJson('/think-guard/cleanup')
          setPending(Array.isArray(data.pending) ? data.pending : [])
        } catch { /* 宿主没起来时静默 */ }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive) load() }
        tick()
        const timer = setInterval(tick, 8000)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      if (pending.length === 0) return null
      const item = pending[0]
      const time = item?.at ? new Date(item.at).toLocaleTimeString() : ''

      const dismiss = async () => {
        setBusy(true)
        try {
          await postJson('/think-guard/cleanup', { sessionId: item.sessionId })
          setPending((prev) => prev.filter((p) => p.sessionId !== item.sessionId))
        } catch { /* ignore */ } finally { setBusy(false) }
      }

      return h('div', {
        style: {
          position: 'fixed', right: 18, bottom: 18, zIndex: 60, maxWidth: 340,
          padding: '12px 14px', borderRadius: 10,
          background: 'rgba(40,40,44,0.96)', color: '#f2f2f2',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)', fontSize: 13, lineHeight: 1.55,
        },
      },
      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, `⚠ ${dict('banner.title', item)}`),
      h('div', { style: { opacity: 0.85 } }, dict('banner.body', item)),
      h('div', { style: { opacity: 0.55, fontSize: 11, marginTop: 4 } }, `${item.sessionId?.slice(-8) ?? ''} · ${time}`),
      h('div', { style: { marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' } },
        h('button', {
          type: 'button', onClick: dismiss, disabled: busy,
          style: { ...btnStyle, color: '#f2f2f2', borderColor: 'rgba(255,255,255,0.35)' },
        }, busy ? '…' : dict('banner.dismiss', item)),
      ),
      )
    }

    // 横幅里拿不到 locale 的 t（不在 view 上下文），用模块级字典兜底。
    let currentLocale = zh
    const dict = (key) => currentLocale[key] ?? key

    const apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'think-guard: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'think-guard',
        order: 40,
        locale: NS,
        label: () => t('view.title'),
      }, (props) => h(CleanupPanel, { ...props, t })))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'think-guard.cleanup-banner',
        order: 80,
        locale: NS,
        label: () => t('banner.title'),
      }, CleanupBanner))
    }

    return {
      apply,
      inject: ['slots', 'locale'],
    }
  },
})
