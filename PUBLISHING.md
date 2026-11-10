# 发布说明

## 当前状态

| 渠道 | 状态 |
|---|---|
| GitHub 仓库 | ✅ <https://github.com/junzhifou0720/dsh-think-guard> |
| npm 包名 `dsh-think-guard` | ❌ **已被他人占用**（v0.2.0，独立 reviewer 模型监督思考，与本项目无关） |
| 安装方式 | 用 `github:` 源或手动 link，见 README |

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
