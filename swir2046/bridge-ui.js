import { projects, projectByName, screenshotPath, logoPath, categoryLabel, statusLabel, imageAlt, imageCaption, getReleases, formatDate, escapeHTML as esc } from './project-store.js';
import { artwork } from './project-art.js';

export const featuredModules = ['KonoNexus', 'SWIR_OS', 'Konofix', 'Dragon-DiskForge', 'BrokeDJ', 'OCRYON'];
const labels = {
  pl: {
    eyebrow: 'NIEZALEŻNE OPROGRAMOWANIE / BY SWIR', title: 'TWÓJ KOD. <br><em>NOWY WYMIAR.</em>',
    intro: 'Odkrywaj projekty. Otwieraj nowe możliwości.', selected: 'WYBRANY MODUŁ', open: 'OTWÓRZ PROJEKT',
    category: 'KATEGORIA', language: 'JĘZYK', projects: 'PROJEKTY', categories: 'KATEGORIE', releases: 'Z WYDANIEM',
    archive: 'PRZEGLĄDAJ ARCHIWUM', matrix: 'MAPA PROJEKTÓW', choose: 'Wybierz moduł na mapie', selection: 'WYBÓR MODUŁU',
    preview: 'PODGLĄD INTERFEJSU', enlarge: 'Powiększ podgląd', actual: 'RZECZYWISTY INTERFEJS', latest: 'OSTATNIE WYDANIA',
    allReleases: 'Wszystkie wydania', creative: 'INNE WYMIARY TWORZENIA', creativeNote: 'Dźwięk. Obraz. Własne światy.',
    illustration: 'Ilustracja projektu', music: 'CZTERY DECKI. WŁASNY RYTM.', ocr: 'OBRAZ ZAMIENIONY W TEKST.', engine: 'ZBUDUJ SWÓJ WŁASNY ŚWIAT.',
    scan: 'WYBRANE PROJEKTY', source: 'KOD ŹRÓDŁOWY / GITHUB', connected: 'PROJEKTY POŁĄCZONE IDEĄ',
  },
  en: {
    eyebrow: 'INDEPENDENT SOFTWARE / BY SWIR', title: 'YOUR CODE. <br><em>NEW DIMENSION.</em>',
    intro: 'Discover projects. Open new possibilities.', selected: 'SELECTED MODULE', open: 'OPEN PROJECT',
    category: 'CATEGORY', language: 'LANGUAGE', projects: 'PROJECTS', categories: 'CATEGORIES', releases: 'WITH RELEASES',
    archive: 'EXPLORE THE ARCHIVE', matrix: 'PROJECT MAP', choose: 'Select a module on the map', selection: 'MODULE SELECTION',
    preview: 'INTERFACE PREVIEW', enlarge: 'Enlarge preview', actual: 'ACTUAL INTERFACE', latest: 'LATEST RELEASES',
    allReleases: 'All releases', creative: 'OTHER DIMENSIONS OF MAKING', creativeNote: 'Sound. Images. Worlds of your own.',
    illustration: 'Project illustration', music: 'FOUR DECKS. YOUR OWN RHYTHM.', ocr: 'IMAGES TURNED INTO TEXT.', engine: 'BUILD A WORLD OF YOUR OWN.',
    scan: 'FEATURED PROJECTS', source: 'SOURCE CODE / GITHUB', connected: 'PROJECTS CONNECTED BY AN IDEA',
  },
};
const briefs = {
  KonoNexus: ['Eksperymentalna sieć mesh w Rust i tester połączeń KNP.', 'Experimental Rust mesh networking and a KNP connection tester.'],
  SWIR_OS: ['Platforma desktopowa rozwijana w edycjach Web, Windows i Linux.', 'A desktop platform in development across Web, Windows and Linux editions.'],
  Konofix: ['Komunikator P2P dla Windows z pokojami, plikami i rozmowami głosowymi.', 'A P2P messenger for Windows with rooms, file sharing and voice calls.'],
  'Dragon-DiskForge': ['Przeglądanie, montowanie i weryfikacja obrazów dysków w Windows.', 'Explore, mount and verify disk images on Windows.'],
  BrokeDJ: ['Natywna stacja DJ dla Windows: cztery decki, mikser i analiza muzyki.', 'A native Windows DJ workstation with four decks, a mixer and music analysis.'],
  OCRYON: ['Lokalny OCR ze skanów, zdjęć i PDF z eksportem do TXT, DOCX i PDF.', 'Local OCR for scans, photos and PDFs, with TXT, DOCX and PDF export.'],
};
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const mark = p => { const path = logoPath(p.name); return `<span class="app-mark ${path ? 'has-image' : ''}" aria-hidden="true">${path ? `<img src="${path}" alt="" width="42" height="42">` : p.icon === 'code' ? icon('code') : esc(p.icon || '</>')}</span>`; };
const title = p => p.name === 'Dragon-DiskForge' ? 'DiskForge' : p.displayName;
const label = (lang, key) => labels[lang]?.[key] ?? labels.pl[key];

export function renderModuleSelection(lang, selected) {
  const p = projectByName.get(selected) || projectByName.get(featuredModules[0]);
  const index = featuredModules.indexOf(p.name) + 1;
  return `<div class="hud-section-label"><span>${label(lang, 'selected')}</span><b>${String(index).padStart(2, '0')} / 06</b></div>
    <div class="module-identity">${mark(p)}<div><span class="module-code">${esc(p.name)}</span><h2>${esc(title(p))}</h2></div></div>
    <span class="stage-tag stage-${esc(p.stage)}">${esc(statusLabel(p.stage, lang))}</span>
    <p class="module-description">${esc(briefs[p.name][lang === 'en' ? 1 : 0])}</p>
    <dl class="module-readouts"><div><dt>${label(lang, 'category')}</dt><dd>${esc(categoryLabel(p.category, lang))}</dd></div><div><dt>${label(lang, 'language')}</dt><dd data-language="${esc(p.name)}">${esc(p.language || '—')}</dd></div></dl>
    <button class="holo-primary" data-open-project="${esc(p.name)}" aria-haspopup="dialog"><span>${label(lang, 'open')}</span>${icon('up')}</button>`;
}

export function renderModulePreview(lang, selected) {
  const p = projectByName.get(selected) || projectByName.get(featuredModules[0]);
  return `<div class="hud-section-label"><span>${label(lang, 'preview')}</span>${icon('code')}</div>
    <button class="module-preview-image" data-preview-image="${esc(p.name)}" aria-label="${esc(label(lang, 'enlarge') + ': ' + p.displayName)}" aria-haspopup="dialog"><img src="${screenshotPath(p.name)}" alt="${esc(imageAlt(p, lang))}" width="480" height="300"><span>${icon('max')}</span></button>
    <div class="preview-caption"><i></i><span>${esc(imageCaption(p.name, lang))}</span></div>
    <a class="module-source" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${icon('github')}<span>${label(lang, 'source')}</span>${icon('up')}</a>`;
}

export function renderBridge(lang, selected) {
  const l = key => label(lang, key);
  const categoryCount = new Set(projects.map(p => p.category)).size;
  const releaseCount = getReleases(projects.length).length;
  const nodes = featuredModules.map((name, index) => {
    const p = projectByName.get(name);
    return `<button class="holo-node node-${index + 1} ${selected === name ? 'is-selected' : ''}" data-select-module="${esc(name)}" aria-pressed="${selected === name}" aria-controls="active-module module-preview"><span class="node-index">${String(index + 1).padStart(2, '0')}</span>${mark(p)}<span class="node-name">${esc(title(p))}</span><span class="node-tick" aria-hidden="true"></span></button>`;
  }).join('');
  return `<div class="bridge-layout">
    <div class="bridge-heading"><p><i></i>${l('eyebrow')}</p><span>SWIR / ORBIT <b>—</b> PROJECT CONTROL INTERFACE</span></div>
    <div class="bridge-main">
      <aside class="bridge-left"><div class="bridge-welcome"><h1>${l('title')}</h1><p>${l('intro')}</p></div>
        <section id="active-module" class="hud-panel module-panel" aria-label="${l('selected')}">${renderModuleSelection(lang, selected)}</section>
        <div class="catalog-readouts"><div><strong>${String(projects.length).padStart(2, '0')}</strong><span>${l('projects')}</span></div><div><strong>${String(categoryCount).padStart(2, '0')}</strong><span>${l('categories')}</span></div><div><strong>${String(releaseCount).padStart(2, '0')}</strong><span>${l('releases')}</span></div></div>
      </aside>
      <section class="holo-stage" aria-label="${l('matrix')}"><div class="holo-topline"><span>01 / ${l('matrix')}</span><span>06 <i>//</i> ${l('scan')}</span></div>
        <div class="holo-display"><canvas id="holo-core" aria-hidden="true"></canvas><div class="holo-reticle" aria-hidden="true"><span></span><span></span><span></span><span></span></div><div class="holo-wordmark" aria-hidden="true"><span>&lt; / &gt;</span><strong>ORBIT</strong><small>SWIR / PROJECT MATRIX</small></div><div class="holo-nodes" role="group" aria-label="${l('selection')}">${nodes}</div><div class="holo-axis axis-top" aria-hidden="true">Y</div><div class="holo-axis axis-bottom" aria-hidden="true">X / Z</div></div>
        <div class="holo-bottomline"><span><i></i>${l('choose')}</span><button data-view="library">${l('archive')}${icon('arrow')}</button></div>
      </section>
      <aside class="bridge-right"><section id="module-preview" class="hud-panel preview-panel">${renderModulePreview(lang, selected)}</section>
        <section class="hud-panel bridge-releases"><div class="hud-section-label"><span>${l('latest')}</span>${icon('release')}</div>${getReleases(3).map(p => `<a class="bridge-release" href="${esc(p.release.url)}" target="_blank" rel="noopener noreferrer">${mark(p)}<span><strong>${esc(p.displayName)}</strong><small>${esc(p.release.tag)} <i>/</i> ${esc(formatDate(new Date(p.release.published_at), lang))}</small></span>${icon('up')}</a>`).join('')}<button class="bridge-release-all" data-view="releases">${l('allReleases')}${icon('arrow')}</button></section>
      </aside>
    </div>
    <section class="creative-channel"><div class="channel-heading"><span>02 / ${l('creative')}</span><p>${l('creativeNote')}</p><span class="channel-line" aria-hidden="true"></span></div><div class="channel-grid">${[['BrokeDJ', 'music'], ['OCRYON', 'ocr'], ['SwirEngine', 'engine']].map(([name, kind], i) => `<button class="channel-card pick-${kind}" data-open-project="${name}" aria-haspopup="dialog"><div class="channel-art">${artwork[name].replace(/Ilustracja projektu/g, l('illustration'))}</div><span class="channel-copy"><small>MODULE / ${String(i + 1).padStart(2, '0')}</small><strong>${esc(projectByName.get(name).displayName)}</strong><span>${l(kind)}</span></span>${icon('up')}</button>`).join('')}</div></section>
  </div>`;
}
