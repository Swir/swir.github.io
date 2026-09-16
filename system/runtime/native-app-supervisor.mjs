import { EventEmitter } from 'node:events';
import { launchNativeApp } from './native-app-launcher.mjs';

function assertAppId(appId) {
  if (!appId || !/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(appId)) throw new Error('invalid appId');
}

export class NativeAppSupervisor extends EventEmitter {
  #processes = new Map();

  launch(request, options = {}) {
    assertAppId(request?.appId);
    if (this.#processes.has(request.appId)) throw new Error(`application already running: ${request.appId}`);
    const launched = launchNativeApp(request, options);
    const record = {
      appId: launched.appId,
      pid: launched.pid,
      executable: launched.executable,
      state: 'running',
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
      signal: null
    };
    this.#processes.set(record.appId, { record, child: launched.child });
    this.emit('started', { ...record });

    launched.child.once('exit', (code, signal) => {
      const current = this.#processes.get(record.appId);
      if (!current || current.child !== launched.child) return;
      record.state = 'exited';
      record.exitedAt = new Date().toISOString();
      record.exitCode = Number.isInteger(code) ? code : null;
      record.signal = signal || null;
      this.emit('exited', { ...record });
    });
    launched.child.once('error', error => this.emit('processError', { appId: record.appId, pid: record.pid, error }));
    return { ...record };
  }

  list({ includeExited = true } = {}) {
    return [...this.#processes.values()]
      .map(({ record }) => ({ ...record }))
      .filter(record => includeExited || record.state === 'running');
  }

  get(appId) {
    assertAppId(appId);
    const item = this.#processes.get(appId);
    return item ? { ...item.record } : null;
  }

  stop(appId, { signal = 'SIGTERM' } = {}) {
    assertAppId(appId);
    const item = this.#processes.get(appId);
    if (!item) return false;
    if (item.record.state !== 'running') return false;
    if (!['SIGTERM', 'SIGINT'].includes(signal)) throw new Error('unsupported stop signal');
    return item.child.kill(signal);
  }

  forget(appId) {
    assertAppId(appId);
    const item = this.#processes.get(appId);
    if (!item) return false;
    if (item.record.state === 'running') throw new Error('cannot forget a running application');
    return this.#processes.delete(appId);
  }
}

export const NativeSupervisorPolicy = Object.freeze({
  schema: 'swir.native-supervisor/0.1',
  oneProcessPerAppId: true,
  allowedStopSignals: ['SIGTERM', 'SIGINT'],
  shellExecution: false
});
