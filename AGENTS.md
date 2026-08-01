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
