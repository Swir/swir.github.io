import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const i18n = read('swir-i18n.js');
const index = read('index.html');
const sw = read('sw.js');
const stage = read('desktop/windows/stage-desktop-runtime.ps1');
const settings = read('swir-settings.html');
const sdk = read('swir-sdk.js');
const bridgeHost = read('swir-app-bridge-host.js');
const bridgeClient = read('swir-app-bridge.js');

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

for (const marker of ['Language & Region','SYSTEM LOCALE','Intl.getCanonicalLocales','system.language','system.region','setLocale?.(canonical)']) {
  if (!settings.includes(marker)) fail(`System Settings locale integration missing: ${marker}`);
}
if (!settings.includes("if(!canonical){show('INVALID BCP-47 LOCALE")) fail('System Settings must fail closed on invalid locale');
if (!settings.includes("if(v==='no')return'nb-NO'")) fail('legacy Norwegian locale migration is missing');

for (const marker of ['locale: Object.freeze','localeInfo','localeTranslate','formatCurrency:localeCurrency']) {
  if (!sdk.includes(marker)) fail(`App SDK locale surface missing: ${marker}`);
}
for (const method of ['locale.info','locale.translate','locale.formatDate','locale.formatNumber','locale.formatCurrency','locale.formatRelativeTime','locale.formatList']) {
  if (!bridgeHost.includes(`case '${method}'`)) fail(`App Bridge host locale method missing: ${method}`);
  if (!bridgeClient.includes(`'${method}'`)) fail(`App Bridge client locale method missing: ${method}`);
}
if (bridgeHost.includes("case 'locale.set'") || bridgeClient.includes("'locale.set'")) fail('isolated applications must not be able to mutate system locale through the read-only bridge');

console.log('SWIR i18n contract OK: BCP-47 core, RTL, Language & Region settings, App SDK/Bridge, offline cache and Desktop staging are wired.');
