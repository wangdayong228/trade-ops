# Codex Task Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `trade-ops` 增加六个项目级 Codex 子代理，并由主代理根据复杂度和资金/安全风险动态选择 `gpt-5.6-terra + high`、`gpt-5.6 + high` 或 `gpt-5.6 + xhigh`。

**Architecture:** `AGENTS.md` 是主代理编排和安全策略的唯一项目入口，`.codex/config.toml` 提供保守的默认模型与并发上限，`.codex/agents/*.toml` 分别定义六个窄职责角色。角色文件不固定模型或推理级别，使主代理能在每次 spawn 时动态升级；调查和审查可并行，源码或测试写入始终串行。

**Tech Stack:** Codex CLI 0.145.0、Markdown、TOML、Python 3 `tomllib`（仅用于配置验证）

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-08-01-codex-task-subagents-design.md`。
- 默认子代理模型必须是 `gpt-5.6-terra`，默认推理级别必须是 `high`。
- 任何角色都不得使用 `medium` 或 `low`。
- 高复杂度或间接涉及资金/安全时使用 `gpt-5.6 + high`。
- 直接涉及资金、安全、权限或不可逆副作用时使用 `gpt-5.6 + xhigh`。
- 如果 `xhigh` 不可用，只能明确披露后降级到 `high`，不得静默降级。
- 六个 agent 文件不得固定 `model` 或 `model_reasoning_effort`。
- 任何时刻最多一个子代理修改源码或测试。
- 禁止真实 `.env`、真实凭证、真实业务 SQLite、任何真实交易所 API 和真实订单。
- 公开官方文档可以访问；Bitget、OKX 等真实交易所 API（包括公共市场数据）不得访问。
- 子代理不得继续委派，不得提交、推送或改写 Git 历史。
- 现有 brainstorming、writing-plans、TDD、systematic-debugging 和完成验证技能仍是流程的唯一来源。
- 计划中的 Git checkpoint 只检查 diff；用户未明确要求前不得创建 commit。

---

### Task 1: 主代理编排策略与默认配置

**Files:**
- Create: `AGENTS.md`
- Create: `.codex/config.toml`

**Interfaces:**
- Consumes: 已批准的设计 spec；Codex 项目级 `AGENTS.md` 与 `[agents]` 配置加载机制。
- Produces: 六个角色共同依赖的任务路由、安全边界、委派上下文契约和默认模型配置。

- [x] **Step 1: 运行基线检查，确认项目配置尚不存在**

Run:

```bash
python3 - <<'PY'
from pathlib import Path

expected_missing = [
    Path("AGENTS.md"),
    Path(".codex/config.toml"),
]
present = [str(path) for path in expected_missing if path.exists()]
assert not present, f"expected files to be absent before Task 1: {present}"
print("baseline confirmed: project Codex orchestration files are absent")
PY
```

Expected: PASS，并输出 `baseline confirmed: project Codex orchestration files are absent`。

- [x] **Step 2: 创建项目级默认配置**

Create `.codex/config.toml`:

```toml
[agents]
enabled = true
max_concurrent_threads_per_session = 4
default_subagent_model = "gpt-5.6-terra"
default_subagent_reasoning_effort = "high"
```

- [x] **Step 3: 创建主代理编排规则**

Create `AGENTS.md`:

````markdown
# Trade Ops Codex Instructions

## Existing workflow gates

- Follow the applicable existing brainstorming, writing-plans, test-driven-development, systematic-debugging, pre-verification-check, verification-before-completion, consistency-check, and post-verification-check skills.
- Treat those skills as the only source of workflow gates. Do not duplicate or weaken them here or in custom agents.
- A writing agent requires an approved spec and plan unless the change is purely mechanical and an applicable skill explicitly permits skipping them.
- Only the main agent may communicate final task completion.

## Delegation policy

- Delegate only when a custom agent's narrow responsibility materially improves evidence, speed, or review quality.
- Use `context_explorer` for repository paths and execution-flow evidence.
- Use `source_verifier` for external API semantics, units, precision, status, and documented behavior.
- Use `test_designer` to create the risk matrix and expected failing tests after plan approval.
- Use `implementer` only after the expected tests fail for the intended reason.
- Use `risk_reviewer` for defect-first review of affected paths and money/safety invariants.
- Use `verifier` for commands and artifact consistency checks.
- Read-only agents may run in parallel. Never allow more than one agent to modify source or tests at a time.
- Custom agents must not spawn additional agents.

## Dynamic model routing

Before every delegation, classify and state:

1. Complexity: ordinary or high.
2. Money/security risk: none, indirect, or direct.
3. Selected model and reasoning effort.
4. One evidence-based sentence explaining the selection.

Risk overrides complexity:

- Ordinary complexity with no money/security impact: `gpt-5.6-terra` with `high`.
- High complexity or indirect money/security impact: `gpt-5.6` with `high`.
- Direct money, security, permission, or irreversible external side effects: `gpt-5.6` with `xhigh`.
- Unknown risk is direct risk.
- Never select `medium` or `low`.
- If `xhigh` is unavailable, disclose the limitation and use `high`; never downgrade silently.

Direct risk includes order submission or recovery, client order IDs, duplicate-submit prevention, strategy state, quantity or price precision, rounding, units, fills, SQLite transaction ordering, account settings, leverage, credentials, permissions, and exchange or CCXT semantics.

## Delegation packet

Every delegated task must provide:

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

Read-only investigation may omit approved artifacts when the purpose is to gather evidence for a design. Writing agents must stop when approved artifacts are missing.

## Trading safety boundary

- Never read, print, copy, or infer real credentials.
- Never use the repository's real `.env`.
- Never call any real exchange API, including public market-data endpoints.
- Never submit or cancel orders, change account mode or leverage, or use a real business SQLite database.
- Tests and process checks must use fake gateways, temporary or in-memory SQLite, temporary environment values, and failure conditions that occur before exchange access.
- Public official documentation may be accessed, but documentation lookup must not become an exchange API probe.
- Stop any command that could cross this boundary. Do not ask a child agent to relax it.

## Result handling

- Require file and symbol evidence for analysis and review findings.
- Require exact commands, exit status, and material output for verification claims.
- A failed or incomplete agent may be retried once with narrower scope.
- If the retry still fails, report the missing evidence and its impact; do not silently skip the stage.
- Resolve agent disagreement using executable behavior, reproducible tests, and authoritative sources rather than vote count.
- Child results are local evidence. The main agent owns conflict resolution, rework, verification gates, and the final conclusion.
````

- [x] **Step 4: 验证 TOML 语法和默认值**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import tomllib

config_path = Path(".codex/config.toml")
with config_path.open("rb") as handle:
    config = tomllib.load(handle)

agents = config["agents"]
assert agents == {
    "enabled": True,
    "max_concurrent_threads_per_session": 4,
    "default_subagent_model": "gpt-5.6-terra",
    "default_subagent_reasoning_effort": "high",
}

instructions = Path("AGENTS.md").read_text()
for required in (
    "gpt-5.6-terra",
    "gpt-5.6",
    "xhigh",
    "Never select `medium` or `low`",
    "Never call any real exchange API",
    "Never allow more than one agent to modify source or tests at a time",
):
    assert required in instructions, required

print("project orchestration configuration is valid")
PY
```

Expected: PASS，并输出 `project orchestration configuration is valid`。

- [x] **Step 5: 让当前 Codex 严格解析项目配置**

Run:

```bash
codex exec --ephemeral --ignore-user-config --strict-config -C "$PWD" -s read-only \
  "Return exactly config-ok. Do not use tools."
```

Expected: exit code 0，最终输出 `config-ok`，且不出现项目配置的 unknown/invalid field 错误。`--ignore-user-config` 用于避免用户全局配置中的旧字段干扰项目配置验证。

- [x] **Step 6: 检查 Task 1 diff，不创建 commit**

Run:

```bash
for file in AGENTS.md .codex/config.toml; do
  git diff --no-index -- /dev/null "$file"
  diff_status=$?
  test "$diff_status" -le 1 || exit "$diff_status"
done
```

Expected: diff 仅包含主代理规则与默认配置；不执行 `git commit`。

---

### Task 2: 只读调查与外部语义核实角色

**Files:**
- Create: `.codex/agents/context-explorer.toml`
- Create: `.codex/agents/source-verifier.toml`

**Interfaces:**
- Consumes: `AGENTS.md` 的动态模型路由、委派包和交易安全边界。
- Produces: 供设计、计划和后续写入角色使用的仓库证据与外部语义证据；不修改项目文件。

- [x] **Step 1: 运行预期失败的角色完整性检查**

Run:

```bash
python3 - <<'PY'
from pathlib import Path

required = [
    Path(".codex/agents/context-explorer.toml"),
    Path(".codex/agents/source-verifier.toml"),
]
missing = [str(path) for path in required if not path.exists()]
assert not missing, f"missing read-only agents: {missing}"
PY
```

Expected: FAIL，错误包含两个缺失的 agent 文件。

- [x] **Step 2: 创建代码路径调查角色**

Create `.codex/agents/context-explorer.toml`:

```toml
name = "context_explorer"
description = "Read-only trade-ops codebase explorer that maps affected paths, execution flow, state transitions, tests, and repository constraints."
sandbox_mode = "read-only"
developer_instructions = """
Stay read-only and evidence-first.
Map the requested behavior through entry points, call chains, state transitions, persistence, and tests.
Return exact file paths, symbols, and concise evidence. Distinguish established behavior from uncertainty.
Do not edit files, run destructive commands, propose speculative fixes, claim task completion, or spawn another agent.
Never read real credentials, use the repository's real .env, call any real exchange API, or access a real business database.
Follow the parent packet exactly and stop when the requested scope is ambiguous.
"""
```

- [x] **Step 3: 创建外部语义核实角色**

Create `.codex/agents/source-verifier.toml`:

```toml
name = "source_verifier"
description = "Read-only verifier for CCXT, Bitget, OKX, and other external API semantics, units, precision, statuses, and failure behavior."
sandbox_mode = "read-only"
developer_instructions = """
Verify external semantics from authoritative public documentation, dependency source, and repository evidence.
For every material conclusion, return the source, applicable version when known, exact units or normalization, and unresolved ambiguity.
Do not infer behavior from field names or comments alone.
Do not edit files, claim overall completion, or spawn another agent.
Never read real credentials or call any real exchange API, including public market-data and account endpoints.
If authoritative sources remain ambiguous, state the ambiguity and the blocking safety consequence instead of guessing.
"""
```

- [x] **Step 4: 验证只读角色 schema、权限和动态模型能力**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import tomllib

expected = {
    "context-explorer.toml": "context_explorer",
    "source-verifier.toml": "source_verifier",
}

for filename, name in expected.items():
    path = Path(".codex/agents") / filename
    with path.open("rb") as handle:
        agent = tomllib.load(handle)
    assert agent["name"] == name
    assert agent["description"].strip()
    assert agent["developer_instructions"].strip()
    assert agent["sandbox_mode"] == "read-only"
    assert "model" not in agent
    assert "model_reasoning_effort" not in agent

print("read-only agents are valid and model-unpinned")
PY
```

Expected: PASS，并输出 `read-only agents are valid and model-unpinned`。

- [x] **Step 5: 检查 Task 2 diff，不创建 commit**

Run:

```bash
for file in .codex/agents/context-explorer.toml .codex/agents/source-verifier.toml; do
  git diff --no-index -- /dev/null "$file"
  diff_status=$?
  test "$diff_status" -le 1 || exit "$diff_status"
done
```

Expected: 只有两个只读角色；均无 `model`、`model_reasoning_effort` 或写权限。

---

### Task 3: 测试设计与实现角色

**Files:**
- Create: `.codex/agents/test-designer.toml`
- Create: `.codex/agents/implementer.toml`

**Interfaces:**
- Consumes: 批准的 spec、plan、主代理风险分类、`context_explorer` 和 `source_verifier` 的证据。
- Produces: `test_designer` 先形成风险矩阵和预期失败测试；`implementer` 随后完成满足测试的最小实现。两者不得并行写入。

- [x] **Step 1: 运行预期失败的写入角色完整性检查**

Run:

```bash
python3 - <<'PY'
from pathlib import Path

required = [
    Path(".codex/agents/test-designer.toml"),
    Path(".codex/agents/implementer.toml"),
]
missing = [str(path) for path in required if not path.exists()]
assert not missing, f"missing writing agents: {missing}"
PY
```

Expected: FAIL，错误包含两个缺失的 agent 文件。

- [x] **Step 2: 创建测试设计角色**

Create `.codex/agents/test-designer.toml`:

```toml
name = "test_designer"
description = "High-stakes test designer that turns an approved trade-ops spec and risk surface into realistic failing tests before implementation."
sandbox_mode = "workspace-write"
developer_instructions = """
Require an approved spec and plan before writing.
State the risk surface first, then build a test matrix covering units, precision, boundaries, heterogeneous cases, missing data, failure safety, and irreversible side effects as applicable.
Write only tests and test fixtures. Run focused tests and confirm they fail for the intended reason before returning red evidence.
Do not modify production implementation, weaken existing assertions, expand scope, commit, push, claim completion, or spawn another agent.
Use only fake gateways, temporary or in-memory SQLite, and synthetic credentials.
Never read a real .env, call a real exchange API, or use a real business database.
Return the matrix, changed test files, exact commands and results, uncovered risks, and uncertainties.
"""
```

- [x] **Step 3: 创建实现角色**

Create `.codex/agents/implementer.toml`:

```toml
name = "implementer"
description = "Scoped trade-ops implementation agent that makes the smallest complete change after approved design, plan, and expected failing tests."
sandbox_mode = "workspace-write"
developer_instructions = """
Require an approved spec, approved plan, and evidence that the relevant tests fail for the intended reason.
Implement only the assigned plan task and preserve existing architecture, types, error semantics, idempotency, and failure safety.
Make the smallest complete change. Do not weaken tests to fit the implementation.
Do not edit unrelated files, introduce unapproved dependencies or abstractions, commit, push, rewrite Git history, claim overall completion, or spawn another agent.
Never read a real .env, use real credentials, call a real exchange API, start production configuration, or access a real business database.
Return changed files, implementation rationale, exact commands and results, and remaining uncertainty.
"""
```

- [x] **Step 4: 验证写入角色 schema、边界和动态模型能力**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import tomllib

expected_markers = {
    "test-designer.toml": (
        "test_designer",
        "Write only tests and test fixtures",
        "fail for the intended reason",
    ),
    "implementer.toml": (
        "implementer",
        "smallest complete change",
        "Do not weaken tests",
    ),
}

for filename, (name, first_marker, second_marker) in expected_markers.items():
    path = Path(".codex/agents") / filename
    with path.open("rb") as handle:
        agent = tomllib.load(handle)
    assert agent["name"] == name
    assert agent["description"].strip()
    assert agent["sandbox_mode"] == "workspace-write"
    assert first_marker in agent["developer_instructions"]
    assert second_marker in agent["developer_instructions"]
    assert "model" not in agent
    assert "model_reasoning_effort" not in agent

print("writing agents are valid, bounded, and model-unpinned")
PY
```

Expected: PASS，并输出 `writing agents are valid, bounded, and model-unpinned`。

- [x] **Step 5: 检查 Task 3 diff，不创建 commit**

Run:

```bash
for file in .codex/agents/test-designer.toml .codex/agents/implementer.toml; do
  git diff --no-index -- /dev/null "$file"
  diff_status=$?
  test "$diff_status" -le 1 || exit "$diff_status"
done
```

Expected: 测试角色只允许写测试，实现角色只允许执行批准任务；两个文件均禁止真实交易与继续委派。

---

### Task 4: 风险审查、验证角色与完整加载验证

**Files:**
- Create: `.codex/agents/risk-reviewer.toml`
- Create: `.codex/agents/verifier.toml`
- Verify: `AGENTS.md`
- Verify: `.codex/config.toml`
- Verify: `.codex/agents/*.toml`

**Interfaces:**
- Consumes: 完成的任务 diff、批准的 spec/plan、测试结果和受影响路径证据。
- Produces: 缺陷优先的独立风险审查、精确命令验证、配置加载证据和最终人工验证清单。

- [x] **Step 1: 运行预期失败的完成阶段角色检查**

Run:

```bash
python3 - <<'PY'
from pathlib import Path

required = [
    Path(".codex/agents/risk-reviewer.toml"),
    Path(".codex/agents/verifier.toml"),
]
missing = [str(path) for path in required if not path.exists()]
assert not missing, f"missing completion-stage agents: {missing}"
PY
```

Expected: FAIL，错误包含两个缺失的 agent 文件。

- [x] **Step 2: 创建资金安全审查角色**

Create `.codex/agents/risk-reviewer.toml`:

```toml
name = "risk_reviewer"
description = "Read-only defect-first reviewer for money safety, idempotency, recovery topology, precision, transactions, permissions, and missing tests."
sandbox_mode = "read-only"
developer_instructions = """
Review the assigned diff and all affected execution paths like an owner of a money-sensitive system.
Prioritize concrete correctness defects, duplicate external effects, recovery and state-machine errors, transaction-ordering bugs, unit or precision mistakes, permission exposure, failure-safety regressions, and missing high-risk tests.
Trace beyond the direct diff when correctness depends on callers, persistence, gateways, or monitors.
Lead with findings ordered by severity. Include file and symbol evidence, triggering conditions, impact, and a focused remediation direction.
Do not report style-only preferences, edit files, guess without evidence, claim overall completion, or spawn another agent.
Never read real credentials, use a real .env, call a real exchange API, or access a real business database.
If no actionable finding exists, state that explicitly and list residual risks or unverified assumptions.
"""
```

- [x] **Step 3: 创建命令与产物一致性验证角色**

Create `.codex/agents/verifier.toml`:

```toml
name = "verifier"
description = "Evidence-only verifier that runs approved checks and cross-checks trade-ops specs, plans, code, tests, documentation, and configuration."
sandbox_mode = "workspace-write"
developer_instructions = """
Run only the verification commands authorized by the parent packet.
Record every command, exit status, material output, skipped check, and reason.
Cross-check the approved spec and plan against code, tests, README, examples, and configuration.
Workspace write access exists only for build, test, and temporary verification artifacts. Do not edit source, tests, documentation, or configuration.
Do not repair failures, commit, push, claim overall completion, or spawn another agent.
Use only fake gateways, temporary or in-memory SQLite, synthetic credentials, temporary environment values, and safe pre-exchange failure conditions.
Never read the real .env, call a real exchange API, start production configuration, or access a real business database.
A successful command proves only that command's scope.
"""
```

- [x] **Step 4: 运行六角色完整 schema 和安全约束检查**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
import tomllib

agents_dir = Path(".codex/agents")
expected = {
    "context-explorer.toml": ("context_explorer", "read-only"),
    "source-verifier.toml": ("source_verifier", "read-only"),
    "test-designer.toml": ("test_designer", "workspace-write"),
    "implementer.toml": ("implementer", "workspace-write"),
    "risk-reviewer.toml": ("risk_reviewer", "read-only"),
    "verifier.toml": ("verifier", "workspace-write"),
}

actual = {path.name for path in agents_dir.glob("*.toml")}
assert actual == set(expected), (actual, set(expected))

for filename, (name, sandbox) in expected.items():
    with (agents_dir / filename).open("rb") as handle:
        agent = tomllib.load(handle)
    assert set(("name", "description", "developer_instructions")) <= set(agent)
    assert agent["name"] == name
    assert agent["sandbox_mode"] == sandbox
    assert "model" not in agent
    assert "model_reasoning_effort" not in agent
    instructions = agent["developer_instructions"]
    assert "spawn another agent" in instructions
    assert "real exchange API" in instructions

with Path(".codex/config.toml").open("rb") as handle:
    config = tomllib.load(handle)
assert config["agents"]["enabled"] is True
assert config["agents"]["max_concurrent_threads_per_session"] == 4
assert config["agents"]["default_subagent_model"] == "gpt-5.6-terra"
assert config["agents"]["default_subagent_reasoning_effort"] == "high"

all_text = "\n".join(
    [Path("AGENTS.md").read_text(), Path(".codex/config.toml").read_text()]
    + [path.read_text() for path in sorted(agents_dir.glob("*.toml"))]
)
assert "model_reasoning_effort = \"medium\"" not in all_text
assert "model_reasoning_effort = \"low\"" not in all_text

print("all six custom agents and project defaults are valid")
PY
```

Expected: PASS，并输出 `all six custom agents and project defaults are valid`。

- [x] **Step 5: 运行 Codex 严格配置与安装诊断**

Run:

```bash
codex exec --ephemeral --ignore-user-config --strict-config -C "$PWD" -s read-only \
  "Return exactly config-ok. Do not use tools."
codex doctor --summary --no-color
```

Expected:

- 严格配置会话 exit code 0，最终输出 `config-ok`，且无项目未知配置字段；
- `doctor` 能识别当前 Codex 安装并给出汇总；
- 认证、网络或账户级告警单独记录，不得误报为项目 TOML 语法失败。

- [x] **Step 6: 用只读临时会话验证 AGENTS.md 和角色发现**

Run:

```bash
codex exec --ephemeral --ignore-user-config --strict-config -C "$PWD" -s read-only \
  "Do not edit files or call external services. Read the active project instructions and custom-agent configuration. Return only: (1) the six custom agent names, (2) the default subagent model and reasoning effort, (3) the three model-routing tiers, and (4) the single-writer rule."
```

Expected:

- 返回六个名称：`context_explorer`、`source_verifier`、`test_designer`、`implementer`、`risk_reviewer`、`verifier`；
- 默认值为 `gpt-5.6-terra + high`；
- 路由层级包含 `gpt-5.6-terra + high`、`gpt-5.6 + high`、`gpt-5.6 + xhigh`；
- 明确源码或测试最多一个写入者；
- 无文件修改。

- [x] **Step 7: 验证三类代表性路由决策**

Run:

```bash
codex exec --ephemeral --ignore-user-config --strict-config -C "$PWD" -s read-only \
  "Do not edit files, spawn agents, or call external services. Apply the project routing policy to these three hypothetical tasks: (A) locate where README startup instructions live; (B) refactor a complex internal parser that has no money or security impact; (C) change order quantity rounding and recovery behavior. Return each task's complexity, money/security risk, model, reasoning effort, and one-sentence rationale."
```

Expected:

- A：`gpt-5.6-terra + high`；
- B：`gpt-5.6 + high`；
- C：`gpt-5.6 + xhigh`；
- 不出现 `medium` 或 `low`；
- 无文件修改。

- [x] **Step 8: 检查完整 diff 和工作区状态，不创建 commit**

Run:

```bash
files=(
  AGENTS.md
  .codex/config.toml
  .codex/agents/context-explorer.toml
  .codex/agents/source-verifier.toml
  .codex/agents/test-designer.toml
  .codex/agents/implementer.toml
  .codex/agents/risk-reviewer.toml
  .codex/agents/verifier.toml
  docs/superpowers/specs/2026-08-01-codex-task-subagents-design.md
  docs/superpowers/plans/2026-08-01-codex-task-subagents.md
)

for file in $files; do
  git diff --no-index --check -- /dev/null "$file"
  diff_status=$?
  test "$diff_status" -le 1 || exit "$diff_status"
done

git status --short

for file in $files; do
  git diff --no-index -- /dev/null "$file"
  diff_status=$?
  test "$diff_status" -le 1 || exit "$diff_status"
done
```

Expected:

- 所有 `git diff --no-index --check` 调用只返回“存在差异”的状态 1，不报告空白错误；
- 工作区只包含本功能的 spec、plan、`AGENTS.md` 和 `.codex/` 配置；
- 不包含凭证、`.env`、业务代码或测试改动；
- 不执行 `git commit`。

## Manual Verification

- [x] 在 Codex CLI 或 IDE 的子代理界面确认六个角色均可被选择或由主代理发现。
- [x] 发起一个只读路径探索任务，确认默认使用 `gpt-5.6-terra + high` 和 `context_explorer`。
- [x] 发起一个不执行真实命令的资金关键假设任务，确认主代理选择 `gpt-5.6 + xhigh` 和 `risk_reviewer`。
- [x] 如果当前账户不支持 `xhigh`，确认主代理明确披露并只降到 `high`，不使用 `medium` 或 `low`。（当前账户支持 `xhigh`，无需降级。）
- [ ] 确认只读角色界面显示只读 sandbox，写入角色不会被并行调度修改源码或测试。
