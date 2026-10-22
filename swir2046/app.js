import { projects, projectByName, snapshot, screenshotPath, logoPath, description, categoryLabel, statusLabel, imageCaption, imageAlt, formatDate, getReleases, normalize, escapeHTML as esc, storage, getMetadataState, refreshPublicMetadata } from './project-store.js';
import { createOrbitSky } from './orbit-sky.js';
import { artwork } from './project-art.js';

const $ = (selector, scope = document) => scope?.querySelector(selector) ?? null;
const $$ = (selector, scope = document) => [...(scope?.querySelectorAll(selector) ?? [])];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const copy = {
 pl: {
  'skip':'Przejdź do projektów','desktop':'Pulpit','independent':'Independent software','search.placeholder':'Znajdź swój następny projekt…','intro.eyebrow':'TWÓJ KIERUNEK. TWOJA ORBITA.','intro.title':'Oprogramowanie <br><em>z innego świata.</em>','intro.copy':'Odkrywaj projekty. Otwieraj możliwości.','explorer':'Eksplorator projektów','workspace':'TWOJA PRZESTRZEŃ','discover':'Odkrywaj','library':'Biblioteka','releases':'Wydania','collections':'KOLEKCJE','selected.projects':'wybrane projekty','quick.search':'Szybkie wyszukiwanie','local.time':'TWÓJ CZAS LOKALNY','clock.quote':'Dobry moment, żeby stworzyć coś swojego.','in.orbit':'JUŻ NA ORBICIE','all.releases':'Wszystkie wydania','desktop.note':'Własny kod.<br>Własne zasady.','guide.title':'Przestrzeń jest Twoja.','guide.copy':'Otwórz projekt z pulpitu lub wróć do eksploratora.','explorer.open':'Otwórz eksplorator','portfolio':'INTERAKTYWNE PORTFOLIO','desktop.hint':'Otwórz projekt. Przesuń okno. Odkrywaj po swojemu.','search':'Szukaj','search.navigate':'wybierz','search.open':'otwórz','minimize':'Minimalizuj','maximize':'Maksymalizuj','restore':'Przywróć rozmiar','close':'Zamknij','home.eyebrow':'NIEZALEŻNE OPROGRAMOWANIE / BY SWIR','home.title':'Witaj na własnej orbicie.','home.count':'22 powody do odkrywania','featured':'PROJEKT W CENTRUM UWAGI','featured.copy':'Komunikacja poza utartym szlakiem. Eksperymentalna sieć mesh i tester połączeń napisany w Rust.','project.open':'Poznaj projekt','featured.caption':'RZECZYWISTY INTERFEJS · TESTER ALPHA','shortcuts':'Wybierz następny kierunek','all.projects':'Wszystkie projekty','creative.title':'Dla pomysłów, które nie mieszczą się w szablonie.','home.footer':'Oryginalne projekty. Rzeczywiste interfejsy. Kod, do którego możesz zajrzeć.','library.eyebrow':'WSZYSTKIE TWOJE KIERUNKI','library.title':'Biblioteka projektów','library.search':'Szukaj nazwy, technologii lub pomysłu…','library.count':'projektów w katalogu','library.visible':'wyników','library.reset':'Wyczyść filtry','empty.title':'Tu jeszcze nic nie ma.','empty.copy':'Spróbuj innej nazwy albo zmień kategorię.','release.eyebrow':'OD KODU DO WYDANIA','release.title':'Gotowe do bliższego poznania.','snapshot.before':'Informacje o wydaniach sprawdzone','snapshot.after':'Aktualny stan i pliki znajdziesz w repozytoriach.','repository':'Kod na GitHubie','release':'Zobacz wydanie','os.preview':'Prezentacja SWIR OS','enlarge':'Powiększ','unreleased':'Projekt jest rozwijany. Aktualny zakres i postępy znajdziesz w repozytorium.','image.close':'Zamknij podgląd','image.illustration':'Ilustracja projektu','project.source':'POZNAJ KOD PROJEKTU','metadata.snapshot':'GitHub / zapis katalogu','metadata.cached':'GitHub / zapisane metadane','metadata.live':'GitHub / metadane odświeżone','metadata.scope':'Odświeżane są liczba repozytoriów, gwiazdki i języki. Katalog i wydania:','motion.pause':'Wstrzymaj efekty','motion.play':'Wznów efekty','search.title':'Wyszukiwanie projektów','search.input':'Nazwa projektu lub dokąd chcesz przejść…','search.commands':'PRZEJDŹ DO','search.projects':'PROJEKTY','terminal.title':'Małe polecenie. Nowe możliwości.','terminal.hint':'Wpisz help, ls lub open KonoNexus.','terminal.greeting':'Witaj w terminalu projektów SWIR.','terminal.help':'help              pokaż dostępne polecenia\nls                pokaż wszystkie projekty\nopen <nazwa>      otwórz okno projektu\nabout             poznaj SWIR / ORBIT\nclear             wyczyść terminal','terminal.unknown':'Nieznane polecenie. Wpisz help.','terminal.notfound':'Nie znaleziono projektu. Wpisz ls, aby zobaczyć listę.','terminal.choose':'Pasuje kilka projektów — wybierz jeden:','terminal.opening':'Otwarto projekt:','terminal.about':'SWIR / ORBIT — interaktywne portfolio niezależnego oprogramowania. Własny kod. Własne zasady.','terminal.send':'Wykonaj','project.opened':'Otwarto okno projektu','project.closed':'Zamknięto okno projektu','project.minimized':'Okno zminimalizowane. Przywrócisz je z docka.','shortcut.label':'Skróty do projektów','widgets.label':'Czas lokalny i wydania','dock.label':'Dock aplikacji','filter.all':'Wszystko','windows.title':'Otwarte okna','windows.input':'Znajdź otwarte lub zminimalizowane okno…','windows.group':'OTWARTE OKNA','terminal.input':'Polecenie terminala','all.repositories':'Wszystkie repozytoria'
 },
 en: {
  'skip':'Skip to projects','desktop':'Desktop','independent':'Independent software','search.placeholder':'Find your next project…','intro.eyebrow':'YOUR DIRECTION. YOUR ORBIT.','intro.title':'Software <br><em>from another world.</em>','intro.copy':'Explore projects. Open possibilities.','explorer':'Project explorer','workspace':'YOUR WORKSPACE','discover':'Discover','library':'Library','releases':'Releases','collections':'COLLECTIONS','selected.projects':'selected projects','quick.search':'Quick search','local.time':'YOUR LOCAL TIME','clock.quote':'A good moment to create something of your own.','in.orbit':'ALREADY IN ORBIT','all.releases':'All releases','desktop.note':'Your code.<br>Your rules.','guide.title':'Make this space yours.','guide.copy':'Open a project from the desktop or return to the explorer.','explorer.open':'Open explorer','portfolio':'INTERACTIVE PORTFOLIO','desktop.hint':'Open a project. Move a window. Explore your way.','search':'Search','search.navigate':'navigate','search.open':'open','minimize':'Minimize','maximize':'Maximize','restore':'Restore size','close':'Close','home.eyebrow':'INDEPENDENT SOFTWARE / BY SWIR','home.title':'Welcome to your own orbit.','home.count':'22 reasons to explore','featured':'IN THE SPOTLIGHT','featured.copy':'Communication beyond the usual paths. An experimental mesh network and connection tester, written in Rust.','project.open':'Explore project','featured.caption':'ACTUAL INTERFACE · ALPHA TESTER','shortcuts':'Choose your next direction','all.projects':'All projects','creative.title':'For ideas that do not fit the template.','home.footer':'Original projects. Actual interfaces. Code you can explore.','library.eyebrow':'EVERY DIRECTION, ONE PLACE','library.title':'Project library','library.search':'Search names, technologies or ideas…','library.count':'projects in the catalog','library.visible':'results','library.reset':'Reset filters','empty.title':'Nothing here yet.','empty.copy':'Try another name or choose a different category.','release.eyebrow':'FROM CODE TO RELEASE','release.title':'Ready for a closer look.','snapshot.before':'Release information checked on','snapshot.after':'See the repositories for the latest status and files.','repository':'Code on GitHub','release':'View release','os.preview':'SWIR OS presentation','enlarge':'Enlarge','unreleased':'This project is in development. Explore its repository for the current scope and progress.','image.close':'Close preview','image.illustration':'Project illustration','project.source':'EXPLORE THE PROJECT CODE','metadata.snapshot':'GitHub / catalog snapshot','metadata.cached':'GitHub / cached metadata','metadata.live':'GitHub / metadata updated','metadata.scope':'Repository count, stars and languages are refreshed. Catalog and releases:','motion.pause':'Pause visual effects','motion.play':'Resume visual effects','search.title':'Project search','search.input':'A project name or somewhere to go…','search.commands':'GO TO','search.projects':'PROJECTS','terminal.title':'Small commands. New possibilities.','terminal.hint':'Type help, ls or open KonoNexus.','terminal.greeting':'Welcome to the SWIR project terminal.','terminal.help':'help              show available commands\nls                list all projects\nopen <name>       open a project window\nabout             learn about SWIR / ORBIT\nclear             clear the terminal','terminal.unknown':'Unknown command. Type help.','terminal.notfound':'Project not found. Type ls to see the list.','terminal.choose':'Several projects match — choose one:','terminal.opening':'Project opened:','terminal.about':'SWIR / ORBIT — an interactive portfolio of independent software. Your code. Your rules.','terminal.send':'Run','project.opened':'Project window opened','project.closed':'Project window closed','project.minimized':'Window minimized. Restore it from the dock.','shortcut.label':'Project shortcuts','widgets.label':'Local time and releases','dock.label':'Application dock','filter.all':'Everything','windows.title':'Open windows','windows.input':'Find an open or minimized window…','windows.group':'OPEN WINDOWS','terminal.input':'Terminal command','all.repositories':'Every repository'
 }
};
let lang=storage.get('swir.language')==='en'?'en':'pl';
const t=key=>copy[lang][key]??copy.pl[key]??key;
const mediaMotion=matchMedia('(prefers-reduced-motion: reduce)');
const mobile=()=>matchMedia('(max-width:760px)').matches;
let paused=mediaMotion.matches||storage.get('swir.motion')==='paused';
let sky=null, view='home', category='all', query='', zIndex=10, focused='explorer';
let activeImage=null, commandTrigger=null, imageTrigger=null, restoreCommandFocus=true, commandScope='all';
const windows=new Map();
const explorer=$('#explorer-window');
const pinned=['KonoNexus','SWIR_OS','Konofix','Dragon-DiskForge','BrokeDJ'];
const categories=['tools','creators','communication','system','games'];
const colors={tools:'#71e7ff',creators:'#ae9aff',communication:'#7ce2c8',system:'#86aaff',games:'#edba7c'};
const terminalHistory=[];
const projectLabel=name=>name==='Dragon-DiskForge'?'DiskForge':projectByName.get(name)?.displayName||name;
const mark=project=>{const path=logoPath(project.name);return `<span class="app-mark ${path?'has-image':''}" style="--project-color:${esc(project.color||'#71e7ff')}" aria-hidden="true">${path?`<img src="${path}" alt="" width="42" height="42">`:project.icon==='code'?icon('code'):esc(project.icon||'</>')}</span>`;};
const tag=project=>`<span class="stage-tag stage-${esc(project.stage)}">${esc(statusLabel(project.stage,lang))}</span>`;
const note=()=>`${t('snapshot.before')} ${formatDate(new Date(snapshot.verified_date+'T12:00:00Z'),lang,true)}. ${t('snapshot.after')}`;
const announce=value=>{$('#announcer').textContent=value;};
const matchProject=(project,value)=>normalize(`${project.name} ${project.displayName} ${description(project,lang)} ${project.language||''} ${categoryLabel(project.category,lang)}`).includes(normalize(value));
function art(name){return (artwork[name]||'').replace(/Ilustracja projektu/g,t('image.illustration'));}
function applyCopy(scope=document){for(const el of $$('[data-i18n]',scope)) el.innerHTML=t(el.dataset.i18n);for(const el of $$('[data-label]',scope))el.setAttribute('aria-label',t(el.dataset.label));}

function renderShortcuts(){
 $('#desktop-shortcuts').innerHTML=pinned.map(name=>{const p=projectByName.get(name);return `<button class="desktop-shortcut" data-open-project="${esc(name)}" aria-haspopup="dialog" title="${esc(t('project.open')+': '+p.displayName)}">${mark(p)}<span>${esc(projectLabel(name))}</span></button>`;}).join('');
 $('#sidebar-collections').innerHTML=categories.map(key=>`<button class="collection-item ${category===key&&view==='library'?'active':''}" data-category="${key}"><i style="--collection-color:${colors[key]}"></i><span>${esc(categoryLabel(key,lang))}</span></button>`).join('');
 renderDock();
}
function dockProject(name){const p=projectByName.get(name);const state=windows.get(name);return `<button class="dock-button ${state?'running':''} ${focused===name&&!state?.el.hidden?'focused':''}" data-dock-project="${esc(name)}" aria-label="${esc(p.displayName)}" aria-haspopup="dialog">${mark(p)}<span class="dock-label">${esc(p.displayName)}</span><i class="running-dot"></i></button>`;}
function renderDock(){
 const active=document.activeElement?.dataset?.dockProject;
 $('#pinned-dock').innerHTML=pinned.map(dockProject).join('');
 const extras=[...windows.keys()].filter(name=>!pinned.includes(name));
 $('#running-dock').innerHTML=extras.length?`<button class="dock-button dock-tasks" data-action="windows" aria-label="${esc(t('windows.title'))}">${icon('restore')}<span class="dock-label">${esc(t('windows.title'))} (${windows.size})</span><small>${windows.size}</small></button>`:'';
 $('.dock').classList.toggle('has-tasks',extras.length>0);
 const launcher=$('[data-dock="explorer"]');launcher.classList.toggle('running',!explorer.hidden);launcher.classList.toggle('focused',focused==='explorer'&&!explorer.hidden);launcher.setAttribute('aria-label',t('explorer.open'));
 if(active)$$('[data-dock-project]').find(el=>el.dataset.dockProject===active)?.focus({preventScroll:true});
}
function viewHeading(eyebrow,title,aside=''){return `<div class="view-heading"><div><p class="micro-label">${esc(eyebrow)}</p><h2>${esc(title)}</h2></div>${aside?`<span>${esc(aside)}</span>`:''}</div>`;}
function renderHome(){
 const nexus=projectByName.get('KonoNexus');
 return viewHeading(t('home.eyebrow'),t('home.title'),t('home.count'))+`<article class="featured-project"><div class="featured-copy"><span class="featured-eyebrow"><i></i>${esc(t('featured'))}</span><div class="featured-brand">${mark(nexus)}<h3>KonoNexus</h3></div><p>${esc(t('featured.copy'))}</p><div class="featured-bottom"><button class="primary-button" data-open-project="KonoNexus" aria-haspopup="dialog">${esc(t('project.open'))}${icon('up')}</button>${tag(nexus)}</div></div><div class="featured-media"><button class="featured-preview" data-preview-image="KonoNexus" aria-label="${esc(t('enlarge')+' — '+imageAlt(nexus,lang))}" aria-haspopup="dialog"><img src="${screenshotPath(nexus.name)}" alt="${esc(imageAlt(nexus,lang))}" width="982" height="792" fetchpriority="high"></button><span class="featured-media-caption">${esc(t('featured.caption'))}</span></div></article><div class="section-line"><h3>${esc(t('shortcuts'))}</h3><button data-view="library">${esc(t('all.projects'))}${icon('arrow')}</button></div><div class="quick-grid">${['SWIR_OS','Konofix','Dragon-DiskForge'].map(name=>{const p=projectByName.get(name);return `<button class="quick-card" data-open-project="${name}" aria-haspopup="dialog">${mark(p)}<span><strong>${esc(projectLabel(name))}</strong><small>${esc(categoryLabel(p.category,lang))}</small></span>${icon('up')}</button>`;}).join('')}</div><div class="section-line"><h3>${esc(t('creative.title'))}</h3></div><div class="creative-grid">${['BrokeDJ','OCRYON','SwirEngine'].map(name=>`<button class="creative-card pick-${name==='BrokeDJ'?'music':name==='OCRYON'?'ocr':'engine'}" data-open-project="${name}" aria-haspopup="dialog">${art(name)}<span class="creative-caption">${esc(projectByName.get(name).displayName)}${icon('up')}</span></button>`).join('')}</div><div class="home-footer">${icon('code')}<span>${esc(t('home.footer'))}</span></div>`;
}
function renderLibrary(){return viewHeading(t('library.eyebrow'),t('library.title'))+`<div class="library-toolbar"><label class="library-search">${icon('search')}<input type="search" id="catalog-search" placeholder="${esc(t('library.search'))}" aria-label="${esc(t('search.title'))}" value="${esc(query)}" autocomplete="off"></label></div><div class="filter-row">${['all',...categories].map(key=>`<button class="filter-chip ${category===key?'active':''}" data-category="${key}" aria-pressed="${category===key}">${esc(key==='all'?t('filter.all'):categoryLabel(key,lang))}</button>`).join('')}</div><div class="results-meta"><span id="result-count"></span><span>${projects.length} ${esc(t('library.count'))}</span></div><div id="project-grid" class="catalog-grid"></div>`;}
function renderLibraryResults(){
 const grid=$('#project-grid');if(!grid)return;
 const matches=projects.filter(p=>(category==='all'||p.category===category||p.categories?.includes(category))&&matchProject(p,query));
 const n=matches.length;const word=lang==='en'?(n===1?'result':'results'):n===1?'wynik':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'wyniki':'wyników';
 $('#result-count').textContent=`${n} ${word}`;
 grid.innerHTML=matches.length?matches.map(p=>`<button class="project-tile" data-open-project="${esc(p.name)}" aria-haspopup="dialog"><span class="tile-top">${mark(p)}${icon('up')}</span><h3>${esc(p.displayName)}</h3><p>${esc(description(p,lang))}</p><span class="tile-bottom">${tag(p)}<span class="tile-language">${esc(p.language||'')}</span></span></button>`).join(''):`<div class="empty-state">${icon('search')}<h3>${esc(t('empty.title'))}</h3><p>${esc(t('empty.copy'))}</p><button class="secondary-button" data-action="reset-filters" style="margin-top:18px">${esc(t('library.reset'))}</button></div>`;
}
function renderReleases(){return viewHeading(t('release.eyebrow'),t('release.title'))+`<div class="release-list">${getReleases(20).map(p=>`<a class="release-item" href="${esc(p.release.url)}" target="_blank" rel="noopener noreferrer">${mark(p)}<span><strong>${esc(p.displayName)}</strong><small>${esc(p.release.tag)} / ${esc(p.platform||p.language||'')}</small></span><time datetime="${esc(p.release.published_at)}">${esc(formatDate(new Date(p.release.published_at),lang))}</time>${icon('release')}</a>`).join('')}</div><p class="snapshot-note">${esc(note())}</p>`;}
function renderTerminal(){return viewHeading('SWIR / TERMINAL',t('terminal.title'))+`<div class="terminal-view"><div class="terminal-logo">&lt;ORBIT /&gt;</div><p class="terminal-sub">${esc(t('terminal.hint'))}</p><div class="terminal-pills"><button data-command="help">help</button><button data-command="ls">ls</button><button data-command="open KonoNexus">open KonoNexus</button><button data-command="clear">clear</button></div><div id="terminal-output" role="log" aria-live="polite"></div><form id="terminal-form" class="terminal-form"><label for="terminal-input" class="terminal-prompt">swir@orbit:~$</label><input id="terminal-input" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="${esc(t('terminal.input'))}"><button class="terminal-submit" aria-label="${esc(t('terminal.send'))}">↵</button></form></div>`;}
function updateTerminalOutput(){const output=$('#terminal-output');if(!output)return;output.innerHTML=`<p class="terminal-line">${esc(t('terminal.greeting'))}</p>`+terminalHistory.slice(-120).map(line=>`<div class="terminal-line ${line.type||''}">${line.html||esc(line.message)}</div>`).join('');}
function renderView(){
 const content=$('#main-content');const previousScroll=content.scrollTop;
 content.innerHTML=view==='home'?renderHome():view==='library'?renderLibrary():view==='releases'?renderReleases():renderTerminal();
 for(const button of $$('#explorer-navigation [data-view]')){button.classList.toggle('active',button.dataset.view===view);button.setAttribute('aria-current',button.dataset.view===view?'page':'false');}
 for(const button of $$('.collection-item'))button.classList.toggle('active',view==='library'&&category===button.dataset.category);
 if(view==='library')renderLibraryResults();if(view==='terminal')updateTerminalOutput();content.scrollTop=previousScroll;
}
function setView(next,options={}){
 if(!['home','library','releases','terminal'].includes(next))return;
 view=next;if(options.category!==undefined)category=options.category;
 explorer.hidden=false;renderView();$('#main-content').scrollTop=0;focusWindow('explorer');updateGuide();
 if(mobile())explorer.scrollIntoView({behavior:paused?'instant':'smooth',block:'start'});
 if(options.focusSearch)$('#catalog-search')?.focus({preventScroll:true});
}
function getWindow(name){return name==='explorer'?explorer:windows.get(name)?.el;}
function focusWindow(name,moveFocus=false){
 const element=getWindow(name);if(!element||element.hidden)return;
 if(zIndex>120){let index=10;for(const window of $$('.app-window').sort((a,b)=>(Number(a.style.zIndex)||0)-(Number(b.style.zIndex)||0)))window.style.zIndex=++index;zIndex=index;}
 focused=name;element.style.zIndex=++zIndex;for(const win of $$('.app-window'))win.classList.toggle('is-focused',win===element);
 if(moveFocus)element.focus({preventScroll:true});renderDock();
}
function updateGuide(){$('#desktop-guide').hidden=!explorer.hidden||[...windows.values()].some(state=>!state.el.hidden);}
function closeWindow(name,minimize=false){
 const element=getWindow(name);if(!element)return;
 const state=windows.get(name);
 if(name==='explorer'||minimize){element.hidden=true;announce(t('project.minimized'));}
 else {element.remove();windows.delete(name);announce(`${t('project.closed')}: ${state?.project.displayName||name}`);}
 const candidates=$$('.app-window').filter(win=>!win.hidden).sort((a,b)=>(Number(b.style.zIndex)||0)-(Number(a.style.zIndex)||0));
 if(candidates[0])focusWindow(candidates[0].dataset.window);else focused=null;
 updateGuide();renderDock();
 const target=state?.trigger?.isConnected&&state.trigger.getClientRects().length?state.trigger:$$('[data-dock-project]').find(el=>el.dataset.dockProject===name)||$('[data-dock="explorer"]');target?.focus({preventScroll:true});
}
function toggleMaximize(name){
 const element=getWindow(name);if(!element||mobile())return;
 const isMax=element.classList.toggle('window-maximized');const btn=$('[data-window-action="maximize"]',element);
 if(btn){btn.setAttribute('aria-label',t(isMax?'restore':'maximize'));btn.innerHTML=icon(isMax?'restore':'max');}
 focusWindow(name);
}
function projectContents(p){
 const screenshot=screenshotPath(p.name);
 return `<div class="project-detail-top">${mark(p)}<div><p class="micro-label">${esc(categoryLabel(p.category,lang))}</p><h2>${esc(p.displayName)}</h2></div>${tag(p)}</div><p class="project-description">${esc(description(p,lang))}</p><div class="project-detail-meta">${p.language?`<span data-language="${esc(p.name)}">${esc(p.language)}</span>`:''}${p.platform&&p.platform!==p.language?`<span>${esc(p.platform)}</span>`:''}${p.release?`<span>${esc(p.release.tag)}</span>`:''}<span data-stars="${esc(p.name)}" ${p.stars>0?'':'hidden'}>☆ ${Number(p.stars)||0}</span></div><div class="project-detail-actions"><a class="primary-button" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${icon('github')}${esc(t('repository'))}${icon('up')}</a>${p.release?`<a class="secondary-button" href="${esc(p.release.url)}" target="_blank" rel="noopener noreferrer">${icon('release')}${esc(t('release'))}</a>`:''}${p.name==='SWIR_OS'?`<a class="secondary-button" href="./swir-os.html">${esc(t('os.preview'))}${icon('up')}</a>`:''}</div>${screenshot?`<button class="project-screenshot" data-preview-image="${esc(p.name)}" aria-label="${esc(t('enlarge')+': '+p.displayName)}" aria-haspopup="dialog"><img src="${screenshot}" alt="${esc(imageAlt(p,lang))}"><span>${icon('max')}${esc(t('enlarge'))}</span></button><p class="project-image-caption">${esc(imageCaption(p.name,lang))}</p>`:`<div class="project-without-image">${mark(p)}<p><small>${esc(t('project.source'))}</small>${esc(p.displayName)}</p></div>`}<p class="snapshot-note">${esc(p.release?note():t('unreleased'))}</p>`;
}
function openProject(name,trigger=document.activeElement){
 const p=projectByName.get(name);if(!p)return;
 let state=windows.get(name);
 if(state){state.el.hidden=false;focusWindow(name,true);updateGuide();return;}
 const el=document.createElement('section');const id='project-title-'+name.replace(/[^a-z0-9-]/gi,'-');
 el.className='app-window project-window is-new';el.dataset.window=name;el.setAttribute('role','dialog');el.setAttribute('aria-labelledby',id);el.tabIndex=-1;
 const offset=(windows.size%4)*24;const width=Math.min(760,innerWidth-80);
 if(!mobile()){el.style.left=Math.min(innerWidth-width-16,Math.max(16,(innerWidth-width)/2+offset))+'px';el.style.top=(47+offset)+'px';}
 el.innerHTML=`<header class="window-titlebar" data-drag="${esc(name)}"><div class="window-caption">${mark(p)}<h2 id="${id}">${esc(p.displayName)}</h2><span class="window-path">/ projects / ${esc(p.name)}</span></div><div class="window-controls"><button data-window-action="minimize" data-window-target="${esc(name)}" data-label="minimize" aria-label="${esc(t('minimize'))}">${icon('minus')}</button><button data-window-action="maximize" data-window-target="${esc(name)}" data-label="maximize" aria-label="${esc(t('maximize'))}">${icon('max')}</button><button data-window-action="close" data-window-target="${esc(name)}" data-label="close" aria-label="${esc(t('close'))}">${icon('close')}</button></div></header><div class="project-window-content">${projectContents(p)}</div>`;
 $('#project-windows').append(el);state={el,project:p,trigger};windows.set(name,state);setupDrag(el);focusWindow(name,true);updateGuide();announce(`${t('project.opened')}: ${p.displayName}`);setTimeout(()=>el.classList.remove('is-new'),350);
}
function toggleDockProject(name,trigger){const state=windows.get(name);if(state&&!state.el.hidden&&focused===name)closeWindow(name,true);else openProject(name,trigger);}
function setupDrag(element){
 const handle=$('.window-titlebar',element);let drag=null;
 handle.addEventListener('pointerdown',event=>{
  if(event.button!==0||mobile()||element.classList.contains('window-maximized')||event.target.closest('button,a'))return;
  const rect=element.getBoundingClientRect(),stage=$('.desktop-stage').getBoundingClientRect();
  drag={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top-stage.top,width:rect.width,height:rect.height};
  element.style.left=drag.left+'px';element.style.top=drag.top+'px';element.style.width=drag.width+'px';element.style.height=drag.height+'px';element.style.right='auto';element.style.bottom='auto';
  element.classList.add('is-dragging');focusWindow(element.dataset.window);handle.setPointerCapture(event.pointerId);event.preventDefault();
 });
 handle.addEventListener('pointermove',event=>{if(!drag)return;const height=$('.desktop-stage').clientHeight;element.style.left=Math.max(8,Math.min(innerWidth-drag.width-8,drag.left+event.clientX-drag.x))+'px';element.style.top=Math.max(0,Math.min(height-90,drag.top+event.clientY-drag.y))+'px';});
 const stop=()=>{drag=null;element.classList.remove('is-dragging');};handle.addEventListener('pointerup',stop);handle.addEventListener('pointercancel',stop);handle.addEventListener('lostpointercapture',stop);
 handle.addEventListener('dblclick',event=>{if(!event.target.closest('button,a'))toggleMaximize(element.dataset.window);});
 element.addEventListener('pointerdown',()=>{if(focused!==element.dataset.window)focusWindow(element.dataset.window);});
 element.addEventListener('focusin',()=>{if(focused!==element.dataset.window)focusWindow(element.dataset.window);});
}
setupDrag(explorer);

function renderWidgets(){
 $('#recent-releases').innerHTML=getReleases(3).map(p=>`<a class="mini-release" href="${esc(p.release.url)}" target="_blank" rel="noopener noreferrer">${mark(p)}<span><strong>${esc(p.displayName)}</strong><small>${esc(p.release.tag)} · ${esc(formatDate(new Date(p.release.published_at),lang))}</small></span>${icon('up')}</a>`).join('');
}
function updateClock(){const now=new Date();const locale=lang==='pl'?'pl-PL':'en-GB';const time=new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',hour12:false}).format(now);$('#bar-clock').textContent=time;$('#large-clock').textContent=time;$('#large-clock').dateTime=now.toISOString();$('#clock-date').textContent=new Intl.DateTimeFormat(locale,{weekday:'long',day:'numeric',month:'long'}).format(now);}
function updateMetadata(){const state=getMetadataState();const label=$('#metadata-label');label.textContent=t('metadata.'+state.mode);label.title=`${t('metadata.scope')} ${formatDate(state.verifiedDate,lang,true)}. ${state.count} ${lang==='pl'?'publicznych repozytoriów':'public repositories'}.`;label.closest('.source-indicator').classList.toggle('is-live',state.mode==='live');if(view==='library')renderLibraryResults();for(const el of $$('[data-language]'))el.textContent=projectByName.get(el.dataset.language)?.language||'';for(const el of $$('[data-stars]')){const stars=projectByName.get(el.dataset.stars)?.stars||0;el.textContent='☆ '+stars;el.hidden=stars<=0;}}
function updateMotion(){document.documentElement.classList.toggle('motion-paused',paused);sky?.setPaused(paused);const button=$('#motion-toggle');button.setAttribute('aria-pressed',String(paused));button.setAttribute('aria-label',t(paused?'motion.play':'motion.pause'));button.title=t(paused?'motion.play':'motion.pause');button.innerHTML=icon(paused?'play':'pause');}
function setLanguage(next){
 lang=next==='en'?'en':'pl';storage.set('swir.language',lang);document.documentElement.lang=lang;document.title=lang==='pl'?'SWIR / ORBIT — Oprogramowanie z innej orbity.':'SWIR / ORBIT — Software from another world.';
 applyCopy();$('#language-toggle').innerHTML=lang==='pl'?'PL <span>EN</span>':'EN <span>PL</span>';$('#language-toggle').setAttribute('aria-label',lang==='pl'?'Switch to English':'Przełącz na polski');
 $('#desktop-shortcuts').setAttribute('aria-label',t('shortcut.label'));$('.desktop-widgets').setAttribute('aria-label',t('widgets.label'));$('.dock').setAttribute('aria-label',t('dock.label'));$('.dock-search').setAttribute('aria-label',t('search.title'));$('#command-title').textContent=t('search.title');$('#command-input').placeholder=t('search.input');$('.command-close').setAttribute('aria-label',t('close'));$('#image-close').setAttribute('aria-label',t('image.close'));
 renderShortcuts();renderView();renderWidgets();updateClock();updateMetadata();updateMotion();
 for(const state of windows.values()){const body=$('.project-window-content',state.el);const top=body.scrollTop;body.innerHTML=projectContents(state.project);body.scrollTop=top;const max=$('[data-window-action="maximize"]',state.el);max.setAttribute('aria-label',t(state.el.classList.contains('window-maximized')?'restore':'maximize'));}
 if($('#command-dialog').open)renderCommands();if(activeImage)renderImage(activeImage);
}

function renderCommands(){
 const value=$('#command-input').value.trim();const commands=[{view:'home',name:t('discover'),icon:'home'},{view:'library',name:t('library'),icon:'grid'},{view:'releases',name:t('releases'),icon:'release'},{view:'terminal',name:'Terminal',icon:'terminal'}].filter(c=>commandScope!=='windows'&&(!value||normalize(c.name).includes(normalize(value))));
 const pool=commandScope==='windows'?[...windows.values()].map(state=>state.project):projects;const found=value?pool.filter(p=>matchProject(p,value)):commandScope==='windows'?pool:pinned.map(name=>projectByName.get(name));
 $('#command-results').innerHTML=(commands.length?`<p class="command-group">${esc(t('search.commands'))}</p>`+commands.map(c=>`<button class="command-result" data-command-view="${c.view}"><span class="command-symbol">${icon(c.icon)}</span><span><strong>${esc(c.name)}</strong><small>SWIR / ORBIT</small></span>${icon('arrow')}</button>`).join(''):'')+(found.length?`<p class="command-group">${esc(t(commandScope==='windows'?'windows.group':'search.projects'))}</p>`+found.slice(0,22).map(p=>`<button class="command-result" data-command-project="${esc(p.name)}"><span>${mark(p)}</span><span><strong>${esc(p.displayName)}</strong><small>${esc(categoryLabel(p.category,lang))} / ${esc(p.language||'')}</small></span>${icon('up')}</button>`).join(''):'')+(!commands.length&&!found.length?`<div class="empty-state"><h3>${esc(t('empty.title'))}</h3><p>${esc(t('empty.copy'))}</p></div>`:'');
}
function openSearch(trigger=document.activeElement,scope='all'){const dialog=$('#command-dialog');if(dialog.open)return;commandTrigger=trigger;restoreCommandFocus=true;commandScope=scope;$('#command-title').textContent=t(scope==='windows'?'windows.title':'search.title');$('#command-input').placeholder=t(scope==='windows'?'windows.input':'search.input');$('#command-input').value='';renderCommands();dialog.showModal();$('#command-input').focus();}
function closeSearch(restore=true){restoreCommandFocus=restore;const dialog=$('#command-dialog');if(dialog.open)dialog.close();}
$('#command-input').addEventListener('input',renderCommands);
$('.command-close').addEventListener('click',()=>closeSearch());
$('#command-dialog').addEventListener('close',()=>{if(restoreCommandFocus&&commandTrigger?.isConnected&&commandTrigger.getClientRects().length)commandTrigger.focus({preventScroll:true});});
$('#command-dialog').addEventListener('keydown',event=>{
 const buttons=$$('.command-result',$('#command-results'));const index=buttons.indexOf(document.activeElement);
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const next=event.key==='ArrowDown'?(index+1)%buttons.length:(index<0?buttons.length-1:(index-1+buttons.length)%buttons.length);buttons[next]?.focus();}
 else if(event.key==='Enter'&&document.activeElement===$('#command-input')){event.preventDefault();buttons[0]?.click();}
});
function renderImage(project){$('#image-title').textContent=project.displayName;$('#image-preview').src=screenshotPath(project.name);$('#image-preview').alt=imageAlt(project,lang);$('#image-caption').textContent=imageCaption(project.name,lang);}
function openImage(name,trigger){const p=projectByName.get(name);if(!p||!screenshotPath(name))return;activeImage=p;imageTrigger=trigger;renderImage(p);$('#image-dialog').showModal();$('#image-close').focus();}
$('#image-close').addEventListener('click',()=>$('#image-dialog').close());
$('#image-dialog').addEventListener('close',()=>{activeImage=null;if(imageTrigger?.isConnected)imageTrigger.focus({preventScroll:true});});
for(const dialog of [$('#command-dialog'),$('#image-dialog')])dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});

function terminalList(list){return list.map(p=>`<button class="terminal-project-link" data-open-project="${esc(p.name)}">${esc(p.displayName)}</button>`).join(' · ');}
function runCommand(raw){
 const command=raw.trim();if(!command)return;
 terminalHistory.push({type:'command',message:'swir@orbit:~$ '+command});
 const [verb,...args]=command.split(/\s+/);const rest=args.join(' ');let projectToOpen=null;
 if(verb.toLowerCase()==='clear'){terminalHistory.length=0;}
 else if(verb.toLowerCase()==='help')terminalHistory.push({message:t('terminal.help')});
 else if(verb.toLowerCase()==='ls')terminalHistory.push({html:terminalList(projects)});
 else if(verb.toLowerCase()==='about')terminalHistory.push({message:t('terminal.about')});
 else if(verb.toLowerCase()==='open'&&rest){const exact=projects.find(p=>normalize(p.name)===normalize(rest)||normalize(p.displayName)===normalize(rest));const list=exact?[exact]:projects.filter(p=>normalize(p.name+' '+p.displayName).includes(normalize(rest)));if(list.length===1){projectToOpen=list[0];terminalHistory.push({message:t('terminal.opening')+' '+projectToOpen.displayName});}else if(list.length>1)terminalHistory.push({html:esc(t('terminal.choose'))+'<br>'+terminalList(list)});else terminalHistory.push({type:'error',message:t('terminal.notfound')});}
 else terminalHistory.push({type:'error',message:t('terminal.unknown')});
 if(terminalHistory.length>120)terminalHistory.splice(0,terminalHistory.length-120);
 updateTerminalOutput();const input=$('#terminal-input');if(input){input.value='';input.focus({preventScroll:true});input.scrollIntoView({block:'nearest',behavior:'instant'});}if(projectToOpen)openProject(projectToOpen.name,input);
}

document.addEventListener('click',event=>{
 if(!(event.target instanceof Element))return;const button=event.target.closest('button,a');if(!button)return;
 const data=button.dataset;
 if(data.windowAction){if(data.windowAction==='maximize')toggleMaximize(data.windowTarget);else closeWindow(data.windowTarget,data.windowAction==='minimize');return;}
 if(data.commandProject){const name=data.commandProject;closeSearch(false);openProject(name,$('[data-action="search"]'));return;}
 if(data.commandView){const next=data.commandView;closeSearch(false);setView(next,{focusSearch:next==='library'});return;}
 if(data.openProject){event.preventDefault();openProject(data.openProject,button);return;}
 if(data.previewImage){openImage(data.previewImage,button);return;}
 if(data.dockProject){toggleDockProject(data.dockProject,button);return;}
 if(data.category){category=data.category;setView('library',{category});$$('.filter-chip').find(el=>el.dataset.category===category)?.focus({preventScroll:true});return;}
 if(data.view){setView(data.view);return;}
 if(data.command){if(view!=='terminal')setView('terminal');runCommand(data.command);return;}
 if(data.action==='search'){openSearch(button);return;}
 if(data.action==='windows'){openSearch(button,'windows');return;}
 if(data.action==='home'){setView('home');return;}
 if(data.action==='reset-filters'){query='';category='all';setView('library');return;}
});
document.addEventListener('input',event=>{if(event.target.id==='catalog-search'){query=event.target.value;renderLibraryResults();}});
document.addEventListener('submit',event=>{if(event.target.id==='terminal-form'){event.preventDefault();runCommand($('#terminal-input').value);}});
document.addEventListener('keydown',event=>{
 const typing=event.target instanceof Element&&(event.target.matches('input,textarea,select')||event.target.isContentEditable);
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!$('#image-dialog').open)openSearch();return;}
 if(event.key==='/'&&!typing&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!$('dialog[open]')){event.preventDefault();openSearch();return;}
 if(event.key==='Escape'&&!$('dialog[open]')&&focused&&focused!=='explorer'){event.preventDefault();closeWindow(focused);}
});
$('#language-toggle').addEventListener('click',()=>setLanguage(lang==='pl'?'en':'pl'));
$('#motion-toggle').addEventListener('click',()=>{paused=!paused;storage.set('swir.motion',paused?'paused':'playing');updateMotion();});
mediaMotion.addEventListener('change',()=>{paused=mediaMotion.matches||storage.get('swir.motion')==='paused';updateMotion();});
addEventListener('resize',()=>{
 if(mobile())return;const height=$('.desktop-stage').clientHeight;
 for(const el of $$('.app-window')){if(el.hidden||el.classList.contains('window-maximized')||!el.style.left)continue;const r=el.getBoundingClientRect();if(r.width>innerWidth-24)el.style.width=(innerWidth-24)+'px';el.style.left=Math.max(8,Math.min(parseFloat(el.style.left)||8,innerWidth-Math.min(r.width,innerWidth-24)-8))+'px';el.style.top=Math.max(0,Math.min(parseFloat(el.style.top)||0,height-90))+'px';}
},{passive:true});
$('#year').textContent=new Date().getFullYear();$('#catalog-size').textContent=projects.length;
setLanguage(lang);focusWindow('explorer');
try{sky=createOrbitSky($('#orbit-sky'));sky.setPaused(paused);}catch{ /* The CSS atmosphere preserves the desktop if canvas is unavailable. */ }
setInterval(updateClock,30000);
refreshPublicMetadata(updateMetadata);
