/**
 * dsh-think-guard · 思考循环兜底（零依赖）
 *
 * 只在「已经出事」的时候拉一把，正常轮次完全不介入。
 *
 * 判据（任一成立即触发，每轮最多一次）：
 *  1. 上一轮 assistant 既没正文也没工具调用 —— 整轮空输出；
 *  2. 上一轮思考里有一段连续 >= guardMinRun 行的「准备句」
 *     （好，写／好，做／好，说／好，输出），说明已经进入复读。
 *
 * 触发后只做一件事：在**本轮**用户消息的最前面加一句提醒，
 * 复刻真人打断的效果（实测有效）。不改系统提示、不改历史思考、
 * 不动磁盘会话文件。异常全部吞掉，绝不因为护栏本身让一轮失败。
 *
 * 可选的第二道（默认关）：把历史里成段的重复折叠掉，切断「复读被写回
 * 上下文、下一轮照着学」的放大回路。它要改 assistant 消息里的 reasoning
 * 文本（块数量与签名不动），有触发服务端签名校验的风险，所以默认关闭，
 * 需要时在 profile 里开 collapseHistory。
 */

import { randomUUID } from 'node:crypto'

export const name = 'think-guard'

const MARK = '[think-guard]'

const DEFAULT_REMINDER_EMPTY =
  '你上一轮思考到最后没有输出任何正文。这次直接回答：不要复述、不要再写准备句、不要解释为什么没输出。'
const DEFAULT_REMINDER_LOOP =
  '你上一轮的思考陷入了重复。这次保持简洁，不要在思考里反复写准备句，想清楚就直接写正文。'
const DEFAULT_INTERRUPT_MESSAGE =
  '你刚才的思考陷入了连续重复，已经被中断。直接回答：不要复述、不要再写准备句、不要解释为什么被打断。'

/**
 * 一行是不是「确认句」（复读的最小单位）。
 *
 * 覆盖两类形态：
 *   1. 纯确认：好 / 好。 / 好. / 好。好。 / 好，好。
 *   2. 确认 + 动作：好，写。 / 好。做。 / 好，说： / 好，输出。
 *   3. 括号化的自我提示：（好）/（好了）/（好，输出）/（好了，输出 no_reply）
 *
 * 实测长会话里最先塌的往往是第 1 类——「好。」一个字，几乎零成本，
 * 一旦开始复读就停不下来（曾见单轮 12 万行）。
 * 不误伤正常句子：「好，我这就去」这类后面还带实义内容的不会被命中。
 */
const RITUAL_LINE =
  /^[（(]?\s*好(?:\s*[。.，、]?\s*好)*\s*了?\s*[。.，、：:]?\s*(?:写|做|说|输出|来)?\s*(?:no_reply)?\s*[）)]?\s*[。.：:！!]?$/

const isRitual = (line) => RITUAL_LINE.test(line.trim())

/**
 * 尾窗「短句轮换」判据（B 型退化）。
 *
 * 连续行判据只能抓 A 型（同一句死磕，比如「好。」×124,046）。
 * B 型是「每句都不一样、但每句都很短」——`Let me write it.` → `Go.` → `Now.` → `OK.`，
 * 连续计数永远到不了阈值，但整块思考的信息量是零。
 *
 * 判据沿用 dsh-degeneration-kit 的 v2 尺子：尾窗内
 *   ① 极短段（≤3 词）占全部段数的比例 ≥ shortShareMin；
 *   ② 最高频 5 段合计占全部段数的比例 ≥ topUnitShareMin。
 * 两条同时成立才算，避免把「正常列了一堆短条目」误判成轮换。
 *
 * @param text - 整段思考文本。
 * @param opts - { tailChars, minChars, shortShareMin, topUnitShareMin }。
 * @returns { hit, shortShare, topShare, segments }
 */
function rotationScore(text, opts = {}) {
  const tailChars = opts.tailChars ?? 4000
  const minChars = opts.minChars ?? 400
  const shortShareMin = opts.shortShareMin ?? 0.35
  const topUnitShareMin = opts.topUnitShareMin ?? 0.5
  if (typeof text !== 'string' || text.length < minChars) return { hit: false, segments: 0 }

  const tail = text.slice(-tailChars)
  const segments = tail
    .split(/[。！？!?\n]+|\.\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length < 20) return { hit: false, segments: segments.length }

  const wordCount = (s) => {
    const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length
    const ascii = s.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean).length
    return Math.ceil(cjk / 2) + ascii
  }

  const shortShare = segments.filter((s) => wordCount(s) <= 3).length / segments.length
  const freq = new Map()
  for (const s of segments) freq.set(s, (freq.get(s) ?? 0) + 1)
  const topShare =
    [...freq.values()]
      .sort((a, b) => b - a)
      .slice(0, 5)
      .reduce((a, b) => a + b, 0) / segments.length

  return {
    hit: shortShare >= shortShareMin && topShare >= topUnitShareMin,
    shortShare,
    topShare,
    segments: segments.length,
  }
}

function isUserMessage(msg) {
  if (!msg) return false
  if (msg.source && typeof msg.source === 'object') return msg.source.kind === 'user'
  return msg.role === 'user'
}

function isAssistantMessage(msg) {
  if (!msg) return false
  if (msg.source && typeof msg.source === 'object') {
    // 宿主给模型消息标 kind: 'model'；工具结果/注入消息有各自的 kind。
    return msg.source.kind === 'model' || msg.source.kind === 'assistant'
  }
  if (msg.role === 'assistant') return true
  // 兜底：有 role 但既不是 user 也不是 tool 的，按 assistant 处理（宁严勿漏）
  return typeof msg.role === 'string' && msg.role !== 'user' && msg.role !== 'tool' && msg.role !== 'system'
}

/** 最长连续准备句行数：单发是正常收尾，成段连续才是退化。 */
function longestRitualRun(text) {
  let best = 0
  let run = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    if (isRitual(line)) {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best
}

/** 把连续重复折叠成一行标记，其余内容原样保留（短段逐行原样留下，不改写原文）。 */
function collapseRitualRuns(text, minRun) {
  const out = []
  let run = []
  const flush = () => {
    if (run.length >= minRun) out.push(`（此处省略 ${run.length} 行重复的确认句）`)
    else out.push(...run)
    run = []
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    if (isRitual(line)) {
      run.push(line)
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return out.join('\n')
}

export function apply(ctx, config = {}) {
  const guardMinRun = Number.isFinite(config.guardMinRun) ? config.guardMinRun : 12
  const reminderEmpty =
    typeof config.reminderEmpty === 'string' && config.reminderEmpty.trim() ? config.reminderEmpty : DEFAULT_REMINDER_EMPTY
  const reminderLoop =
    typeof config.reminderLoop === 'string' && config.reminderLoop.trim() ? config.reminderLoop : DEFAULT_REMINDER_LOOP
  // 第二道防线：默认关。要开就设 collapseHistory: true。
  const collapseHistory = config.collapseHistory === true
  const collapseMinRun = Number.isFinite(config.collapseMinRun) ? config.collapseMinRun : 20

  // 第三道防线：实时中断。默认关——先只观测，确认能收到流事件再打开。
  const interruptOnLoop = config.interruptOnLoop === true
  const interruptMinRun = Number.isFinite(config.interruptMinRun) ? config.interruptMinRun : 12
  const interruptCooldownMs = Number.isFinite(config.interruptCooldownMs) ? config.interruptCooldownMs : 120000
  const interruptMessage =
    typeof config.interruptMessage === 'string' && config.interruptMessage.trim()
      ? config.interruptMessage
      : DEFAULT_INTERRUPT_MESSAGE

  /** sessionId -> Agent。pre-step 时登记，流式期间用来 followup / cancel。 */
  const agents = new Map()
  /** attemptId -> 尚未判定的思考尾部（当前未完成行）。 */
  const tails = new Map()
  /** sessionId -> 上次中断时间，防抖。 */
  const lastInterrupt = new Map()

  // B 型（短句轮换）判据。A 型（同一句死磕）走连续行，B 型走尾窗占比。
  const rotationGuard = config.rotationGuard !== false
  const rotationOpts = {
    tailChars: Number.isFinite(config.rotationTailChars) ? config.rotationTailChars : 4000,
    minChars: Number.isFinite(config.rotationMinChars) ? config.rotationMinChars : 400,
    shortShareMin: Number.isFinite(config.rotationShortShareMin) ? config.rotationShortShareMin : 0.35,
    topUnitShareMin: Number.isFinite(config.rotationTopShareMin) ? config.rotationTopShareMin : 0.5,
  }

  const log = (level, msg) => {
    try {
      const fn = ctx.logger?.[level]
      if (typeof fn === 'function') fn.call(ctx.logger, `think-guard: ${msg}`)
    } catch {}
  }

  if (typeof ctx.on !== 'function') {
    log('warn', 'ctx.on 不可用，兜底未注册')
    return
  }

  try {
    ctx.on(
      'agent/pre-step',
      async (payload, next) => {
        const decision = await next()
        try {
          // 登记 Agent（流式期间的中断要靠它 followup / cancel）
          const sid = payload?.agent?.session?.id
          if (typeof sid === 'string' && sid) agents.set(sid, payload.agent)

          if (!decision || decision.kind !== 'enter') return decision
          if (payload?.signal?.aborted) return decision
          if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision

          let messages = decision.messages

          // ── 判定上一轮是否出事 ──────────────────────────────
          let lastAssistant = null
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (isAssistantMessage(messages[i])) {
              lastAssistant = messages[i]
              break
            }
          }
          if (!lastAssistant) return decision

          const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : []
          const hasText = content.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
          const hasTool = content.some((b) => b?.type === 'tool-call')

          let trigger = null
          if (!hasText && !hasTool) {
            trigger = 'empty'
          } else {
            let worst = 0
            let rotation = null
            for (const b of content) {
              if (b?.type !== 'reasoning' || typeof b.text !== 'string') continue
              const run = longestRitualRun(b.text)
              if (run > worst) worst = run
              if (!rotation && rotationGuard) {
                const rs = rotationScore(b.text, rotationOpts)
                if (rs.hit) rotation = rs
              }
            }
            if (worst >= guardMinRun) trigger = `loop(${worst})`
            else if (rotation)
              trigger = `rotation(short=${rotation.shortShare.toFixed(2)},top=${rotation.topShare.toFixed(2)},seg=${rotation.segments})`
          }

          // ── 可选：折叠历史里的成段重复（切断放大回路） ──────────
          let collapsed = 0
          if (collapseHistory) {
            messages = messages.map((msg) => {
              if (!isAssistantMessage(msg) || !Array.isArray(msg.content)) return msg
              let touched = false
              const nextContent = msg.content.map((block) => {
                if (block?.type !== 'reasoning' || typeof block.text !== 'string') return block
                if (longestRitualRun(block.text) < collapseMinRun) return block
                const cleaned = collapseRitualRuns(block.text, collapseMinRun)
                if (cleaned === block.text) return block
                touched = true
                return { ...block, text: cleaned }
              })
              if (!touched) return msg
              collapsed += 1
              return { ...msg, content: nextContent }
            })
          }

          // ── 触发时拉一把：本轮用户消息前加一句提醒 ──────────────
          let reminded = false
          if (trigger) {
            let userIndex = -1
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              if (isUserMessage(messages[i])) {
                userIndex = i
                break
              }
            }
            if (userIndex !== -1) {
              const msg = messages[userIndex]
              if (Array.isArray(msg?.content)) {
                const textIndex = msg.content.findIndex((b) => b?.type === 'text' && typeof b.text === 'string')
                if (textIndex !== -1 && !String(msg.content[textIndex].text).startsWith(`${MARK} `)) {
                  const text = trigger === 'empty' ? reminderEmpty : reminderLoop
                  const patched = messages.slice()
                  patched[userIndex] = {
                    ...msg,
                    content: msg.content.map((b, i) => (i === textIndex ? { ...b, text: `${MARK} ${text}\n\n${b.text}` } : b)),
                  }
                  messages = patched
                  reminded = true
                }
              }
            }
          }

          if (!reminded && collapsed === 0) return decision
          if (reminded) log('info', `上一轮${trigger === 'empty' ? '空输出' : `复读 ${trigger}`}，已注入提醒（turn ${payload?.turn ?? '?'}）`)
          if (collapsed > 0) log('info', `已折叠 ${collapsed} 条历史思考里的连续重复`)
          return { ...decision, messages }
        } catch (error) {
          log('error', `兜底检查失败（已跳过）: ${String(error)}`)
          return decision
        }
      },
      { prepend: true },
    )
    log('info', `兜底已注册（连续 >= ${guardMinRun} 行准备句 或 整轮空输出时触发；历史折叠 ${collapseHistory ? '开' : '关'}）`)
  } catch (error) {
    log('error', `注册 agent/pre-step 失败: ${String(error)}`)
  }

  // ── 防线 3：流式实时检测 / 中断 ──────────────────────────────
  //
  // 挂在 agent/assistant-stream 上，每个增量 chunk 都会经过这里。
  // 一旦尾部连续出现 interruptMinRun 行确认句：
  //   · interruptOnLoop = false（默认）：只打日志，用来确认这条链路通不通；
  //   · interruptOnLoop = true：先 agent.followup() 排一句「继续」，
  //     再 agent.cancel({keepInbox: true}) 中断当前流 —— 顺序不能反，
  //     反了就是「中断了但没人接话」。
  try {
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const frame = payload?.frame
        if (!frame) return
        const attemptId = String(frame.attemptId ?? '')
        if (!attemptId) return

        if (frame.type === 'start' || frame.type === 'end') {
          tails.delete(attemptId)
          return
        }
        if (frame.type !== 'chunk') return

        const chunk = frame.chunk
        if (!chunk || chunk.type !== 'reasoning-delta' || typeof chunk.text !== 'string') return

        // 维护「最近若干完整行 + 一个未完成行」的滚动窗口
        const st = tails.get(attemptId) ?? { pending: '', lines: [], stopped: false, tail: '', n: 0 }
        // 同一次尝试只中断一次：取消在下一个 chunk 边界才生效，
        // 不锁住的话后续 chunk 会继续命中，塞进十几条重复提醒。
        if (st.stopped) return
        const parts = (st.pending + chunk.text).split('\n')
        st.pending = parts.pop() ?? ''
        if (parts.length > 0) {
          st.lines.push(...parts)
          if (st.lines.length > 80) st.lines = st.lines.slice(-80)
        }
        // B 型判据要整段尾部，单独留一份（比行窗口长）
        st.tail = ((st.tail ?? '') + chunk.text).slice(-(rotationOpts.tailChars + 2000))
        st.n = (st.n ?? 0) + 1
        tails.set(attemptId, st)
        if (tails.size > 64) {
          const firstKey = tails.keys().next().value
          if (firstKey !== attemptId) tails.delete(firstKey)
        }

        let run = 0
        for (let i = st.lines.length - 1; i >= 0; i -= 1) {
          const l = String(st.lines[i] ?? '').trim()
          if (!l) continue
          if (isRitual(l)) run += 1
          else break
        }

        // B 型：每 16 个 chunk 看一次尾窗（每 chunk 都算太贵）
        let rotation = null
        if (rotationGuard && run < interruptMinRun && st.n % 16 === 0) {
          const rs = rotationScore(st.tail, rotationOpts)
          if (rs.hit) rotation = rs
        }

        // 第三种形态：行内堆叠——所有「好。」塞在同一行里用空格分隔，
        // 不产生换行，上面两条判据都抓不到（实测一行塞过几百个）。
        let inline = 0
        if (run < interruptMinRun && !rotation && st.pending.length > 200) {
          inline = (st.pending.match(/好\s*[。，、]/g) ?? []).length
        }

        if (run < interruptMinRun && !rotation && inline < 20) return

        const kind =
          run >= interruptMinRun
            ? `连续 ${run} 行确认句`
            : rotation
              ? `短句轮换(short=${rotation.shortShare.toFixed(2)},top=${rotation.topShare.toFixed(2)},seg=${rotation.segments})`
              : `行内堆叠（单行 ${inline} 个「好。」）`

        const sid = attemptId.includes(':') ? attemptId.slice(0, attemptId.lastIndexOf(':')) : attemptId
        log(
          'info',
          `流式命中：${kind}（turn ${frame.turn ?? '?'} step ${frame.step ?? '?'}，${
            interruptOnLoop ? '将中断' : '仅观测'
          }）`,
        )
        if (!interruptOnLoop) return

        const now = Date.now()
        if (now - (lastInterrupt.get(sid) ?? 0) < interruptCooldownMs) {
          log('info', '冷却期内，跳过本次中断')
          return
        }

        const agent = agents.get(sid)
        if (!agent || typeof agent.followup !== 'function' || typeof agent.cancel !== 'function') {
          log('warn', '拿不到可取消的 Agent（未登记），跳过中断')
          return
        }

        lastInterrupt.set(sid, now)
        st.stopped = true
        try {
          agent.followup({
            // 落成 user/message 时必须带齐 role 和 id：
            // 缺 role → 上游反序列化 400；缺 id → 本地加载时报
            // "session event at seq N lacks an identified message"。两个都实测踩过。
            role: 'user',
            id: randomUUID(),
            content: [{ type: 'text', text: interruptMessage }],
            source: { kind: 'user' },
          })
        } catch (error) {
          log('error', `followup 失败: ${String(error)}`)
        }
        try {
          agent.cancel({ kind: 'hook', reason: 'think-guard: reasoning repetition' }, { keepInbox: true })
        } catch (error) {
          log('error', `cancel 失败: ${String(error)}`)
        }
        log('info', `已中断 turn ${frame.turn ?? '?'} step ${frame.step ?? '?'}，并排入续写提醒`)
      } catch (error) {
        try {
          ctx.logger?.warn?.(`think-guard: 流式检测失败（已跳过）: ${String(error)}`)
        } catch {}
      }
    })
    log(
      'info',
      `流式检测已注册（连续 >= ${interruptMinRun} 行确认句命中；中断 ${
        interruptOnLoop ? `开（冷却 ${Math.round(interruptCooldownMs / 1000)}s）` : '关，仅观测'
      }）`,
    )
  } catch (error) {
    log('error', `注册 agent/assistant-stream 失败: ${String(error)}`)
  }
}
