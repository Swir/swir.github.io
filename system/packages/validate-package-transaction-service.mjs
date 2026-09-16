import fs from 'node:fs';
import path from 'node:path';

const packageDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const systemDir = path.dirname(packageDir);
const contractsDir = path.join(systemDir, 'contracts');
const readJson = name => JSON.parse(fs.readFileSync(path.join(contractsDir, name), 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const journal = readJson('package-transaction-journal.schema.json');
const plan = readJson('distribution-package-plan.schema.json');
const service = fs.readFileSync(path.join(packageDir, 'package-transaction-service.mjs'), 'utf8');
const executor = fs.readFileSync(path.join(packageDir, 'privileged-package-executor.mjs'), 'utf8');

assert(journal.$schema?.includes('2020-12'), 'package transaction journal must use JSON Schema 2020-12');
assert(journal.properties?.schema?.const === 'swir.system-package-transaction/0.1', 'package transaction journal schema mismatch');
assert(journal.properties?.plan?.$ref === './distribution-package-plan.schema.json', 'journal must bind to the distribution package plan contract');
assert(journal.properties?.planDigest?.pattern === '^[a-f0-9]{64}$', 'journal must require SHA-256 plan digest');
assert(journal.properties?.authorization?.properties?.scope?.const === 'packages.mutate', 'journal must bind the mutation authorization scope');
assert(journal.properties?.recovery?.properties?.rollbackCommand, 'journal must expose recovery metadata');
assert(plan.properties?.transaction?.properties?.journalRequired?.const === true, 'system package plans must require a journal');
assert(plan.properties?.transaction?.properties?.requiresPrivilege?.const === true, 'system package plans must require privilege');

for (const phrase of [
  'repository signature verification must remain required',
  'distribution repository is not allowlisted for privileged mutation',
  'package mutation must require a durable journal',
  'authorization denied for ${scope}',
  'trust, authorization and pre-mutation snapshot captured',
  'package transaction command does not match the trusted provider plan',
  'automatic rollback is currently limited to rpm-ostree deployment rollback',
  'JOURNAL_PLAN_DIGEST_MISMATCH',
  'failed-needs-recovery',
  'packages.recover'
]) assert(service.includes(phrase), `package transaction service missing fail-closed boundary: ${phrase}`);

assert(service.includes('fs.fsyncSync'), 'package transaction journal must fsync data before atomic replacement');
assert(service.includes('fs.renameSync'), 'package transaction journal must use atomic rename');
assert(service.includes('mode: 0o600'), 'package transaction journal must request owner-only file mode');
assert(!service.includes('node:child_process'), 'transaction orchestrator must not directly spawn privileged processes');
for (const forbidden of ['exec(', 'execSync(', 'spawn(', 'spawnSync(', 'shell: true']) {
  assert(!service.includes(forbidden), `transaction orchestrator contains forbidden direct execution primitive: ${forbidden}`);
}

assert(executor.includes("from 'node:child_process'"), 'privileged executor must use an explicit process API');
assert(executor.includes("pkexecPath = '/usr/bin/pkexec'"), 'privileged executor must use the polkit pkexec transport by default');
assert(executor.includes('shell: false'), 'privileged executor must explicitly disable shell execution');
assert(executor.includes('EXECUTABLE_NOT_ROOT_OWNED'), 'privileged executor must verify root ownership');
assert(executor.includes('EXECUTABLE_WRITABLE_BY_NON_ROOT'), 'privileged executor must reject group/world-writable executables');
assert(executor.includes('COMMAND_MISMATCH'), 'privileged executor must independently validate package-manager command shape');
assert(executor.includes("PATH: '/usr/sbin:/usr/bin:/sbin:/bin'"), 'privileged executor must provide a fixed PATH');
assert(!executor.includes('shell: true'), 'privileged executor must never enable shell execution');
for (const forbidden of ['exec(', 'execSync(', 'spawnSync(', 'sudo ']) {
  assert(!executor.includes(forbidden), `privileged executor contains forbidden primitive: ${forbidden}`);
}

console.log('SWIR System Package Transaction Service contract validation: OK');
console.log('Mutation boundary: signed/allowlisted repository + authorization + pre-mutation snapshot + durable journal');
console.log('Privileged transport: guarded pkexec with shell=false and root-owned allowlisted executables');
console.log('Automatic rollback: rpm-ostree deployment rollback only; other managers fail closed to recovery-needed state');
