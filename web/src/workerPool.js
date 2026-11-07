/**
 * Small pool of plan Workers — parallel jobs without SharedArrayBuffer/COEP.
 */
import PlanWorker from './plan.worker.js?worker';

export class PlanWorkerPool {
  constructor(size = 2) {
    this.size = Math.max(1, size);
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.ready = false;
    this.version = null;
  }

  async init() {
    const starts = [];
    for (let i = 0; i < this.size; i++) {
      const w = new PlanWorker();
      this.workers.push(w);
      starts.push(
        new Promise((resolve, reject) => {
          const onMsg = (ev) => {
            if (ev.data.type === 'ready') {
              this.version = ev.data.version;
              w.removeEventListener('message', onMsg);
              this.idle.push(w);
              resolve();
            } else if (ev.data.type === 'error') {
              reject(new Error(ev.data.error));
            }
          };
          w.addEventListener('message', onMsg);
          w.postMessage({ type: 'init' });
        }),
      );
    }
    await Promise.all(starts);
    this.ready = true;
    this.#pump();
    return this.version;
  }

  #pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      this.#run(w, job);
    }
  }

  #run(worker, job) {
    const { payload, transfer, resolve, reject } = job;
    const onMsg = (ev) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        job.onProgress?.(msg.text);
        return;
      }
      worker.removeEventListener('message', onMsg);
      this.idle.push(worker);
      this.#pump();
      if (msg.type === 'done') resolve(msg.result);
      else reject(new Error(msg.error || 'worker failed'));
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage(payload, transfer || []);
  }

  /** Run a plan job; returns Promise<result>. */
  plan(payload, transfer = [], onProgress) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, transfer, resolve, reject, onProgress });
      this.#pump();
    });
  }

  /** Run several independent plan jobs in parallel (up to pool size). */
  planMany(jobs) {
    return Promise.all(
      jobs.map((j) => this.plan(j.payload, j.transfer || [], j.onProgress)),
    );
  }
}
