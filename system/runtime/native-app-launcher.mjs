import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_ROOTS = ['/usr/bin', '/usr/local/bin', '/opt/swir/apps'];
const SAFE_ENV = new Set(['HOME','LANG','LC_ALL','LC_CTYPE','PATH','TERM','USER','LOGNAME','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','DBUS_SESSION_BUS_ADDRESS']);

function within(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function sanitizeEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => SAFE_ENV.has(key) && typeof value === 'string'));
}

export function validateLaunchRequest(request, options = {}) {
  if (!request || typeof request !== 'object') throw new Error('launch request must be an object');
  if (request.schema !== 'swir.native-launch/0.1') throw new Error('unsupported launch request schema');
  if (request.executionClass !== 'linux-native') throw new Error('native launcher accepts linux-native only');
  if (!request.appId || !/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(request.appId)) throw new Error('invalid appId');
  if (!path.isAbsolute(request.executable || '')) throw new Error('executable must be an absolute path');
  if (!Array.isArray(request.args) || request.args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('args must be NUL-free strings');

  const roots = (options.allowedRoots || DEFAULT_ROOTS).map(x => path.resolve(x));
  const resolved = fs.realpathSync(request.executable);
  if (!roots.some(root => within(resolved, root))) throw new Error('executable is outside approved native application roots');
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('executable must be a regular file');
  if ((stat.mode & 0o111) === 0) throw new Error('executable is not marked executable');

  const cwd = request.cwd ? fs.realpathSync(request.cwd) : undefined;
  if (cwd && !fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  return { executable: resolved, args: [...request.args], cwd, appId: request.appId };
}

export function launchNativeApp(request, options = {}) {
  const checked = validateLaunchRequest(request, options);
  const child = spawn(checked.executable, checked.args, {
    cwd: checked.cwd,
    env: sanitizeEnvironment(options.environment || process.env),
    shell: false,
    windowsHide: true,
    stdio: options.stdio || 'ignore',
    detached: false
  });
  return { pid: child.pid, child, appId: checked.appId, executable: checked.executable };
}

export const NativeLaunchPolicy = Object.freeze({
  schema: 'swir.native-launch/0.1',
  executionClass: 'linux-native',
  shell: false,
  allowedRoots: [...DEFAULT_ROOTS],
  environmentAllowlist: [...SAFE_ENV]
});
