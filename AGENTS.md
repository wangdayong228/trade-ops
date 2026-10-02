# Trade Ops Codex 与 Cursor 指令

## 正确性优先

**正确性是最高原则。** 它优先于速度、便利、复杂度和“看起来更简单”。本文后续所有 workflow gates、delegation、routing 和安全边界，都必须在正确性成立的前提下执行；任何与正确性冲突的做法都必须停止。

- 调查、design 和实现必须首先保证正确性；“更简单”只能在多个方案同样正确时作为取舍依据，不得为了降低复杂度接受不正确、不完整或无法证明的行为。
- 在判定时序、事务、状态转换和跨系统行为前，必须先核对已批准 design、绑定源码及可复现证据；若观测结果违反已证明的时序或不变量，必须按错误或完整性异常 fail-closed 处理，不得为了方便将其解释为正常竞态。
- 无法证明某个方案正确时，必须继续调查或请求裁决，不得凭假设选择“看起来更简单”的方案。

## 既有 workflow gates

- 遵守当前适用的 brainstorming、writing-plans、test-driven-development、systematic-debugging、pre-verification-check、verification-before-completion、consistency-check 和 post-verification-check skills。
- 将这些 skills 视为 workflow gates 的唯一来源。不要在本文档或 custom agents 中重复或削弱它们。
- writing agent 必须持有已批准的 spec 和 plan，除非改动纯粹是机械性的，且适用 skill 明确允许跳过。
- 只有 main agent 可以宣布任务最终完成。

## 强制代码规则

- 所有 design、implementation 和 review 工作必须遵循 [docs/standards/code-rules.md](docs/standards/code-rules.md)。

## Delegation 策略

- 仅当 custom agent 的窄职责能实质提升证据质量、速度或 review 质量时，才进行委派。
- 使用 Codex `context_explorer` 或 Cursor `context-explorer` 获取仓库路径和 execution-flow 证据。
- 使用 Codex `source_verifier` 或 Cursor `source-verifier` 核对外部 API 的 semantics、units、precision、status 和文档行为。
- 使用 Codex `test_designer` 或 Cursor `test-designer` 在 plan 批准后创建 risk matrix 和预期会失败的 tests。
- 仅在预期 tests 已按预定原因失败后，才使用 Codex `implementer` 或 Cursor `implementer`。
- 使用 Codex `risk_reviewer` 或 Cursor `risk-reviewer` 对受影响路径和 money/safety invariants 做 defect-first review。
- 使用 Codex `verifier` 或 Cursor `verifier` 做命令与产物一致性检查。
- read-only agents 可以并行运行。同一时间绝不允许超过一个 agent 修改 source 或 tests。
- custom agents 不得再派生子 agents。

## Cursor 兼容性

`.cursor/agents/*.md` agents 是对应 Codex agents 的原生等价物。Cursor 中的 read-only 行为是 agent 约束，不是 Codex sandbox 保证。main agent 根据当前平台能力动态选择 model 和 reasoning effort。

## 动态 model routing

每次委派前，必须分类并写明：

1. Complexity：ordinary 或 high。
2. Money/security risk：none、indirect 或 direct。
3. 选定的 model 和 reasoning effort。
4. 一句基于证据的说明，解释该选择。

Risk 优先于 complexity：

- ordinary complexity 且无 money/security 影响：`gpt-5.6-terra`，reasoning effort 为 `high`。
- high complexity 或 indirect money/security 影响：`gpt-5.6`，reasoning effort 为 `high`。
- direct money、security、permission 或不可逆外部副作用：`gpt-5.6`，reasoning effort 为 `xhigh`。
- 未知 risk 视为 direct risk。
- 绝不选择 `medium` 或 `low`。
- 若 `xhigh` 不可用，必须披露该限制并改用 `high`；不得静默降级。

direct risk 包括 order submission 或 recovery、client order IDs、duplicate-submit prevention、strategy state、quantity 或 price precision、rounding、units、fills、SQLite transaction ordering、account settings、leverage、credentials、permissions，以及 exchange 或 CCXT semantics。

## Delegation packet

每个被委派的任务必须提供：

```text
Goal: user goal and verifiable completion criteria
Scope: allowed paths and forbidden paths
ApprovedArtifacts: approved spec and plan
Risk: complexity, money/security level, selected model, reasoning effort, and rationale
RelevantFiles: key files, symbols, and established facts
Constraints: code style, minimal-change rule, workflow gates, and safety limits
Tests: permitted and required verification commands
DoNot: no commits, pushes, unrelated edits, real credentials/accounts/exchanges, or further delegation
Return: evidence or change summary, file list, command results, unexecuted checks, and uncertainties
```

read-only 调查若目的是为 design 收集证据，可以省略 approved artifacts。writing agents 在缺少 approved artifacts 时必须停止。

## 交易安全边界

- 绝不读取、打印、复制或推断真实 credentials。
- 绝不使用仓库中的真实 `.env`。
- 绝不调用任何真实 exchange API，包括 public market-data endpoints。
- 绝不 submit 或 cancel orders、更改 account mode 或 leverage，或使用真实业务 SQLite database。
- tests 和 process checks 必须使用 fake gateways、临时或 in-memory SQLite、临时 environment values，以及发生在 exchange access 之前的 failure conditions。
- 可以访问公开官方文档，但 documentation lookup 不得变成 exchange API probe。
- 任何可能越过该边界的命令必须立即停止。不要要求 child agent 放宽该边界。

## 结果处理

- 分析和 review 结论必须提供 file 和 symbol 证据。
- verification 主张必须给出精确 commands、exit status 和关键输出。
- 失败或不完整的 agent 可以收窄 scope 后重试一次。
- 若重试仍然失败，必须报告缺失证据及其影响；不得静默跳过该阶段。
- 用可执行行为、可复现 tests 和权威来源解决 agent 分歧，而不是按票数决定。
- child 结果只是本地证据。conflict resolution、rework、verification gates 和最终结论由 main agent 负责。

## 文档职责与实现依据

- `docs/superpowers/` 保存历史决策、当前 design 和未来 design。代码实现的目标行为、范围、边界和验收标准，只能来自本任务适用且已经确认的 spec 和 implementation plan。
- `docs/superpowers/` 中的文件不因位于该目录就自动生效。开始实现前必须确定本任务适用的 spec/plan；若适用范围、确认状态或文档间关系不明确，必须停止实现并先完成范围裁决。
- 需求发生变化时，可以修改相关 spec 和 plan；修改时必须明确新决策、适用范围以及被替代或失效的旧结论。
