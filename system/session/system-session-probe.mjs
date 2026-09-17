#!/usr/bin/env node
import { SystemSessionIdentityService } from './system-session-identity-service.mjs';

const compact = process.argv.includes('--compact');
try {
  const service = new SystemSessionIdentityService();
  const inventory = await service.inventory();
  process.stdout.write(`${JSON.stringify(inventory, null, compact ? 0 : 2)}\n`);
} catch (error) {
  const report = {
    schema: 'swir.system-session-inventory/0.1',
    provider: 'systemd-logind',
    available: false,
    readOnly: true,
    mutationCapable: false,
    arbitrarySessionOverride: false,
    secretsExposed: false,
    sessions: [],
    activeActor: null,
    probe: { available: false, trustedBinary: false, reason: String(error?.code || 'probe-failed') }
  };
  process.stdout.write(`${JSON.stringify(report, null, compact ? 0 : 2)}\n`);
}
