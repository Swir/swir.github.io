/* SWIR Package Integrity 1.1 — portable package verification + publisher trust */
(() => {
  'use strict';

  const SCHEMA = 'swir.integrity/1.1';
  const SIGNATURE_SCHEMA = 'swir.signature/1.0';

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((out, key) => {
        if (value[key] !== undefined) out[key] = stable(value[key]);
        return out;
      }, {});
    }
    return value;
  }
  function canonicalize(value) { return JSON.stringify(stable(value)); }
  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input === 'string') return new TextEncoder().encode(input);
    return new TextEncoder().encode(canonicalize(input));
  }
  function hex(buffer) { return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join(''); }
  function base64Bytes(value) {
    const clean = String(value || '').replace(/^base64:/i, '').replace(/\s+/g, '');
    const raw = atob(clean); const out = new Uint8Array(raw.length);
    for (let i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i); return out;
  }
  async function sha256(input) {
    if (!globalThis.crypto?.subtle) throw new Error('SHA-256 unavailable in this runtime');
    return hex(await crypto.subtle.digest('SHA-256', toBytes(input)));
  }
  function normalizeDigest(value) { return String(value || '').trim().toLowerCase().replace(/^sha256[-:]/, ''); }
  async function verifyDigest(input, expected) {
    const wanted = normalizeDigest(expected);
    if (!/^[a-f0-9]{64}$/.test(wanted)) return { ok:false, algorithm:'SHA-256', expected:wanted, actual:null, error:'Invalid SHA-256 digest' };
    const actual = await sha256(input);
    return { ok:actual === wanted, algorithm:'SHA-256', expected:wanted, actual, error:actual === wanted ? null : 'Digest mismatch' };
  }
  function manifestPayload(manifest) {
    if (!manifest || typeof manifest !== 'object') throw new Error('Package manifest required');
    const copy = { ...manifest }; delete copy.integrity; delete copy.signature; return copy;
  }
  async function fingerprintManifest(manifest) { return sha256(canonicalize(manifestPayload(manifest))); }
  async function verifyManifest(manifest, expectedDigest = null) {
    const actual = await fingerprintManifest(manifest);
    const expected = normalizeDigest(expectedDigest || manifest?.integrity?.manifestSha256 || '');
    if (!expected) return { ok:true, state:'UNPINNED', algorithm:'SHA-256', actual, expected:null, warning:'Manifest has no pinned digest' };
    return { ok:actual === expected, state:actual === expected ? 'VERIFIED' : 'MISMATCH', algorithm:'SHA-256', actual, expected, warning:null };
  }
  async function verifyEntry(manifest, fetcher = globalThis.fetch?.bind(globalThis)) {
    const expected = normalizeDigest(manifest?.integrity?.entrySha256 || '');
    if (!expected) return { ok:true, state:'UNPINNED', expected:null, actual:null, warning:'Entry payload has no pinned digest' };
    if (!fetcher) return { ok:false, state:'UNAVAILABLE', expected, actual:null, error:'Fetch unavailable' };
    const entry = String(manifest?.entry || '');
    if (!entry) return { ok:false, state:'INVALID', expected, actual:null, error:'Package entry missing' };
    const response = await fetcher(entry, { cache:'no-store', credentials:'same-origin' });
    if (!response.ok) return { ok:false, state:'FETCH_FAILED', expected, actual:null, error:`Entry fetch failed (${response.status})` };
    const result = await verifyDigest(await response.arrayBuffer(), expected);
    return { ...result, state:result.ok ? 'VERIFIED' : 'MISMATCH', entry };
  }
  function validateSignatureDescriptor(signature) {
    const errors = [];
    if (!signature || typeof signature !== 'object') errors.push('signature descriptor required');
    else {
      if (signature.schema !== SIGNATURE_SCHEMA) errors.push(`schema must be ${SIGNATURE_SCHEMA}`);
      if (!signature.packageId) errors.push('packageId required');
      if (!signature.version) errors.push('version required');
      if (signature.algorithm !== 'Ed25519') errors.push('algorithm must be Ed25519');
      if (!signature.keyId) errors.push('keyId required');
      if (!signature.manifestSha256 || !/^[a-f0-9]{64}$/i.test(normalizeDigest(signature.manifestSha256))) errors.push('valid manifestSha256 required');
      if (!signature.signature) errors.push('signature required');
    }
    return { ok:errors.length === 0, errors, schema:SIGNATURE_SCHEMA };
  }
  function signedPayload(signature) {
    return canonicalize({ schema:SIGNATURE_SCHEMA, packageId:String(signature.packageId), version:String(signature.version), manifestSha256:normalizeDigest(signature.manifestSha256) });
  }
  async function importEd25519Key(record) {
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto unavailable');
    if (record.format === 'jwk') return crypto.subtle.importKey('jwk', record.publicKey, { name:'Ed25519' }, false, ['verify']);
    const bytes = base64Bytes(record.publicKey);
    return crypto.subtle.importKey(record.format === 'spki' ? 'spki' : 'raw', bytes, { name:'Ed25519' }, false, ['verify']);
  }
  async function verifySignature(manifest, signature = manifest?.signature, trustStore = globalThis.SwirTrustedKeys) {
    const descriptor = validateSignatureDescriptor(signature);
    if (!descriptor.ok) return { ok:false, state:'INVALID_DESCRIPTOR', algorithm:'Ed25519', errors:descriptor.errors };
    const packageId = manifest?.packageId || manifest?.id || null;
    if (String(signature.packageId) !== String(packageId || '')) return { ok:false, state:'PACKAGE_MISMATCH', algorithm:'Ed25519', error:'Signature packageId does not match manifest' };
    if (String(signature.version) !== String(manifest?.version || '')) return { ok:false, state:'VERSION_MISMATCH', algorithm:'Ed25519', error:'Signature version does not match manifest' };
    const manifestCheck = await verifyManifest(manifest, signature.manifestSha256);
    if (!manifestCheck.ok) return { ok:false, state:'MANIFEST_MISMATCH', algorithm:'Ed25519', manifest:manifestCheck, error:'Signed manifest digest mismatch' };
    if (!trustStore?.trustedFor) return { ok:false, state:'TRUST_STORE_UNAVAILABLE', algorithm:'Ed25519', error:'Trusted Key Store unavailable' };
    const trust = trustStore.trustedFor(signature.keyId, packageId);
    if (!trust.ok) return { ok:false, state:trust.state, algorithm:'Ed25519', keyId:signature.keyId, error:trust.error };
    try {
      const key = await importEd25519Key(trust.key);
      const ok = await crypto.subtle.verify({ name:'Ed25519' }, key, base64Bytes(signature.signature), toBytes(signedPayload(signature)));
      return { ok, state:ok ? 'VERIFIED' : 'BAD_SIGNATURE', algorithm:'Ed25519', keyId:signature.keyId, publisher:trust.key.name, manifest:manifestCheck, error:ok ? null : 'Cryptographic signature verification failed' };
    } catch (error) {
      return { ok:false, state:'CRYPTO_UNAVAILABLE', algorithm:'Ed25519', keyId:signature.keyId, error:error?.message || String(error) };
    }
  }
  async function plan(manifest, options = {}) {
    const manifestCheck = await verifyManifest(manifest, options.manifestSha256);
    let entryCheck = { ok:true, state:'SKIPPED' };
    if (options.verifyEntry === true || manifest?.integrity?.entrySha256) {
      try { entryCheck = await verifyEntry(manifest, options.fetcher); }
      catch (error) { entryCheck = { ok:false, state:'ERROR', error:error?.message || String(error) }; }
    }
    const signatureDescriptor = options.signature || manifest?.signature || null;
    let signatureCheck = { ok:true, state:'UNSIGNED', algorithm:'Ed25519' };
    if (signatureDescriptor) signatureCheck = options.verifySignature === false ? validateSignatureDescriptor(signatureDescriptor) : await verifySignature(manifest, signatureDescriptor, options.trustStore);
    const errors = [];
    if (!manifestCheck.ok) errors.push('Manifest digest mismatch');
    if (!entryCheck.ok) errors.push(entryCheck.error || 'Entry digest mismatch');
    if (!signatureCheck.ok) {
      if (signatureCheck.error) errors.push(signatureCheck.error);
      else if (Array.isArray(signatureCheck.errors)) errors.push(...signatureCheck.errors);
      else errors.push('Signature verification failed');
    }
    return { schema:SCHEMA, ok:errors.length === 0, packageId:manifest?.packageId || manifest?.id || null, version:manifest?.version || null, manifest:manifestCheck, entry:entryCheck, signature:signatureCheck, errors, next:errors.length ? 'BLOCK' : 'RESOLVE_DEPENDENCIES' };
  }

  window.SwirPackageIntegrity = Object.freeze({
    meta:Object.freeze({ name:'SWIR Package Integrity', version:'1.1.0', schema:SCHEMA, signatureSchema:SIGNATURE_SCHEMA, algorithms:['SHA-256','Ed25519'] }),
    canonicalize, sha256, verifyDigest, fingerprintManifest, verifyManifest, verifyEntry, validateSignatureDescriptor, verifySignature, signedPayload, plan
  });
})();
