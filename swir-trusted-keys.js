/* SWIR Trusted Key Store 1.0 — portable package publisher trust registry */
(() => {
  'use strict';

  const SCHEMA = 'swir.trust/1.0';
  const STORAGE_KEY = 'swir-trusted-keys-user-v1';
  const SYSTEM_KEYS = Object.freeze([]);

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function normalize(record = {}) {
    return {
      keyId: String(record.keyId || '').trim(),
      name: String(record.name || record.keyId || 'Publisher').trim(),
      algorithm: String(record.algorithm || 'Ed25519').trim(),
      format: String(record.format || 'raw').trim().toLowerCase(),
      publicKey: record.publicKey || null,
      scope: Array.isArray(record.scope) ? record.scope.map(String) : ['*'],
      source: String(record.source || 'user'),
      addedAt: Number(record.addedAt || Date.now())
    };
  }
  function valid(record) {
    const r = normalize(record);
    return !!r.keyId && r.algorithm === 'Ed25519' && ['raw','spki','jwk'].includes(r.format) && !!r.publicKey;
  }
  function loadUser() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value.map(normalize).filter(valid) : [];
    } catch { return []; }
  }
  function saveUser(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.map(normalize).filter(valid)));
  }
  function all() { return [...SYSTEM_KEYS.map(clone), ...loadUser()]; }
  function get(keyId) { return all().find(x => x.keyId === String(keyId || '')) || null; }
  function trustedFor(keyId, packageId) {
    const key = get(keyId);
    if (!key) return { ok:false, state:'UNKNOWN_KEY', key:null, error:'Signing key is not trusted' };
    const scope = key.scope || ['*'];
    const ok = scope.includes('*') || scope.includes(String(packageId || ''));
    return { ok, state:ok ? 'TRUSTED' : 'OUT_OF_SCOPE', key, error:ok ? null : 'Signing key is not trusted for this package' };
  }
  function add(record) {
    const key = normalize({ ...record, source:'user', addedAt:Date.now() });
    if (!valid(key)) throw new Error('Invalid trusted key record');
    if (SYSTEM_KEYS.some(x => x.keyId === key.keyId)) throw new Error('System trust key cannot be replaced');
    const list = loadUser().filter(x => x.keyId !== key.keyId);
    list.push(key); saveUser(list); return clone(key);
  }
  function remove(keyId) {
    if (SYSTEM_KEYS.some(x => x.keyId === keyId)) throw new Error('System trust key cannot be removed');
    const before = loadUser(), after = before.filter(x => x.keyId !== keyId); saveUser(after); return after.length !== before.length;
  }
  function clearUser() { saveUser([]); return true; }
  function info() { return { schema:SCHEMA, systemKeys:SYSTEM_KEYS.length, userKeys:loadUser().length, total:all().length }; }

  window.SwirTrustedKeys = Object.freeze({
    meta:Object.freeze({ name:'SWIR Trusted Key Store', version:'1.0.0', schema:SCHEMA, algorithm:'Ed25519' }),
    all, get, trustedFor, add, remove, clearUser, info
  });
})();
