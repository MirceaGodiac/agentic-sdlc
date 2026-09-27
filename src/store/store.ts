import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunEvent, StoredEvent } from '../engine/events.js';
import { pidAlive } from '../util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL, pipeline_name TEXT NOT NULL, pipeline_hash TEXT NOT NULL,
  status TEXT NOT NULL, current TEXT, input TEXT NOT NULL, workspace_path TEXT,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (run_id, seq)
);
CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL, step_id TEXT NOT NULL, iteration INTEGER NOT NULL, attempt INTEGER NOT NULL,
  status TEXT NOT NULL, output_ref TEXT, started_at TEXT, ended_at TEXT,
  PRIMARY KEY (run_id, step_id, iteration, attempt)
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, pipeline_name TEXT NOT NULL, step_id TEXT NOT NULL,
  iteration INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_usd REAL, savings_usd REAL, price_version TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_at ON usage (at);
CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, gate_id TEXT NOT NULL, instance INTEGER NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL, deadline TEXT, decision TEXT, opened_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS run_locks (run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, host TEXT NOT NULL, acquired_at TEXT NOT NULL);
`;

export interface RunRow {
  id: string;
  pipeline_name: string;
  status: string;
  current: string | null;
  input: string;
  workspace_path: string | null;
  started_at: string;
  ended_at: string | null;
  cost_usd: number | null;
  tokens: number | null;
}

export interface GateRow {
  id: string;
  run_id: string;
  gate_id: string;
  instance: number;
  reason: string;
  status: string;
  deadline: string | null;
  opened_at: string;
  pipeline_name: string;
}

export interface UsageRow {
  run_id: string;
  pipeline_name: string;
  step_id: string;
  iteration: number;
  provider: string;
  model: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_usd: number | null;
  savings_usd: number | null;
  price_version: string | null;
  at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(path.join(home, 'agentp.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  runDir(runId: string): string {
    const dir = path.join(this.home, 'runs', runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Writes a large artifact (output, prompt, response) under runs/<id>/ and returns its reference. */
  writeArtifact(runId: string, name: string, content: string): string {
    const rel = path.join('runs', runId, name);
    mkdirSync(path.dirname(path.join(this.home, rel)), { recursive: true });
    writeFileSync(path.join(this.home, rel), content);
    return rel;
  }

  readArtifact(ref: string): string {
    return readFileSync(path.join(this.home, ref), 'utf8');
  }

  artifactPath(ref: string): string {
    return path.join(this.home, ref);
  }

  /** Appends events atomically and updates the read projections in the same transaction. */
  append(runId: string, events: RunEvent[]): StoredEvent[] {
    const stored: StoredEvent[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?').get(runId) as {
        seq: number;
      };
      let seq = row.seq;
      const insert = this.db.prepare('INSERT INTO events (run_id, seq, type, payload_json, at) VALUES (?, ?, ?, ?, ?)');
      for (const e of events) {
        const at = new Date().toISOString();
        seq += 1;
        insert.run(runId, seq, e.type, JSON.stringify(e), at);
        const s = { ...e, seq, at } as StoredEvent;
        this.project(runId, s);
        stored.push(s);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return stored;
  }

  events(runId: string, afterSeq = 0): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, payload_json, at FROM events WHERE run_id = ? AND seq > ? ORDER BY seq')
      .all(runId, afterSeq) as { seq: number; payload_json: string; at: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.payload_json), seq: r.seq, at: r.at }));
  }

  private project(runId: string, e: StoredEvent) {
    const db = this.db;
    const setStatus = (status: string, ended = false) =>
      db.prepare(`UPDATE runs SET status = ?${ended ? ', ended_at = ?' : ''} WHERE id = ?`).run(
        ...(ended ? [status, e.at, runId] : [status, runId]),
      );
    switch (e.type) {
      case 'RunStarted': {
        const pipelineId = `${e.pipeline.name}@${e.pipeline.hash.slice(0, 12)}`;
        db.prepare('INSERT OR IGNORE INTO pipelines (id, name, path, content_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
          pipelineId,
          e.pipeline.name,
          e.pipeline.file,
          e.pipeline.hash,
          e.at,
        );
        db.prepare(
          `INSERT INTO runs (id, pipeline_id, pipeline_name, pipeline_hash, status, input, workspace_path, started_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
        ).run(runId, pipelineId, e.pipeline.name, e.pipeline.hash, e.input, e.workspace.path, e.at);
        break;
      }
      case 'StepStarted':
        db.prepare(
          `INSERT OR REPLACE INTO steps (run_id, step_id, iteration, attempt, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
        ).run(runId, e.stepId, e.iteration, e.attempt, e.at);
        db.prepare('UPDATE runs SET current = ? WHERE id = ?').run(`${e.stepId} #${e.iteration}`, runId);
        break;
      case 'StepCompleted':
      case 'StepFailed':
        db.prepare(
          'UPDATE steps SET status = ?, output_ref = ?, ended_at = ? WHERE run_id = ? AND step_id = ? AND iteration = ? AND attempt = ?',
        ).run(
          e.type === 'StepCompleted' ? 'succeeded' : 'failed',
          e.type === 'StepCompleted' ? e.outputRef : null,
          e.at,
          runId,
          e.stepId,
          e.iteration,
          e.attempt,
        );
        break;
      case 'UsageRecorded': {
        const run = db.prepare('SELECT pipeline_name FROM runs WHERE id = ?').get(runId) as { pipeline_name: string };
        db.prepare(
          `INSERT INTO usage (run_id, pipeline_name, step_id, iteration, provider, model, input, output, cache_read, cache_write,
             cost_usd, savings_usd, price_version, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          run.pipeline_name,
          e.stepId,
          e.iteration,
          e.provider,
          e.model,
          e.usage.inputTokens,
          e.usage.outputTokens,
          e.usage.cacheReadTokens,
          e.usage.cacheWriteTokens,
          e.costUsd,
          e.savingsUsd,
          e.priceVersion,
          e.at,
        );
        break;
      }
      case 'GateOpened':
        db.prepare(
          `INSERT OR REPLACE INTO gates (id, run_id, gate_id, instance, reason, status, deadline, opened_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(`${runId}:${e.gateId}#${e.instance}`, runId, e.gateId, e.instance, e.reason, e.deadline, e.at);
        setStatus('waiting');
        db.prepare('UPDATE runs SET current = ? WHERE id = ?').run(`gate ${e.gateId}`, runId);
        break;
      case 'GateDecided':
        db.prepare(`UPDATE gates SET status = 'decided', decision = ?, decided_at = ? WHERE id = ?`).run(
          `${e.decision}${e.by === 'timeout' ? ' (timeout)' : ''}`,
          e.at,
          `${runId}:${e.gateId}#${e.instance}`,
        );
        if (e.decision === 'reject') setStatus('rejected', true);
        else setStatus('running');
        break;
      case 'RunPaused':
        setStatus('paused');
        break;
      case 'RunResumed': {
        const open = db.prepare(`SELECT 1 FROM gates WHERE run_id = ? AND status = 'open'`).get(runId);
        setStatus(open ? 'waiting' : 'running');
        break;
      }
      case 'RunCancelled':
        setStatus('cancelled', true);
        db.prepare(`UPDATE gates SET status = 'cancelled' WHERE run_id = ? AND status = 'open'`).run(runId);
        break;
      case 'RunFinished':
        setStatus(e.status, true);
        db.prepare('UPDATE runs SET current = NULL WHERE id = ?').run(runId);
        break;
      default:
        break;
    }
  }

  listRuns(limit = 50): RunRow[] {
    return this.db
      .prepare(
        `SELECT r.id, r.pipeline_name, r.status, r.current, r.input, r.workspace_path, r.started_at, r.ended_at,
                (SELECT SUM(cost_usd) FROM usage u WHERE u.run_id = r.id) AS cost_usd,
                (SELECT SUM(COALESCE(input, 0) + COALESCE(output, 0)) FROM usage u WHERE u.run_id = r.id) AS tokens
         FROM runs r ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as RunRow[];
  }

  /** Resolves a full or prefix run id. */
  resolveRun(ref: string): string {
    const rows = this.db.prepare('SELECT id FROM runs WHERE id LIKE ?').all(`${ref}%`) as { id: string }[];
    if (rows.length === 0) throw new Error(`no run matches "${ref}"`);
    if (rows.length > 1) throw new Error(`"${ref}" matches several runs: ${rows.map((r) => r.id).join(', ')}`);
    return rows[0].id;
  }

  openGates(): GateRow[] {
    return this.db
      .prepare(
        `SELECT g.*, r.pipeline_name FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.status = 'open' ORDER BY g.opened_at`,
      )
      .all() as unknown as GateRow[];
  }

  usage(filter: { runId?: string; since?: string; pipeline?: string } = {}): UsageRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.runId) where.push('run_id = ?') && args.push(filter.runId);
    if (filter.since) where.push('at >= ?') && args.push(filter.since);
    if (filter.pipeline) where.push('pipeline_name = ?') && args.push(filter.pipeline);
    return this.db
      .prepare(`SELECT * FROM usage ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`)
      .all(...args) as unknown as UsageRow[];
  }

  spentSince(since: string, pipeline?: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE at >= ?${pipeline ? ' AND pipeline_name = ?' : ''}`)
      .get(...(pipeline ? [since, pipeline] : [since])) as { c: number };
    return row.c;
  }

  // Run locks: one process drives a run at a time. A lock held by a dead process is taken over.

  lockHolder(runId: string): number | null {
    const row = this.db.prepare('SELECT pid, host FROM run_locks WHERE run_id = ?').get(runId) as
      | { pid: number; host: string }
      | undefined;
    if (!row) return null;
    if (row.host === hostname() && !pidAlive(row.pid)) return null;
    return row.pid;
  }

  acquireLock(runId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const holder = this.lockHolder(runId);
      if (holder != null && holder !== process.pid) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db
        .prepare('INSERT OR REPLACE INTO run_locks (run_id, pid, host, acquired_at) VALUES (?, ?, ?, ?)')
        .run(runId, process.pid, hostname(), new Date().toISOString());
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  releaseLock(runId: string) {
    this.db.prepare('DELETE FROM run_locks WHERE run_id = ? AND pid = ?').run(runId, process.pid);
  }
}
