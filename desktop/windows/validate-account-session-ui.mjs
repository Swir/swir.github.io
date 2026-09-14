import fs from 'node:fs';

const settings = fs.readFileSync('swir-settings.html', 'utf8');
const runtime = fs.readFileSync('swir-runtime.js', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message);
}

function forbidText(source, needle, message) {
  if (source.includes(needle)) throw new Error(message);
}

requireText(settings, 'id="identityMode"', 'Settings must expose identity provider mode.');
requireText(settings, 'id="identityAccount"', 'Settings must expose current account diagnostics.');
requireText(settings, 'id="identityAuth"', 'Settings must expose authentication diagnostics.');
requireText(settings, 'id="identitySession"', 'Settings must expose session diagnostics.');
requireText(settings, 'id="identityPrivilege"', 'Settings must expose privilege diagnostics.');
requireText(settings, 'const runtime=()=>{try{return parent.SwirRuntime}', 'Settings must resolve the portable SwirRuntime surface.');
requireText(settings, 'r.identity.info()', 'Settings must read portable identity info.');
requireText(settings, 'r.identity.account()', 'Settings must read portable account data.');
requireText(settings, 'r.identity.session()', 'Settings must read portable session data.');
requireText(settings, "native?'DESKTOP NATIVE':'WEB FALLBACK'", 'Settings must distinguish native Desktop identity from Web fallback.');
requireText(settings, 'Identity surface is read-only', 'Settings must communicate the read-only identity boundary.');
requireText(settings, 'Credentials, security tokens, PINs and profile paths are never displayed here.', 'Settings must disclose privacy boundaries.');

for (const mutation of ['identity.login(', 'identity.logout(', 'identity.setPassword(', 'identity.changePassword(', 'identity.createAccount(', 'identity.removeAccount(', 'identity.unlock(']) {
  forbidText(settings, mutation, `Settings must not expose privileged identity mutation: ${mutation}`);
}

for (const sensitive of ['securityIdentifier', 'accessToken', 'refreshToken', 'passwordHash', 'profilePath', 'homeDirectory']) {
  forbidText(settings, sensitive, `Settings must not bind sensitive identity field: ${sensitive}`);
}

requireText(runtime, 'const identity = Object.freeze({', 'Portable runtime identity surface is missing.');
requireText(sw, "'./swir-settings.html'", 'System Settings must remain in the offline core cache.');
requireText(sw, 'account-session-ui-0.1.0', 'Service worker cache must be versioned for Account/Session UI cutover.');

console.log('SWIR Desktop Account/Session Settings UI contract: OK');
