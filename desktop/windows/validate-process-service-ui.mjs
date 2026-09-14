import fs from 'node:fs';

const runtime = fs.readFileSync('swir-runtime.js', 'utf8');
const taskmgr = fs.readFileSync('swir-taskmgr.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

const requireText = (text, needle, message) => {
  if (!text.includes(needle)) throw new Error(message || `Missing required contract fragment: ${needle}`);
};

requireText(runtime, "const processes = Object.freeze({ list:", 'SwirRuntime process surface missing');
requireText(taskmgr, 'parent.SwirRuntime', 'Task Manager must consume the portable runtime');
requireText(taskmgr, 'rt.processes.list()', 'Task Manager must request process inventory through SwirRuntime');
requireText(taskmgr, "surfaces?.processes?.native", 'Task Manager must detect native process provider');
requireText(taskmgr, "if(!b||native())return", 'Native process mutation must remain disabled in Task Manager');
requireText(taskmgr, 'READ-ONLY NATIVE PROCESS INVENTORY', 'Desktop read-only policy must be visible in Task Manager');
requireText(sw, "'./swir-taskmgr.html'", 'Task Manager must remain in the offline core cache');

if (/SWIR_NATIVE_HOST\.processes/i.test(taskmgr))
  throw new Error('Task Manager must not bypass SwirRuntime and call SWIR_NATIVE_HOST directly');

console.log('Desktop Task Manager native process UI contract: OK');
