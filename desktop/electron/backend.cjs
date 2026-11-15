const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createInterface } = require('node:readline');

class Backend extends EventEmitter {
  constructor(command, args, options = {}) {
    super();
    this.pending = new Map();
    this.serial = 0;
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', data => process.stderr.write(data));
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if ('hostResult' in message) {
          const waiter = this.pending.get(message.hostResult);
          if (waiter) {
            clearTimeout(waiter.timer);
            this.pending.delete(message.hostResult);
            message.error ? waiter.reject(new Error(message.error)) : waiter.resolve(message.result);
          }
        } else if (message.native) this.emit('native', message);
        else this.emit('message', line);
      } catch (error) { console.error('Invalid sidecar response:', error); }
    });
    const fail = error => {
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      this.pending.clear();
      if (!this.stopping) this.emit('failure', error);
    };
    this.child.on('error', fail);
    this.child.on('exit', (code, signal) => fail(new Error(`Python service exited (${code ?? signal})`)));
  }
  send(message) {
    if (!this.child.stdin.writable || this.child.exitCode !== null) throw new Error('Python service unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(action, fields = {}, timeout = 30000) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Sidecar ${action} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ _host: action, id, ...fields }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async stop() {
    this.stopping = true;
    if (this.child.exitCode !== null) return;
    try { await this.request('shutdown', {}, 5000); } catch {}
    this.child.stdin.end();
    await new Promise(resolve => {
      if (this.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 10000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
module.exports = { Backend };
