# Cursor Subagents Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有六个 Codex 子代理新增 Cursor 原生等价镜像，并以最小改动让 `AGENTS.md` 成为两个平台的共享入口。

**Architecture:** 保留 `.codex` 原样，把六个 Codex 角色的职责和安全约束转换为六个固定的 `.cursor/agents/*.md` 文件。Cursor 文件只使用 `name`、`description` YAML frontmatter 与 Markdown system prompt；共享策略继续集中在 `AGENTS.md`。

**Tech Stack:** Markdown、YAML frontmatter、Python 3 标准库、Git 只读检查

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-08-01-cursor-subagents-mirror-design.md`。
- 用户已授权本计划写完后 autopilot 执行，无需增加批准门禁。
- 只修改 `AGENTS.md`，只新增六个 `.cursor/agents/*.md`；不得修改 `.codex` 或其他文件。
- 固定映射：`context_explorer` → `context-explorer`、`source_verifier` → `source-verifier`、`test_designer` → `test-designer`、`implementer` → `implementer`、`risk_reviewer` → `risk-reviewer`、`verifier` → `verifier`。
- Cursor agent frontmatter 只允许 `name`、`description`；不得加入 `model`、`reasoning_effort`、`sandbox_mode`。
- Cursor 只读角色以行为约束表达，不宣称拥有 Codex 等价强制沙箱。
- 保留现有工作流门禁、动态模型路由、单写入者规则、交易安全边界和主代理最终结论责任。
- 这是配置与说明文件工作，不构造业务 TDD 红灯；使用静态格式、映射、diff 和一致性验证。
- 不提交、不推送，不读取真实 `.env`，不访问交易所或业务数据库。

---

### Task 1: 建立共享入口与六角色 Cursor 镜像

**Files:**
- Modify: `AGENTS.md:1-20`
- Create: `.cursor/agents/context-explorer.md`
- Create: `.cursor/agents/source-verifier.md`
- Create: `.cursor/agents/test-designer.md`
- Create: `.cursor/agents/implementer.md`
- Create: `.cursor/agents/risk-reviewer.md`
- Create: `.cursor/agents/verifier.md`

**Interfaces:**
- Consumes: `AGENTS.md` 的共享策略和对应 `.codex/agents/*.toml` 的角色语义。
- Produces: Cursor 可发现的六个连字符角色名，以及 Codex/Cursor 明确名称映射。

- [x] **Step 1: 修改共享入口**

将 `AGENTS.md` 标题改为 `# Trade Ops Codex and Cursor Instructions`。在 `Delegation policy` 的六条角色调用说明中同时写出 Codex 下划线名与 Cursor 连字符名；紧接该节增加 `## Cursor compatibility`，明确 `.cursor/agents/*.md` 是原生等价镜像、Cursor 只读由行为约束而非 Codex 沙箱保证、模型与推理强度仍由主代理动态选择。不得改动其他规则语义。

- [x] **Step 2: 创建六个 Cursor agent 文件**

逐个读取对应 `.codex/agents/*.toml`，创建映射后的 Markdown 文件。每个文件必须以以下已确定格式开头，`name` 使用该文件的固定连字符名称，`description` 使用对应 Codex 描述的等价文本：

```yaml
---
name: context-explorer
description: Read-only trade-ops codebase explorer that maps affected paths, execution flow, state transitions, tests, and repository constraints.
---
```

其余五个文件采用同一字段结构并替换为各自固定名称和对应描述。正文把对应 `developer_instructions` 转为清晰的 Markdown system prompt，完整保留职责、禁止事项、证据返回要求和交易安全边界。三个只读角色明确“保持只读，不修改文件”，但不声称 Cursor 提供强制 sandbox；`test-designer` 只写测试及 fixture，`implementer` 只做批准范围内的最小实现，`verifier` 不编辑源码、测试、文档或配置。六个角色均不得继续委派或独立宣称整体完成。

- [x] **Step 3: 检查 Task 1 范围**

Run: `git status --short && git diff -- AGENTS.md .cursor/agents`

Expected: 仅显示 `AGENTS.md` 与六个 `.cursor/agents/*.md` 的预期实现改动；`.codex` 不在 diff 中。

---

### Task 2: 静态格式、映射与一致性验证

**Files:**
- Verify: `AGENTS.md`
- Verify: `.cursor/agents/context-explorer.md`
- Verify: `.cursor/agents/source-verifier.md`
- Verify: `.cursor/agents/test-designer.md`
- Verify: `.cursor/agents/implementer.md`
- Verify: `.cursor/agents/risk-reviewer.md`
- Verify: `.cursor/agents/verifier.md`
- Verify unchanged: `.codex/config.toml`
- Verify unchanged: `.codex/agents/*.toml`

**Interfaces:**
- Consumes: Task 1 的七个目标文件和本计划的固定映射。
- Produces: 文件存在、frontmatter、名称映射、范围和空白一致性的可复现证据。

- [x] **Step 1: 运行七文件与 frontmatter 检查**

Run:

```bash
python3 - <<'PY'
from pathlib import Path

mapping = {
    "context_explorer": "context-explorer",
    "source_verifier": "source-verifier",
    "test_designer": "test-designer",
    "implementer": "implementer",
    "risk_reviewer": "risk-reviewer",
    "verifier": "verifier",
}
root = Path(".cursor/agents")
expected = {f"{name}.md" for name in mapping.values()}
assert {p.name for p in root.glob("*.md")} == expected
for name in mapping.values():
    text = (root / f"{name}.md").read_text()
    assert text.startswith("---\n")
    frontmatter, body = text[4:].split("\n---\n", 1)
    fields = dict(line.split(":", 1) for line in frontmatter.splitlines())
    fields = {key.strip(): value.strip() for key, value in fields.items()}
    assert set(fields) == {"name", "description"}
    assert fields["name"] == name and fields["description"] and body.strip()
    assert "real exchange api" in body.lower()
shared = Path("AGENTS.md").read_text()
assert shared.startswith("# Trade Ops Codex and Cursor Instructions\n")
assert "## Cursor compatibility" in shared
for codex, cursor in mapping.items():
    assert codex in shared and cursor in shared
print("seven target files and Cursor mappings are valid")
PY
```

Expected: exit code 0，并输出 `seven target files and Cursor mappings are valid`。

- [x] **Step 2: 确认 Codex 配置未被修改**

Run: `git diff --exit-code -- .codex`

Expected: exit code 0 且无输出。

- [x] **Step 3: 检查空白与最终范围**

Run:

```bash
git diff --check
git status --short
git diff -- AGENTS.md .cursor/agents
git diff --exit-code -- .codex
```

Expected: `git diff --check` 和 `.codex` 检查均为 exit code 0；状态与 diff 除已批准 spec、plan 外，只包含 `AGENTS.md` 和六个 `.cursor/agents/*.md`；不执行 commit。

## Manual Verification

- [ ] 在当前 Cursor IDE 中确认六个项目级 agent 均以连字符名称出现。若当前版本或界面不提供可核查入口，记录为未执行，不以静态检查替代。
  - 状态：未执行，因为当前自动化工具没有 Cursor 项目级自定义 agent 发现/展示入口；根据 spec 不用静态检查冒充。
