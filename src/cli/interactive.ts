import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { EngineHooks, GateAnswer } from '../engine/engine.js';
import type { StoredEvent } from '../engine/events.js';
import { apply, latestOutput, type OpenGate, replay, type RunState } from '../engine/state.js';
import { allSteps } from '../pipeline/types.js';
import { formatLog } from '../report/logs.js';
import { colors, renderRun } from '../report/view.js';
import type { Store } from '../store/store.js';
import { truncate } from '../util.js';

/**
 * Terminal front end for a foreground run: a live view that redraws in place on a TTY (or plain log lines
 * otherwise), and gate prompts answered right here.
 */
export class LiveTerminal {
  private state: RunState | null = null;
  private events: StoredEvent[] = [];
  private chunk = '';
  private drawn = 0;
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  readonly tty = Boolean(process.stdout.isTTY);
  private c = colors(this.tty);

  constructor(
    private store: Store,
    private runId: string,
    private interactive: boolean,
  ) {
    this.events = store.events(runId);
    this.state = replay(runId, this.events);
    if (!this.tty) for (const l of formatLog(this.events, store)) console.log(l);
  }

  hooks(): EngineHooks {
    return {
      onEvent: (e) => this.onEvent(e),
      onChunk: (_stepId, text) => {
        this.chunk = (this.chunk + text).slice(-500);
        this.schedule();
      },
      askGate: this.interactive ? (state, gate, signal) => this.askGate(state, gate, signal) : undefined,
    };
  }

  private onEvent(e: StoredEvent) {
    this.events.push(e);
    if (this.state) apply(this.state, e);
    if (e.type === 'StepStarted' || e.type === 'StepCompleted') this.chunk = '';
    if (this.tty) this.schedule();
    else for (const l of formatLog([e], this.store)) console.log(l);
  }

  private schedule() {
    if (!this.tty || this.paused || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draw();
    }, 80);
  }

  draw() {
    if (!this.tty || !this.state || this.paused) return;
    const lines = renderRun(this.state, this.events, { chunk: this.chunk, color: true });
    const width = process.stdout.columns || 120;
    const clipped = lines.map((l) => clip(l, width));
    let out = '';
    if (this.drawn) out += `\x1b[${this.drawn}F`;
    out += clipped.map((l) => `\x1b[2K${l}`).join('\n') + '\n';
    if (this.drawn > clipped.length) out += '\x1b[0J';
    process.stdout.write(out);
    this.drawn = clipped.length;
  }

  finish() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.draw();
  }

  private async askGate(state: RunState, gate: OpenGate, signal: AbortSignal): Promise<GateAnswer | null> {
    this.finish();
    this.paused = true;
    this.drawn = 0;
    const c = this.c;
    try {
      const ahead = [...this.events].reverse().find((e) => e.type === 'GateOpened');
      if (ahead?.type === 'GateOpened' && ahead.behindBase) {
        console.log(c.yellow(`  the base branch has moved ${ahead.behindBase} commit(s) since this run started`));
      }
      printOutputs(this.store, state, gate.show, 3000);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const choice = (
            await rl.question(c.bold('[a]pprove  [r]eject  [e]dit  [s]end back  [v]iew full  [d]etach > '), { signal })
          )
            .trim()
            .toLowerCase();
          if (choice === 'a' || choice === 'approve') {
            if (gate.reason === 'budget') {
              const v = Number((await rl.question('new run cap in USD > ', { signal })).trim());
              if (!Number.isFinite(v) || v <= 0) {
                console.log('enter a positive number');
                continue;
              }
              return { decision: 'approve', budgetUsd: v };
            }
            return { decision: 'approve' };
          }
          if (choice === 'r' || choice === 'reject') {
            const note = (await rl.question('reason (optional) > ', { signal })).trim();
            return { decision: 'reject', note: note || undefined };
          }
          if (choice === 'e' || choice === 'edit') {
            const candidates = gate.show.filter((n) => latestOutput(state, n));
            if (!candidates.length) {
              console.log('nothing to edit at this gate');
              continue;
            }
            let output = candidates[candidates.length - 1];
            if (candidates.length > 1) {
              const pick = (await rl.question(`which output? (${candidates.join(', ')}) [${output}] > `, { signal })).trim();
              if (pick) output = pick;
            }
            const v = latestOutput(state, output);
            if (!v) {
              console.log(`unknown output ${output}`);
              continue;
            }
            rl.pause();
            const text = editInEditor(this.store.readArtifact(v.ref), output);
            rl.resume();
            return { decision: 'edit', output, text };
          }
          if (choice === 's' || choice === 'sendback') {
            const ids = allSteps(state.pipeline).map((s) => s.id);
            const to = (await rl.question(`send back to which step? (${ids.join(', ')}) > `, { signal })).trim();
            if (!ids.includes(to)) {
              console.log(`unknown step "${to}"`);
              continue;
            }
            return { decision: 'sendback', to };
          }
          if (choice === 'v' || choice === 'view') {
            printOutputs(this.store, state, gate.show, Infinity);
            continue;
          }
          if (choice === 'd' || choice === 'detach' || choice === 'q') return null;
        }
      } finally {
        rl.close();
      }
    } finally {
      this.paused = false;
    }
  }
}

function printOutputs(store: Store, state: RunState, names: string[], max: number) {
  const c = colors(Boolean(process.stdout.isTTY));
  for (const name of names) {
    const v = latestOutput(state, name);
    if (!v) continue;
    console.log(c.cyan(`\n── ${name} (${v.humanEdit ? 'human edit' : `${v.stepId} #${v.iteration}`}) ──`));
    console.log(Number.isFinite(max) ? truncate(store.readArtifact(v.ref), max) : store.readArtifact(v.ref));
  }
  console.log('');
}

export function editInEditor(initial: string, name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentp-edit-'));
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, initial);
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const res = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
  if (res.status !== 0) throw new Error(`editor exited with ${res.status}`);
  return readFileSync(file, 'utf8');
}

// Clip to terminal width, counting visible characters only (ANSI codes are zero-width).
function clip(line: string, width: number): string {
  let visible = 0;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i);
      out += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible >= width - 1) break;
    out += line[i];
    visible++;
  }
  return out + (line.includes('\x1b') ? '\x1b[0m' : '');
}
