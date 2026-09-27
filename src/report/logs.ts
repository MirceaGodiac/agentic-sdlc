import type { StoredEvent } from '../engine/events.js';
import type { Store } from '../store/store.js';
import { formatDuration, formatTokens, formatUsd } from '../util.js';
import { colors } from './view.js';

export interface LogOptions {
  step?: string;
  full?: boolean;
  color?: boolean;
}

/** Human-readable log straight from the event stream: what each step was given, what it did, what it cost. */
export function formatLog(events: StoredEvent[], store: Store, opts: LogOptions = {}): string[] {
  const c = colors(opts.color ?? false);
  const lines: string[] = [];
  const time = (e: StoredEvent) => c.dim(e.at.slice(11, 19));
  const block = (title: string, text: string) => {
    lines.push(c.dim(`    ┌─ ${title}`));
    for (const l of text.split('\n')) lines.push(c.dim('    │ ') + l);
    lines.push(c.dim('    └─'));
  };
  for (const e of events) {
    if (opts.step && 'stepId' in e && e.stepId !== opts.step) continue;
    if (opts.step && !('stepId' in e)) continue;
    const tag = 'stepId' in e && 'iteration' in e ? c.cyan(`${e.stepId} #${e.iteration}`) : '';
    const say = (msg: string) => lines.push(`${time(e)}  ${tag ? `${tag}  ` : ''}${msg}`);
    switch (e.type) {
      case 'RunStarted':
        say(`run started: ${c.bold(e.pipeline.name)} (pipeline ${e.pipeline.hash.slice(0, 12)}) in ${e.workspace.path}`);
        say(`input: ${e.input.length > 200 && !opts.full ? `${e.input.slice(0, 200)}…` : e.input}`);
        break;
      case 'ContextBuilt': {
        const parts = e.parts
          .map((p) => `${p.source} ${c.dim(`${formatTokens(p.chars)} chars, ${p.zone}`)}${p.substituted ? c.yellow(` [${p.substituted}]`) : ''}`)
          .join(' · ');
        say(`context (attempt ${e.attempt}): ${parts}`);
        if (e.cacheSource) say(c.dim(`shares its first ${e.cacheSource.sharedParts} part(s) with ${e.cacheSource.stepId} #${e.cacheSource.iteration}`));
        if (opts.full) block('prompt', store.readArtifact(e.promptRef));
        break;
      }
      case 'StepStarted':
        say(`started on ${e.provider}/${e.model} (attempt ${e.attempt})`);
        break;
      case 'ModelCalled':
        say(c.dim(`call ${e.turn}: ~${formatTokens(e.estimatedInputTokens)} input tokens, max output ${e.maxOutputTokens}`));
        break;
      case 'UsageRecorded': {
        const u = e.usage;
        const cache = u.cacheReadTokens != null ? ` (${formatTokens(u.cacheReadTokens)} cached)` : '';
        say(
          `usage: in ${u.inputTokens == null ? 'not reported' : formatTokens(u.inputTokens)}${cache}, out ${u.outputTokens == null ? 'not reported' : formatTokens(u.outputTokens)}, cost ${e.costUsd == null ? 'not reported' : formatUsd(e.costUsd)}${e.savingsUsd ? `, saved ${formatUsd(e.savingsUsd)}` : ''}`,
        );
        break;
      }
      case 'ToolCalled':
        say(`${e.ok ? '' : c.red('✘ ')}tool ${e.name} ${c.dim(e.args.slice(0, 120))}`);
        if (opts.full) block(`${e.name} result`, e.result);
        break;
      case 'NotebookAppended':
        say(`notebook: ${e.key} = ${e.value}`);
        break;
      case 'StepCompleted':
        say(
          `${c.green('done')} in ${formatDuration(e.durationMs)} → ${e.output}${e.verdict ? ` [${e.verdict}${e.findingsCount ? `, ${e.findingsCount} findings` : ''}]` : ''}${e.sha ? c.dim(` @${e.sha.slice(0, 8)}`) : ''}`,
        );
        if (opts.full) block(`output ${e.output}`, store.readArtifact(e.outputRef));
        break;
      case 'StepFailed':
        say(`${c.red('failed')}: ${e.error}${e.willRetry ? c.dim(' (will retry)') : ''}`);
        break;
      case 'LoopIteration':
        say(`loop ${e.loopId}: round ${e.iteration}`);
        break;
      case 'LoopExited':
        say(`loop ${e.loopId} ended after round ${e.iteration}: ${e.reason === 'condition' ? 'condition met' : c.yellow('max_iterations reached')}`);
        break;
      case 'GateOpened':
        say(`${c.yellow('gate')} ${e.gateId} opened: ${e.message}${e.deadline ? ` (times out ${e.deadline} → ${e.onTimeout})` : ''}${e.behindBase ? c.yellow(` · base branch is ${e.behindBase} commit(s) ahead`) : ''}`);
        break;
      case 'GateDecided':
        say(
          `${c.yellow('gate')} ${e.gateId}: ${e.decision}${e.to ? ` → ${e.to}` : ''}${e.edit ? ` (${e.edit.output} replaced by a human edit)` : ''}${e.budgetUsd != null ? ` (run cap now ${formatUsd(e.budgetUsd)})` : ''} by ${e.by}${e.note ? `: ${e.note}` : ''}`,
        );
        if (opts.full && e.edit) block(`edited ${e.edit.output}`, store.readArtifact(e.edit.ref));
        break;
      case 'RunPaused':
      case 'RunResumed':
        say(e.type === 'RunPaused' ? 'paused' : 'resumed');
        break;
      case 'RunCancelled':
        say(c.red(`cancelled${e.reason ? `: ${e.reason}` : ''}`));
        break;
      case 'RunFinished':
        say(`${e.status === 'succeeded' ? c.green('finished') : c.red(e.status)}${e.error ? `: ${e.error}` : ''}`);
        break;
    }
  }
  return lines;
}
