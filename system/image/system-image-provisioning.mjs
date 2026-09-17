import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fsp = fs.promises;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(HERE, 'system-image-provisioning.json');
const STATE_SCHEMA = 'swir.system-image-provisioning-state/0.1';
const REPORT_SCHEMA = 'swir.system-image-provisioning-report/0.1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MODE = /^0[0-7]{3}$/;

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'SystemImageProvisioningError';
  error.code = code;
  throw error;
}
function ensure(value, code, message) { if (!value) fail(code, message); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function mode(value) {
  ensure(typeof value === 'string' && SAFE_MODE.test(value), 'INVALID_IMAGE_MODE', `invalid image mode ${value}`);
  return Number.parseInt(value, 8);
}
function imagePath(value) {
  ensure(typeof value === 'string' && value.startsWith('/') && value !== '/' && !value.includes('\0'), 'INVALID_IMAGE_PATH', 'managed image path must be absolute and non-root');
  ensure(path.posix.normalize(value) === value && !value.split('/').includes('..'), 'INVALID_IMAGE_PATH', `image path is not canonical: ${value}`);
  return value;
}
function target(rootfs, value) {
  imagePath(value);
  const out = path.resolve(rootfs, `.${value}`);
  ensure(out.startsWith(`${rootfs}${path.sep}`), 'IMAGE_PATH_ESCAPE', `image path escapes rootfs: ${value}`);
  return out;
}
async function safeRoot(rootfs) {
  ensure(typeof rootfs === 'string' && path.isAbsolute(rootfs), 'ROOTFS_PATH_REQUIRED', 'rootfs must be an explicit absolute path');
  const resolved = path.resolve(rootfs);
  ensure(resolved !== path.parse(resolved).root, 'REAL_ROOT_TARGET_FORBIDDEN', 'refusing to provision the live filesystem root');
  let stat;
  try { stat = await fsp.lstat(resolved); } catch (error) { fail('ROOTFS_UNAVAILABLE', `rootfs is unavailable: ${resolved}`, error); }
  ensure(stat.isDirectory() && !stat.isSymbolicLink(), 'ROOTFS_INVALID', 'rootfs must be a real directory, not a symlink');
  ensure(await fsp.realpath(resolved) === resolved, 'ROOTFS_SYMLINKED', 'rootfs must resolve exactly to the requested directory');
  return resolved;
}
async function noSymlinkAncestors(rootfs, destination) {
  const relative = path.relative(rootfs, destination);
  ensure(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'IMAGE_PATH_ESCAPE', 'managed path escaped rootfs');
  let current = rootfs;
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fsp.lstat(current);
      ensure(!stat.isSymbolicLink(), 'IMAGE_PATH_SYMLINK_ANCESTOR', `managed image path traverses a symlink: ${current}`);
      if (i < parts.length - 1) ensure(stat.isDirectory(), 'IMAGE_PATH_ANCESTOR_INVALID', `non-directory ancestor: ${current}`);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}
function validateRepositoryPolicy(raw) {
  let policy;
  try { policy = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
  catch (error) { fail('REPOSITORY_POLICY_INVALID_JSON', 'repository trust policy is invalid JSON', error); }
  ensure(policy?.schema === 'swir.system-repository-trust-policy/0.1', 'REPOSITORY_POLICY_SCHEMA_INVALID', 'repository trust policy schema is invalid');
  ensure(SAFE_ID.test(policy.defaultRepositoryId || ''), 'REPOSITORY_POLICY_DEFAULT_INVALID', 'default repository id is invalid');
  ensure(Array.isArray(policy.repositories) && policy.repositories.length > 0, 'REPOSITORY_POLICY_EMPTY', 'at least one repository is required');
  let defaultSeen = false;
  for (const repo of policy.repositories) {
    ensure(repo && SAFE_ID.test(repo.id || ''), 'REPOSITORY_POLICY_ENTRY_INVALID', 'repository id is invalid');
    defaultSeen ||= repo.id === policy.defaultRepositoryId;
    ensure(['apt', 'dnf', 'rpm-ostree', 'pacman', 'zypper'].includes(repo.manager), 'REPOSITORY_POLICY_MANAGER_INVALID', `unsupported package manager for ${repo.id}`);
    ensure(typeof repo.nativeId === 'string' && repo.nativeId.length > 0 && repo.nativeId.length <= 512 && !repo.nativeId.includes('example.invalid'), 'EXAMPLE_REPOSITORY_POLICY_FORBIDDEN', `repository ${repo.id} requires a real native repository id`);
    ensure(['distribution-repository', 'vendor-official-repository'].includes(repo.sourceClass), 'REPOSITORY_POLICY_SOURCE_INVALID', `repository ${repo.id} source is not approved`);
    ensure(repo.signatureVerification === 'native-required' && repo.allowInsecure === false && repo.enabled === true, 'REPOSITORY_POLICY_INSECURE', `repository ${repo.id} must be enabled with native signature verification and insecure mode disabled`);
    ensure(Array.isArray(repo.distributions) && repo.distributions.length > 0 && repo.distributions.every(item => SAFE_ID.test(item)), 'REPOSITORY_DISTRIBUTIONS_INVALID', `repository ${repo.id} distributions are invalid`);
  }
  ensure(defaultSeen, 'REPOSITORY_POLICY_DEFAULT_MISSING', 'default repository does not exist');
  return policy;
}
function validateManifest(manifest) {
  ensure(manifest?.schema === 'swir.system-image-provisioning-manifest/0.1' && manifest.target === 'linux-rootfs', 'IMAGE_MANIFEST_SCHEMA_INVALID', 'image provisioning manifest is invalid');
  ensure(manifest.productionOwnerUid === 0, 'IMAGE_OWNER_POLICY_INVALID', 'production owner must be root');
  ensure(Array.isArray(manifest.directories) && Array.isArray(manifest.files) && manifest.directories.length && manifest.files.length, 'IMAGE_MANIFEST_EMPTY', 'manifest requires directories and files');
  const seen = new Set();
  for (const entry of manifest.directories) { imagePath(entry.path); mode(entry.mode); ensure(!seen.has(entry.path), 'DUPLICATE_IMAGE_PATH', `duplicate ${entry.path}`); seen.add(entry.path); }
  for (const entry of manifest.files) {
    ensure(SAFE_ID.test(entry.id || ''), 'INVALID_IMAGE_ARTIFACT_ID', 'artifact id is invalid'); imagePath(entry.path); mode(entry.mode);
    ensure(!seen.has(entry.path), 'DUPLICATE_IMAGE_PATH', `duplicate ${entry.path}`); seen.add(entry.path);
    ensure(['repository-source', 'deployment-input'].includes(entry.kind), 'INVALID_IMAGE_ARTIFACT_KIND', `unsupported kind ${entry.kind}`);
    if (entry.kind === 'repository-source') {
      ensure(typeof entry.source === 'string' && !path.isAbsolute(entry.source) && !entry.source.split(/[\\/]/).includes('..'), 'INVALID_IMAGE_SOURCE', `source for ${entry.id} escapes repository`);
      ensure(Array.isArray(entry.requiredActionIds) && entry.requiredActionIds.length > 0, 'POLKIT_ACTIONS_REQUIRED', `policy ${entry.id} requires action ids`);
    } else ensure(entry.input === 'repositoryTrustPolicy', 'UNKNOWN_DEPLOYMENT_INPUT', 'only repositoryTrustPolicy deployment input is supported');
  }
  imagePath(manifest.generatedState?.path); mode(manifest.generatedState?.mode);
  ensure(manifest.generatedState?.schema === STATE_SCHEMA, 'IMAGE_STATE_SCHEMA_INVALID', 'generated state schema is invalid');
  const p = manifest.policy || {};
  ensure(p.allowRealRootTarget === false && p.allowSymlinkDestinations === false && p.allowArbitraryUrls === false && p.allowExampleRepositoryPolicy === false && p.shellExecution === false && p.productionRequiresRoot === true && p.repositorySignatureVerificationRequired === true, 'IMAGE_SECURITY_POLICY_WEAKENED', 'manifest security policy is weaker than SWIR System 0.1');
  return manifest;
}
export async function loadSystemImageProvisioningManifest(manifestPath = DEFAULT_MANIFEST) {
  return validateManifest(JSON.parse(await fsp.readFile(manifestPath, 'utf8')));
}
async function trustedSource(sourceRoot, relative) {
  const root = await fsp.realpath(sourceRoot);
  const source = path.resolve(root, relative);
  ensure(source.startsWith(`${root}${path.sep}`), 'IMAGE_SOURCE_ESCAPE', `source escapes repository: ${relative}`);
  const stat = await fsp.lstat(source);
  ensure(stat.isFile() && !stat.isSymbolicLink() && await fsp.realpath(source) === source, 'IMAGE_SOURCE_INVALID', `source must be a regular non-symlink file: ${relative}`);
  return source;
}
function validatePolicyXml(content, actionIds, id) {
  const text = Buffer.from(content).toString('utf8');
  for (const action of actionIds) ensure(text.includes(`action id="${action}"`), 'POLKIT_ACTION_MISSING', `${id} is missing ${action}`);
  ensure(!/<allow_(any|inactive|active)>\s*yes\s*<\/allow_/.test(text), 'POLKIT_POLICY_UNSAFE', `${id} contains an unauthenticated allow rule`);
}
async function atomicWrite(destination, content, fileMode) {
  try { const stat = await fsp.lstat(destination); ensure(!stat.isSymbolicLink() && stat.isFile(), 'IMAGE_DESTINATION_INVALID', `unsafe destination ${destination}`); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try { await fsp.writeFile(temp, content, { mode: fileMode, flag: 'wx' }); await fsp.chmod(temp, fileMode); await fsp.rename(temp, destination); }
  finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
}
async function chownIfProduction(targetPath, uid, production) { if (production) await fsp.chown(targetPath, uid, 0); }

export async function stageSystemImageFoundation({ rootfs, sourceRoot, deploymentInputs = {}, manifestPath = DEFAULT_MANIFEST, production = false, clock = () => new Date().toISOString() } = {}) {
  const root = await safeRoot(rootfs);
  ensure(typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot), 'SOURCE_ROOT_REQUIRED', 'sourceRoot must be an absolute repository root');
  if (production) {
    ensure(typeof process.getuid === 'function' && process.getuid() === 0, 'PRODUCTION_REQUIRES_ROOT', 'production provisioning must run as root');
    const rootStat = await fsp.lstat(root);
    ensure(rootStat.uid === 0 && (rootStat.mode & 0o022) === 0, 'PRODUCTION_ROOTFS_UNTRUSTED', 'production rootfs must be root-owned and not group/world writable');
  }
  const manifest = await loadSystemImageProvisioningManifest(manifestPath);
  const ownerUid = production ? 0 : (typeof process.getuid === 'function' ? process.getuid() : null);
  ensure(Number.isInteger(ownerUid) && ownerUid >= 0, 'IMAGE_OWNER_UID_UNAVAILABLE', 'cannot determine image owner uid');

  for (const entry of manifest.directories) {
    const destination = target(root, entry.path);
    await noSymlinkAncestors(root, destination);
    try { const stat = await fsp.lstat(destination); ensure(stat.isDirectory() && !stat.isSymbolicLink(), 'IMAGE_DESTINATION_INVALID', `unsafe directory ${entry.path}`); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; await fsp.mkdir(destination, { recursive: true, mode: mode(entry.mode) }); }
    await noSymlinkAncestors(root, destination); await fsp.chmod(destination, mode(entry.mode)); await chownIfProduction(destination, ownerUid, production);
  }

  const artifacts = [];
  for (const entry of manifest.files) {
    const destination = target(root, entry.path);
    await noSymlinkAncestors(root, destination); await fsp.mkdir(path.dirname(destination), { recursive: true }); await noSymlinkAncestors(root, destination);
    let content;
    if (entry.kind === 'repository-source') {
      content = await fsp.readFile(await trustedSource(sourceRoot, entry.source)); validatePolicyXml(content, entry.requiredActionIds, entry.id);
    } else {
      const input = deploymentInputs[entry.input];
      ensure(typeof input === 'string' && path.isAbsolute(input), 'DEPLOYMENT_INPUT_REQUIRED', `${entry.input} must be an absolute file`);
      const stat = await fsp.lstat(input); ensure(stat.isFile() && !stat.isSymbolicLink(), 'DEPLOYMENT_INPUT_INVALID', `${entry.input} must be a regular non-symlink file`);
      content = await fsp.readFile(input); validateRepositoryPolicy(content);
    }
    await atomicWrite(destination, content, mode(entry.mode)); await chownIfProduction(destination, ownerUid, production);
    artifacts.push({ id: entry.id, path: entry.path, sha256: digest(content), bytes: content.length });
  }

  const manifestRaw = await fsp.readFile(manifestPath);
  const state = { schema: STATE_SCHEMA, profile: manifest.profile, target: manifest.target, production, ownerUid, generatedAt: clock(), manifestSha256: digest(manifestRaw), artifacts };
  const stateFile = target(root, manifest.generatedState.path);
  await noSymlinkAncestors(root, stateFile); await atomicWrite(stateFile, Buffer.from(`${JSON.stringify(state, null, 2)}\n`), mode(manifest.generatedState.mode)); await chownIfProduction(stateFile, ownerUid, production);
  const report = await verifySystemImageFoundation({ rootfs: root, manifestPath, production, expectedOwnerUid: ownerUid });
  ensure(report.ready, 'IMAGE_PROVISIONING_VERIFICATION_FAILED', `staging verification failed: ${report.blockers.join(', ')}`);
  return Object.freeze({ ...report, staged: true, state });
}
async function inspect(destination, expectedMode, ownerUid, directory) {
  try {
    const stat = await fsp.lstat(destination);
    if (stat.isSymbolicLink()) return { trusted: false, reason: 'symlink' };
    const typeOk = directory ? stat.isDirectory() : stat.isFile();
    const actualMode = stat.mode & 0o777;
    const ownerOk = ownerUid === null || typeof stat.uid !== 'number' || stat.uid === ownerUid;
    return { trusted: typeOk && actualMode === expectedMode && ownerOk, typeOk, ownerOk, ownerUid: typeof stat.uid === 'number' ? stat.uid : null, mode: actualMode.toString(8).padStart(4, '0') };
  } catch (error) { return { trusted: false, reason: error?.code === 'ENOENT' ? 'missing' : String(error?.code || 'probe-error') }; }
}
export async function verifySystemImageFoundation({ rootfs, manifestPath = DEFAULT_MANIFEST, production = false, expectedOwnerUid = production ? 0 : (typeof process.getuid === 'function' ? process.getuid() : null) } = {}) {
  const root = await safeRoot(rootfs); const manifest = await loadSystemImageProvisioningManifest(manifestPath); const checks = [];
  const rootStat = await fsp.lstat(root);
  checks.push({ id: 'rootfs-ownership', required: true, passed: !production || (rootStat.uid === 0 && (rootStat.mode & 0o022) === 0), detail: { ownerUid: rootStat.uid ?? null, mode: (rootStat.mode & 0o777).toString(8).padStart(4, '0'), production } });
  for (const entry of manifest.directories) {
    const destination = target(root, entry.path); let ancestorsSafe = true; try { await noSymlinkAncestors(root, destination); } catch { ancestorsSafe = false; }
    const result = await inspect(destination, mode(entry.mode), expectedOwnerUid, true); checks.push({ id: `dir:${entry.path}`, required: true, passed: ancestorsSafe && result.trusted, detail: { ...result, ancestorsSafe } });
  }
  const stateFile = target(root, manifest.generatedState.path); let state = null;
  try { state = JSON.parse(await fsp.readFile(stateFile, 'utf8')); } catch {}
  const stateOk = state?.schema === STATE_SCHEMA && state?.profile === manifest.profile && Array.isArray(state?.artifacts);
  checks.push({ id: 'provisioning-state-shape', required: true, passed: stateOk, detail: { schema: state?.schema || null } });
  const recorded = new Map((state?.artifacts || []).map(item => [item?.id, item]));
  for (const entry of manifest.files) {
    const destination = target(root, entry.path); let ancestorsSafe = true; try { await noSymlinkAncestors(root, destination); } catch { ancestorsSafe = false; }
    const result = await inspect(destination, mode(entry.mode), expectedOwnerUid, false); let stateBound = false; let semanticOk = false; let sha256 = null;
    if (result.trusted) try {
      const content = await fsp.readFile(destination); sha256 = digest(content); const binding = recorded.get(entry.id);
      stateBound = binding?.path === entry.path && binding?.sha256 === sha256 && binding?.bytes === content.length;
      if (entry.kind === 'repository-source') validatePolicyXml(content, entry.requiredActionIds, entry.id); else validateRepositoryPolicy(content);
      semanticOk = true;
    } catch {}
    checks.push({ id: `file:${entry.id}`, required: true, passed: ancestorsSafe && result.trusted && stateBound && semanticOk, detail: { ...result, ancestorsSafe, sha256, stateBound, semanticOk } });
  }
  let stateAncestorsSafe = true; try { await noSymlinkAncestors(root, stateFile); } catch { stateAncestorsSafe = false; }
  const stateProbe = await inspect(stateFile, mode(manifest.generatedState.mode), expectedOwnerUid, false);
  checks.push({ id: 'provisioning-state-file', required: true, passed: stateAncestorsSafe && stateProbe.trusted, detail: { ...stateProbe, ancestorsSafe: stateAncestorsSafe } });
  if (stateOk) {
    const actualManifest = digest(await fsp.readFile(manifestPath));
    checks.push({ id: 'manifest-digest', required: true, passed: state.manifestSha256 === actualManifest, detail: { recorded: state.manifestSha256, actual: actualManifest } });
    checks.push({ id: 'production-mode-binding', required: true, passed: state.production === production && state.ownerUid === expectedOwnerUid, detail: { stateProduction: state.production, expectedProduction: production, stateOwnerUid: state.ownerUid, expectedOwnerUid } });
  }
  const blockers = checks.filter(item => item.required && !item.passed).map(item => item.id);
  return Object.freeze({ schema: REPORT_SCHEMA, readOnlyVerification: true, production, rootfs: root, ready: blockers.length === 0, bootableImageClaim: false, checks, blockers });
}
export const SystemImageProvisioningPolicy = Object.freeze({ schema: 'swir.system-image-provisioning-policy/0.1', manifestPath: DEFAULT_MANIFEST, explicitRootfsRequired: true, liveRootTargetAllowed: false, symlinkDestinationsAllowed: false, arbitraryUrlsAllowed: false, exampleRepositoryPolicyAllowed: false, repositorySignatureVerificationRequired: true, productionRequiresRoot: true, shellExecution: false, bootableImageClaim: false });
