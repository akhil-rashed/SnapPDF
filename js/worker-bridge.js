/**
 * Promise-based RPC bridge to js/pdf-worker.js
 */
class WorkerBridge {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.seq = 1;
  }

  _ensure() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./pdf-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const { id, ok, result, error, progress } = e.data;
        const entry = this.pending.get(id);
        if (!entry) return;
        if (progress !== undefined) {
          if (entry.onProgress) entry.onProgress(progress);
          return;
        }
        this.pending.delete(id);
        if (ok) entry.resolve(result);
        else entry.reject(new Error(error || 'Worker error'));
      };
      this.worker.onerror = (err) => {
        for (const [, entry] of this.pending) {
          entry.reject(new Error(err.message || 'Worker crashed'));
        }
        this.pending.clear();
        this.worker = null;
      };
    }
    return this.worker;
  }

  call(type, payload, onProgress) {
    const w = this._ensure();
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ id, type, payload });
    });
  }
}

export const workerBridge = new WorkerBridge();
