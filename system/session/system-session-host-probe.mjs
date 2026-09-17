#!/usr/bin/env node
import { SystemSessionIdentityService } from './system-session-identity-service.mjs';

const compact = process.argv.includes('--compact');
for (const arg of process.argv.slice(2)) {
  if (arg !== '--compact') throw new Error(`Unknown argument: ${arg}`);
}

const service = new SystemSessionIdentityService();
const probe = await service.probe();
let inventory = null;
let active = null;
let diagnosis = null;

if (probe.available) {
  try {
    inventory = await service.inventory();
    try {
      active = await service.resolveActiveSession();
    } catch (error) {
      diagnosis = { code: error?.code || 'ACTIVE_SESSION_PROBE_FAILED', message: String(error?.message || '') };
    }
  } catch (error) {
    diagnosis = { code: error?.code || 'SESSION_INVENTORY_FAILED', message: String(error?.message || '') };
  }
}

const report = {
  schema: 'swir.system-session-host-probe/0.1',
  readOnly: true,
  provider: 'systemd-logind',
  generatedAt: new Date().toISOString(),
  probe,
  inventory: inventory ? {
    schema: inventory.schema,
    available: inventory.available,
    sessionCount: inventory.sessions.length,
    eligibleLocalSessions: inventory.sessions.filter(item => item.eligible).length,
    graphicalSessions: inventory.sessions.filter(item => item.graphical).length,
    secretsExposed: inventory.secretsExposed
  } : null,
  activeSession: active,
  diagnosis,
  mutationPerformed: false,
  authenticationPerformed: false,
  privilegeGranted: false
};

process.stdout.write(`${JSON.stringify(report, null, compact ? 0 : 2)}\n`);
