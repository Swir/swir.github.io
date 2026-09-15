import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const program = read('./Program.cs');
const broker = read('./PermissionBroker.cs');
const policy = read('./ExecutionPolicyCatalog.cs');
const tests = read('./PermissionBrokerSelfTests.cs');

const requireText = (text, needle, message) => {
  if (!text.includes(needle)) throw new Error(message);
};

// Source identity must dominate any caller-supplied execution token for packages.
requireText(program, 'var trustedShell = IsTrustedShellSource(e.Source);', 'Host must classify the WebView source before dispatch.');
requireText(program, 'if (trustedShell)\n                    effectiveToken = request.ContextToken;', 'Only the trusted shell may present its host execution token.');
requireText(program, '_isolation.TryResolveEntrySource(e.Source, out var packageId)', 'Package calls must resolve identity from the isolated entry source.');
requireText(program, 'effectiveToken = _permissions.RequirePackageExecutionToken(packageId);', 'Package calls must replace caller tokens with the host-owned package token.');
requireText(program, 'else\n                    return;', 'Unknown WebView sources must fail closed before native dispatch.');

// Every ordinary native surface must pass the permission broker.
requireText(program, '_permissions.Authorize(effectiveToken, request.Surface, request.Method, RequestedOwner(request));', 'Native dispatch must pass PermissionBroker authorization.');
requireText(program, 'SHELL_INTEGRATION_FORBIDDEN', 'Shell integration must remain trusted-shell-only.');
requireText(program, '_permissions.AuthorizePackageTarget(callerToken, packageId, "appdata", method);', 'App Data must enforce package ownership.');

// Contexts and capabilities must be session/owner bound and revocable.
requireText(broker, 'EXECUTION_IDENTITY_MISMATCH', 'Permission broker must reject cross-package identity use.');
requireText(broker, 'EXECUTION_SESSION_MISMATCH', 'Permission broker must bind execution contexts to the host session.');
requireText(broker, '_capabilities.RevokeOwner(packageId);', 'Removing or replacing a package context must revoke owner capabilities.');
requireText(broker, 'RUNTIME_UNSUPPORTED', 'Unmapped native methods must fail closed.');

// Package permissions are an explicit allowlist and grants cannot exceed policy declarations.
requireText(policy, 'KnownPackagePermissions', 'Desktop policy must use an explicit package permission allowlist.');
requireText(policy, 'PACKAGE_PERMISSION_UNKNOWN', 'Unknown grants must fail closed.');
requireText(policy, 'PACKAGE_PERMISSION_ESCALATION', 'Undeclared grants must fail closed.');
requireText(policy, 'PACKAGE_POLICY_MISSING', 'Packages without a trusted Desktop policy must fail closed.');

// Regression coverage must include downgrade, uninstall and owner isolation.
for (const marker of [
  'CAPABILITY_OWNER_MISMATCH',
  'CAPABILITY_INVALID',
  'EXECUTION_CONTEXT_INVALID',
  'PACKAGE_CONTEXT_NOT_READY',
  'PACKAGE_PERMISSION_ESCALATION',
  'PACKAGE_PERMISSION_UNKNOWN'
]) {
  requireText(tests, marker, `Permission self-tests are missing ${marker} regression coverage.`);
}

for (const forbidden of ['Process.Kill(', 'Environment.Exit(', 'Registry.LocalMachine', 'HKEY_LOCAL_MACHINE']) {
  if (program.includes(forbidden) || broker.includes(forbidden) || policy.includes(forbidden)) {
    throw new Error(`Sandbox permission boundary contains forbidden privileged escape: ${forbidden}`);
  }
}

console.log('SWIR Desktop sandboxed-permissions contract: PASS');
console.log('- WebView source identity overrides package-supplied context tokens');
console.log('- unknown WebView sources fail closed');
console.log('- native surfaces remain PermissionBroker guarded');
console.log('- App Data and capabilities remain package-owner bound');
console.log('- unknown/undeclared package grants fail closed');
console.log('- downgrade/uninstall invalidation regression coverage present');
