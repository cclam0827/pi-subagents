# pi-subagents

A Pi extension for delegated agents with isolated context, long-lived RPC sessions, provider-neutral model levels, and a Claude Code-style panel below the prompt.

**This is an independent Pi package, not a Pi core modification.** The orchestration runner works in TUI, print, JSON, and RPC sessions; the interactive panel is a TUI adapter.

## Features

- **Built-in roles, zero agent setup**: `explore`, `implement`, and `verify` ship inside the package.
- **Four model levels**: `fast`, `balanced`, `deep`, and `max`, with `auto` as the default.
- **Long-lived child sessions**: each agent runs as a separate `pi --mode rpc` process and accepts follow-ups after becoming idle.
- **Orchestrator-controlled retention**: release idle processes or archive finished agents without deleting their reports or transcripts; retain only the agents likely to be reused.
- **Nested delegation**: subagents can spawn subagents, subject to run-wide depth, fan-out, count, and concurrency limits.
- **Interactive agent panel**: move from the prompt into agent rows, open transcripts, steer agents, and stop subtrees.
- **Shared run state**: descendants route messages and cancellation through their direct process owner.
- **Writer isolation**: one checkout has at most one writer; parallel implementation agents receive separate git worktrees.
- **Persistent transcripts**: closing Pi stops the process tree but preserves run metadata and Pi session files for later resume.
- **User and trusted-project overrides**: add roles without forking or copying the built-in definitions.

## Requirements

- Pi with extension and RPC support
- Node.js 22.19 or newer
- Git when worktree isolation is required

## Install

### From Git

```bash
pi install git:github.com/<your-name>/pi-subagents@v1
```

Replace the repository and ref with the release you intend to install. Git checkouts are managed by Pi and may be reset during package updates, so the extension never writes user state into its package directory.

### From a local checkout

From the directory containing this repository:

```bash
pi install ./pi-subagents
```

For development without installing:

```bash
pi --no-extensions -e ./src/index.ts
```

`--no-extensions` is useful for isolating this extension during development. It is not required for normal use.

## Quick start

Ask the main agent naturally:

```text
Use an explore agent to find the authentication flow, then implement the fix.
Use two independent agents to investigate the failing tests and review the API changes.
```

The orchestrator can use one tool with eight actions:

```text
subagent { action: "spawn", role: "explore", task: "Find the authentication flow" }
subagent { action: "wait", agentId: "agent-..." }
subagent { action: "message", agentId: "agent-...", message: "Focus on token refresh" }
subagent { action: "stop", agentId: "agent-..." }
subagent { action: "release", agentId: "agent-..." }
subagent { action: "archive", agentId: "agent-..." }
subagent { action: "retain", agentId: "agent-..." }
subagent { action: "list", includeArchived: false }
```

`spawn` is asynchronous by default. A completion notification reaches the direct parent when the agent settles. Use `wait: true` or the `wait` action only when the parent cannot make useful progress without the result.

After collecting a result, use `release` when the idle process is no longer needed, `archive` when the agent should also leave the default panel and list, or `retain` to mark it as reusable. Release and archive preserve reports, run metadata, and Pi session transcripts. A later message or resume makes an archived or released agent reusable again.

## Agent panel

The panel is docked below the prompt in interactive mode.

| Key | Behavior |
| --- | --- |
| `↓` in the prompt | Enter the agent panel when the cursor is on the last editor line and autocomplete is closed |
| `↑` / `↓` in the panel | Select an agent |
| `Enter` | Open the selected agent transcript |
| `x` | Stop the selected agent and its descendants; active writers require confirmation |
| `Esc` | Return from panel to prompt; in a transcript, clear the message or go back |
| `↑` / `↓`, `PageUp` / `PageDown` in a transcript | Scroll messages |
| `Enter` in the transcript input | Send a steering message while running or a new prompt while idle |

Opening a transcript only changes which process you are viewing. Other agents continue running.

The docked panel shows active agents and completed agents marked reusable. Released, stopped, failed, and archived agents move to history. `/agents list` shows all unarchived records; `/agents all` includes archived records. Archiving changes visibility and process retention, not transcript retention.

Use `/agents` for the full agent list. Additional commands:

```text
/agents stop <agent-id>
/agents release <agent-id>
/agents archive <agent-id>
/agents retain <agent-id>
/agents resume <agent-id> [message]
/agents all
/agents new <role-name>
/agents doctor
```

`/agents new` creates a user-level YAML scaffold without overwriting an existing file.

## Built-in roles

| Role | Capabilities | Default isolation |
| --- | --- | --- |
| `explore` | Read-only research using `read`, `grep`, `find`, and `ls`; no arbitrary bash access | Shared checkout |
| `implement` | Research, editing, bash, and nested delegation | Shared for one writer; worktree for parallel writers |
| `verify` | Read, search, explicit test execution, and nested delegation | Shared checkout; no source editing tools |

Role tool lists are **caps**, not permission grants. The effective tools are the intersection of the role, user policy, project policy, and depth limit. Project overlays cannot add tools to an existing role or weaken its isolation. In particular, a project cannot turn the built-in `explore` role into a writer.

## Model selection

Subagents default to `model: "auto"`. Role definitions describe capabilities, not provider-specific model families.

`auto` performs two separate steps:

1. The orchestrator selects a routing level for the dispatch, defaulting to `balanced` when there is no strong signal.
2. The resolver maps that level to an available, authenticated `provider/model-id`.

The selected model remains fixed for that agent process. A follow-up uses the same session and model; resuming a stopped agent starts a new process while retaining its logical agent ID and transcript.

### The four levels

| Level | Intended work | Default thinking | Rough Claude analogy |
| --- | --- | --- | --- |
| `fast` | Targeted lookups, simple summaries, mechanical work | `low` | **Haiku** — fast and efficient |
| `balanced` | Everyday implementation, analysis, and review | `medium` | **Sonnet** — general coding work |
| `deep` | Complex reasoning, cross-module changes, high-risk work | `high` | **Opus** — complex agentic coding |
| `max` | The hardest debugging, design, and long-horizon tasks | `max` | **Fable** — maximum capability and long-running work |

These are routing intents, not claims that models from different providers are equivalent.

The package currently includes these Anthropic candidates:

```text
fast      anthropic/claude-haiku-5-5
balanced  anthropic/claude-sonnet-5-5
deep      anthropic/claude-opus-5-5
max       anthropic/claude-fable-5-1
```

A model that is absent from Pi's available, authenticated registry is skipped. If no candidate is available, the resolver explicitly reports that it is inheriting the parent model. Exact model references never silently fall back. Automatic `max` dispatch requires confirmation unless the user explicitly selected that level or model.

### Overrides

A role or spawn request can use:

```text
"auto"                  Select a level and resolve its model
"fast"                  Force the fast level
"balanced"              Force the balanced level
"deep"                  Force the deep level
"max"                   Force the max level
"provider/model-id"     Use an exact model
```

Resolution precedence:

```text
Per-invocation model or level
> Role model
> User/project defaultModel
> auto
```

The `level` parameter is independent and can force a level while leaving `model: auto`.

## Configuration

Built-in definitions stay inside the Git package. User and project files are overlays, so package updates never overwrite custom configuration.

```text
Git package
└─ agents/                         Built-in roles and future updates

~/.pi/agent/pi-subagents/
├─ config.json                     Personal model and execution policy
├─ agents/*.yaml                   Personal roles and overlays
├─ state/                          Shared run metadata
└─ worktrees/                      Isolated implementation checkouts

<repository>/.pi/pi-subagents/
├─ config.json                     Trusted-project policy
└─ agents/*.yaml                   Trusted-project roles and overlays
```

Pi's `PI_CODING_AGENT_DIR` setting is respected; `~/.pi/agent` is only the default.

### Example `config.json`

```json
{
  "schemaVersion": 1,
  "defaultModel": "auto",
  "agentScope": "user",
  "childExtensions": [],
  "confirmMax": true,
  "allowedTools": ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent"],
  "limits": {
    "maxDepth": 2,
    "maxChildrenPerAgent": 3,
    "maxAgentsPerRun": 8,
    "maxConcurrent": 4
  },
  "levels": {
    "fast": {
      "thinking": "low",
      "candidates": ["anthropic/claude-haiku-5-5", "openai/your-fast-model"]
    },
    "balanced": {
      "thinking": "medium",
      "candidates": ["anthropic/claude-sonnet-5-5", "openai/your-balanced-model"]
    },
    "deep": {
      "thinking": "high",
      "candidates": ["anthropic/claude-opus-5-5", "openai/your-deep-model"]
    },
    "max": {
      "thinking": "max",
      "candidates": ["anthropic/claude-fable-5-1", "openai/your-max-model"]
    }
  }
}
```

Use exact IDs from `pi --list-models` or `/model`; do not assume the placeholder provider models above exist in your installation.

`agentScope` controls role discovery:

- `user`: built-in plus user agents; the default.
- `project`: built-in plus trusted-project agents.
- `both`: built-in, user, and trusted-project agents, in that precedence order.

Project resources are ignored when the project is not trusted. Project limits can only reduce user limits, project tool policy can only narrow access, and project model overrides require confirmation.

### Child provider extensions

Children start with a controlled extension set: this extension plus any entries in `childExtensions`. Built-in Pi providers continue to work normally, but a custom provider extension may need to be listed explicitly:

```json
{
  "childExtensions": ["npm:your-pi-provider-package"]
}
```

This prevents unrelated UI extensions from being loaded into every RPC child while still supporting custom authentication and model catalogs.

## Agent definitions

Create a user agent with `/agents new security-review`, or write YAML directly:

```yaml
schemaVersion: 1
name: security-review
description: Review authentication and authorization changes for security regressions.
model: auto
isolation: shared
tools: [read, grep, find, ls]
instructions: |
  You are a security review subagent.
  Inspect only the delegated changes and return concrete findings with file references.

  Finish with Summary, Findings, Files changed, Tests, and Risks sections.
```

To override only a built-in role's model, leave every other field out:

```yaml
# ~/.pi/agent/pi-subagents/agents/explore.yaml
name: explore
model: fast
```

Unspecified fields inherit the lower layer. Arrays and instructions are replaced rather than implicitly concatenated, except that project tool overlays are narrowed to the lower-layer tool cap. Set `enabled: false` in a user overlay to disable a role; a project cannot re-enable it.

Configuration is rediscovered for new spawns. A running or idle agent retains the role, tools, instructions, and model snapshot recorded at launch.

## Delegation and resource limits

Depth is counted as follows:

```text
Depth 0: Main orchestrator
Depth 1: Subagent
Depth 2: Sub-subagent; cannot spawn another agent
```

Defaults:

```text
maxDepth:             2
maxChildrenPerAgent:  3
maxAgentsPerRun:      8 subagents, excluding the main agent
maxConcurrent:        4 across the entire process tree
```

These limits are stored in a lock-protected run file shared by parent and child processes. A child cannot bypass them by maintaining its own local count. Token and cost totals remain visible through Pi session statistics; a hard token/cost ceiling is not imposed by default.

## Filesystem behavior

- Read-only exploration can share the current checkout.
- A single implementation writer can use the current working directory.
- A second active writer in the same git checkout is placed in a new worktree based on `HEAD`.
- Existing changes are never discarded. An automatically created worktree is removed only when it is clean and still points at its original commit.
- The main agent remains responsible for integration and final verification.

Process isolation is **not** a security sandbox. Agents with bash access retain the operating-system permissions granted to that process. Use tool caps, protected credentials, containers, or a VM when stronger isolation is required.

## Results, failure, and resume

Agents are instructed to return:

```text
Summary
Findings
Files changed
Tests
Risks
```

The parent receives a structured summary capped at 50 KB; the complete transcript remains in the child session. Results flow to the direct parent, which decides whether to retry, change level, or delegate differently. The runner does not blindly retry failed work.

Closing Pi stops the live process tree rather than leaving orphan workers. Run metadata and Pi session files remain available. `/agents resume <id>` starts a new RPC process for the same logical agent, restores its saved session when available, and delivers a new instruction.

New agents default to `reusable`. `release` stops the selected terminal subtree's idle processes and marks its records `released`; `archive` does the same but also hides the records from default lists. Neither operation deletes reports, transcripts, or run-budget history. `retain` marks one record reusable without starting a process; the next message resumes it if necessary. Active subtrees must be stopped before release or archive.

Retention cleanup is routed through each agent's direct process owner, including deeper nested descendants. A pending transition blocks new work on that subtree. If a cleanup is interrupted, restarting the root Pi session removes stale retention commands, stops leftover transition processes, and clears the pending marker so cleanup can be retried safely.

## Architecture

```text
Main Pi session
  └─ subagent tool / agent panel
       └─ SubagentManager
            ├─ Config + role overlays
            ├─ Four-level model resolver
            ├─ Lock-protected shared run store
            ├─ RPC process owners
            └─ Workspace manager
                 └─ git worktrees for parallel writers

Each child is a long-lived `pi --mode rpc` process.
Messages for descendants travel through their direct process owner.
The TUI observes the same manager used by the model-facing tool.
```

## Development

```bash
npm ci
npm run check
```

Or run the checks separately:

```bash
npm run typecheck
npm test
```

Tests cover role/config precedence, project capability caps, model resolution and fallback, structured reports, shared depth/count/concurrency limits, writer conflicts, command routing, nested-owner retention/resume, release/archive visibility, and the RPC adapter with a fake Pi process. An offline end-to-end test also starts a real Pi child against a local fake OpenAI-compatible endpoint, then verifies idle follow-up and resume through a replacement manager without using external API quota.

## Current limitations

- The panel is available only in interactive TUI mode; headless sessions use the same tool and structured results without the panel.
- Agents do not continue as detached workers after the parent Pi process exits.
- Direct edits made by the user or main agent cannot be locked against every child writer; partition work and let the main agent integrate after workers finish.
- Custom provider packages must be listed in `childExtensions` when children need them.
- Worktree-based tasks start from `HEAD`, not another checkout's uncommitted changes.

## Security

Extensions execute with your system permissions. Install only sources you trust. Project agent definitions are prompts that can direct tool use, so they load only after project trust and the configured scope allows them. API credentials remain managed by Pi and are never written into role YAML or run metadata.

## License

MIT
