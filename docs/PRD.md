# PRD — Agent Pipeline Orchestrator

## 1. Problem

Running several AI agents in sequence (plan → build → validate → fix) is manual today: copy prompts, paste outputs, restart when something fails, guess what it cost. There's no repeatable way to define the flow, no place for a human to step in, and no visibility into spend.

## 2. Idea

A tool where you **describe a pipeline of agents once**, then **run it, watch it, and pay only for what you expect**.

- Each agent is defined by a Markdown file (its instructions).
- Agents are wired into a flow: steps, loops, and human approval gates.
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
| **Context** | What flows between steps: previous outputs, attached files, shared notes. |

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
