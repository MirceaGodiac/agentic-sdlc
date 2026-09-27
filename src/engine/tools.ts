import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolName } from '../pipeline/types.js';
import type { ToolCall, ToolDef } from '../providers/types.js';
import { truncate } from '../util.js';

export interface ToolContext {
  workspace: string;
  /** Directory holding oversized context parts, readable as `artifact:<file>`. */
  artifactDir: string;
  notebookRead(): string;
  notebookAppend(key: string, value: string): void;
  signal: AbortSignal;
}

const DEFS: Record<string, ToolDef> = {
  read_file: {
    name: 'read_file',
    description: 'Read a text file from the run workspace (or "artifact:<name>" for truncated context).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a text file in the run workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  list_files: {
    name: 'list_files',
    description: 'List files in a workspace directory (recursive, ignores .git and node_modules).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  run_command: {
    name: 'run_command',
    description: 'Run a shell command in the workspace root. Returns exit code and output (2 minute timeout).',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
  },
  notebook_read: {
    name: 'notebook_read',
    description: 'Read the shared run notebook that every agent in this run can read and append to.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  notebook_append: {
    name: 'notebook_append',
    description: 'Append a note to the shared run notebook for later steps.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
};

export function toolDefs(tools: ToolName[]): ToolDef[] {
  return tools.flatMap((t) => (t === 'notebook' ? [DEFS.notebook_read, DEFS.notebook_append] : [DEFS[t]]));
}

/** Resolves a path inside the workspace and refuses anything that escapes it (including via symlinks). */
function inside(root: string, p: string): string {
  const full = path.resolve(root, p);
  const realRoot = realpathSync(root);
  let probe = full;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(realpathSync(probe), path.relative(probe, full));
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`path escapes the workspace: ${p}`);
  return full;
}

export async function executeTool(call: ToolCall, allowed: ToolName[], ctx: ToolContext): Promise<string> {
  const name = call.name;
  const allowedNames = toolDefs(allowed).map((d) => d.name);
  if (!allowedNames.includes(name)) throw new Error(`tool "${name}" is not allowed for this agent`);
  const args = JSON.parse(call.arguments || '{}') as Record<string, string>;
  switch (name) {
    case 'read_file': {
      if (args.path.startsWith('artifact:')) {
        return readFileSync(inside(ctx.artifactDir, args.path.slice('artifact:'.length)), 'utf8');
      }
      return truncate(readFileSync(inside(ctx.workspace, args.path), 'utf8'), 200_000);
    }
    case 'write_file': {
      const full = inside(ctx.workspace, args.path);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, args.content);
      return `wrote ${args.content.length} chars to ${args.path}`;
    }
    case 'list_files': {
      const root = inside(ctx.workspace, args.path || '.');
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          if (entry === '.git' || entry === 'node_modules') continue;
          const full = path.join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else out.push(path.relative(ctx.workspace, full));
          if (out.length >= 2000) return;
        }
      };
      walk(root);
      return out.join('\n') || '(no files)';
    }
    case 'run_command':
      return new Promise((resolve) => {
        exec(
          args.command,
          { cwd: ctx.workspace, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, signal: ctx.signal },
          (err, stdout, stderr) => {
            const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
            resolve(truncate(`exit code: ${code}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`, 20_000));
          },
        );
      });
    case 'notebook_read':
      return ctx.notebookRead() || '(empty)';
    case 'notebook_append':
      ctx.notebookAppend(args.key, args.value);
      return 'noted';
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
