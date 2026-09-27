# PRD — Agent Pipeline Orchestrator

## 1. Problem

Running several AI agents in sequence (plan → build → validate → fix) is manual today: copy prompts, paste outputs, restart when something fails, guess what it cost. There's no repeatable way to define the flow, no place for a human to step in, and no visibility into spend.

## 2. Idea

A tool where you **describe a pipeline of agents once**, then **run it, watch it, and pay only for what you expect**.

- Each agent is defined by a Markdown file (its instructions).
- Agents are wired into a flow: steps, loops, and human approval gates.
- Agents pass context to each other and reuse cached prompts written by earlier agents.
- Every run is tracked: tokens, cache, cost, time, outcome.
- Agents run through **Cursor** or **OpenAI** using your own API key.

## 3. Users

- **Builder** — a developer who designs pipelines and tunes agent prompts.
- **Approver** — a person who reviews output at gates and says go / no-go (often the same person).

## 4. Core Concepts

| Concept | What it is |
|---|---|
| **Agent** | A `.md` file with instructions + settings (provider, model, allowed tools). |
| **Step** | One run of an agent inside a pipeline. Gets input, produces output. |
| **Pipeline** | An ordered set of steps, loops, and gates. Saved as a config file. |
| **Loop** | Repeat a group of steps until a condition is met or a limit is hit (e.g. validator → fixer until the validator passes, max 5 rounds). |
| **Gate** | A pause that waits for a human to approve, reject, or edit before continuing. |
| **Run** | One execution of a pipeline, with its full history and costs. |
| **Context** | What flows between steps: previous outputs, attached files, shared notes. Explicitly declared per step. |
| **Cache** | Prompt-cache entries written by one step that later steps can read instead of paying for the same tokens again. |

## 5. Example

```
Planner ──► Coder ──► ┌─ Validator ─► pass? ─┐ ──► [Human Gate] ──► Done
                      │        │ fail          │
                      └──── Fixer ◄────────────┘   (max 5 loops)
```

## 6. What It Must Do

### Pipeline definition
- Create an agent by pointing to a `.md` file.
- Chain agents into steps; choose what each step receives (previous output, specific files, everything).
- Define loops with an **exit condition** (e.g. validator says "PASS") and a **hard max** on iterations.
- Insert gates anywhere. A gate shows the current output and offers: Approve / Reject / Edit & continue / Send back to step X.
- Save pipelines as plain files (YAML/JSON + `.md`) so they can live in git.

### Context passing
- Each step declares what it **receives** (inputs) and what it **hands on** (outputs).
- Sources a step can pull from: the output of any earlier step (not just the one before it), the run's input, attached files, and a shared **run notebook** that any agent can read and append to.
- Outputs can be named (e.g. `plan`, `review_findings`) so later steps reference them by name.
- In loops, the fixer gets the validator's latest findings plus a short history of earlier rounds, so it doesn't repeat failed fixes.
- Large context can be passed as a summary or a file reference instead of full text, to control token use.
- The context handed to each step is visible in the run log — you can always see exactly what an agent was given.

### Cache sharing
- When a step writes to the provider's prompt cache, later steps should **reuse it instead of paying for it again**.
- The orchestrator builds prompts in a fixed order, stable parts first (shared system/project context, files, earlier outputs), changing parts last, so later steps start with the same cached prefix.
- Steps that share a prefix are grouped to run on the same provider/model, since caches don't carry across providers or models.
- Loop rounds reuse the cached prefix, so only the new findings or changes cost full price.
- Cache hits, misses and savings are reported per step, e.g. "Step 4 read 38k cached tokens from Step 2, saving $0.41".
- A step can opt out of the shared cache when it needs a clean, isolated context (e.g. an independent reviewer).

### Running
- Start a run with an input (a task description, a repo, files).
- Steps run in order; loops repeat; gates pause the run until a human acts.
- A run can be paused, resumed, or cancelled.
- If a step fails, retry it or stop — no silent failures.
- Choose provider + model per agent (Cursor or OpenAI).

### Monitoring
- Per step and per run: **input tokens, output tokens, cache reads, cache writes, cost, duration**.
- Live view of the running pipeline: which step is active, what it's producing.
- Full log of every step: prompt sent, response received, decisions made.
- Cost totals per run, per pipeline, per day.
- **Budget limits**: stop or pause a run when it passes a set cost or token cap.

### Human gates
- Notify when a run is waiting (in-app to start; later Slack/email).
- Gates can have a timeout with a default action (approve / reject / keep waiting).

## 7. Out of Scope (v1)

- Running steps in parallel.
- Multi-user teams, roles, permissions.
- A drag-and-drop visual editor (config files first; a read-only visual view is fine).
- Providers beyond Cursor and OpenAI.
- Hosting as a SaaS — v1 runs locally.

## 8. Success Looks Like

- A validator/fixer loop can be defined in minutes and runs without babysitting.
- Every dollar spent is traceable to a specific step and run.
- A human can approve a gate in under a minute with the context they need in front of them.
- No run ever exceeds its budget cap.

## 9. Open Questions

1. How does a validator signal pass/fail — a keyword, structured output, or an exit code from a script?
2. Should steps share one working directory (e.g. a git checkout), or pass only text?
3. Cursor: use its background-agent API, its CLI, or both? What usage/cost data does it expose?
4. Should gates allow editing the agent's `.md` mid-run, or only the output?
5. Where do run histories live — local files, SQLite, or something else?
6. How much control does each provider give over caching? OpenAI caches automatically when prompts start with the same prefix; Cursor's behaviour is unknown. Do we only report cache usage, or also try to shape prompts for reuse?
