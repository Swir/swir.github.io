/* SWIR signed catalog release slot.
 * Source/Web builds intentionally carry no trusted release metadata.
 * Production Desktop packaging may replace this PUBLIC file with output from
 * scripts/build-signed-catalog-release.mjs. Native trust remains authoritative.
 */
(() => {
  'use strict';
  const host = (() => { try { return window.parent && window.parent !== window ? window.parent : window; } catch { return window; } })();
  if (!Object.prototype.hasOwnProperty.call(host, 'SWIR_SIGNED_CATALOG_RELEASE')) {
    Object.defineProperty(host, 'SWIR_SIGNED_CATALOG_RELEASE', {
      value: null,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
})();
