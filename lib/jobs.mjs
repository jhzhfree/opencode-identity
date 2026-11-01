/** In-memory job registry. Every long step reports progress so the UI can poll. */
import { randomUUID } from 'node:crypto';

export class Job {
  constructor(type, meta = {}) {
    this.id = randomUUID();
    this.type = type;
    this.state = 'running';           // running | done | failed
    this.steps = [];
    this.result = null;
    this.error = null;
    this.meta = meta;
    this.startedAt = Date.now();
    this.endedAt = null;
  }

  plan(names) {
    this.steps = names.map(name => ({ name, status: 'pending', ms: null, detail: null }));
    return this;
  }

  async step(name, fn) {
    const step = this.steps.find(s => s.name === name);
    if (!step) throw new Error(`Unknown step ${name}`);
    step.status = 'running';
    step.startedAt = Date.now();
    try {
      const value = await fn(step);
      step.status = 'done';
      step.ms = Date.now() - step.startedAt;
      return value;
    } catch (e) {
      step.status = 'failed';
      step.ms = Date.now() - step.startedAt;
      step.detail = e.message;
      throw e;
    }
  }

  note(name, detail) {
    const step = this.steps.find(s => s.name === name);
    if (step) step.detail = detail;
  }

  finish(result) {
    this.state = 'done';
    this.result = result;
    this.endedAt = Date.now();
  }

  fail(error) {
    this.state = 'failed';
    this.error = error?.message ?? String(error);
    this.endedAt = Date.now();
  }

  get progress() {
    if (!this.steps.length) return 0;
    const done = this.steps.filter(s => s.status === 'done' || s.status === 'failed').length;
    return Math.round((done / this.steps.length) * 100);
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      state: this.state,
      progress: this.progress,
      steps: this.steps,
      result: this.result ? Object.fromEntries(Object.entries(this.result).filter(([key])=>key!=='zip')) : null,
      error: this.error,
      meta: this.meta,
      elapsedMs: (this.endedAt ?? Date.now()) - this.startedAt,
    };
  }
}

const jobs = new Map();

export function createJob(type, meta) {
  const job = new Job(type, meta);
  jobs.set(job.id, job);
  // Keep the newest 40 jobs; old ones only hold small JSON.
  if (jobs.size > 40) {
    const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    jobs.delete(oldest.id);
  }
  return job;
}

export const getJob = id => jobs.get(id);

/** Rehydrate a job persisted on disk (used after a Studio restart). */
export function restoreJob(record) {
  const job = new Job(record.type ?? 'build');
  Object.assign(job, record);
  jobs.set(job.id, job);
  return job;
}

export const allJobs = () => [...jobs.values()];
