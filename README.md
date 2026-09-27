# agentp: Agent Pipeline Orchestrator

Describe a pipeline of AI agents once, then run it, watch it, and pay only what you expect.
Everything happens in the terminal.

- **Agents are Markdown files**: instructions plus front-matter settings (provider, model, tools).
- **Pipelines are YAML**: steps, loops with an exit condition and a hard limit, and human approval gates.
- **Runs survive anything**: every change is an event in SQLite, so a run can wait days at a gate or crash mid-step and resume where it stopped.
- **Every token is accounted for**: tokens, cache reads, cost and time per model call, with budget caps enforced *before* each call.
- **Prompts are built for cache reuse**: stable parts first, so later steps and loop rounds read earlier steps' cached prefix, and the savings are reported per step.
- **Code changes stay isolated**: each run works in its own git worktree and branch.

See [docs/PRD.md](docs/PRD.md) for the product requirements and [docs/SAD.md](docs/SAD.md) for the architecture.

## Install

Requires Node.js 22.13 or newer.

```sh
npm install
npm run build
npm link          # puts `agentp` on your PATH
```

Store an API key in the OS keychain (or set `OPENAI_API_KEY`):

```sh
agentp keys set openai
```

## Quick start

```sh
cd your-repo
agentp validate path/to/examples/pipelines/build-feature.yaml
agentp run path/to/examples/pipelines/build-feature.yaml --input "Add a --verbose flag to the CLI"
```

The run creates a worktree at `.agentp/worktrees/<run>` on branch `agentp/<run>`, plans, codes, then loops
validator → fixer until the validator passes (at most 5 rounds), and stops at the review gate:

```
build-feature  run 7f3a2c   $1.84 / $5.00   612k tokens (cache hit 71%)   waiting
  ✔ plan          gpt-5-mini     $0.21   12s
  ✔ code          gpt-5-mini     $0.93   48s
  ✔ validate-fix  2 rounds
      ✔ validate      gpt-5-mini $0.18   9s   PASS
      – fix           gpt-5-mini          not needed this round
  ⏸ review        waiting for a decision

[a]pprove  [r]eject  [e]dit  [s]end back  [v]iew full  [d]etach >
```

## Pipelines

```yaml
name: build-feature
budget: { max_cost_usd: 5, max_tokens: 2_000_000 }   # optional; also max_cost_usd_per_day
shared_context: [docs/PROJECT.md]                    # sent first in every prompt: cached once, reused
retries: 2                                           # per step, default 2
max_input_chars: 60000                               # larger inputs are truncated + referenced

steps:
  - id: plan
    agent: agents/planner.md
    inputs: [run.input]           # run.input, any earlier output, file:<path>, notebook, loop.history
    output: plan
    task: Write the plan.         # optional; default asks for the named output

  - loop:
      id: validate-fix
      max_iterations: 5           # required
      until: validate.verdict == "pass"
      on_exhausted: gate          # gate (default) or fail
      steps:
        - id: validate
          agent: agents/validator.md
          inputs: [plan, patch]
          output: findings
        - id: fix
          agent: agents/fixer.md
          inputs: [plan, patch, findings, loop.history]
          output: patch

  - gate:
      id: review
      show: [plan, patch, findings]
      timeout: 24h                # optional
      on_timeout: wait            # approve | reject | wait
```

Paths resolve relative to the pipeline file, then to the current directory.

## Agents

```markdown
---
provider: openai            # openai | cursor (experimental)
model: gpt-5-mini
temperature: 0              # optional
output_schema: verdict      # optional: `verdict` ({verdict: pass|fail, findings: [...]}) or a JSON schema file
cache: shared               # shared (default) | isolated: no shared prefix, for independent reviewers
tools: [read_file, write_file, list_files, run_command, notebook]
max_output_tokens: 8192
max_turns: 25               # tool-use turns per step
---
You are a strict validator. ...
```

Loop exit conditions test fields of structured output, never free text, so the step named in `until:`
must declare `output_schema`.

## Commands

| Command | What it does |
|---|---|
| `agentp validate <pipeline>` | Check a pipeline and its agents; show cache-sharing and budget warnings |
| `agentp run <pipeline> -i "…" [--detach] [--repo dir \| --no-repo]` | Start a run (foreground with a live view, or in the background) |
| `agentp ls` | Runs: status, current step, cost so far |
| `agentp attach <run>` | Live view; drives the run here if no other process is |
| `agentp pause \| resume \| cancel <run>` | Pause after the current step, continue, or stop now |
| `agentp gates` | Gates waiting for a decision |
| `agentp approve <run> [--budget usd]` | Approve and continue (`--budget` sets a new cap at a budget gate) |
| `agentp reject <run>` | Reject; ends the run |
| `agentp edit <run> [--output name] [--file f]` | Replace an output shown at the gate (opens `$EDITOR`), then continue |
| `agentp sendback <run> --to <step>` | Re-enter the pipeline at an earlier step |
| `agentp logs <run> [--step id] [--full]` | Context given to each step, calls, tool use, outputs, decisions |
| `agentp cost [<run>] [--by step\|model\|day\|pipeline\|run]` | Tokens, cache reads, cost and cache savings |
| `agentp diagram <pipeline \| run> [--costs] [--out file.md]` | Mermaid flowchart of the design, or of what a run actually did |
| `agentp diff <run> [--from step] [--to step]` | Code changes the run made, between any two steps |
| `agentp keys set \| delete <provider>` | Manage API keys in the OS keychain |

Most commands take `--json`. Global options: `--home <dir>` (data directory; default: nearest `.agentp/`,
or `./.agentp`) and `--prices <file>`.

## Budgets and prices

Costs come from a versioned price table: `--prices`, `$AGENTP_PRICES`, `<home>/prices.yaml`, or the bundled
[prices.yaml](prices.yaml). The bundled prices are examples: **check them against your provider's current
pricing.** Each usage record keeps the price version it was calculated with.

Before every model call the Budget Guard checks that the input fits in what is left and lowers the call's
output limit so the output fits too. If nothing fits, the run pauses at a `budget` gate. A global daily cap
goes in `<home>/config.yaml`:

```yaml
budget:
  max_cost_usd_per_day: 20
```

`agentp run` refuses a budget it cannot enforce: a cost cap with a model missing from the price table, or a
provider that does not report usage (Cursor, for now) unless you pass `--allow-unmetered`.

## Status

v1 covers everything in the PRD except:

- **Cursor adapter is experimental.** It drives the `cursor-agent` CLI (override with `AGENTP_CURSOR_BIN`);
  what usage data Cursor reports is still to be verified (PRD open question 3), so its cost shows "not reported".
- **Oversized inputs** are truncated with a file reference, not summarised by a model.
- **Notifications** are desktop only (`notify-send` / `osascript`); Slack and email are later plugins.
- Out of scope for v1, per the PRD: parallel steps, multiple users, any web UI, hosting.

## Development

```sh
npm test            # vitest: engine, budgets, context/caching, loader, OpenAI adapter and CLI end to end
npm run typecheck
npm run dev -- ls   # run the CLI from source
```

The end-to-end tests run the real OpenAI adapter and CLI against a local fake of the streaming Chat
Completions API (`test/fake-openai.ts`), so no API key or network is needed.
