#!/usr/bin/env node
/**
 * fix-session-reasoning.mjs — 清理 DSH 会话日志里退化的「准备句」复读
 *
 * 只做一件事：找出思考（reasoning）里连续重复的「好，写／好，做／好，说／好，输出」，
 * 把它们折叠成一行标记，保留想法骨架，其余内容一字不动。
 *
 * 关键点：按 DSH 的写入约定「逐帧处理」——
 *   · 一帧 = 一次追加（header 或一批事件）
 *   · 每帧带 checksum，不写 content size
 *   · 只重压受影响的那几帧，其余帧字节级原样拷贝，帧数必须守恒
 * 否则 DSH 会读不完整，会话会从列表里消失。
 *
 * 用法：
 *   node fix-session-reasoning.mjs --file <session.v4.jsonl.zstd> --dry-run
 *   node fix-session-reasoning.mjs --file <session.v4.jsonl.zstd> --apply
 *
 * 选项：
 *   --min-run <n>     连续多少行准备句算复读（默认 3）
 *   --turns a,b,c     只处理指定轮次（默认自动检测所有退化轮次）
 *   --keep-bak        写入前自动备份（默认开）
 *
 * 退出码：0 成功；1 校验失败或参数错误。
 */

import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync } from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 4247762216;
const RITUAL_LINE = /^好\s*[，。、]?\s*(写|做|说|输出|来)?\s*[。：:！!]?$/;

function parseArgs(argv) {
  const args = { file: null, apply: false, minRun: 3, turns: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--min-run') args.minRun = Number(argv[++i]);
    else if (a === '--turns') args.turns = argv[++i].split(',').map(Number).filter(Number.isFinite);
  }
  return args;
}

/** 按 zstd 帧结构扫描边界，不解压块数据。 */
function scanFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`帧头魔数不对，偏移 ${offset}`);
    offset += 4;
    const descriptor = buf.readUInt8(offset); offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictFlag = descriptor & 3;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes;
    for (;;) {
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const last = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      offset += blockType === 1 ? 1 : blockSize;
      if (last) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

const isRitual = (line) => RITUAL_LINE.test(line.trim());

/** 最长连续准备句行数。 */
function longestRun(text) {
  let best = 0;
  let run = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (isRitual(line)) { run++; if (run > best) best = run; } else run = 0;
  }
  return best;
}

/** 折叠连续重复，保留其余内容。 */
function collapse(text, minRun) {
  const out = [];
  let run = 0;
  const flush = () => {
    if (run >= minRun) out.push(`（此处省略 ${run} 行重复）`);
    else for (let i = 0; i < run; i++) out.push('好，写。');
    run = 0;
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (isRitual(line)) { run++; continue; }
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.file || !existsSync(args.file)) {
    console.error('用法: node fix-session-reasoning.mjs --file <session.v4.jsonl.zstd> [--dry-run|--apply]');
    process.exit(1);
  }

  const buf = readFileSync(args.file);
  const frames = scanFrames(buf);
  const opts = {
    params: {
      [zlib.constants.ZSTD_c_checksumFlag]: 1,
      [zlib.constants.ZSTD_c_contentSizeFlag]: 0,
    },
  };

  const outFrames = [];
  const report = [];
  let changedFrames = 0;

  for (let i = 0; i < frames.length; i++) {
    const orig = buf.subarray(frames[i].start, frames[i].end);
    let text;
    try {
      text = zlib.zstdDecompressSync(orig).toString('utf8');
    } catch {
      outFrames.push(orig);
      continue;
    }
    let touched = false;
    const rows = text.split('\n').map((row) => {
      if (!row) return row;
      let evt;
      try { evt = JSON.parse(row); } catch { return row; }
      if (evt.type !== 'assistant/message') return row;
      const turn = evt.data?.turn;
      if (args.turns && !args.turns.includes(turn)) return row;
      const content = evt.data?.message?.content;
      if (!Array.isArray(content)) return row;
      let local = false;
      const nextContent = content.map((block) => {
        if (block?.type !== 'reasoning' || typeof block.text !== 'string') return block;
        if (longestRun(block.text) < args.minRun) return block;
        const cleaned = collapse(block.text, args.minRun);
        if (cleaned === block.text) return block;
        local = true;
        report.push({ turn, frame: i, before: block.text.length, after: cleaned.length });
        return { ...block, text: cleaned };
      });
      if (!local) return row;
      touched = true;
      return JSON.stringify({ ...evt, data: { ...evt.data, message: { ...evt.data.message, content: nextContent } } });
    });

    if (!touched) {
      outFrames.push(orig);
      continue;
    }
    changedFrames++;
    outFrames.push(zlib.zstdCompressSync(Buffer.from(rows.join('\n'), 'utf8'), opts));
  }

  const outBuf = Buffer.concat(outFrames);

  // ── 校验 ──────────────────────────────────────────────
  const vFrames = scanFrames(outBuf);
  let lineCount = 0, badJson = 0, seqOk = true, prevSeq = -1;
  for (const f of vFrames) {
    const t = zlib.zstdDecompressSync(outBuf.subarray(f.start, f.end)).toString('utf8');
    for (const l of t.split('\n').filter(Boolean)) {
      lineCount++;
      try {
        const o = JSON.parse(l);
        if (typeof o.seq === 'number') {
          if (o.seq <= prevSeq) seqOk = false;
          prevSeq = o.seq;
        }
      } catch { badJson++; }
    }
  }

  console.log(`源文件      : ${args.file}`);
  console.log(`帧数        : ${frames.length} -> ${vFrames.length}`);
  console.log(`改动帧数    : ${changedFrames}`);
  console.log(`总行数      : ${lineCount}（JSON 坏行 ${badJson}，seq 单调 ${seqOk ? '是' : '否'}）`);
  console.log(`文件大小    : ${buf.length} -> ${outBuf.length} 字节`);
  for (const r of report) console.log(`  第 ${r.turn} 轮（帧 ${r.frame}）: ${r.before} -> ${r.after} 字符`);

  const ok =
    report.length > 0 &&
    vFrames.length === frames.length &&
    lineCount > 0 &&
    badJson === 0 &&
    seqOk;

  if (!ok) {
    console.error('\n校验未通过，未写入任何文件。');
    process.exit(1);
  }

  if (!args.apply) {
    console.log('\n[dry-run] 校验通过。加 --apply 才会写回。');
    return;
  }

  const bak = `${args.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(args.file, bak);
  const tmp = `${args.file}.tmp`;
  writeFileSync(tmp, outBuf);
  renameSync(tmp, args.file);
  console.log(`\n已写入。备份：${bak}`);
  console.log('现在重启 DSH 生效。重启前不要在该会话里发消息。');
}

main();
