import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import type { GateAnswer } from '../engine/engine.js';
import { currentLabel, isTerminal, latestOutput, type RunState } from '../engine/state.js';
import { diff } from '../engine/workspace.js';
import { isGitRepo } from '../engine/workspace.js';
import { loadPipeline, PipelineError } from '../pipeline/loader.js';
import { allSteps, type Pipeline, PROVIDERS, type ProviderId } from '../pipeline/types.js';
import { deleteApiKey, setApiKey } from '../providers/keys.js';
import { cacheAttribution, formatCostTable, type GroupBy, groupUsage } from '../report/cost.js';
import { pipelineDiagram, runDiagram } from '../report/diagram.js';
import { formatLog } from '../report/logs.js';
import { colors, renderRun } from '../report/view.js';
import { priceFor } from '../usage/prices.js';
import { formatTokens, formatUsd, sleep } from '../util.js';
import { type Ctx, openContext } from './context.js';
import { editInEditor, LiveTerminal } from './interactive.js';

const program = new Command();
const c = colors(Boolean(process.stdout.isTTY));

program
  .name('agentp')
  .description('Agent Pipeline Orchestrator: define, run and monitor pipelines of AI agents.')
  .version('0.1.0')
  .option('--home <dir>', 'agentp data directory (default: nearest .agentp, or ./.agentp)')
  .option('--prices <file>', 'price table to use instead of <home>/prices.yaml or the bundled one');

const globals = () => program.opts<{ home?: string; prices?: string }>();
const ctx = () => openContext(globals());
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

/** Wraps an action: prints errors cleanly and sets the exit code. */
function action<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof PipelineError) console.error(c.red(err.message));
      else console.error(c.red(`error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  };
}

// ---------------------------------------------------------------- validate

program
  .command('validate')
  .description('check a pipeline and its agents; show cache-sharing and budget warnings')
  .argument('<pipeline>', 'pipeline YAML file')
  .option('--json', 'machine-readable output')
  .action(
    action((file: string, opts: { json?: boolean }) => {
      const { pipeline, warnings } = loadPipeline(file);
      const x = ctx();
      const budget = budgetChecks(x, pipeline);
      warnings.push(...budget.blockers, ...budget.warnings);
      if (opts.json) return print({ ok: true, name: pipeline.name, hash: pipeline.hash, warnings });
      console.log(`${c.green('✔')} ${pipeline.name}: ${allSteps(pipeline).length} steps, ${pipeline.nodes.filter((n) => n.kind === 'loop').length} loops, ${pipeline.nodes.filter((n) => n.kind === 'gate').length} gates`);
      for (const w of warnings) console.log(`${c.yellow('!')} ${w}`);
    }),
  );

/** Budget problems: blockers stop "agentp run" (the cap could not be enforced); the rest are warnings. */
function budgetChecks(x: Ctx, p: Pipeline): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const hasCostCap = p.budget.maxCostUsd != null || p.budget.maxCostUsdPerDay != null || x.config.budget?.max_cost_usd_per_day != null;
  const hasCap = hasCostCap || p.budget.maxTokens != null;
  const unmetered = x.engine.unmeteredProviders(p);
  if (hasCap && unmetered.length) {
    warnings.push(`budget: ${unmetered.join(', ')} does not report usage, so caps cannot be enforced on those steps (run needs --allow-unmetered)`);
  }
  if (hasCostCap) {
    const missing = [...new Set(allSteps(p).filter((s) => !unmetered.includes(s.agent.provider) && !priceFor(x.prices, s.agent.provider, s.agent.model)).map((s) => `${s.agent.provider}/${s.agent.model}`))];
    if (missing.length) blockers.push(`budget: no price for ${missing.join(', ')} in price table "${x.prices.version}", so the cost cap cannot be enforced; add it to prices.yaml`);
  }
  return { blockers, warnings };
}

// ---------------------------------------------------------------- run & control

program
  .command('run')
  .description('start a run of a pipeline')
  .argument('<pipeline>', 'pipeline YAML file')
  .option('-i, --input <text>', 'the task for this run')
  .option('-f, --input-file <file>', 'read the task from a file')
  .option('--repo <dir>', 'git repository the run works on (default: current directory if it is a git repo)')
  .option('--no-repo', 'do not create a git worktree; the run gets an empty directory')
  .option('-d, --detach', 'keep running in the background; reconnect with "agentp attach"')
  .option('--allow-unmetered', 'allow budget caps with providers that do not report usage')
  .option('--json', 'print the final run state as JSON')
  .action(
    action(async (file: string, opts: { input?: string; inputFile?: string; repo?: string | boolean; detach?: boolean; allowUnmetered?: boolean; json?: boolean }) => {
      const { pipeline, warnings } = loadPipeline(file);
      const x = ctx();
      const budget = budgetChecks(x, pipeline);
      if (budget.blockers.length) throw new Error(budget.blockers.join('\n'));
      if (budget.warnings.length && !opts.allowUnmetered) throw new Error(budget.warnings.join('\n'));
      for (const w of warnings) console.error(`${c.yellow('!')} ${w}`);
      let input = opts.input ?? '';
      if (opts.inputFile) input = readFileSync(opts.inputFile, 'utf8');
      if (!input && !process.stdin.isTTY) input = readFileSync(0, 'utf8');
      const repo = opts.repo === false ? null : typeof opts.repo === 'string' ? opts.repo : isGitRepo(process.cwd()) ? process.cwd() : null;
      const runId = x.engine.start(pipeline, input, { repo });
      console.error(`run ${c.bold(runId)} started${repo ? ` (worktree ${path.relative(process.cwd(), x.store.home)}/worktrees/${runId})` : ''}`);
      x.store.close();
      if (opts.detach) return detach(runId);
      await driveForeground(runId, opts.json);
    }),
  );

program
  .command('attach')
  .description('live view of a run; drives it here if no other process is')
  .argument('<run>')
  .action(
    action(async (ref: string) => {
      const x = ctx();
      const runId = x.store.resolveRun(ref);
      const holder = x.store.lockHolder(runId);
      if (holder == null) {
        const { state } = x.engine.load(runId);
        x.store.close();
        if (isTerminal(state.status) || state.status === 'paused') return printSummary(state);
        return driveForeground(runId);
      }
      await watch(x, runId);
    }),
  );

program
  .command('pause')
  .description('pause a run after its current step')
  .argument('<run>')
  .action(
    action((ref: string) => {
      const x = ctx();
      const runId = x.store.resolveRun(ref);
      x.engine.pause(runId);
      console.log(`run ${runId} will pause after its current step`);
    }),
  );

program
  .command('resume')
  .description('resume a paused or interrupted run')
  .argument('<run>')
  .option('-d, --detach', 'continue in the background')
  .action(
    action(async (ref: string, opts: { detach?: boolean }) => {
      const x = ctx();
      const runId = x.store.resolveRun(ref);
      x.engine.resume(runId);
      x.store.close();
      if (opts.detach) return detach(runId);
      await driveForeground(runId);
    }),
  );

program
  .command('cancel')
  .description('cancel a run (stops a step in progress)')
  .argument('<run>')
  .option('--reason <text>')
  .action(
    action((ref: string, opts: { reason?: string }) => {
      const x = ctx();
      const runId = x.store.resolveRun(ref);
      x.engine.cancel(runId, opts.reason);
      console.log(`run ${runId} cancelled`);
    }),
  );

program
  .command('ls')
  .description('list runs: status, current step, cost so far')
  .option('-n, --limit <n>', 'how many', '20')
  .option('--json')
  .action(
    action((opts: { limit: string; json?: boolean }) => {
      const x = ctx();
      x.engine.sweepTimeouts();
      const rows = x.store.listRuns(Number(opts.limit));
      if (opts.json) return print(rows);
      if (!rows.length) return console.log('no runs yet');
      table(
        ['run', 'pipeline', 'status', 'current', 'cost', 'tokens', 'started'],
        rows.map((r) => [r.id, r.pipeline_name, colorStatus(r.status), r.current ?? '', formatUsd(r.cost_usd ?? 0), formatTokens(r.tokens ?? 0), r.started_at.slice(0, 16).replace('T', ' ')]),
      );
    }),
  );

// ---------------------------------------------------------------- gates

program
  .command('gates')
  .description('list gates waiting for a decision')
  .option('--json')
  .action(
    action((opts: { json?: boolean }) => {
      const x = ctx();
      x.engine.sweepTimeouts();
      const gates = x.store.openGates();
      if (opts.json) return print(gates);
      if (!gates.length) return console.log('no gates waiting');
      for (const g of gates) {
        const { state } = x.engine.load(g.run_id);
        console.log(`${c.bold(g.run_id)}  ${g.pipeline_name}  ${c.yellow(g.gate_id)}  ${g.reason}  opened ${g.opened_at.slice(0, 16).replace('T', ' ')}${g.deadline ? `  times out ${g.deadline.slice(0, 16).replace('T', ' ')}` : ''}`);
        console.log(`   ${state.openGate?.message ?? ''}`);
        for (const name of state.openGate?.show ?? []) {
          const v = latestOutput(state, name);
          if (v) console.log(c.dim(`   ${name}: ${x.store.artifactPath(v.ref)}`));
        }
      }
      console.log(c.dim('\ndecide with: agentp approve|reject|edit|sendback <run>'));
    }),
  );

const decideOpts = (cmd: Command) =>
  cmd
    .argument('<gate>', 'run id (or run:gate)')
    .option('--note <text>', 'note recorded with the decision')
    .option('-d, --detach', 'continue the run in the background')
    .option('--no-continue', 'only record the decision; do not continue the run');

async function decide(ref: string, answer: GateAnswer, opts: { detach?: boolean; continue?: boolean }) {
  const x = ctx();
  x.engine.sweepTimeouts();
  const runId = x.store.resolveRun(ref.split(':')[0]);
  const { state } = x.engine.load(runId);
  const gateName = ref.split(':')[1];
  if (gateName && state.openGate?.gateId !== gateName) throw new Error(`gate "${gateName}" is not open on run ${runId}`);
  x.engine.decideGate(runId, answer);
  console.log(`${state.openGate?.gateId}: ${answer.decision}`);
  const driven = x.store.lockHolder(runId) != null;
  x.store.close();
  if (answer.decision === 'reject' || !opts.continue) return;
  if (driven) return console.log('the process attached to this run will continue it');
  if (opts.detach) return detach(runId);
  await driveForeground(runId);
}

decideOpts(program.command('approve').description('approve the open gate and continue'))
  .option('--budget <usd>', 'new run cost cap (required for budget gates)')
  .action(action((ref: string, o: { note?: string; budget?: string; detach?: boolean; continue?: boolean }) => decide(ref, { decision: 'approve', note: o.note, budgetUsd: o.budget ? Number(o.budget) : undefined }, o)));

decideOpts(program.command('reject').description('reject the open gate; ends the run')).action(
  action((ref: string, o: { note?: string; detach?: boolean; continue?: boolean }) => decide(ref, { decision: 'reject', note: o.note }, o)),
);

decideOpts(program.command('edit').description('edit an output shown at the gate (opens $EDITOR), then continue'))
  .option('--output <name>', 'which output to replace (default: the last one the gate shows)')
  .option('--file <path>', 'take the new content from a file instead of $EDITOR')
  .action(
    action(async (ref: string, o: { note?: string; output?: string; file?: string; detach?: boolean; continue?: boolean }) => {
      let text: string;
      if (o.file) text = readFileSync(o.file, 'utf8');
      else {
        const x = ctx();
        const { state } = x.engine.load(x.store.resolveRun(ref.split(':')[0]));
        const gate = state.openGate;
        if (!gate) throw new Error('no open gate on this run');
        const name = o.output ?? [...gate.show].reverse().find((n) => latestOutput(state, n));
        const v = name ? latestOutput(state, name) : undefined;
        if (!name || !v) throw new Error('nothing to edit at this gate; pass --output');
        text = editInEditor(x.store.readArtifact(v.ref), name);
        o.output = name;
        x.store.close();
      }
      await decide(ref, { decision: 'edit', text, output: o.output, note: o.note }, o);
    }),
  );

decideOpts(program.command('sendback').description('send the run back to an earlier step'))
  .requiredOption('--to <step>', 'step to re-enter the pipeline at')
  .action(action((ref: string, o: { note?: string; to: string; detach?: boolean; continue?: boolean }) => decide(ref, { decision: 'sendback', to: o.to, note: o.note }, o)));

// ---------------------------------------------------------------- reports

program
  .command('logs')
  .description('what each step was given, what it did, and what it cost')
  .argument('<run>')
  .option('--step <id>', 'only this step')
  .option('--full', 'include prompts, outputs and tool results')
  .option('--json', 'raw events')
  .action(
    action((ref: string, opts: { step?: string; full?: boolean; json?: boolean }) => {
      const x = ctx();
      const events = x.store.events(x.store.resolveRun(ref));
      if (opts.json) return print(events.map((e) => (e.type === 'RunStarted' ? { ...e, pipeline: { name: e.pipeline.name, hash: e.pipeline.hash } } : e)));
      for (const l of formatLog(events, x.store, { step: opts.step, full: opts.full, color: Boolean(process.stdout.isTTY) })) console.log(l);
    }),
  );

program
  .command('cost')
  .description('tokens, cache reads/writes, cost and cache savings')
  .argument('[run]', 'one run (default: all runs)')
  .addOption(new Option('--by <group>', 'group rows by').choices(['step', 'model', 'day', 'pipeline', 'run']))
  .option('--since <date>', 'only usage on or after this date (YYYY-MM-DD)')
  .option('--json')
  .action(
    action((ref: string | undefined, opts: { by?: GroupBy; since?: string; json?: boolean }) => {
      const x = ctx();
      const runId = ref ? x.store.resolveRun(ref) : undefined;
      const by: GroupBy = opts.by ?? (runId ? 'step' : 'day');
      const rows = groupUsage(x.store.usage({ runId, since: opts.since }), by);
      const attribution = runId ? cacheAttribution(x.store.events(runId)) : [];
      if (opts.json) return print({ by, rows, cache: attribution, priceVersion: x.prices.version });
      if (!rows.length) return console.log('no usage recorded');
      for (const l of formatCostTable(rows, by)) console.log(l);
      if (attribution.length) {
        console.log('');
        for (const l of attribution) console.log(`  ${l}`);
      }
    }),
  );

program
  .command('diagram')
  .description('Mermaid diagram of a pipeline (designed flow) or of a run (what actually happened)')
  .argument('<target>', 'pipeline YAML file or run id')
  .option('--costs', 'run mode: show tokens, cache hits and cost per step')
  .option('--out <file>', 'write a Markdown file instead of printing')
  .action(
    action((target: string, opts: { costs?: boolean; out?: string }) => {
      let mermaid: string;
      let title: string;
      if (/\.ya?ml$/.test(target) || existsSync(target)) {
        const { pipeline } = loadPipeline(target);
        mermaid = pipelineDiagram(pipeline);
        title = `Pipeline ${pipeline.name}`;
      } else {
        const x = ctx();
        const { state, events } = x.engine.load(x.store.resolveRun(target));
        mermaid = runDiagram(state, events, { costs: opts.costs });
        title = `Run ${state.runId} of ${state.pipeline.name} (${state.status})`;
      }
      if (opts.out) {
        writeFileSync(opts.out, `# ${title}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`);
        console.error(`wrote ${opts.out}`);
      } else console.log(mermaid);
    }),
  );

program
  .command('diff')
  .description("show the code changes a run's steps made in its worktree")
  .argument('<run>')
  .option('--from <step>', 'step (or step#iteration) to diff from (default: the run start)')
  .option('--to <step>', 'step (or step#iteration) to diff to (default: latest)')
  .option('--stat', 'summary only')
  .action(
    action((ref: string, opts: { from?: string; to?: string; stat?: boolean }) => {
      const x = ctx();
      const { state, events } = x.engine.load(x.store.resolveRun(ref));
      const shaOf = (spec: string | undefined, fallback: string | null) => {
        if (!spec) return fallback;
        const [step, iter] = spec.split('#');
        const done = events.filter((e) => e.type === 'StepCompleted' && e.stepId === step && (!iter || e.iteration === Number(iter)));
        const last = done[done.length - 1];
        if (!last || last.type !== 'StepCompleted' || !last.sha) throw new Error(`no commit recorded for ${spec}`);
        return last.sha;
      };
      const from = shaOf(opts.from, state.workspace.git?.baseSha ?? null);
      const to = shaOf(opts.to, state.lastSha);
      if (!from || !to) throw new Error('this run has no git workspace');
      process.stdout.write(diff(state.workspace, from, to, opts.stat) || '(no changes)\n');
    }),
  );

// ---------------------------------------------------------------- keys

const keys = program.command('keys').description('store provider API keys in the OS keychain');
keys
  .command('set')
  .argument('<provider>', PROVIDERS.join(' | '))
  .action(
    action(async (provider: ProviderId) => {
      if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`);
      const key = process.stdin.isTTY ? await promptHidden(`${provider} API key: `) : readFileSync(0, 'utf8').trim();
      if (!key) throw new Error('empty key');
      setApiKey(provider, key);
      console.log(`stored ${provider} key in the keychain`);
    }),
  );
keys
  .command('delete')
  .argument('<provider>')
  .action(
    action((provider: ProviderId) => {
      deleteApiKey(provider);
      console.log(`deleted ${provider} key`);
    }),
  );

// Internal: the background driver started by --detach.
program
  .command('_drive', { hidden: true })
  .argument('<run>')
  .action(
    action(async (runId: string) => {
      const x = ctx();
      await x.engine.drive(runId);
    }),
  );

// ---------------------------------------------------------------- helpers

async function driveForeground(runId: string, json = false) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !json;
  const x = ctx();
  const live = new LiveTerminal(x.store, runId, interactive);
  x.engine.setHooks(live.hooks());
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) {
      try {
        x.engine.pause(runId);
      } catch {
        /* already stopping */
      }
      console.error(c.yellow('\npausing after the current step… (Ctrl-C again to stop now; "agentp resume" continues)'));
    } else process.exit(130);
  };
  process.on('SIGINT', onSigint);
  try {
    const state = await x.engine.drive(runId);
    live.finish();
    if (json) print(summary(state));
    else printSummary(state, !live.tty);
    if (['failed', 'rejected', 'budget_exceeded', 'cancelled'].includes(state.status)) process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    x.store.close();
  }
}

function detach(runId: string) {
  const x = ctx();
  const log = openSync(path.join(x.store.runDir(runId), 'driver.log'), 'a');
  const args = [...process.execArgv, process.argv[1], '--home', x.home, ...(globals().prices ? ['--prices', globals().prices!] : []), '_drive', runId];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  console.log(`run ${c.bold(runId)} continues in the background (pid ${child.pid}); watch it with: agentp attach ${runId}`);
}

async function watch(x: Ctx, runId: string) {
  console.error(c.dim(`run ${runId} is driven by another process; watching (Ctrl-C to stop watching)`));
  let drawn = 0;
  for (;;) {
    const { state, events } = x.engine.load(runId);
    const lines = renderRun(state, events, { color: Boolean(process.stdout.isTTY) });
    if (process.stdout.isTTY && drawn) process.stdout.write(`\x1b[${drawn}F\x1b[0J`);
    console.log(lines.join('\n'));
    drawn = lines.length;
    if (isTerminal(state.status) || state.status === 'paused' || x.store.lockHolder(runId) == null) {
      if (state.openGate) console.log(c.dim('\nthe driver exited at this gate; decide with agentp approve|reject|edit|sendback'));
      return;
    }
    await sleep(700);
  }
}

function summary(state: RunState) {
  return {
    run: state.runId,
    pipeline: state.pipeline.name,
    status: state.status,
    current: currentLabel(state),
    costUsd: state.spentUsd,
    tokens: state.tokens,
    gate: state.openGate,
    error: state.error,
    workspace: state.workspace.path,
    branch: state.workspace.git?.branch ?? null,
  };
}

function printSummary(state: RunState, plain = true) {
  if (plain) {
    const lines = renderRun(state, [], { color: Boolean(process.stdout.isTTY) });
    console.log('');
    console.log(lines[0]);
    if (state.openGate) console.log(lines.slice(-3).join('\n'));
  }
  if (state.status === 'succeeded' && state.workspace.git) {
    console.log(c.dim(`changes are on branch ${state.workspace.git.branch} (agentp diff ${state.runId})`));
  }
  if (state.status === 'paused') console.log(c.dim(`paused; continue with: agentp resume ${state.runId}`));
}

function colorStatus(s: string) {
  if (s === 'succeeded') return c.green(s);
  if (s === 'running' || s === 'waiting' || s === 'paused') return c.yellow(s);
  return c.red(s);
}

function table(header: string[], rows: string[][]) {
  // eslint-disable-next-line no-control-regex
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => visible(r[i]))));
  const fmt = (r: string[]) => r.map((cell, i) => cell + ' '.repeat(widths[i] - visible(cell))).join('  ');
  console.log(c.dim(fmt(header)));
  for (const r of rows) console.log(fmt(r));
}

async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString()) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

await program.parseAsync();
