import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const i18n = read('swir-i18n.js');
const index = read('index.html');
const sw = read('sw.js');
const stage = read('desktop/windows/stage-desktop-runtime.ps1');

const fail = message => { throw new Error(`SWIR_I18N_CONTRACT: ${message}`); };

if (!i18n.includes("const CONTRACT='swir.i18n/1.0'")) fail('missing swir.i18n/1.0 contract marker');
if (!i18n.includes("const VERSION='1.0.0'")) fail('unexpected locale runtime version');
for (const api of ['setLocale','registerMessages','formatDate','formatNumber','formatCurrency','formatRelativeTime','formatList']) {
  if (!i18n.includes(api)) fail(`missing required API: ${api}`);
}
if (!i18n.includes('Intl.getCanonicalLocales')) fail('BCP-47 canonicalization is missing');
if (!i18n.includes('Intl.Locale')) fail('Intl.Locale support is missing');
if (!i18n.includes("document.documentElement.dir=directionOf(canonical)")) fail('document RTL/LTR direction propagation is missing');

const i18nScript = index.indexOf('<script src="./swir-i18n.js"></script>');
const platformScript = index.indexOf('<script src="./swir-platform.js"></script>');
if (i18nScript < 0) fail('index.html does not load swir-i18n.js');
if (platformScript < 0 || i18nScript > platformScript) fail('locale runtime must load before platform runtime');

if (!sw.includes("'./swir-i18n.js'")) fail('offline cache does not include swir-i18n.js');
if (!stage.includes("'swir-i18n.js'")) fail('Desktop runtime staging does not require swir-i18n.js');

console.log('SWIR i18n contract OK: BCP-47 locale core, RTL, formatting, offline cache and Desktop staging are wired.');
