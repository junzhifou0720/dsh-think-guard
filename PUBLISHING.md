# 发布说明

## 当前状态

| 渠道 | 状态 |
|---|---|
| GitHub 仓库 | ✅ <https://github.com/junzhifou0720/dsh-think-guard> |
| 最新版本 | **v0.5.0**（2026-11-19） |
| 本地 git | ✅ 已 init、已提交（`3222671`），remote 已配 |
| **push** | ⚠️ **需要手动**——这台机器上 `git push` 会卡在认证（`GIT_TERMINAL_PROMPT=0` 也不返回） |
| npm 包名 `dsh-think-guard` | ❌ **已被他人占用**（v0.2.0，独立 reviewer 模型监督思考，与本项目无关） |
| 安装方式 | 用 `github:` 源或手动 link，见 README |

### 手动 push（在这台机器上）

```powershell
cd D:\dsh\workspaces\default-workspace\publish\dsh-think-guard
git push -u origin main
```

**如果卡住不动**：换 GitHub Desktop，或者开一个带凭据的终端（`gh auth login` 之后 `git push` 就能走 gh 的 credential helper）。

**发布 tgz 已生成**：`dsh-think-guard-0.5.0.tgz`（32.7 kB，8 个文件），可以直接拖到 GitHub Release 里。

---

## 版本发布流程

```bash
# 0. 确认在 publish\dsh-think-guard 目录里
# 1. 从开发目录同步代码
Copy-Item ..\..\plugins\dsh-think-guard\index.js  index.js  -Force
Copy-Item ..\..\plugins\dsh-think-guard\client.js client.js -Force
# 2. 改 package.json 的 version
# 3. 更新 CHANGELOG.md（顶部加一条）
# 4. 更新 README 里的配置示例和限制章节
# 5. 语法检查
node --check index.js && node --check client.js
# 6. 打包
cmd /c "D:\nodejs\npm.cmd pack"
# 7. 提交
git add -A
git commit -m "vX.Y.Z: ..."
# 8. 推送（见上面的「手动 push」）
git push -u origin main
```

**注意**：`npm.ps1` 会被 ExecutionPolicy 拦住，必须用 `npm.cmd`。

---

## 如果要发 npm（需要改名）

### 1. 选名

已确认可用的备选（2026-11-10 查）：

| 候选 | 状态 |
|---|---|
| `dsh-think-brake` | ✅ 可用（推荐，与 think-guard 语义最近） |
| `dsh-loop-brake` | ✅ 可用 |
| `dsh-reasoning-guard` | ✅ 可用 |
| `dsh-think-loop-guard` | ✅ 可用 |
| `dsh-loop-breaker` | ❌ 已被占用 |

### 2. 改名清单（四个地方，缺一个就装不上）

假设新名是 `dsh-think-brake`：

| 文件 | 改什么 |
|---|---|
| `package.json` | `"name": "dsh-think-brake"` |
| `cordis.patch.yml` | 条目里的 `name: dsh-think-brake` |
| `README.md` | 安装命令、目录名引用 |
| `CHANGELOG.md` | 顶部加一条「改名」记录 |

**注意**：`cordis.patch.yml` 里的 `name` 必须与 `package.json` 的 `name` 一致，否则 loader 解析不到。

### 3. 发布

```bash
npm login                     # 没有账号先 npm adduser
npm pack --dry-run            # 确认清单是 6 个文件
npm publish --access public
npm view dsh-think-brake version
```

### 4. 用 scope 也可以

```json
{ "name": "@junzhifou0720/dsh-think-guard" }
```

好处是本名不变，坏处是搜索权重低、需要先在 npm 注册同名账号。

---

## 上市场（可选）

当前同赛道已有多个项目：

- [walksls/dsh-degeneration-kit](https://github.com/walksls/dsh-degeneration-kit) — 折叠 + 压缩双插件
- [visiter911/dsh-thinking-guard](https://github.com/visiter911/dsh-thinking-guard) — 缝合 / 封装 / 去重
- [ethanwong-hk/dsh-thinking-guard](https://github.com/ethanwong-hk/dsh-thinking-guard) — 三重熔断
- [@mrweicodes/dsh-loop-guard](https://www.npmjs.com/package/@mrweicodes/dsh-loop-guard) — Thinking-Loop Guard

**本项目的差异点**（写进 issue 时强调）：

1. **三种形态**：A 型连发、B 型轮换、**行内堆叠**（第三种是实测发现，别的项目没覆盖）
2. **清理 + 兜底 + 实时中断三合一**
3. **有完整的实测记录**：单轮 509,782 字符 / 124,046 行「好。」；B 型进化链（A → B → 行内）

提交入口：

- DSH Market：<https://github.com/2BingLing/dsh-market/issues/new>
- 或自己的 format-1 索引（schema 见 `docs/` 里的说明）

---

## 版本发布流程

```bash
# 1. 改代码
# 2. 更新 CHANGELOG.md
# 3. 升版本
npm version patch   # 或 minor / major
# 4. 重新打包
npm pack
# 5. 推送
git add . && git commit -m "vX.Y.Z: ..." && git push
# 6. 发 npm（如果用了 npm）
npm publish
```
