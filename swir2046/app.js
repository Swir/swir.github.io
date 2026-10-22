import { snapshot } from './projects.js';

const $ = (selector, scope = document) => scope?.querySelector(selector) ?? null;
const $$ = (selector, scope = document) => [...(scope?.querySelectorAll(selector) ?? [])];
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Session-only preferences still work. */ } },
};
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const normalize = value => String(value ?? '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
const projects = snapshot.projects.map(project => ({ ...project }));
const projectByName = new Map(projects.map(project => [project.name, project]));
const stageOrder = ['Dragon-DiskForge', 'Konofix', 'Swirui', 'KonoNexus', 'SWIR_OS'];
const assets = {
  'Dragon-DiskForge': { image: 'dragon-diskforge.jpg', logo: 'dragon-diskforge-sigil.svg' },
  Konofix: { image: 'konofix.jpg', logo: 'konofix-icon.ico' },
  Swirui: { image: 'swirui.jpg', logo: 'swirui-icon.svg' },
  KonoNexus: { image: 'kononexus.jpg', logo: 'kononexus-icon.png' },
  SWIR_OS: { image: 'swir-os.jpg', logo: 'swir-os-icon.svg' },
  OCRYON: { image: 'ocryon.png', logo: 'ocryon-icon.svg' },
  BrokeDJ: { image: 'brokedj.jpg', logo: 'brokedj-icon.svg' },
};
const text = {
  pl: {
    'category.all': 'Wszystko', 'category.tools': 'Narzędzia', 'category.creators': 'Dla twórców',
    'category.communication': 'Komunikacja', 'category.system': 'System', 'category.games': 'Gry i media', 'category.other': 'Pozostałe projekty',
    'status.release': 'WYDANIE', 'status.beta': 'BETA', 'status.alpha': 'ALPHA', 'status.pre-alpha': 'PRE-ALPHA', 'status.development': 'W ROZWOJU', 'status.source': 'ŹRÓDŁA',
    'empty.title': 'Nie znaleziono projektu.', 'empty.description': 'Spróbuj innej nazwy lub wybierz inną kategorię.',
    'generic.description': 'Poznaj dokumentację, kod i historię projektu na GitHubie.',
    'repository': 'Repozytorium', 'release': 'Zobacz wydanie', 'os.preview': 'Prezentacja SWIR OS',
    'unreleased': 'Projekt jest rozwijany. Aktualny zakres i postępy znajdziesz w repozytorium.',
    'snapshot.before': 'Informacje o wydaniach sprawdzone', 'snapshot.after': 'Aktualny stan znajdziesz na GitHubie.',
    'image.open': 'Powiększ zrzut ekranu', 'image.caption': 'Zrzut ekranu z publicznego repozytorium',
    'image.nexus.caption': 'Zrzut z repozytorium · tester połączeń alpha', 'image.os.caption': 'Zrzut z repozytorium · SWIR OS Web Edition',
    'image.alt': 'Interfejs aplikacji', 'image.nexus.alt': 'Interfejs testera połączeń KonoNexus', 'image.os.alt': 'Pulpit SWIR OS Web Edition',
    'motion.on': 'Efekty wł.', 'motion.off': 'Efekty wył.', 'motion.pause': 'Wstrzymaj efekty', 'motion.play': 'Wznów efekty',
    'menu.open': 'Otwórz nawigację', 'menu.close': 'Zamknij nawigację',
    'data.live': 'GitHub · metadane odświeżone', 'data.cached': 'GitHub · zapisane metadane',
    'data.scope': 'Odświeżane są tylko liczba publicznych repozytoriów, gwiazdki i języki. Opisy i wydania pochodzą z',
  },
  en: {
    'category.all': 'Everything', 'category.tools': 'Tools', 'category.creators': 'For creators',
    'category.communication': 'Communication', 'category.system': 'System', 'category.games': 'Games & media', 'category.other': 'More projects',
    'status.release': 'RELEASE', 'status.beta': 'BETA', 'status.alpha': 'ALPHA', 'status.pre-alpha': 'PRE-ALPHA', 'status.development': 'IN DEVELOPMENT', 'status.source': 'SOURCE',
    'empty.title': 'No project found.', 'empty.description': 'Try another name or choose a different category.',
    'generic.description': 'Explore the documentation, code and project history on GitHub.',
    'repository': 'View repository', 'release': 'View release', 'os.preview': 'SWIR OS presentation',
    'unreleased': 'This project is in development. Explore the repository for its current scope and progress.',
    'snapshot.before': 'Release information checked on', 'snapshot.after': 'See GitHub for the current status.',
    'image.open': 'Enlarge screenshot', 'image.caption': 'Screenshot from the public repository',
    'image.nexus.caption': 'Repository screenshot · alpha connection tester', 'image.os.caption': 'Repository screenshot · SWIR OS Web Edition',
    'image.alt': 'Application interface', 'image.nexus.alt': 'KonoNexus connection tester interface', 'image.os.alt': 'SWIR OS Web Edition desktop',
    'motion.on': 'Effects on', 'motion.off': 'Effects off', 'motion.pause': 'Pause visual effects', 'motion.play': 'Resume visual effects',
    'menu.open': 'Open navigation', 'menu.close': 'Close navigation',
    'data.live': 'GitHub · metadata updated', 'data.cached': 'GitHub · cached metadata',
    'data.scope': 'Only the public repository count, stars and languages are refreshed. Descriptions and releases were checked on',
  },
};

// Only author-provided static markup is translated through innerHTML.
// Remote metadata and project content are always escaped or assigned as text.
const staticCopy = $$('[data-en]').map(element => ({ element, pl: element.innerHTML, en: element.dataset.en }));
const attributeCopy = [['data-en-alt', 'alt'], ['data-en-label', 'aria-label'], ['data-en-placeholder', 'placeholder']]
  .flatMap(([source, target]) => $$(`[${source}]`).map(element => ({ element, target, pl: element.getAttribute(target) ?? '', en: element.getAttribute(source) ?? '' })));
const originalTitle = document.title;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let lang = storage.get('swir.language') === 'en' ? 'en' : 'pl';
let motionPaused = reducedMotion.matches || storage.get('swir.motion') === 'paused';
let currentStage = stageOrder[0];
let filter = 'all';
let limit = 9;
let dataMode = 'snapshot';
let activeProject = null;
let activeImage = null;
let switchTimer = 0;
let revealObserver = null;
const t = key => text[lang][key] ?? text.pl[key] ?? key;
const description = project => (lang === 'en' ? project.description_en || project.description_pl : project.description_pl || project.description_en) || t('generic.description');
const category = project => t(`category.${project.category}`);
const screenshotPath = name => assets[name]?.image ? `./swir2046/screenshots/${assets[name].image}` : null;
const logoPath = name => assets[name]?.logo ? `./swir2046/icons/${assets[name].logo}` : null;
const imageCaption = name => t(name === 'KonoNexus' ? 'image.nexus.caption' : name === 'SWIR_OS' ? 'image.os.caption' : 'image.caption');
const imageAlt = project => project.name === 'KonoNexus' ? t('image.nexus.alt') : project.name === 'SWIR_OS' ? t('image.os.alt') : `${project.displayName} — ${t('image.alt')}`;
const stageClass = project => project.stage === 'release' ? 'release-tag' : ['beta', 'alpha', 'pre-alpha'].includes(project.stage) ? 'beta-tag' : 'development-tag';
const tag = project => `<span class="stage-tag ${stageClass(project)}">${escapeHTML(t(`status.${project.stage}`))}</span>`;
const verifiedDate = new Date(`${snapshot.verified_date}T12:00:00Z`);
const formatDate = (date, long = false) => new Intl.DateTimeFormat(lang === 'pl' ? 'pl-PL' : 'en-GB', { day: '2-digit', month: long ? 'long' : 'short', year: 'numeric', timeZone: 'Europe/Oslo' }).format(date);
const snapshotNote = () => `${t('snapshot.before')} ${formatDate(verifiedDate, true)}. ${t('snapshot.after')}`;
const polishForm = (number, one, few, many) => number === 1 ? one : number % 10 >= 2 && number % 10 <= 4 && (number % 100 < 12 || number % 100 > 14) ? few : many;

function setLanguage(next) {
  lang = next === 'en' ? 'en' : 'pl';
  storage.set('swir.language', lang);
  document.documentElement.lang = lang;
  document.title = lang === 'pl' ? originalTitle : document.documentElement.dataset.enTitle || 'SWIR — Your code. Your rules.';
  for (const copy of staticCopy) if (copy.element.isConnected) copy.element.innerHTML = copy[lang];
  for (const copy of attributeCopy) if (copy.element.isConnected) copy.element.setAttribute(copy.target, copy[lang]);
  const toggle = $('#language-toggle');
  if (toggle) {
    toggle.innerHTML = lang === 'pl' ? 'PL <span>/ EN</span>' : 'EN <span>/ PL</span>';
    toggle.setAttribute('aria-label', lang === 'pl' ? 'Switch to English' : 'Przełącz na polski');
  }
  renderStage(); renderProjects(); renderReleases(); updateDataLabel(); updateMotionButton(); updateMenuLabel();
  if (activeProject) renderProjectDialog(activeProject);
  if (activeImage) renderImageDialog(activeImage);
}

// Selected projects: explicit tabs, no automatic rotation or hidden timer state.
const stageTabs = $$('.stage-tab[data-stage]');
for (const [index, tab] of stageTabs.entries()) {
  if (!tab.id) tab.id = `stage-tab-${index + 1}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', $('#stage-panel')?.id || 'stage');
  tab.addEventListener('click', () => selectStage(tab.dataset.stage));
  tab.addEventListener('keydown', event => {
    let nextIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % stageTabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + stageTabs.length) % stageTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = stageTabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = stageTabs[nextIndex];
    selectStage(nextTab.dataset.stage);
    nextTab.focus({ preventScroll: true });
    nextTab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });
}
function selectStage(name) {
  if (!stageOrder.includes(name) || !projectByName.has(name)) return;
  const changed = currentStage !== name;
  currentStage = name;
  clearTimeout(switchTimer);
  const stage = $('#stage');
  stage?.classList.remove('is-switching');
  renderStage();
  if (changed && !motionPaused && !reducedMotion.matches && stage) {
    stage.classList.add('is-switching');
    switchTimer = setTimeout(() => stage.classList.remove('is-switching'), 180);
  }
}
function renderStage() {
  const project = projectByName.get(currentStage);
  const stage = $('#stage');
  if (!project || !stage) return;
  stage.dataset.project = project.name;
  stage.style.setProperty('--stage-color', project.color);
  const panel = $('#stage-panel') || stage;
  panel.setAttribute('role', 'tabpanel');
  for (const tab of stageTabs) {
    const selected = tab.dataset.stage === currentStage;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) panel.setAttribute('aria-labelledby', tab.id);
  }
  const values = { '#stage-name': project.displayName, '#stage-description': description(project), '#stage-category': category(project), '#stage-index': `${String(stageOrder.indexOf(currentStage) + 1).padStart(2, '0')} / ${String(stageOrder.length).padStart(2, '0')}`, '#stage-caption': imageCaption(project.name) };
  for (const [selector, value] of Object.entries(values)) { const element = $(selector); if (element) element.textContent = value; }
  const image = $('#stage-image');
  if (image) { image.src = screenshotPath(project.name); image.alt = imageAlt(project); }
  const logoHost = $('#stage-logo');
  const logo = logoHost?.matches('img') ? logoHost : $('img', logoHost);
  if (logo) { logo.src = logoPath(project.name); logo.alt = ''; }
  const status = $('#stage-status');
  if (status) { status.textContent = t(`status.${project.stage}`); status.classList.remove('release-tag', 'beta-tag', 'development-tag'); status.classList.add('stage-tag', stageClass(project)); }
  const link = $('#stage-link');
  if (link) { link.href = project.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  const detail = $('#stage-detail');
  if (detail) { detail.dataset.openProject = project.name; detail.setAttribute('aria-haspopup', 'dialog'); }
  const zoom = $('#stage-zoom');
  if (zoom) { zoom.dataset.previewImage = project.name; zoom.setAttribute('aria-haspopup', 'dialog'); zoom.setAttribute('aria-label', `${t('image.open')}: ${project.displayName}`); }
}

function renderProjects() {
  const grid = $('#project-grid');
  if (!grid) return;
  const focusedName = grid.contains(document.activeElement) ? document.activeElement.dataset.openProject : null;
  const query = normalize($('#catalog-search')?.value.trim() ?? '');
  const matches = projects.filter(project => (filter === 'all' || project.category === filter || project.categories?.includes(filter)) && (!query || normalize(`${project.name} ${project.displayName} ${description(project)} ${project.language ?? ''} ${category(project)}`).includes(query)));
  const shown = matches.slice(0, limit);
  const count = $('#result-count');
  if (count) count.textContent = lang === 'pl' ? `${matches.length} ${polishForm(matches.length, 'projekt', 'projekty', 'projektów')} · ${shown.length} ${polishForm(shown.length, 'widoczny', 'widoczne', 'widocznych')}` : `${matches.length} ${matches.length === 1 ? 'project' : 'projects'} · ${shown.length} shown`;
  grid.innerHTML = shown.length ? shown.map((project, index) => `<article class="catalog-row"><span class="catalog-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><div class="catalog-main"><h3><button type="button" data-open-project="${escapeHTML(project.name)}" aria-haspopup="dialog">${escapeHTML(project.displayName)}</button></h3><p class="catalog-description">${escapeHTML(description(project))}</p></div><div class="catalog-aside">${tag(project)}<span class="catalog-language">${escapeHTML(project.language || category(project))}</span></div><span class="catalog-arrow" aria-hidden="true">↗</span></article>`).join('') : `<div class="empty-results"><h3>${escapeHTML(t('empty.title'))}</h3><p>${escapeHTML(t('empty.description'))}</p></div>`;
  const more = $('#show-more');
  if (more) more.hidden = shown.length >= matches.length;
  if (focusedName) $$('[data-open-project]', grid).find(button => button.dataset.openProject === focusedName)?.focus({ preventScroll: true });
}
function renderReleases() {
  const list = $('#release-list');
  if (!list) return;
  const releases = projects.filter(project => project.stage === 'release' && project.release && project.release.prerelease !== true && Number.isFinite(Date.parse(project.release.published_at))).sort((left, right) => Date.parse(right.release.published_at) - Date.parse(left.release.published_at)).slice(0, 4);
  list.innerHTML = releases.map(project => `<a class="release-row" href="${escapeHTML(project.release.url)}" target="_blank" rel="noopener noreferrer"><time class="release-date" datetime="${escapeHTML(project.release.published_at)}">${formatDate(new Date(project.release.published_at))}</time><span class="release-title">${escapeHTML(project.displayName)}<small>${escapeHTML(project.release.tag)}</small></span><span class="release-platform">${escapeHTML(project.platform || project.language || 'GITHUB RELEASE')}</span>${icon('up')}</a>`).join('');
}

// Native dialog stacking preserves the project's dialog when its image is enlarged.
const projectDialog = $('#project-dialog');
const imageDialog = $('#image-dialog');
const dialogStack = [];
const returnFocus = new Map();
let previousOverflow = null;
function captureFocus(element = document.activeElement) {
  return { element, project: element?.dataset?.openProject, image: element?.dataset?.previewImage, catalog: Boolean(element?.closest?.('#project-grid')) };
}
function syncScrollLock() {
  const hasOpenDialog = dialogStack.some(dialog => dialog.open);
  if (hasOpenDialog && previousOverflow === null) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
  else if (!hasOpenDialog && previousOverflow !== null) { document.body.style.overflow = previousOverflow; previousOverflow = null; }
}
function showDialog(dialog, closeSelector, trigger) {
  if (!dialog || dialog.open) return;
  returnFocus.set(dialog, captureFocus(trigger));
  dialog.showModal();
  dialogStack.push(dialog);
  syncScrollLock();
  $(closeSelector, dialog)?.focus({ preventScroll: true });
}
function setupDialog(dialog, closeSelector, onClose) {
  if (!dialog) return;
  $(closeSelector, dialog)?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    const index = dialogStack.lastIndexOf(dialog);
    if (index !== -1) dialogStack.splice(index, 1);
    onClose(); syncScrollLock();
    const saved = returnFocus.get(dialog);
    returnFocus.delete(dialog);
    const topDialog = [...dialogStack].reverse().find(item => item.open);
    const focusScope = saved?.catalog ? $('#project-grid') : document;
    let target = saved?.element?.isConnected ? saved.element : saved?.project ? $$('[data-open-project]', focusScope).find(element => element.dataset.openProject === saved.project) : saved?.image ? $$('[data-preview-image]').find(element => element.dataset.previewImage === saved.image) : null;
    if (topDialog && (!target || !topDialog.contains(target))) target = $('button, a[href], input, [tabindex="0"]', topDialog);
    if (target && !target.closest('dialog:not([open])')) target.focus({ preventScroll: true });
  });
}
function renderProjectDialog(project) {
  const content = $('#dialog-content');
  if (!content) return;
  const image = screenshotPath(project.name);
  const logo = logoPath(project.name);
  const mark = logo ? `<img src="${logo}" alt="" width="44" height="44">` : project.icon === 'code' ? icon('code') : escapeHTML(project.icon);
  content.innerHTML = `<div class="dialog-header"><span class="card-icon" aria-hidden="true">${mark}</span><span class="dialog-category">${escapeHTML(category(project))}</span>${tag(project)}</div><h2 id="dialog-title">${escapeHTML(project.displayName)}</h2><p class="dialog-description">${escapeHTML(description(project))}</p>${image ? `<button class="dialog-image-button" type="button" data-preview-image="${escapeHTML(project.name)}" aria-haspopup="dialog" aria-label="${escapeHTML(t('image.open'))}: ${escapeHTML(project.displayName)}"><img class="dialog-image" src="${image}" alt="${escapeHTML(imageAlt(project))}"></button>` : ''}<div class="dialog-detail">${project.language ? `<span>${escapeHTML(project.language)}</span>` : ''}${project.release ? `<span>${escapeHTML(project.release.tag)}</span>` : ''}${project.platform && project.platform !== project.language ? `<span>${escapeHTML(project.platform)}</span>` : ''}${Number.isFinite(project.stars) && project.stars > 0 ? `<span>☆ ${project.stars}</span>` : ''}</div><p class="dialog-note">${escapeHTML(project.release ? snapshotNote() : t('unreleased'))}</p><div class="dialog-links"><a class="button button-primary" href="${escapeHTML(project.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(t('repository'))}${icon('up')}</a>${project.release ? `<a class="button button-outline" href="${escapeHTML(project.release.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(t('release'))}${icon('download')}</a>` : ''}${project.name === 'SWIR_OS' ? `<a class="button button-outline" href="./swir-os.html">${escapeHTML(t('os.preview'))}${icon('up')}</a>` : ''}</div>`;
}
function openProject(name, trigger) {
  const project = projectByName.get(name);
  if (!project || !projectDialog) return;
  activeProject = project;
  renderProjectDialog(project);
  showDialog(projectDialog, '.dialog-close', trigger);
}
function renderImageDialog(project) {
  const image = $('#image-dialog-image');
  if (image) { image.src = screenshotPath(project.name); image.alt = imageAlt(project); }
  const title = $('#image-dialog-title');
  if (title) title.textContent = project.displayName;
  const caption = $('#image-dialog-caption');
  if (caption) caption.textContent = imageCaption(project.name);
}
function openImage(name, trigger) {
  const project = projectByName.get(name);
  if (!project || !screenshotPath(name) || !imageDialog) return;
  activeImage = project;
  renderImageDialog(project);
  showDialog(imageDialog, '.image-close', trigger);
}
setupDialog(projectDialog, '.dialog-close', () => { activeProject = null; });
setupDialog(imageDialog, '.image-close', () => { activeImage = null; });
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const details = event.target.closest('[data-open-project]');
  if (details) { event.preventDefault(); openProject(details.dataset.openProject, details); return; }
  const preview = event.target.closest('[data-preview-image]');
  if (preview) { event.preventDefault(); openImage(preview.dataset.previewImage, preview); }
});

$('#language-toggle')?.addEventListener('click', () => setLanguage(lang === 'pl' ? 'en' : 'pl'));
for (const button of $$('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter; limit = 9;
  for (const item of $$('[data-filter]')) { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected)); }
  renderProjects();
});
$('#catalog-search')?.addEventListener('input', () => { limit = 9; renderProjects(); });
$('#show-more')?.addEventListener('click', () => {
  const previous = limit;
  limit += 9; renderProjects();
  $$('[data-open-project]', $('#project-grid'))[previous]?.focus({ preventScroll: true });
});
function focusSearch() {
  closeMenu();
  $('#projects')?.scrollIntoView({ behavior: motionPaused || reducedMotion.matches ? 'instant' : 'smooth' });
  $('#catalog-search')?.focus({ preventScroll: true });
}
for (const button of $$('.search-open')) button.addEventListener('click', focusSearch);
const menuButton = $('#menu-toggle');
const mobileNav = $('#mobile-nav');
function updateMenuLabel() {
  if (menuButton) menuButton.setAttribute('aria-label', t(mobileNav && !mobileNav.hidden ? 'menu.close' : 'menu.open'));
}
function closeMenu(restoreFocus = false) {
  if (!mobileNav || !menuButton) return;
  mobileNav.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); updateMenuLabel();
  if (restoreFocus) menuButton.focus({ preventScroll: true });
}
menuButton?.addEventListener('click', () => {
  if (!mobileNav) return;
  mobileNav.hidden = !mobileNav.hidden;
  menuButton.setAttribute('aria-expanded', String(!mobileNav.hidden)); updateMenuLabel();
});
for (const link of $$('a', mobileNav)) link.addEventListener('click', () => closeMenu());
document.addEventListener('keydown', event => {
  if (dialogStack.some(dialog => dialog.open)) return;
  if (event.key === 'Escape' && mobileNav && !mobileNav.hidden) { event.preventDefault(); closeMenu(true); return; }
  const target = event.target;
  const typing = target instanceof Element && (target.matches('input, textarea, select') || target.isContentEditable);
  if ((event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) { event.preventDefault(); focusSearch(); }
});
addEventListener('resize', () => { if (menuButton && mobileNav && !mobileNav.hidden && getComputedStyle(menuButton).display === 'none') closeMenu(); }, { passive: true });

function updateMotionButton() {
  const button = $('#motion-toggle');
  if (!button) return;
  const label = t(motionPaused ? 'motion.play' : 'motion.pause');
  button.setAttribute('aria-pressed', String(motionPaused));
  button.setAttribute('aria-label', label); button.title = label;
  const visibleLabel = $('.motion-label', button);
  if (visibleLabel) visibleLabel.textContent = t(motionPaused ? 'motion.off' : 'motion.on');
}
function revealAll() {
  revealObserver?.disconnect(); revealObserver = null;
  for (const element of $$('.reveal')) element.classList.add('revealed');
  document.documentElement.classList.remove('js-reveal');
}
function applyMotion() {
  document.documentElement.classList.toggle('motion-paused', motionPaused);
  document.body.classList.toggle('motion-paused', motionPaused);
  if (motionPaused || reducedMotion.matches) { clearTimeout(switchTimer); $('#stage')?.classList.remove('is-switching'); revealAll(); }
  updateMotionButton();
}
$('#motion-toggle')?.addEventListener('click', () => {
  motionPaused = !motionPaused;
  storage.set('swir.motion', motionPaused ? 'paused' : 'playing'); applyMotion();
});
reducedMotion.addEventListener('change', event => {
  motionPaused = event.matches || storage.get('swir.motion') === 'paused'; applyMotion();
});
function setupReveals() {
  if (motionPaused || reducedMotion.matches || !('IntersectionObserver' in window)) { revealAll(); return; }
  try {
    revealObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('revealed'); revealObserver.unobserve(entry.target); }
    }, { threshold: 0.03, rootMargin: '0px 0px 80px 0px' });
    for (const element of $$('.reveal')) revealObserver.observe(element);
    document.documentElement.classList.add('js-reveal');
    // A fail-open fallback prevents CSS-hidden content if observation is interrupted.
    setTimeout(revealAll, 5000);
  } catch { revealAll(); }
}
const progress = $('.scroll-progress');
if (progress) {
  let queued = false;
  const update = () => { const range = document.documentElement.scrollHeight - innerHeight; progress.style.transform = `scaleX(${range > 0 ? scrollY / range : 0})`; queued = false; };
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  update();
}
if ($('#year')) $('#year').textContent = new Date().getFullYear();
if ($('#repo-count')) $('#repo-count').textContent = snapshot.public_repository_count;

// Only metadata for the existing catalog is refreshed. New repositories are not
// automatically added; descriptions and releases keep their verified snapshot date.
const CACHE_KEY = 'swir.public-repositories.v1';
const CACHE_TTL = 6 * 60 * 60 * 1000;
function updateDataLabel() {
  const label = $('#data-source-text');
  if (!label) return;
  label.textContent = dataMode === 'snapshot' ? `GitHub / ${formatDate(verifiedDate)}` : t(`data.${dataMode}`);
  label.title = `${t('data.scope')} ${formatDate(verifiedDate, true)}.`;
  label.closest('.data-source')?.classList.toggle('live', dataMode === 'live');
}
function publicMetadata(repos) {
  return Array.isArray(repos) ? repos.filter(repo => repo && repo.private === false && typeof repo.owner?.login === 'string' && repo.owner.login.toLowerCase() === 'swir' && typeof repo.name === 'string') : [];
}
function applyPublicMetadata(repos, mode) {
  const visibleRepos = publicMetadata(repos);
  if (!visibleRepos.length) return false;
  const metadata = new Map(visibleRepos.map(repo => [repo.name, repo]));
  for (const project of projects) {
    const repo = metadata.get(project.name);
    if (!repo) continue;
    if (Number.isSafeInteger(repo.stargazers_count) && repo.stargazers_count >= 0) project.stars = repo.stargazers_count;
    if (typeof repo.language === 'string' && repo.language.length < 80) project.language = repo.language;
  }
  if ($('#repo-count')) $('#repo-count').textContent = visibleRepos.length;
  dataMode = mode; updateDataLabel(); renderProjects();
  return true;
}
async function refreshPublicMetadata() {
  try {
    const cached = JSON.parse(storage.get(CACHE_KEY) || 'null');
    if (Number.isFinite(cached?.expires) && cached.expires > Date.now() && applyPublicMetadata(cached.repos, 'cached')) return;
  } catch { /* Invalid storage never prevents browsing the verified catalog. */ }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 6500);
  try {
    const repos = [];
    for (let page = 1; page <= 3; page++) {
      const response = await fetch(`https://api.github.com/users/Swir/repos?type=owner&sort=full_name&per_page=100&page=${page}`, { signal: abort.signal, headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) throw new Error('Public metadata unavailable');
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('Invalid public metadata');
      repos.push(...batch);
      if (batch.length < 100) break;
      if (page === 3) throw new Error('Repository list incomplete');
    }
    if (applyPublicMetadata(repos, 'live')) storage.set(CACHE_KEY, JSON.stringify({ expires: Date.now() + CACHE_TTL, repos: publicMetadata(repos).map(repo => ({ name: repo.name, private: false, owner: { login: 'Swir' }, stargazers_count: repo.stargazers_count, language: repo.language })) }));
  } catch { /* GitHub rate limits and offline use keep the local snapshot available. */ }
  finally { clearTimeout(timeout); }
}

setLanguage(lang);
applyMotion();
setupReveals();
refreshPublicMetadata();
