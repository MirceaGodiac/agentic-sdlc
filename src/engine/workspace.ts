import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './events.js';

const GIT_ID = ['-c', 'user.name=agentp', '-c', 'user.email=agentp@localhost'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/**
 * Each run gets its own git worktree on a new branch (`agentp/<run>`), so code-editing agents never touch
 * the user's checkout. Without a git repo the run gets a plain empty directory.
 */
export function createWorkspace(home: string, runId: string, repo: string | null): Workspace {
  const dir = path.join(home, 'worktrees', runId);
  if (repo && isGitRepo(repo)) {
    const root = git(repo, ['rev-parse', '--show-toplevel']);
    const baseSha = git(root, ['rev-parse', 'HEAD']);
    let baseRef = baseSha;
    try {
      baseRef = git(root, ['symbolic-ref', '--short', 'HEAD']);
    } catch {
      /* detached HEAD */
    }
    const branch = `agentp/${runId}`;
    git(root, ['worktree', 'add', '-q', '-b', branch, dir, baseSha]);
    return { path: dir, git: { repo: root, branch, baseRef, baseSha } };
  }
  mkdirSync(dir, { recursive: true });
  return { path: dir, git: null };
}

/** Commits whatever the step changed and returns the new HEAD (or the current one if nothing changed). */
export function commitStep(ws: Workspace, message: string): string | null {
  if (!ws.git || !existsSync(ws.path)) return null;
  if (git(ws.path, ['status', '--porcelain'])) {
    git(ws.path, ['add', '-A']);
    git(ws.path, [...GIT_ID, 'commit', '-q', '--no-verify', '-m', message]);
  }
  return git(ws.path, ['rev-parse', 'HEAD']);
}

export function diff(ws: Workspace, from: string, to: string, stat = false): string {
  if (!ws.git) throw new Error('this run has no git workspace');
  return execFileSync('git', ['diff', ...(stat ? ['--stat'] : []), from, to], { cwd: ws.path, encoding: 'utf8' });
}

/** How many commits the base branch has gained since the run started (stale-run check at gates). */
export function behindBase(ws: Workspace): number | null {
  if (!ws.git || ws.git.baseRef === ws.git.baseSha) return null;
  try {
    return Number(git(ws.git.repo, ['rev-list', '--count', `${ws.git.baseSha}..${ws.git.baseRef}`]));
  } catch {
    return null;
  }
}
