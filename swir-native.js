/* SWIR OS native module bridge */
(() => {
  'use strict';
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data) return;
    if (event.data.type === 'SWIR_NATIVE_OPEN') {
      const id = String(event.data.id || '');
      const exists = window.SwirOS?.apps?.some(app => app.id === id);
      if (exists) window.SwirOS.open(id);
    }
  });
})();
