# Configuration and role examples

These files are starting points, not automatically loaded configuration. Copy only the pieces you need, then adjust model IDs to those shown by `pi --list-models` or `/model` in your installation.

**Do not put API keys in these files.** Authentication remains managed by Pi.

## Choose a model configuration

| File | Use it when | Provider extension needed by children |
| --- | --- | --- |
| `config.anthropic.json` | You use Anthropic through Pi's built-in provider | No |
| `config.openai-codex.json` | You use OpenAI Codex through Pi's built-in provider | No |
| `config.ccr.json` | You route models through Claude Code Router | Yes, already included in the file |
| `config.mixed-providers.json` | You want ordered fallback across Anthropic and OpenAI Codex | No |
| `config.project.json` | A trusted repository needs narrower tools and smaller limits | No |

The first four files are complete user-level examples. Install one as:

```bash
mkdir -p ~/.pi/agent/pi-subagents
cp -n examples/config.anthropic.json ~/.pi/agent/pi-subagents/config.json
```

`cp -n` avoids overwriting an existing config. If the destination already exists, merge the fields you need instead of replacing your current policy.

To use another preset, replace the source path, for example:

```bash
cp -n examples/config.mixed-providers.json ~/.pi/agent/pi-subagents/config.json
```

The model IDs are examples, not a promise that every provider or account exposes them. Replace unavailable IDs with exact `provider/model-id` values from your registry. Candidates are checked in order, so put your preferred available provider first.

### Anthropic

`config.anthropic.json` maps the four levels directly to the Claude families:

```text
fast       claude-haiku-5-5
balanced   claude-sonnet-5-5
deep       claude-opus-5-5
max        claude-fable-5-1
```

It also includes the default depth, fan-out, count, concurrency, and max-confirmation policy.

### OpenAI Codex

`config.openai-codex.json` demonstrates that levels are not tied to Anthropic names:

```text
fast       gpt-5.6-terra
balanced   gpt-5.6-luna
deep       gpt-5.6-sol
max        gpt-5.6-sol with max thinking
```

The `max` level can reuse the `deep` model with a different thinking level; a level is a routing policy, not necessarily a distinct model family.

### CCR

`config.ccr.json` includes both model mappings and the provider extension required in child processes:

```json
{
  "childExtensions": ["git:github.com/cclam0827/pi-ccr-provider"]
}
```

Edit every `ccr/CPA/...` ID to match your CCR catalog. If your CCR route uses another alias or provider prefix, use that exact string. CCR credentials continue to come from the environment or your existing provider setup.

### Mixed providers

`config.mixed-providers.json` tries Anthropic first and OpenAI Codex second for every level. Reverse the candidate order if you prefer Codex first. An unavailable candidate is skipped; an exact `provider/model-id` selected explicitly never falls back silently.

### Trusted project policy

`config.project.json` is intentionally smaller than a user config. It removes editing tools and reduces the run to:

```text
maxDepth:             1
maxChildrenPerAgent:  2
maxAgentsPerRun:      4
maxConcurrent:        2
```

First enable project discovery in your **user-level** config:

```json
{
  "agentScope": "both"
}
```

Then copy the project example into a trusted repository:

```bash
mkdir -p .pi/pi-subagents
cp -n examples/config.project.json .pi/pi-subagents/config.json
```

Project limits can only reduce user limits. A project cannot use this file to increase depth, concurrency, or tool access.

## Role examples

| File | Role name | Model | Filesystem behavior |
| --- | --- | --- | --- |
| `agents/explore.fast.yaml` | `explore` override | `fast` | Inherits the built-in read-only role |
| `agents/implement.deep.yaml` | `implement` override | `deep` | Inherits automatic writer isolation |
| `agents/security-review.yaml` | `security-review` | `deep` | Read-only security review |
| `agents/test-engineer.yaml` | `test-engineer` | `balanced` | Writes tests; worktree on writer conflict |
| `agents/refactor-worker.yaml` | `refactor-worker` | `deep` | Always uses a separate worktree |
| `agents/migration-reviewer.yaml` | `migration-reviewer` | `deep` | Read-only migration and backfill review |
| `agents/dependency-auditor.yaml` | `dependency-auditor` | `fast` | Static manifest and lockfile inspection |
| `agents/performance-verifier.yaml` | `performance-verifier` | `balanced` | Benchmarks and diagnostics without source edits |

Copy one or more custom roles into your user agents directory:

```bash
mkdir -p ~/.pi/agent/pi-subagents/agents
cp -n examples/agents/security-review.yaml ~/.pi/agent/pi-subagents/agents/
cp -n examples/agents/test-engineer.yaml ~/.pi/agent/pi-subagents/agents/
```

For project-local roles in a trusted repository:

```bash
mkdir -p .pi/pi-subagents/agents
cp -n examples/agents/migration-reviewer.yaml .pi/pi-subagents/agents/
```

Remember that project discovery requires `agentScope: "both"` or `"project"` in your user config.

### Built-in overrides

`explore.fast.yaml` and `implement.deep.yaml` deliberately contain only the fields being changed. Everything else continues to inherit package updates.

Copy them using the built-in role filename:

```bash
cp -n examples/agents/explore.fast.yaml ~/.pi/agent/pi-subagents/agents/explore.yaml
cp -n examples/agents/implement.deep.yaml ~/.pi/agent/pi-subagents/agents/implement.yaml
```

Do not copy both as additional custom roles unless you actually want to replace the built-in behavior.

## Recipes

### Low-cost codebase research

Use `config.anthropic.json` or your preferred provider config, then install the `explore.fast.yaml` override. Ask:

```text
Use explore to map the token refresh flow and return file references.
```

### Independent security and test passes

Install `security-review.yaml` and `test-engineer.yaml`, then ask:

```text
Have security-review inspect the authentication changes read-only.
In parallel, have test-engineer add regression tests in its own checkout.
Integrate and run the final checks yourself.
```

The reviewer cannot edit files. The test engineer can write tests and is moved to a worktree if another writer is active.

### Large behavior-preserving refactor

Install `refactor-worker.yaml`, which always uses a worktree and defaults to `deep`. Ask:

```text
Use refactor-worker to rename the session repository interface across all call sites.
Preserve behavior and run typecheck plus relevant tests.
```

The worktree starts from `HEAD`; the main agent must review and integrate the result.

### Migration review in a shared repository

Install `config.project.json` and `migration-reviewer.yaml` under `.pi/pi-subagents/`, then trust the repository and enable project discovery. The project policy removes `edit` and `write`, so even its bash-capable reviewer cannot receive source-editing tools.

### Exact model for one role

Edit the role after copying it:

```yaml
name: security-review
model: ccr/CPA/your-exact-model-id
```

Other fields remain unchanged. An exact model must exist in the child's available registry. For CCR, keep the `childExtensions` entry from `config.ccr.json`.

## Verify the setup

Run in Pi:

```text
/agents doctor
```

Check that:

- each expected role appears with the intended `builtin`, `user`, or `project` source;
- the selected level and candidates are correct;
- custom provider packages appear in `childExtensions`;
- project limits are no larger than user limits;
- no role unexpectedly receives `edit` or `write`.

Configuration applies to new spawns. Existing agents keep the role, tool, instruction, and model snapshot recorded at launch.
