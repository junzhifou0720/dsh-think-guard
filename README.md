# dsh-think-guard

DSH（DeepSeek Harness）长会话的**思考循环兜底**。

上一轮整轮没输出、或思考陷入连续复读时，它会在下一轮自动注入一句「直接回答」，把模型从循环里拉回来。**正常轮次完全不介入。**

---

## 症状

在跑推理模型（`deepseek-flash` + reasoning effort high/max）的长会话里，思考视图会刷屏几千行：

```
好，写。
好。做。
好，写。
好。做。
好。
（× 4,000+）
```

而那一轮的**正文一个字都没有**——不是卡顿，不是截断，结束原因还是 `stop`（模型自己认为说完了）。

---

## 它做什么

挂在 `agent/pre-step` 瀑布上（每轮请求发给模型前的钩子），检查**上一条 assistant 消息**，满足任一条件才动手：

| 触发条件 | 说明 |
|---|---|
| 上一轮思考里有一段**连续 ≥ 12 行**的确认句 | 这叫复读。正常轮次是单发 1~2 句、散在各处，凑不成连续 12 行 |
| 上一轮**既没正文也没工具调用** | 整轮空输出 |

**「确认句」包括哪些**：

- 纯确认：`好` / `好。` / `好。好。` / `好，好。`
- 确认 + 动作：`好，写。` / `好。做。` / `好，说：` / `好，输出。`
- 括号化的自我提示：`（好）` / `（好了）` / `（好，输出）` / `（好了，输出 no_reply）`

> **纯「好。」这一类最容易漏。** 它只有一个字，几乎零成本，出现在任何一步都不奇怪。
> 实测见过单轮 **124,046 行「好。」**、打满 256,000 输出 token 才停的案例——所以它必须被纳入。

触发后只做一件事：在**本轮**用户消息最前面加一句

```
[think-guard] 你上一轮的思考陷入了重复。这次保持简洁，
不要在思考里反复写准备句，想清楚就直接写正文。
```

模型看到这句就继续回答。**只在这一轮生效，下一轮自动消失。**

---

## 复读分两型，判据也分两把尺子

| | **A 型 · 同一句死磕** | **B 型 · 短句轮换** |
|---|---|---|
| 重复次数 | 10³–10⁴ | 20–200 |
| 样子 | 「好。」×124,046 | `Let me write it.` → `Go.` → `Now.` → `OK.` |
| 读起来像 | 正常思考，句句合规，信息量为 0 | **正常推进**——最难认出来 |
| 判据 | 连续 N 行确认句 | **尾窗占比**（见下） |

**只数连续行抓不到 B 型**：每句都不一样，连续计数永远到不了阈值。

### B 型怎么判

看思考尾部 4000 字符，切成句子后算两个比例，**同时满足**才算命中：

| 参数 | 默认 | 含义 |
|---|---|---|
| `rotationTailChars` | 4000 | 只看尾部这么长 |
| `rotationMinChars` | 400 | 短于这个长度不看 |
| `rotationShortShareMin` | 0.35 | 极短段（≤3 词）占段数的比例下限 |
| `rotationTopShareMin` | 0.50 | 最高频 5 段合计占段数的比例下限 |

**为什么要两个**：光看"短句比例"会把「正常列了一堆短条目」误判成轮换——那些也全是短句。加上"最高频占比"才能区分：

| 样本 | 短句占比 | 最高频5段占比 | 结果 |
|---|---|---|---|
| A 型「好。」×500 | 1.00 | 1.00 | ✅ 命中 |
| B 型英文轮换 | 0.88 | 0.62 | ✅ 命中 |
| 正常长句推理 | 0.00 | 0.08 | ❌ |
| **正常短句列举（内容互不相同）** | **1.00** | **0.06** | ❌ **不误判** |

判据来自 [dsh-degeneration-kit](https://github.com/walksls/dsh-degeneration-kit) 的 v2 尺子，阈值照搬它的实测值（12,203 个正常英文块 0 误伤）。

### 第三种形态：行内堆叠

```
好。好。好。好。好。……（几百个，空格分隔，全程不换行）……好，调用 game_build_room。
```

**一行里塞几百个「好。」**——不产生换行，所以：

- 连续行判据数不了行（它只有一行）
- B 型切句判据也够呛（整段是一个超长段）

判据：**当前行 > 200 字符，且里面已经有 ≥ 20 个「好。」**

三种形态对照：

| 形态 | maxRun | 判据 | 危险度 |
|---|---|---|---|
| A 型连发 | 大 | 连续 ≥12 行 | 显眼 |
| B 型轮换 | 1 | 尾窗占比 | 难抓 |
| **行内堆叠** | 1 | 单行长度 + 数量 | **按行判据完全失效** |

**这三种是同一个病的三种写法。** 实测：把 A 型压成单句之后，它会改用 B 型；B 型清理之后，又出现过行内堆叠。所以判据必须三条腿，缺一条就会漏。

---

## 它不做什么

- ❌ **不改系统提示**——不会给模型加常驻纪律，不影响正常思考深度
- ❌ **不改历史消息**——默认配置下历史 reasoning 原样发送
- ❌ **不动磁盘文件**——会话日志一个字不碰
- ⚠️ **实时中断默认关闭**——需要显式打开 `interruptOnLoop: true`

任何内部异常都会被吞掉，不会因为护栏本身让一轮请求失败。

---

## 第三道防线（可选）：流式实时中断

前两道都是「已经空了一轮之后」才动手。这一道在**生成过程中**就掐断：

```
agent/assistant-stream（每个 chunk 都触发）
        │
        ├─ 累积最近 80 行思考
        │
        ▼ 尾部连续 ≥ interruptMinRun 行确认句
   agent.followup({...})                          ← 先排一句「继续」到下一回合
   agent.cancel({kind:'hook'}, {keepInbox:true})  ← 再中断当前流
        │
        ▼
   流在下一个 chunk 边界停住 → turn/end = aborted
        │
        ▼
   inbox 里那句还在 → 自动开新一轮 → 模型直接输出正文
```

DSH 原生支持这个组合：`followup()` 排队新回合、`cancel()` 带 `{ keepInbox: true }` 不清空队列，`send()` 里还有专门的 `wakingAfterAbort` 分支处理「中止后唤醒」。

**顺序不能反**：先 `cancel` 再 `followup` 的话，中断发生时队列是空的，就没人接话了。

### 开启前先观测

默认 `interruptOnLoop: false`，只打日志不中断。先跑一轮，确认日志里出现：

```
think-guard: 流式命中：连续 12 行确认句（turn N step 1，仅观测）
```

说明 `agent/assistant-stream` 这条链路通，再把 `interruptOnLoop` 改成 `true`。

### 配置

```yaml
- id: think-guard
  config:
    interruptOnLoop: false      # 改成 true 才真的中断
    interruptMinRun: 12         # 连续多少行算循环
    interruptCooldownMs: 120000 # 同一会话两次中断的最小间隔
    interruptMessage: '你刚才的思考陷入了连续重复，已经被中断。直接回答：不要复述。'
```

### 已知代价

- **会留下半截思考**：中断时已生成的部分会作为带 `interrupted` 标记的 assistant 消息落盘，下一轮模型能看到「我想到一半被打断」——这其实是个强信号；
- **用户会看到一条自己没发的消息**：`followup` 注入的内容以 user 消息形式出现，带 `[think-guard]` 前缀，一眼能认出是插件；
- **可能误伤**：正常思考里如果真的连续写了 12 行「好。」，会被打断。阈值可调。

---

## 安装

```bash
npx @deepseek-ai/dsh plugin --profile <你的profile> add dsh-think-guard
```

装完**重启 DSH** 生效（插件层在启动时合成）。

### 手动安装

1. 把包放进 `~/.dsh/profiles/<profile>/node_modules/dsh-think-guard`
2. 在 profile 的 `package.json` 里：
   - `dependencies` 加 `"dsh-think-guard": "link:<包路径>"`
   - `dsh.profile.bundles` 加 `"dsh-think-guard"`
3. 重启 DSH

---

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖默认值：

```yaml
- id: think-guard
  config:
    # ── 下一轮兜底 ──
    guardMinRun: 12          # A 型：连续多少行确认句算复读
    # ── B 型（短句轮换） ──
    rotationGuard: true
    rotationShortShareMin: 0.35
    rotationTopShareMin: 0.5
    rotationTailChars: 4000
    # ── 流式实时中断 ──
    interruptOnLoop: false   # 先设 false 只观测，确认链路通了再改 true
    interruptMinRun: 12
    interruptCooldownMs: 120000
    interruptMessage: '你刚才的思考陷入了连续重复，已经被中断。直接回答：不要复述、不要再写准备句、不要解释为什么被打断。'
    # ── 可选：折叠历史（默认关） ──
    collapseHistory: false
    collapseMinRun: 20
```

### `guardMinRun` 怎么调

参考数据（一个 913 轮的真实会话）：

- 正常轮次：平均 4 次/轮，**分散**在各段之间
- 退化轮次：**连续** 618 / 2653 / 931 行

12 离两头都很远，不会误伤。觉得太灵敏调到 20，太迟钝调到 6。

### `collapseHistory` 为什么默认关

打开后，它会把历史思考里成段的重复折叠成一行标记：

```
（此处省略 618 行重复）
```

这能切断「复读被写回上下文、下一轮照着学」的放大回路，但它要**改写 assistant 消息里的 reasoning 文本**（块数量和签名不动），有触发服务端签名校验的风险。所以默认关闭，确认你的服务端接受后再开。

---

## 原理

推理模型把「思考」和「输出」拆成两个通道。这个 bug 是那个拆分的代价：

1. 模型稳定地以「好，写。」收尾思考——它是**从思考通道切到正文通道前的最后一个 token**；
2. 切换失败时，模型继续在思考通道生成，最可能的下一 token 又是「好，写。」→ 自激循环；
3. reasoning 全文会被写回下一轮上下文（为了前缀缓存），所以一次循环会成为下一次循环的范本。

实测：同一会话里用户说过一次「你思考了一轮超级多的好，写，但最后什么都没说」，模型立刻正常输出了 486 字，并自己总结「你打断它，我就退出了那个循环」。

**这个插件只是把那次打断自动化了。**

它做不到的：上下文本身的稀释问题（624K 里一半是历史思考）——那只能靠压缩或换会话解决。实时中断能拦下「正在复读的那一段」，但拦不住「上下文已经太满」。

---

## 已知坑（都是实测踩出来的）

### 1. `followup` 注入的消息必须带齐 `role` 和 `id`

DSH 会把 `agent.followup(input)` 的 input **原样落成 `user/message`**。少一个字段就：

| 缺什么 | 报错 |
|---|---|
| `role` | 上游 400：`missing field \`role\`` |
| `id` | 本地加载失败：`session event at seq N lacks an identified message` |

DSH 的校验规则（`assertMessageEventShape`）对 `user/message` 有四条：

```js
typeof message.id === 'string' && message.id !== ''   // 必须有 id
message.role === 'user'                                // role 必须对
typeof message.source?.kind === 'string'               // source.kind 非空
Array.isArray(message.content)                         // content 是数组
```

v0.3.3 已修。**如果你 fork 后改这里的代码，别把 `id` 删了。**

### 2. 不要用"改文本"的方式折叠历史当默认

`collapseHistory: true` 会改写 assistant 消息里的 reasoning 文本（块数量和 signature 不动）。理论上服务端可能校验签名与内容一致，所以默认关闭。

更安全的做法是用 DSH 的 surface replace（`surfaceOp: {op:'replace', startSeq, endSeq}`）——替换副本是 model-only，人看的记录不受影响。本插件还没做，欢迎 PR。

---

## 许可

MIT
