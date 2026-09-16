import path from 'node:path';
import { NativeAppSupervisor } from './native-app-supervisor.mjs';

const SYSTEM_PROVIDERS = new Set(['swir.package.system', 'swir.package.flatpak', 'swir.package.appimage']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

export function buildNativeLaunchRequest(manifest, options = {}) {
  assertObject(manifest, 'package manifest');
  if (manifest.schema !== 'swir.package-provider/0.2') throw new Error('unsupported package provider schema');
  if (!Array.isArray(manifest.targetEditions) || !manifest.targetEditions.includes('system')) throw new Error('package does not target System Edition');
  if (manifest.executionClass !== 'linux-native') throw new Error('native package execution accepts linux-native only');
  if (!SYSTEM_PROVIDERS.has(manifest.provider)) throw new Error('unsupported native System Edition provider');
  assertObject(manifest.package, 'package');
  if (typeof manifest.package.nativeEntryPoint !== 'string' || !manifest.package.nativeEntryPoint) throw new Error('nativeEntryPoint is required');
  if (!path.isAbsolute(manifest.package.nativeEntryPoint)) throw new Error('nativeEntryPoint must be an absolute path');
  if (manifest.trust?.signatureRequired !== true) throw new Error('native System Edition package must require signature verification');
  if (options.trustVerified !== true) throw new Error('package trust must be verified before execution');

  return {
    schema: 'swir.native-launch/0.1',
    executionClass: 'linux-native',
    appId: manifest.id,
    executable: manifest.package.nativeEntryPoint,
    args: Array.isArray(options.args) ? [...options.args] : [],
    ...(options.cwd ? { cwd: options.cwd } : {})
  };
}

export class NativePackageExecutionService {
  #supervisor;

  constructor({ supervisor = new NativeAppSupervisor() } = {}) {
    this.#supervisor = supervisor;
  }

  launch(manifest, options = {}) {
    const request = buildNativeLaunchRequest(manifest, options);
    return this.#supervisor.launch(request, {
      allowedRoots: options.allowedRoots,
      environment: options.environment,
      stdio: options.stdio
    });
  }

  list(options) { return this.#supervisor.list(options); }
  get(appId) { return this.#supervisor.get(appId); }
  stop(appId, options) { return this.#supervisor.stop(appId, options); }
  forget(appId) { return this.#supervisor.forget(appId); }
  on(...args) { this.#supervisor.on(...args); return this; }
  once(...args) { this.#supervisor.once(...args); return this; }
}

export const NativePackageExecutionPolicy = Object.freeze({
  schema: 'swir.native-package-execution/0.1',
  acceptedManifest: 'swir.package-provider/0.2',
  targetEdition: 'system',
  executionClass: 'linux-native',
  providers: [...SYSTEM_PROVIDERS],
  trustVerifiedRequired: true,
  signatureRequired: true,
  shellExecution: false
});
