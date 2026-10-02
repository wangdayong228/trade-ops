# 对冲完全对账原则 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `docs/standards/code-rules.md` 增加第 4 条：对冲必须完全对账。

**Architecture:** 只追加一条与现有第 1、2 条同构的短原则和示例。不改实现、测试或其它文档语义。

**Tech Stack:** Markdown

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-09-05-complete-hedge-reconciliation-design.md`。
- 用户已要求写完计划后立即执行。
- 只修改 `docs/standards/code-rules.md` 的实现正文；第 1 至 3 条保持不变。
- 第 4 条正文必须与 spec 第 4 节一致，不得改语义。
- 不改 `src/strategy/hedge-coordinator.ts`、`src/strategy/order-monitor.ts` 或其他实现、测试、操作文档。
- 这是规则文档工作，不构造业务 TDD 红灯；用文件内容和 diff 验证。
- 不提交、不推送，不读取真实 `.env`，不访问交易所或业务数据库。

---

### Task 1: 写入第 4 条

**Files:**
- Modify: `docs/standards/code-rules.md`

**Interfaces:**
- Consumes: spec 第 4 节批准正文。
- Produces: `code-rules.md` 第 4 条硬约束。

- [x] **Step 1: 追加第 4 条**

在现有第 3 条之后追加：

```
4. **对冲必须完全对账**：对账是重中之重。凡会推进对冲状态的路径（协调器执行/续跑、订单监控、重启恢复），在进入 `HEDGED`、`FAILED`、`HEDGE_INCOMPLETE` 或决定补 GTC 之前，必须完成完全对账：本地策略状态、本地订单与交易所快照在角色、数量、状态上一致，并核对两腿成交量、对残差给出唯一解释（已对冲 / 需补 GTC / 明确失败）。不得在对账未完成时宣称对冲完成或结束任务。

   > 示例：并发开仓现货成交 `1`、合约成交 `0.6` 时，必须先对账再对合约补 `0.4` 的 GTC；不得直接标为 `HEDGED`，也不得在未查回两腿订单时标为 `FAILED`。
```

- [x] **Step 2: 核对正文与范围**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
text = Path('docs/standards/code-rules.md').read_text()
needles = [
    '1. **先检查，再执行**',
    '2. **错误必须精确**',
    '3. API 错误日志必须包含请求信息',
    '4. **对冲必须完全对账**',
    '对账是重中之重',
    '协调器执行/续跑、订单监控、重启恢复',
    'HEDGED',
    'FAILED',
    'HEDGE_INCOMPLETE',
    '已对冲 / 需补 GTC / 明确失败',
    '现货成交 `1`、合约成交 `0.6`',
]
missing = [n for n in needles if n not in text]
print('missing=', missing)
print('rule_count=', text.count('\n4. '))
raise SystemExit(1 if missing else 0)
PY
git diff --stat -- docs/standards/code-rules.md src/strategy/hedge-coordinator.ts src/strategy/order-monitor.ts
```

Expected: `missing=[]`，`rule_count=1`，exit 0；`hedge-coordinator.ts` 与 `order-monitor.ts` 无 diff。
