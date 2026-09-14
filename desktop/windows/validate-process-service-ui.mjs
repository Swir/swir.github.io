import fs from 'node:fs';

const runtime = fs.readFileSync('swir-runtime.js', 'utf8');
const taskmgr = fs.readFileSync('swir-taskmgr.html', 'utf8');
const services = fs.readFileSync('swir-services.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

const requireText = (text, needle, message) => {
  if (!text.includes(needle)) throw new Error(message || `Missing required contract fragment: ${needle}`);
};

requireText(runtime, "const processes = Object.freeze({ list:", 'SwirRuntime process surface missing');
requireText(runtime, 'const services = Object.freeze({', 'SwirRuntime services surface missing');
requireText(runtime, "call('services','info'", 'SwirRuntime services.info must route through the portable host adapter');
requireText(runtime, "call('services','list'", 'SwirRuntime services.list must route through the portable host adapter');
requireText(runtime, "'processes','services','clipboard'", 'Runtime capability diagnostics must include services');
requireText(runtime, 'packages,processes,services,clipboard', 'Runtime public API must expose services');

requireText(taskmgr, 'parent.SwirRuntime', 'Task Manager must consume the portable runtime');
requireText(taskmgr, 'rt.processes.list()', 'Task Manager must request process inventory through SwirRuntime');
requireText(taskmgr, "surfaces?.processes?.native", 'Task Manager must detect native process provider');
requireText(taskmgr, "if(!b||native())return", 'Native process mutation must remain disabled in Task Manager');
requireText(taskmgr, 'READ-ONLY NATIVE PROCESS INVENTORY', 'Desktop read-only policy must be visible in Task Manager');

requireText(services, 'parent.SwirRuntime', 'SWIR Services must consume the portable runtime');
requireText(services, 'rt.services.info()', 'SWIR Services must request service metadata through SwirRuntime');
requireText(services, 'rt.services.list()', 'SWIR Services must request service inventory through SwirRuntime');
requireText(services, 'surfaces?.services?.native', 'SWIR Services must detect the native services provider');
requireText(services, 'READ ONLY', 'SWIR Services must visibly communicate native read-only policy');
requireText(services, 'service inventory is intentionally read-only', 'SWIR Services must explain privileged mutation policy');
requireText(sw, "'./swir-taskmgr.html'", 'Task Manager must remain in the offline core cache');
requireText(sw, "'./swir-services.html'", 'SWIR Services must remain in the offline core cache');

if (/SWIR_NATIVE_HOST\.processes/i.test(taskmgr))
  throw new Error('Task Manager must not bypass SwirRuntime and call SWIR_NATIVE_HOST directly');
if (/SWIR_NATIVE_HOST\.services/i.test(services))
  throw new Error('SWIR Services must not bypass SwirRuntime and call SWIR_NATIVE_HOST directly');
if (/\.(start|stop|restart|kill|terminate)\s*\(/i.test(services))
  throw new Error('Native service mutation must remain unavailable in SWIR Services');

console.log('Desktop process/service UI portable runtime contract: OK');
