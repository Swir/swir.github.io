import { snapshot } from './projects.js';
import { initCoreScene } from './core-scene.js';

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const safeStorage = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, value); } catch { /* Preferences remain session-local. */ } } };
const translations = {
  en: {
    'skip':'Skip to projects','navigation':'Main navigation','nav.selected':'Selected projects','nav.projects':'Ecosystem','nav.releases':'Releases','search.open':'Search projects','search.placeholder':'Find a project…','search.label':'Find a project','menu.open':'Open navigation','close':'Close',
    'hero.line1':'TOMORROW','hero.line2':'STARTS','hero.line3':'RIGHT HERE<span class="cyan-period">.</span>','hero.description':'From the first line of code to an entire universe. Apps, engines and tools built for whatever comes next.','hero.explore':'Explore projects','hero.github':'Explore the code','hero.scroll':'Scroll. This is only the beginning.',
    'motion.pause':'Pause visual effects','motion.play':'Resume visual effects','motion.label':'Effects','motion.off':'Paused',
    'selected.eyebrow':'SELECTED TRANSMISSIONS','selected.title':'Ideas that<br>became <em>code.</em>','selected.intro':'Every project is a world of its own.<br>Find your way in.',
    'category.communication':'COMMUNICATION','category.creators':'FOR CREATORS','category.games':'GAME ENGINE','project.discover':'Explore the project',
    'konofix.headline':'Connect. On your terms.','konofix.description':'Conversations, rooms, files and voice in a P2P messenger. Your own space to connect, without a traditional account.','konofix.image':'Konofix application screenshot from the public repository','image.caption':'Screenshot from the project repository',
    'swirui.description':'Native interfaces in Python. Reactive components and GPU rendering powered by Rust and wgpu.','engine.description':'Build worlds of your own. A Python game engine evolving around 2D, 3D, multiplayer and visual tools.','art.caption':'Concept visualization',
    'manifesto.title':'We don’t wait<br>for the <span>future.</span><br><em>We write it.</em>','manifesto.description':'Curiosity becomes an idea. Persistence turns it into a project. From everyday tools to a game engine of our own, it all starts with “what if…”.',
    'ecosystem.eyebrow':'EXPLORE WITHOUT LIMITS','ecosystem.title':'The whole <em>ecosystem.</em>','ecosystem.repos':'public repositories<br>one creative direction','filters.label':'Project categories',
    'filter.all':'Everything','filter.tools':'Tools','filter.creators':'For creators','filter.communication':'Communication','filter.system':'System','filter.games':'Games & media','filter.other':'More projects',
    'catalog.more':'Discover more projects','catalog.github':'All repositories on GitHub','releases.eyebrow':'FROM CODE TO REALITY','releases.title':'Freshly <em>released.</em>','releases.intro':'New versions. New possibilities.<br>Explore the files and release notes.','releases.note':'Releases from public GitHub repositories. See each release page for requirements and installation instructions.',
    'cta.eyebrow':'THE NEXT CHAPTER IS BEING WRITTEN','cta.title':'CURIOUS<span>?</span>','cta.description':'Visit GitHub. Find your project.<br>Leave a star if you like where this is going.','cta.action':'Join the future','footer.by':'Designed with character. By Swir.','footer.top':'Back to orbit',
    'results':'projects','results.shown':'shown','empty.title':'No signal here.','empty.description':'Try a different name or choose another category.','status.release':'RELEASE','status.beta':'BETA','status.alpha':'ALPHA','status.pre-alpha':'PRE-ALPHA','status.development':'IN DEVELOPMENT','status.source':'SOURCE','dialog.repository':'View repository','dialog.release':'View release','dialog.os':'SWIR OS preview','dialog.snapshot':'Release information checked on 21 October 2026. See GitHub for the current status.','dialog.unreleased':'This project is still evolving. Explore the repository for its current scope and progress.','generic.description':'Explore the documentation, code and project history on GitHub.','data.live':'GitHub · updated','data.cached':'GitHub · cached','data.snapshot':'GitHub / 21 Oct 2026',
  }
};
const polish = {};
for (const el of $$('[data-i18n]')) polish[el.dataset.i18n] = el.innerHTML;
for (const [attribute, target] of [['i18nAria','aria-label'],['i18nPlaceholder','placeholder'],['i18nAlt','alt'],['i18nTitle','title']]) for (const el of $$(`[data-${attribute.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())}]`)) polish[el.dataset[attribute]] = el.getAttribute(target);
Object.assign(polish, {'results':'projektów','results.shown':'widocznych','empty.title':'Tu jeszcze nie ma sygnału.','empty.description':'Spróbuj innej nazwy lub wybierz inną kategorię.','status.release':'WYDANIE','status.beta':'BETA','status.alpha':'ALPHA','status.pre-alpha':'PRE-ALPHA','status.development':'W ROZWOJU','status.source':'ŹRÓDŁA','dialog.repository':'Repozytorium','dialog.release':'Zobacz wydanie','dialog.os':'Podgląd SWIR OS','dialog.snapshot':'Informacje o wydaniach sprawdzone 21 października 2026. Aktualny stan znajdziesz na GitHubie.','dialog.unreleased':'Projekt jest rozwijany. Aktualny zakres i postępy znajdziesz w repozytorium.','generic.description':'Poznaj dokumentację, kod i historię projektu na GitHubie.','data.live':'GitHub · odświeżone','data.cached':'GitHub · zapisane dane','data.snapshot':'GitHub / 21.10.2026','filter.other':'Pozostałe projekty','motion.off':'Wstrzymane','motion.play':'Wznów efekty'});
translations.pl = polish;
let lang = safeStorage.get('swir.language') === 'en' ? 'en' : 'pl';
let filter = 'all';
let limit = 9;
let projects = snapshot.projects.map(p => ({...p}));
let dataMode = 'snapshot';
let activeProject = null;
let lastFocusedElement = null;
const t = key => translations[lang][key] ?? translations.pl[key] ?? key;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = id => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const categoryLabel = key => t('filter.' + key);
const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').toLowerCase();
const description = p => lang === 'en' ? (p.description_en || p.description_pl || t('generic.description')) : (p.description_pl || p.description_en || t('generic.description'));
const tag = p => `<span class="stage-tag ${p.stage === 'release' ? 'release-tag' : ['beta','alpha','pre-alpha'].includes(p.stage) ? 'beta-tag' : 'development-tag'}">${esc(t('status.'+p.stage))}</span>`;

function setLanguage(next) {
  lang = next;
  safeStorage.set('swir.language', lang);
  document.documentElement.lang = lang;
  document.title = lang === 'pl' ? 'SWIR — Jutro zaczyna się tutaj.' : 'SWIR — Tomorrow starts right here.';
  for (const el of $$('[data-i18n]')) el.innerHTML = t(el.dataset.i18n);
  for (const [attribute, target] of [['i18nAria','aria-label'],['i18nPlaceholder','placeholder'],['i18nAlt','alt'],['i18nTitle','title']]) for (const el of $$(`[data-${attribute.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())}]`)) el.setAttribute(target,t(el.dataset[attribute]));
  $('#language-toggle').innerHTML = lang === 'pl' ? 'PL <span>/ EN</span>' : 'EN <span>/ PL</span>';
  $('#language-toggle').setAttribute('aria-label',lang === 'pl' ? 'Switch to English' : 'Przełącz na polski');
  renderProjects(); renderReleases(); updateDataLabel(); updateMotionButton();
  if (activeProject) renderDialog(activeProject);
}

function renderProjects() {
  const query = normalize($('#catalog-search').value.trim());
  const matches = projects.filter(p => (filter === 'all' || p.category === filter || p.categories?.includes(filter)) && (!query || normalize(`${p.name} ${p.displayName} ${description(p)} ${p.language || ''} ${categoryLabel(p.category)}`).includes(query)));
  const shown = matches.slice(0,limit);
  $('#result-count').textContent = lang==='pl' ? `Projekty: ${matches.length} / Pokazano: ${shown.length}` : `Projects: ${matches.length} / Showing: ${shown.length}`;
  $('#project-grid').innerHTML = shown.length ? shown.map(p=>`<article class="project-card" style="--project-color:${p.color};--project-glow:${p.color}0c"><div class="project-card-top"><span class="card-icon" aria-hidden="true">${p.icon === 'code' ? icon('code') : esc(p.icon)}</span>${tag(p)}</div><h3><button type="button" data-open-project="${esc(p.name)}" aria-haspopup="dialog">${esc(p.displayName)}</button></h3><p>${esc(description(p))}</p><div class="project-card-bottom"><span class="card-language"><i></i>${esc(p.language || categoryLabel(p.category))}</span><span class="card-arrow" aria-hidden="true">↗</span></div></article>`).join('') : `<div class="empty-results"><h3>${t('empty.title')}</h3><p>${t('empty.description')}</p></div>`;
  $('#show-more').hidden = shown.length >= matches.length;
}

function renderReleases() {
  const releases = projects.filter(p=>p.release && p.release.published_at && p.stage === 'release').sort((a,b)=>new Date(b.release.published_at)-new Date(a.release.published_at)).slice(0,4);
  $('#release-list').innerHTML = releases.map(p=>`<a class="release-row" href="${esc(p.release.url)}" target="_blank" rel="noopener noreferrer"><time class="release-date" datetime="${esc(p.release.published_at)}">${new Intl.DateTimeFormat(lang==='pl'?'pl-PL':'en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'Europe/Oslo'}).format(new Date(p.release.published_at))}</time><span class="release-title">${esc(p.displayName)}<small>${esc(p.release.tag)}</small></span><span class="release-platform">${esc(p.platform || p.language || 'GITHUB RELEASE')}</span>${icon('up')}</a>`).join('');
}

function renderDialog(p) {
  const localImage = p.name === 'Konofix' ? './swir2046/screenshots/konofix.jpg' : p.name === 'Swirui' ? './swir2046/screenshots/swirui.jpg' : null;
  $('#dialog-content').innerHTML = `<div class="dialog-header"><span class="card-icon" style="--project-color:${p.color}" aria-hidden="true">${p.icon==='code'?icon('code'):esc(p.icon)}</span><span class="dialog-category">${esc(categoryLabel(p.category))}</span>${tag(p)}</div><h2 id="dialog-title">${esc(p.displayName)}</h2><p class="dialog-description">${esc(description(p))}</p>${localImage?`<img class="dialog-image" src="${localImage}" alt="${esc(p.displayName)} — ${esc(t('image.caption'))}">`:''}<div class="dialog-detail">${p.language?`<span>${esc(p.language)}</span>`:''}${p.release?`<span>${esc(p.release.tag)}</span>`:''}${p.platform&&p.platform!==p.language?`<span>${esc(p.platform)}</span>`:''}${Number.isFinite(p.stars) && p.stars>0?`<span>☆ ${p.stars}</span>`:''}</div><p class="dialog-note">${t(p.release?'dialog.snapshot':'dialog.unreleased')}</p><div class="dialog-links"><a class="button button-primary" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${t('dialog.repository')}${icon('up')}</a>${p.release?`<a class="button button-outline" href="${esc(p.release.url)}" target="_blank" rel="noopener noreferrer">${t('dialog.release')}${icon('download')}</a>`:''}${p.name==='SWIR_OS'?`<a class="button button-outline" href="./swir-os.html">${t('dialog.os')}${icon('up')}</a>`:''}</div>`;
}

function openProject(name) {
  const p = projects.find(p=>p.name===name);
  if (!p) return;
  lastFocusedElement = document.activeElement;
  activeProject = p;
  renderDialog(p);
  $('#project-dialog').showModal();
  document.body.style.overflow = 'hidden';
  $('.dialog-close').focus();
}
function closeProject() { $('#project-dialog').close(); }
$('#project-dialog').addEventListener('close',()=>{document.body.style.overflow='';activeProject=null;if(lastFocusedElement?.isConnected)lastFocusedElement.focus();});
$('.dialog-close').addEventListener('click',closeProject);
$('#project-dialog').addEventListener('click',e=>{if(e.target===$('#project-dialog')){const rect=e.target.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)closeProject();}});
$('#project-grid').addEventListener('click',e=>{const button=e.target.closest('[data-open-project]');if(button)openProject(button.dataset.openProject);});
$('#language-toggle').addEventListener('click',()=>setLanguage(lang==='pl'?'en':'pl'));
for (const button of $$('[data-filter]')) button.addEventListener('click',()=>{filter=button.dataset.filter;limit=9;for(const b of $$('[data-filter]')){b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));}renderProjects();});
$('#catalog-search').addEventListener('input',()=>{limit=9;renderProjects();});
$('#show-more').addEventListener('click',()=>{const previous=limit;limit+=9;renderProjects();const newlyRevealed=$$('[data-open-project]')[previous];newlyRevealed?.focus({preventScroll:true});});
const focusSearch=()=>{$('#projects').scrollIntoView({behavior:motionPaused?'instant':'smooth'});$('#catalog-search').focus({preventScroll:true});};
$('.search-open').addEventListener('click',focusSearch);
document.addEventListener('keydown',e=>{if($('#project-dialog').open)return;const target=e.target;const typing=target.matches('input,textarea,select')||target.isContentEditable;if((e.key==='/'&&!typing)||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k')){e.preventDefault();focusSearch();}});
const menuButton=$('.menu-toggle'), mobileNav=$('#mobile-nav');
menuButton.addEventListener('click',()=>{const expanded=menuButton.getAttribute('aria-expanded')==='true';menuButton.setAttribute('aria-expanded',String(!expanded));mobileNav.hidden=expanded;});
for (const a of $$('a',mobileNav)) a.addEventListener('click',()=>{mobileNav.hidden=true;menuButton.setAttribute('aria-expanded','false');});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!mobileNav.hidden){mobileNav.hidden=true;menuButton.setAttribute('aria-expanded','false');menuButton.focus();}});

const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let motionPaused=reducedMotion.matches || safeStorage.get('swir.motion')==='paused';
let core=null;
try { core=initCoreScene($('#core-canvas')); core.setPaused(motionPaused); } catch { $('#core-canvas').hidden=true; }
function updateMotionButton(){const button=$('#motion-toggle');button.setAttribute('aria-pressed',String(motionPaused));button.title=t(motionPaused?'motion.play':'motion.pause');$('.motion-glyph',button).textContent=motionPaused?'▷':'Ⅱ';$('[data-i18n="motion.label"]',button).textContent=t(motionPaused?'motion.off':'motion.label');}
function applyMotion(){document.body.classList.toggle('motion-paused',motionPaused);document.documentElement.classList.toggle('motion-paused',motionPaused);core?.setPaused(motionPaused);updateMotionButton();}
$('#motion-toggle').addEventListener('click',()=>{motionPaused=!motionPaused;safeStorage.set('swir.motion',motionPaused?'paused':'playing');applyMotion();});
reducedMotion.addEventListener('change',e=>{if(e.matches){motionPaused=true;applyMotion();}});
applyMotion();
if ('IntersectionObserver' in window && !reducedMotion.matches) {
  document.documentElement.classList.add('js-reveal');
  const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){e.target.classList.add('revealed');observer.unobserve(e.target);}},{threshold:.06,rootMargin:'0px 0px 15px 0px'});
  for(const el of $$('.reveal'))observer.observe(el);
}
let scrollQueued=false;
const updateScroll=()=>{const range=document.documentElement.scrollHeight-innerHeight;$('.scroll-progress').style.transform=`scaleX(${range>0?scrollY/range:0})`;scrollQueued=false;};
addEventListener('scroll',()=>{if(!scrollQueued){scrollQueued=true;requestAnimationFrame(updateScroll);}},{passive:true});
$('#year').textContent=new Date().getFullYear();

// Public metadata only. No authentication, tracking or user data leaves this page.
// A verified snapshot is always usable when GitHub is unavailable/rate-limited.
const CACHE_KEY='swir.public-repositories.v1';
function updateDataLabel(){const label=$('#data-source-text');label.textContent=t('data.'+dataMode);$('.data-source').classList.toggle('live',dataMode==='live');label.title=lang==='pl'?'Opisy i wydania: 21.10.2026. Liczba repozytoriów i gwiazdki mogą być odświeżane z GitHuba.':'Descriptions and releases: 21 Oct 2026. Repository count and stars may be refreshed from GitHub.';}
function applyPublicMetadata(repos,mode){
  if(!Array.isArray(repos))return;
  const publicRepos=repos.filter(r=>r && r.private===false && r.owner?.login?.toLowerCase()==='swir' && typeof r.name==='string');
  if(!publicRepos.length)return;
  for(const p of projects){const r=publicRepos.find(r=>r.name===p.name);if(r){p.stars=Number.isFinite(r.stargazers_count)?r.stargazers_count:p.stars;p.language=r.language||p.language;}}
  $('#repo-count').textContent=publicRepos.length;
  dataMode=mode;updateDataLabel();
}
async function refreshPublicMetadata(){
  try{const cache=JSON.parse(safeStorage.get(CACHE_KEY)||'null');if(cache?.expires>Date.now()&&Array.isArray(cache.repos)){applyPublicMetadata(cache.repos,'cached');return;}}catch{/* A corrupt cache never blocks the catalog. */}
  const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),6000);
  try {
    const repos=[];
    for(let page=1;page<=3;page++){
      const response=await fetch(`https://api.github.com/users/Swir/repos?type=owner&per_page=100&page=${page}`,{signal:abort.signal,headers:{Accept:'application/vnd.github+json'}});
      if(!response.ok)throw new Error('Public repository metadata unavailable');
      const batch=await response.json();if(!Array.isArray(batch))throw new Error('Invalid GitHub response');repos.push(...batch);if(batch.length<100)break;
    }
    applyPublicMetadata(repos,'live');safeStorage.set(CACHE_KEY,JSON.stringify({expires:Date.now()+6*60*60*1000,repos:repos.map(({name,private:privateValue,owner,stargazers_count,language})=>({name,private:privateValue,owner:{login:owner.login},stargazers_count,language}))}));
  } catch {/* Keep the verified, dated snapshot. */} finally {clearTimeout(timeout);}
}
setLanguage(lang);
refreshPublicMetadata();
