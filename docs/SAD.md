# SAD — Agent Pipeline Orchestrator

Software Architecture Document. Companion to [PRD.md](./PRD.md).

## 1. Goals That Shape the Architecture

1. **Runs survive anything.** A run may wait days at a gate or crash mid-step; it must resume exactly where it stopped.
2. **Every token is accounted for.** Usage and cost are recorded per model call, not estimated afterwards.
3. **Pipelines are plain files.** They can be versioned, diffed and reviewed in git.
4. **Providers are swappable.** Cursor and OpenAI in v1; adding one more should mean one new adapter.
5. **Local first.** Single user, one machine, no server to operate.

## 2. System Overview

```
 ┌──────────────┐     ┌──────────────┐
 │  Web UI      │     │  CLI         │
 └──────┬───────┘     └──────┬───────┘
        └──────── HTTP / WS ─┘
                   │
 ┌─────────────────▼──────────────────────────────────────┐
 │                   Orchestrator (local)                 │
 │                                                        │
 │  Pipeline Loader ──► Run Engine ◄──► Gate Service      │
 │                        │    ▲                          │
 │                        ▼    │                          │
 │            Context Builder  │  Budget Guard            │
 │                        │    │       ▲                  │
 │                        ▼    │       │                  │
 │                   Step Runner ──► Usage Meter          │
 │                        │                               │
 │              ┌─────────┴─────────┐                     │
 │              ▼                   ▼                     │
 │       OpenAI Adapter      Cursor Adapter               │
 └──────────────┬───────────────────┬─────────────────────┘
                ▼                   ▼
            OpenAI API          Cursor API/CLI

        Storage: SQLite (runs, events, usage) + files (.md, artifacts)
```

## 3. Components

| Component | Responsibility |
|---|---|
| **Pipeline Loader** | Reads pipeline YAML and agent `.md` files, validates them, and compiles them into a graph of steps, loops and gates. Rejects invalid pipelines before any tokens are spent. |
| **Run Engine** | The core state machine. Decides the next node, runs it, records the result, and handles loops, gates, retries, pause, resume and cancel. |
| **Step Runner** | Runs one agent call: assembles the request, calls the adapter, streams the output, and parses the verdict. |
| **Context Builder** | Collects a step's declared inputs and orders them so the prompt starts with parts that stay the same across steps and so hits the provider's prompt cache (§6). |
| **Provider Adapters** | Translate a generic request into OpenAI or Cursor calls. Return output and **normalised usage**. |
| **Usage Meter** | Converts raw usage into tokens, cache reads/writes and cost using a versioned price table. |
| **Budget Guard** | Checks limits before and after every call. Pauses or stops the run when a cap is hit. |
| **Gate Service** | Stores pending approvals, sends notifications, applies timeouts, and feeds decisions back into the engine. |
| **API + UI** | Local HTTP API with WebSocket live updates. The Web UI shows the pipeline graph, live runs, logs, gates and costs; the CLI covers the same actions. |

## 4. Pipeline Model

A pipeline compiles into a small graph with four node types: **step**, **loop**, **gate**, **end**.

```yaml
# pipelines/build-feature.yaml
name: build-feature
budget: { max_cost_usd: 5, max_tokens: 2_000_000 }
shared_context: [docs/PROJECT.md]          # cached prefix for every step

steps:
  - id: plan
    agent: agents/planner.md
    inputs: [run.input]
    output: plan

  - id: code
    agent: agents/coder.md
    inputs: [plan]
    output: patch

  - loop:
      id: validate-fix
      max_iterations: 5
      until: validate.verdict == "pass"
      steps:
        - id: validate
          agent: agents/validator.md
          inputs: [patch]
          output: findings          # must return {verdict, findings}
        - id: fix
          agent: agents/fixer.md
          inputs: [patch, findings, loop.history]
          output: patch

  - gate:
      id: review
      show: [plan, patch, findings]
      timeout: 24h
      on_timeout: wait
```

Agent file = Markdown instructions + front-matter settings:

```markdown
---
provider: openai
model: <model-id>
temperature: 0
output_schema: verdict        # optional structured output
cache: shared                 # shared | isolated
---
You are a strict validator. ...
```

**Decisions**
- Validators return **structured output** (`{verdict: pass|fail, findings: [...]}`). Loop exit conditions test fields, never free text.
- Loops always have `max_iterations`. On hitting it the run goes to a gate by default rather than failing silently.
- Outputs are named, and a later step may reference any earlier output, not only the previous step's.

## 5. Run Execution

**Event-sourced runs.** Every change is an append-only event in SQLite:

```
RunStarted → StepStarted → ModelCalled → UsageRecorded → StepCompleted
          → LoopIteration → GateOpened → GateDecided → ... → RunFinished
```

Run state is rebuilt by replaying events. This gives:
- **Resume after a crash**: replay, find the last incomplete step, re-run only that step.
- **Long waits at gates**: nothing is held in memory; a gate is just an open event.
- **A full audit trail**: the run log in the UI is the event stream.

**Step states:** `pending → running → succeeded | failed | skipped`, where `failed` leads to a retry (with backoff, up to N times) or stops the run.

**Concurrency:** one active step per run (no parallel steps in v1); several runs may execute at once.

**Workspace:** each run gets its own **git worktree**. Code-editing agents work in it; steps pass references (commit SHA, file paths) instead of pasting whole files. A gate can show the diff between any two steps.

## 6. Context & Caching

**Context assembly order** (most stable first):

```
1. Agent instructions (.md)           ─┐
2. Pipeline shared_context files       │  stable prefix → cacheable
3. Earlier outputs, oldest first      ─┘
4. Loop history / latest findings     ─┐  changes every call
5. The step's specific task            ─┘
```

- Keeping this order fixed means step N+1 usually starts with the same text step N already sent, so the provider's prompt cache serves it.
- The **Cache Planner** (part of Context Builder) warns at load time when steps that could share a prefix use different providers or models, because caches don't carry across them.
- `cache: isolated` agents get a fresh context with none of the shared prefix. Use this for independent reviewers.
- **Oversized context** is replaced by a stored summary or a file reference. The substitution is logged so it's visible.
- **Run notebook**: a key/value store per run that any agent can read and append to through a tool call. Its contents go in the non-cached tail.

Cache effect is **measured, not assumed**: the Usage Meter records cached tokens per call as reported by the provider and attributes savings to the step that first wrote the prefix.

## 7. Providers

```ts
interface ProviderAdapter {
  id: "openai" | "cursor";
  run(req: AgentRequest, onChunk: (c: Chunk) => void): Promise<AgentResult>;
  capabilities(): { structuredOutput: boolean; promptCache: "auto" | "explicit" | "none"; reportsCacheWrites: boolean };
}

type Usage = {
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number | null;   // null = provider doesn't report it
  providerCostUsd: number | null;                             // when the provider reports cost directly
};
```

- **OpenAI**: direct API. Prompt caching is automatic when prompts start with the same text; usage reports cached input tokens.
- **Cursor**: accessed through its agent API or CLI. Exactly which usage and cache fields it exposes is still **to be verified** (PRD Q3). The adapter reports `null` for anything it can't observe, and the UI shows "not reported" rather than a guess.
- API keys are stored in the OS keychain and never written to run logs.

## 8. Cost & Budgets

- **Price table**: a versioned file (`prices.yaml`) with prices per model for input, output, cache-read and cache-write tokens. Each usage record stores the price version it was calculated with, so old runs keep their original cost after prices change.
- If the provider reports cost directly, that figure wins over the calculated one.
- **Budget Guard** checks:
  - *before* a call: estimated cost of this call + spent so far ≤ cap, otherwise pause at an automatic gate
  - *after* a call: actual cost is recorded, and the run stops if the hard cap is exceeded
- Caps can be set per run, per pipeline per day, and globally per day.

## 9. Gates & Notifications

- A gate writes `GateOpened` with a snapshot of what to show, then the engine parks the run.
- Decisions: **approve**, **reject** (end the run), **edit & continue** (the edited output replaces the step output and is logged as a human edit), **send back to step X** (re-enter the graph there).
- Notifications go through a small interface: in-app in v1, with Slack and email as later plugins.
- Timeouts are checked by a scheduler inside the orchestrator. They survive restarts because the deadline is stored in the event.

## 10. Data Model (SQLite)

```
pipelines(id, name, path, content_hash, created_at)
runs(id, pipeline_id, pipeline_hash, status, input, workspace_path, started_at, ended_at)
events(id, run_id, seq, type, payload_json, at)            -- source of truth
steps(run_id, step_id, iteration, status, output_ref, ...)  -- projection for fast reads
usage(id, run_id, step_id, iteration, provider, model,
      input, output, cache_read, cache_write, cost_usd, price_version, at)
gates(id, run_id, step_id, status, deadline, decision, decided_at)
```

Large outputs (patches, long text) are stored as files under `runs/<run-id>/` and referenced from the tables.

A run records the pipeline's content hash, so editing a pipeline never changes the meaning of past runs.

## 11. Tech Choices (proposed)

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript (Node) | One language for engine, API and UI; good SDKs for both providers. |
| Storage | SQLite | Zero setup, transactional, enough for single-user local use. |
| API | HTTP + WebSocket | Live step streaming to the UI. |
| UI | React, served locally | Graph view, logs, gates, cost charts. |
| Config | YAML + Markdown | Readable, diffable, lives in git. |

## 12. Risks

| Risk | Mitigation |
|---|---|
| Cursor exposes little usage or cache data | Adapter reports what it can; the UI marks gaps; OpenAI remains the reference provider for exact accounting. |
| Runaway loops burn budget | `max_iterations` is required, Budget Guard checks before every call, and a gate opens by default when the limit is hit. |
| Cache savings lower than expected | Measure per step, show hit rate, and have the Cache Planner warn at load time. |
| Prices change | Versioned price table; each usage record keeps the price version it used. |
| Long-waiting runs go stale (e.g. repo moved on) | A gate shows how far the run's worktree is behind its base branch; "send back to step X" allows re-running. |

## 13. Answers to PRD Open Questions (proposed)

| PRD Q | Proposal |
|---|---|
| 1. Validator pass/fail | Structured output `{verdict, findings}`; optionally a script's exit code as an extra check. |
| 2. Shared workspace or text | A git worktree per run, with steps passing references to it. |
| 3. Cursor integration | Adapter behind a common interface; exact API or CLI to be decided after a spike. |
| 4. Editing at gates | Output only in v1. Agent `.md` edits apply to the next run. |
| 5. Run history storage | SQLite events + files for large outputs. |
| 6. Cache control | Shape prompts for reuse (fixed order) **and** report actual hits. |
