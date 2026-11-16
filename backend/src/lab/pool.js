import { Worker } from 'node:worker_threads';

/** Small fixed-size worker-thread pool. Tasks queue when all threads are busy. */
export class WorkerPool {
  constructor(file, size = 2) {
    this.file = file; this.size = size; this.idle = []; this.queue = []; this.all = []; this.completed = 0;
    for (let i = 0; i < size; i++) this.#add();
  }
  #add() {
    const w = new Worker(this.file);
    w.on('message', (m) => { const job = w._job; w._job = null; this.completed++; job?.resolve(m); this.idle.push(w); this.#dispatch(); });
    w.on('error', (e) => { const job = w._job; w._job = null; job?.reject(e); this.all = this.all.filter((x) => x !== w); this.idle = this.idle.filter((x) => x !== w); this.#add(); this.#dispatch(); });
    this.all.push(w); this.idle.push(w);
  }
  run(op, arg) { return new Promise((resolve, reject) => { this.queue.push({ op, arg, resolve, reject }); this.#dispatch(); }); }
  #dispatch() { while (this.idle.length && this.queue.length) { const w = this.idle.pop(); const job = this.queue.shift(); w._job = job; w.postMessage({ op: job.op, arg: job.arg }); } }
  stats() { return { threads: this.all.length, busy: this.all.length - this.idle.length, queued: this.queue.length, completed: this.completed }; }
  async close() { await Promise.all(this.all.map((w) => w.terminate())); }
}
