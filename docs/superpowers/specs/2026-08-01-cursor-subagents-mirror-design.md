# Cursor 子代理最小镜像设计

## 背景与目标

项目已有由 `AGENTS.md`、`.codex/config.toml` 和六个 `.codex/agents/*.toml` 组成的 Codex 子代理体系。本变更增加 Cursor 原生等价镜像，使两个平台共享角色职责、流程门禁、单写入者规则、动态模型路由原则和交易安全边界，同时保持 `.codex` 原样。

本设计已由用户逐段确认，并获准在 spec 与 plan 写完后直接执行；这是 autopilot 授权，不再增加批准门禁。

## 最小方案

只小改 `AGENTS.md`，并新增六个文件：

- `.cursor/agents/context-explorer.md` 镜像 `context_explorer`；
- `.cursor/agents/source-verifier.md` 镜像 `source_verifier`；
- `.cursor/agents/test-designer.md` 镜像 `test_designer`；
- `.cursor/agents/implementer.md` 镜像 `implementer`；
- `.cursor/agents/risk-reviewer.md` 镜像 `risk_reviewer`；
- `.cursor/agents/verifier.md` 镜像 `verifier`。

Cursor 使用连字符名称，Codex 保留下划线名称。每个 Cursor agent 使用仅含 `name`、`description` 的 YAML frontmatter，正文为 Markdown system prompt；不添加未经支持的 `model`、`reasoning_effort` 或 `sandbox_mode` frontmatter。

`AGENTS.md` 继续作为共享入口：标题改为 Codex/Cursor 共享标题；六条角色调用规则同时注明两个平台的名称；增加简短 Cursor compatibility 段。其余规则语义不变。

## 角色语义与平台差异

Cursor 镜像保留对应 Codex 角色的职责、禁止事项、证据返回要求和交易安全边界。`context-explorer`、`source-verifier`、`risk-reviewer` 的只读性由 system prompt 和主代理调度约束表达，不冒充 Codex `sandbox_mode = "read-only"` 的强制沙箱。`test-designer`、`implementer`、`verifier` 继续遵守批准产物、单写入者和各自写入边界。

模型与推理强度仍由 `AGENTS.md` 动态路由，不在 Cursor agent 文件中固定。Cursor agent 不继续委派、不独立宣称整体完成，也不绕过现有技能门禁。

## 范围外

- 不修改 `.codex/config.toml` 或 `.codex/agents/*.toml`。
- 不大规模重构或复制 `AGENTS.md` 的现有规则。
- 不引入依赖、业务代码、测试代码、hook、MCP 或新编排层。
- 不提交、不推送，不访问真实 `.env`、凭证、交易所或业务数据库。

## 验证与完成标准

1. `AGENTS.md` 和六个 `.cursor/agents/*.md` 均存在，名称映射完整且唯一。
2. 每个 Cursor agent 只有受支持的 frontmatter 字段，正文非空，并保留对应职责和安全边界。
3. `AGENTS.md` 只增加共享标题、名称映射和 Cursor compatibility 说明。
4. `.codex` 无 diff。
5. `git diff --check` 无空白错误，最终 diff 不含范围外文件。

Cursor 是否在特定 IDE 版本中展示六个 agent 属于人工验证，不以静态检查冒充。
