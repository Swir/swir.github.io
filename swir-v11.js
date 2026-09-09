/* SWIR OS 1.1 runtime loader — corrected build */
(() => {
  const script = document.createElement('script');
  script.src = './swir-v11-fixed.js?v=1.1.1';
  script.defer = true;
  document.head.appendChild(script);
})();
