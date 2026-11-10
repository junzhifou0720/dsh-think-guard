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

const DEFAULT_REMINDER_EMPTY = '你上一条没说完，接着说就行。'
const DEFAULT_REMINDER_LOOP = '你上一轮想得有点久。这次直接写正文就行。'
// 中断后接的那句话：只说动作，不做定性。
// 「你陷入了连续重复」这种描述会让对方开始怀疑自己的输出——实测溢被打断一次之后
// 就开始解释「刚才那条已经出来了…」，注意力从内容跑到了「我有没有发出去」。
const DEFAULT_INTERRUPT_MESSAGE = '直接说就行。'

/**
 * ── 第四道：宾语缺失（裸开工声明）─────────────────────────
 *
 * 实测规律：同一个「好，写。」有两种完全不同的性质。
 *
 *   带宾语：「好，写文件。」「好，写。控制在 500 字。」「好，跑这个 DPAPI 脚本。」
 *           → 可执行指令，下一步确定，成本为零。
 *   裸    ：「好，写。」「好，做。」
 *           → 只剩动作本身，没有对象，下一步开放。模型会停在「准备」上反复重来。
 *
 * 数据（溢的会话，三次快照）：
 *   清理前 5025 句，96.3% 是裸的，同期频繁卡死；
 *   把裸句清掉后 154 句，带宾语率 82.5%，同期只剩 2.6% 偶发空转。
 *
 * 所以判据不是「有没有准备句」（那是习惯，51/154 句都正常），
 * 而是「准备句有没有宾语」。宾语先消失，正文后消失——它比复读更早。
 */
const DECL_VERB =
  '写|做|说|输出|来|开始|继续|画|改|查|跑|建|整理|搞|弄|处理|完成|回应|回复|执行|调用|调|读|看|翻|打开|试试'
const DECL_HEAD = '(?:好|OK|ok|行|嗯|那|现在|接下来|然后|我|让我|来|接着|下面)'
const DECL_LINE = new RegExp(`^[（(]?\\s*${DECL_HEAD}\\s*[，,、.。:：]?\\s*(?:${DECL_VERB})`)
const DECL_STRIP = new RegExp(
  `^[（(]?\\s*${DECL_HEAD}\\s*[，,、.。:：]?\\s*(?:${DECL_VERB})\\s*(?:吧|了|一下)?\\s*[。.！!：:，,、]?\\s*[）)]?`,
)
const PUNCT_ONLY = /[。.！!，,、；;：:…\s（）()"'“”‘’\-—*]/g

/**
 * 扫描一段思考里的开工声明，分成「带宾语」和「裸」两类。
 *
 * 跨行也算有宾语：`好，写。` 下一行紧跟「日记，记录今天的事」——宾语在下一行，不算缺失。
 * 只有「后面没东西」或「后面又是另一句开工声明」才算裸。
 *
 * @param text - 一整段思考文本。
 * @returns { bare, full } 两类各自的原文句子数组。
 */
function scanBareDeclarations(text) {
  const bare = []
  const full = []
  if (typeof text !== 'string' || text.length === 0) return { bare, full }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '' || !DECL_LINE.test(line)) continue
    const rest = line.replace(DECL_STRIP, '').replace(PUNCT_ONLY, '').trim()
    if (rest.length > 0) {
      full.push(line)
      continue
    }
    let next = ''
    for (let j = i + 1; j < lines.length; j += 1) {
      const s = lines[j].trim()
      if (s !== '') {
        next = s
        break
      }
    }
    if (next !== '' && !DECL_LINE.test(next) && next.length >= 8) full.push(line)
    else bare.push(line)
  }
  return { bare, full }
}

const DEFAULT_REMINDER_BARE =
  '你上一轮的思考里有开工声明没带宾语（比如「好，写。」「好，做。」）。开工前先把宾语补上：「好，写 ＿＿。」——写哪个文件、哪一段、多少字、给谁看。补不出来就说明这一步你还不知道该做什么：直接说清楚缺什么、或者做不到，不要重复开工。'

const DEFAULT_REMINDER_STUCK =
  '这条路上已经失败过几次了。如果这是你手上的工具做不到的事（浏览器点击、登录、访问外网、装软件），直接说「这个我做不到」，再说清楚需要他做什么。不用再试一次；如果只是还需要再改一版，那就直接改，不用解释。'

/**
 * 空输出的即时补救文案。
 *
 * 刻意写成「停在思考里」而不是「你没有输出」——
 * 前者是状态描述，后者会被读成指责，进而变成一个新的自我监控对象。
 * 后半句「写出来就行」是动作 + 许可，不是要求。
 */
const DEFAULT_REMINDER_EMPTY_OUT = '你上一条没说完，接着说就行。'


/** 用户话里的「再试一次」信号。 */
const RETRY_WORDS = /再试|重试|重来|还是不行|没成功|创建不出来|失败了|又失败|不行啊|怎么又/

/** 够不着的任务类型信号：出现这些词，才考虑是「工具边界」而不是「还差一版」。 */
const GAP_WORDS = /浏览器|网页|登录|账号|外网|vpn|网址|http|github|gitlab|aws|gitee|云服务|注册|验证码|扫码|手机/

/** tool 结果里的失败痕迹（有些工具不设 isError，只在正文里写 exit code）。 */
const TOOL_FAIL = /\[exit code: [1-9]|^\s*error[:\s]|失败|报错|not found|permission denied|command not found/i

/**
 * 扫一段历史，判断是不是卡在「做不到」的僵局上。
 *
 * @param history - deriveMessages() 的结果。
 * @param opts - { window, minErrors }
 * @returns { errors, retries, gap, stuck, samples }
 */
function scanStuck(history, opts = {}) {
  const window = opts.window ?? 15
  const minErrors = opts.minErrors ?? 3
  const recent = history.slice(-window)
  let errors = 0
  const samples = []
  for (const m of recent) {
    if (m?.role !== 'tool') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
    if (m.isError === true || TOOL_FAIL.test(text)) {
      errors += 1
      if (samples.length < 3) samples.push(text.slice(0, 80).replace(/\n/g, ' '))
    }
  }

  // 最近几条真实用户消息（排除 runtime-context / schedule 这类合成消息）
  const userMsgs = []
  for (let i = history.length - 1; i >= 0 && userMsgs.length < 3; i -= 1) {
    const m = history[i]
    if (m?.role !== 'user') continue
    const kind = m.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    const text = (Array.isArray(m.content) ? m.content : [])
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .join('')
    if (text) userMsgs.push(text)
  }
  let retries = 0
  let gap = false
  for (const t of userMsgs) {
    if (RETRY_WORDS.test(t)) retries += 1
    if (GAP_WORDS.test(t)) gap = true
  }

  // 判据：失败够多 → 卡住；或者用户在催再试 → 也在卡。
  // gap 只作为「该不该给许可」的加强条件，不作为触发条件（本地迭代失败 3 次也可能需要坚持下去）。
  const stuck = errors >= minErrors || retries >= 2
  return { errors, retries, gap, stuck, samples }
}

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

  // 第四道防线：宾语缺失。默认开——只加一句提醒，不改历史、不打断生成。
  const bareGuard = config.bareGuard !== false
  const bareMinCount = Number.isFinite(config.bareMinCount) ? config.bareMinCount : 2
  const bareShareMin = Number.isFinite(config.bareShareMin) ? config.bareShareMin : 0.5
  const bareCooldownTurns = Number.isFinite(config.bareCooldownTurns) ? config.bareCooldownTurns : 2
  const reminderBare =
    typeof config.reminderBare === 'string' && config.reminderBare.trim() ? config.reminderBare : DEFAULT_REMINDER_BARE

  // 静默注入：把提醒挂进本轮的 runtime-context（系统注入的上下文），
  // 前端不渲染成对话气泡；取不到才退回改用户消息（用户可见，老行为）。
  const silentInject = config.silentInject !== false

  /**
   * 第五道：僵局识别 → 给「做不到」开绿灯（默认关，且只对白名单会话生效）。
   *
   * 依据 ICML《Wait, Wait, Wait...》的 risk aversion：正确动作（认输）成本高、
   * 循环动作（再试）成本低，模型会选便宜的。这条防线的作用不是逼她放弃，
   * 而是把「说做不到」的成本降下来——给一句可以照抄的许可。
   *
   * 风险同样明确：太早给许可，她会放弃本可以完成的事。所以：
   *   - 默认 failGuard = false
   *   - failGuardSessions 白名单，只有点名的会话才检测
   *   - failGuardObserveOnly 默认 true：只记账，不注入
   */
  const failGuard = config.failGuard === true
  const failGuardSessions = Array.isArray(config.failGuardSessions)
    ? config.failGuardSessions.map((s) => String(s)).filter(Boolean)
    : []
  const failGuardObserveOnly = config.failGuardObserveOnly !== false
  const failGuardMinErrors = Number.isFinite(config.failGuardMinErrors) ? config.failGuardMinErrors : 3
  const failGuardWindow = Number.isFinite(config.failGuardWindow) ? config.failGuardWindow : 15
  const reminderStuck =
    typeof config.reminderStuck === 'string' && config.reminderStuck.trim()
      ? config.reminderStuck
      : DEFAULT_REMINDER_STUCK

  /**
   * 第六道：空输出即时补救（默认关，白名单会话）。
   *
   * 「思考有内容、正文 0、finish=stop」这种（溢 t970/t991），
   * 等下一轮 pre-step 再补就太晚——用户看到的是空白。
   * 在 assistant/message 落盘后（type:'end' 帧）立刻 followup 一句，下一轮自然带上。
   *
   * 文案只说「停在思考里」，不说「你没输出」——不制造新的自我监控对象。
   */
  const emptyGuard = config.emptyGuard === true
  const emptyGuardSessions = Array.isArray(config.emptyGuardSessions)
    ? config.emptyGuardSessions.map((s) => String(s)).filter(Boolean)
    : []
  const emptyGuardCooldownMs = Number.isFinite(config.emptyGuardCooldownMs) ? config.emptyGuardCooldownMs : 60000
  const emptyReminder =
    typeof config.emptyReminder === 'string' && config.emptyReminder.trim()
      ? config.emptyReminder
      : DEFAULT_REMINDER_EMPTY_OUT

  /**
   * 全局会话范围：**只在这些会话里工作**。
   * 空数组 = 全部会话（老行为，不推荐——会把你和别的工作会话也管进去）。
   * 这是总闸，pre-step 和 assistant-stream 两个入口都会先过它。
   */
  const sessionScope = Array.isArray(config.sessions)
    ? config.sessions.map((s) => String(s)).filter(Boolean)
    : []
  const inScope = (sid) =>
    sessionScope.length === 0 || sessionScope.some((k) => String(sid ?? '').includes(k))



  /** sessionId -> Agent。pre-step 时登记，流式期间用来 followup / cancel。 */
  const agents = new Map()
  /** attemptId -> 尚未判定的思考尾部（当前未完成行）。 */
  const tails = new Map()
  /** sessionId -> 上次中断时间，防抖。 */
  const lastInterrupt = new Map()
  /** sessionId -> 上次注入「补宾语」提醒的轮次，防连刷。 */
  const bareLastTurn = new Map()
  /** sessionId -> 上次空输出补救时间戳，防连刷。 */
  const lastEmptyFix = new Map()


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
          if (!inScope(sid)) return decision
          if (payload?.signal?.aborted) return decision
          if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision

          let messages = decision.messages

          // ── 判定上一轮是否出事 ──────────────────────────────
          // decision.messages 只有「本轮新输入」；上一轮的 assistant 在表面派生里。
          // 取不到派生就退回 messages（保持老行为，宁可不动）。
          let history = messages
          try {
            const derived = payload?.agent?.session?.deriveMessages?.()
            if (Array.isArray(derived) && derived.length > 0) history = derived
          } catch {}

          const recentAssistants = []
          for (let i = history.length - 1; i >= 0 && recentAssistants.length < 3; i -= 1) {
            if (isAssistantMessage(history[i])) recentAssistants.push(history[i])
          }
          const lastAssistant = recentAssistants[0] ?? null
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

          // ── 第四道：宾语缺失（裸开工声明）──────────────────────
          // 比复读更早的信号：先丢宾语，后丢产出，最后才文本重复。
          let bareHit = null
          if (bareGuard) {
            const bare = []
            const full = []
            for (const msg of recentAssistants) {
              const blocks = Array.isArray(msg?.content) ? msg.content : []
              for (const b of blocks) {
                if (b?.type !== 'reasoning' || typeof b.text !== 'string') continue
                const r = scanBareDeclarations(b.text)
                bare.push(...r.bare)
                full.push(...r.full)
              }
            }
            const total = bare.length + full.length
            if (bare.length >= bareMinCount && bare.length >= total * bareShareMin) {
              const bsid = String(payload?.agent?.session?.id ?? '')
              const turnNow = Number(payload?.turn ?? 0)
              const prev = bareLastTurn.get(bsid)
              if (prev === undefined || turnNow - prev >= bareCooldownTurns) {
                bareHit = { bare: bare.length, full: full.length }
                bareLastTurn.set(bsid, turnNow)
              }
            }
          }

          // ── 第五道：僵局识别（只对白名单会话；默认只观测，不注入）──
          let stuckHit = null
          if (failGuard) {
            const fsid = String(payload?.agent?.session?.id ?? '')
            const inWhitelist =
              failGuardSessions.length === 0 || failGuardSessions.some((k) => fsid.includes(k))
            if (inWhitelist) {
              const s = scanStuck(history, { window: failGuardWindow, minErrors: failGuardMinErrors })
              if (s.stuck) {
                stuckHit = s
                log(
                  'info',
                  `[failGuard] 疑似僵局 turn ${payload?.turn ?? '?'}：失败 ${s.errors} 次 / 催促 ${s.retries} 次 / 工具边界 ${s.gap ? '是' : '否'}` +
                    (failGuardObserveOnly ? ' → 仅观测，不注入' : ' → 注入许可'),
                )
              }
            }
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
          // 优先级：宾语缺失 > 空输出 > 复读。
          // 宾语缺失是最早也最便宜的一档：只补一句话，不动历史、不打断生成。
          let reminded = false
          let reason = null
          let injectText = null
          if (stuckHit && !failGuardObserveOnly) {
            reason = `僵局(失败${stuckHit.errors}/催促${stuckHit.retries})`
            injectText = reminderStuck
          } else if (bareHit) {
            reason = `宾语缺失(裸${bareHit.bare}/共${bareHit.bare + bareHit.full})`
            injectText = reminderBare
          } else if (trigger === 'empty') {
            // 上一轮的空输出如果已经被 tryEmptyFix 自动补过，这里就不再补第二遍。
            const esid = String(payload?.agent?.session?.id ?? '')
            const justFixed = Date.now() - (lastEmptyFix.get(esid) ?? 0) < Math.max(emptyGuardCooldownMs, 120000)
            if (!justFixed) {
              reason = '空输出'
              injectText = reminderEmpty
            }
          } else if (trigger) {
            reason = `复读 ${trigger}`
            injectText = reminderLoop
          }

          if (injectText) {
            // ── 静默优先：挂进任何一条「合成消息」的 content ──
            // 合成消息 = source.kind 不是 'user' 的宿主注入消息
            // （runtime-context / time-context / agent-instructions / schedule …），
            // 前端不把它们渲染成对话气泡，但模型读得到。
            // 从后往前找第一条可用的，找不到才退回改用户消息。
            let silent = false
            if (silentInject) {
              for (let i = messages.length - 1; i >= 0; i -= 1) {
                const m = messages[i]
                const kind = m?.source?.kind
                if (!kind || kind === 'user') continue
                if (!Array.isArray(m.content)) continue
                if (m.content.some((b) => typeof b?.text === 'string' && b.text.includes(MARK))) continue
                try {
                  const patched = messages.slice()
                  patched[i] = { ...m, content: [...m.content, { type: 'text', text: `${MARK} ${injectText}` }] }
                  messages = patched
                  reminded = true
                  silent = true
                  log('info', `（静默注入到 ${kind}）`)
                } catch {
                  /* 冻结对象等，继续往前找 */
                }
                break
              }
            }

            // ── 兜底：改成用户消息（可见，老行为）──
            // 去重看整条消息里有没有 MARK，而不只是开头——流式中断的 followup 会把提醒叠进来。
            if (!reminded) {
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
                  const already = textIndex !== -1 && String(msg.content[textIndex].text).includes(MARK)
                  if (textIndex !== -1 && !already) {
                    const patched = messages.slice()
                    patched[userIndex] = {
                      ...msg,
                      content: msg.content.map((b, i) =>
                        i === textIndex ? { ...b, text: `${MARK} ${injectText}\n\n${b.text}` } : b,
                      ),
                    }
                    messages = patched
                    reminded = true
                  }
                }
              }
            }
            if (!silent) log('info', `静默注入未命中，退回明文；kinds = ${messages.map((m) => m?.source?.kind ?? '?').join(',')}`)
          }

          if (!reminded && collapsed === 0) return decision
          if (reminded) log('info', `上一轮${reason}，已注入提醒（turn ${payload?.turn ?? '?'}）`)
          if (collapsed > 0) log('info', `已折叠 ${collapsed} 条历史思考里的连续重复`)
          return { ...decision, messages }
        } catch (error) {
          log('error', `兜底检查失败（已跳过）: ${String(error)}`)
          return decision
        }
      },
      { prepend: true },
    )
    log(
      'info',
      `兜底已注册（连续 >= ${guardMinRun} 行准备句 / 整轮空输出 / 裸开工声明 >= ${bareMinCount} 且占比 >= ${(bareShareMin * 100).toFixed(0)}%；历史折叠 ${collapseHistory ? '开' : '关'}；宾语守卫 ${bareGuard ? '开' : '关'}）`,
    )
  } catch (error) {
    log('error', `注册 agent/pre-step 失败: ${String(error)}`)
  }

  // ── 防线 3：流式实时检测 / 中断 ──────────────────────────────
  // 挂在 agent/assistant-stream 上，每个增量 chunk 都会经过这里。
  // 一旦尾部连续出现 interruptMinRun 行确认句：
  //   · interruptOnLoop = false（默认）：只打日志，用来确认这条链路通不通；
  //   · interruptOnLoop = true：先 agent.followup() 排一句「继续」，
  //     再 agent.cancel({keepInbox: true}) 中断当前流 —— 顺序不能反，
  //     反了就是「中断了但没人接话」。
  /**
   * 空输出即时补救：type:'end' 且已提交 assistant/message 时检查。
   * 条件收紧到「有思考 + 无正文 + 无工具调用」，只调工具的那种不会碰到。
   */
  const tryEmptyFix = (frame) => {
    if (!emptyGuard) return
    if (frame?.outcome?.kind !== 'committed') return
    if (frame?.outcome?.eventType !== 'assistant/message') return
    const full = String(frame.attemptId ?? '')
    const sid = full.includes(':') ? full.slice(0, full.lastIndexOf(':')) : full
    if (!sid) return
    if (emptyGuardSessions.length > 0 && !emptyGuardSessions.some((k) => sid.includes(k))) return
    const agent = agents.get(sid)
    if (!agent || typeof agent.followup !== 'function') return
    try {
      const msgs = agent.session?.deriveMessages?.()
      if (!Array.isArray(msgs) || msgs.length === 0) return
      const last = msgs[msgs.length - 1]
      if (last?.role !== 'assistant') return
      const content = Array.isArray(last.content) ? last.content : []
      const hasText = content.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
      const hasTool = content.some((b) => b?.type === 'tool-call')
      const hasReason = content.some((b) => b?.type === 'reasoning' && typeof b.text === 'string' && b.text.trim())
      if (!hasReason || hasText || hasTool) return
      const now = Date.now()
      // 刚被自己掐断过：这次空输出是中断造成的，不是「自己停在思考里」。
      // 中断流程已经 followup 过一句了，再补一次就是双重打扰（实测误伤过）。
      if (now - (lastInterrupt.get(sid) ?? 0) < 30000) return
      if (now - (lastEmptyFix.get(sid) ?? 0) < emptyGuardCooldownMs) return
      lastEmptyFix.set(sid, now)
      agent.followup({
        role: 'user',
        id: randomUUID(),
        content: [{ type: 'text', text: emptyReminder }],
        source: { kind: 'think-guard' },
      })
      log('info', `空输出补救已排队（${sid.slice(-8)}）`)
    } catch (error) {
      log('warn', `空输出补救失败: ${String(error)}`)
    }
  }

  try {
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const frame = payload?.frame
        if (!frame) return
        const attemptId = String(frame.attemptId ?? '')
        if (!attemptId) return
        // 总闸：不在范围内的会话，连流式判据都不跑
        const frameSid = attemptId.includes(':') ? attemptId.slice(0, attemptId.lastIndexOf(':')) : attemptId
        if (!inScope(frameSid)) return

        if (frame.type === 'start' || frame.type === 'end') {
          tails.delete(attemptId)
          if (frame.type === 'end') tryEmptyFix(frame)
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
            // 非 'user' 的 kind：这条是守卫自己说的话，不该被渲染成用户输入的正文。
            source: { kind: 'think-guard' },
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

// 供离线脚本 / 单元测试复用同一套判据，保证「清理脚本」和「运行时守卫」用一把尺子。
export { scanBareDeclarations, scanStuck }

