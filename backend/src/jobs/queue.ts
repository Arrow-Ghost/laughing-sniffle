// In-process job queue (spec §107).
//
// A single-box, single-worker FIFO. Long operations — integrity analysis, a
// judging pass, event analytics — run here instead of on the request thread so a
// busy event does not stall the console. Not durable (jobs live in memory); on
// restart, re-enqueue. Failed jobs retry with linear backoff up to maxAttempts.

import { randomUUID } from 'node:crypto';
import type { Job, JobKind, JobStatus, Id } from '../domain/types.ts';

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

export class JobQueue {
  private handlers = new Map<JobKind, Handler>();
  private jobs = new Map<Id, Job>();
  private pending: Id[] = [];
  private running = false;
  private retention: number;
  private backoffMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { retention?: number; backoffMs?: number } = {}) {
    this.retention = opts.retention ?? 200;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  register(kind: JobKind, handler: Handler): void {
    this.handlers.set(kind, handler);
  }

  enqueue(kind: JobKind, payload: Record<string, unknown>, opts: { maxAttempts?: number } = {}): Job {
    if (!this.handlers.has(kind)) throw new Error(`no handler registered for job kind "${kind}"`);
    const job: Job = {
      id: randomUUID(),
      kind,
      payload,
      status: 'queued',
      attempts: 0,
      maxAttempts: Math.max(1, opts.maxAttempts ?? 2),
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.prune();
    this.kick();
    return job;
  }

  get(id: Id): Job | null {
    return this.jobs.get(id) ?? null;
  }

  list(opts: { status?: JobStatus; limit?: number } = {}): Job[] {
    let all = [...this.jobs.values()].sort((a, b) => b.enqueuedAt - a.enqueuedAt);
    if (opts.status) all = all.filter((j) => j.status === opts.status);
    return opts.limit ? all.slice(0, opts.limit) : all;
  }

  /** Run the queue to empty. Used by tests and by a graceful shutdown. */
  async drain(): Promise<void> {
    while (this.pending.length > 0) await this.step();
  }

  stats(): { queued: number; running: number; done: number; failed: number; total: number } {
    const s = { queued: 0, running: 0, done: 0, failed: 0, total: this.jobs.size };
    for (const j of this.jobs.values()) s[j.status]++;
    return s;
  }

  private kick(): void {
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loop();
    }, 0);
  }

  private async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) await this.step();
    } finally {
      this.running = false;
    }
  }

  private async step(): Promise<void> {
    const id = this.pending.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job) return;
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      job.status = 'failed';
      job.error = `no handler for ${job.kind}`;
      job.finishedAt = Date.now();
      return;
    }
    job.status = 'running';
    job.startedAt = job.startedAt ?? Date.now();
    job.attempts += 1;
    try {
      job.result = await handler(job.payload);
      job.status = 'done';
      job.error = null;
      job.finishedAt = Date.now();
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
      if (job.attempts < job.maxAttempts) {
        job.status = 'queued';
        await new Promise((r) => setTimeout(r, this.backoffMs * job.attempts));
        this.pending.push(job.id);
      } else {
        job.status = 'failed';
        job.finishedAt = Date.now();
      }
    }
    if (job.status === 'done' || job.status === 'failed') this.prune();
  }

  private prune(): void {
    if (this.jobs.size <= this.retention) return;
    const done = [...this.jobs.values()]
      .filter((j) => j.status === 'done' || j.status === 'failed')
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    while (this.jobs.size > this.retention && done.length) {
      const oldest = done.shift()!;
      this.jobs.delete(oldest.id);
    }
  }
}
