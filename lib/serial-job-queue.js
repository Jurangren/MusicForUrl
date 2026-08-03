class SerialJobQueue {
  constructor() {
    this.pending = [];
    this.runningId = null;
  }

  enqueue(jobId) {
    const id = String(jobId || '');
    if (!id || this.runningId === id || this.pending.includes(id)) return false;
    this.pending.push(id);
    return true;
  }

  startNext() {
    if (this.runningId || this.pending.length === 0) return null;
    this.runningId = this.pending.shift();
    return this.runningId;
  }

  finish(jobId) {
    if (this.runningId !== String(jobId || '')) return false;
    this.runningId = null;
    return true;
  }

  remove(jobId) {
    const id = String(jobId || '');
    const index = this.pending.indexOf(id);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  position(jobId) {
    const id = String(jobId || '');
    if (this.runningId === id) return 0;
    const index = this.pending.indexOf(id);
    return index < 0 ? -1 : index + 1;
  }

  get length() {
    return this.pending.length;
  }
}

module.exports = { SerialJobQueue };
