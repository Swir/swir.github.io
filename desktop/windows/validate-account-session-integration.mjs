import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const program = read('desktop/windows/Program.cs');
const permission = read('desktop/windows/PermissionBroker.cs');
const broker = read('desktop/windows/DesktopAccountSessionBroker.cs');

function requireText(source, text, message) {
  if (!source.includes(text)) throw new Error(message);
}

function forbidText(source, text, message) {
  if (source.includes(text)) throw new Error(message);
}

requireText(program, 'private readonly DesktopAccountSessionBroker _identity;', 'Desktop Host must own one account/session broker for the lifetime of the host session.');
requireText(program, '_identity = new DesktopAccountSessionBroker(_capabilities.SessionId);', 'Desktop Host must bind identity snapshots to the native host session id.');
requireText(program, '"identity" => DispatchIdentityAsync(request.Method)', 'Native bridge dispatch must route the identity surface.');
requireText(program, '"info" => _identity.Describe()', 'identity.info must use the native broker.');
requireText(program, '"account" => _identity.Account()', 'identity.account must use the native broker.');
requireText(program, '"session" => _identity.Session()', 'identity.session must use the native broker.');
requireText(program, "nativeAccountSession: true", 'Native Host feature flags must advertise account/session support.');
requireText(program, "identity: surface('identity', ['info','account','session'])", 'SWIR_NATIVE_HOST must expose only read-only identity methods.');

requireText(permission, '("identity", "info" or "account" or "session") => "identity.inspect"', 'Identity methods must remain protected by identity.inspect.');
requireText(permission, '"identity.inspect"', 'identity.inspect permission must exist.');

for (const mutation of ['login','logout','setPassword','changePassword','createAccount','removeAccount','unlock']) {
  forbidText(program, `identity', ['${mutation}`, `Unsafe identity mutation exposed through SWIR_NATIVE_HOST: ${mutation}`);
  forbidText(program, `\"${mutation}\" => _identity`, `Unsafe native identity mutation dispatch exposed: ${mutation}`);
}

for (const secret of ['Password','Pin','Credential','AccessToken','RefreshToken','SecurityIdentifier','ProfilePath','HomeDirectory']) {
  forbidText(broker, `${secret}:`, `Identity broker must not expose secret/sensitive field ${secret}.`);
}

requireText(broker, 'readOnly = true', 'Native identity descriptor must remain explicitly read-only.');
requireText(broker, 'accountManagement = false', 'Native identity descriptor must not claim account-management capability.');
requireText(broker, 'credentialExposure = false', 'Native identity descriptor must explicitly deny credential exposure.');

console.log('Desktop account/session Host integration contract OK.');
