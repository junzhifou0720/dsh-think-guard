# Changelog

## 0.3.3 — 2026-11-10

**修复**：`followup` 注入的消息缺 `id`，导致 DSH 加载会话时报
`session event at seq N lacks an identified message`。

DSH 的 `assertMessageEventShape` 对 `user/message` 有四项要求：
`id` 非空、`role === 'user'`、`source.kind` 非空、`content` 是数组。
0.3.2 只补了 `role`，这次补齐 `id`（`randomUUID()`）。

---

## 0.3.2 — 2026-11-10

**修复**：`followup` 注入的消息缺 `role`，上游反序列化 400：
`Failed to deserialize the JSON body: messages[N]: missing field \`role\``。

---

## 0.3.1 — 2026-11-09

**新增**：行内堆叠检测。

`t807.28` 实测发现第三种形态——把几百个「好。」塞在**同一行**里用空格分隔，
不产生换行。连续行判据数不了行、B 型切句判据也失效。

判据：当前行 > 200 字符且已含 ≥ 20 个「好。」。

**开启**：profile 里 `interruptOnLoop: true`（实时中断真正生效）。

---

## 0.3.0 — 2026-11-09

**新增**：B 型（短句轮换）判据 `rotationGuard`。

只数连续行抓不到「每句都不一样、但每句都很短」的复读。
判据沿用 dsh-degeneration-kit 的 v2 尺子：尾窗内极短段占比 ≥0.35
且最高频 5 段占比 ≥0.50。

**修复**：折叠时短段会被改写成 `好，写。`（篡改原文），改为保留原行。

---

## 0.2.0 — 2026-11-09

**新增**：流式实时中断（`agent/assistant-stream`）。

命中判定 → `agent.followup()` 排队一句「继续」→
`agent.cancel({keepInbox: true})` 掐断当前流 → 自动开新一轮。

默认 `interruptOnLoop: false` 只观测。

---

## 0.1.0 — 2026-11-08

首个版本：`agent/pre-step` 上的下一轮兜底。

- 上一轮整轮空输出 → 注入「直接回答」
- 上一轮思考连续复读 → 注入「保持简洁」

**不用**常驻系统提示（第一版试过，会全局压低思考深度，已移除）。
