import { snapshot } from './projects.js';

export { snapshot };

export const projects = snapshot.projects.map(project => ({ ...project }));
export const projectByName = new Map(projects.map(project => [project.name, project]));

export const assets = {
  'Dragon-DiskForge': { image: 'dragon-diskforge.jpg', logo: 'dragon-diskforge-sigil.svg' },
  Konofix: { image: 'konofix.jpg', logo: 'konofix-icon.ico' },
  Swirui: { image: 'swirui.jpg', logo: 'swirui-icon.svg' },
  KonoNexus: { image: 'kononexus.jpg', logo: 'kononexus-icon.png' },
  SWIR_OS: { image: 'swir-os.jpg', logo: 'swir-os-icon.svg' },
  OCRYON: { image: 'ocryon.png', logo: 'ocryon-icon.svg' },
  BrokeDJ: { image: 'brokedj.jpg', logo: 'brokedj-icon.svg' },
};

export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Preferences can remain session-only. */ } },
};

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
export const normalize = value => String(value ?? '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');

const labels = {
  pl: {
    'category.all': 'Wszystko', 'category.tools': 'Narzędzia', 'category.creators': 'Dla twórców',
    'category.communication': 'Komunikacja', 'category.system': 'System', 'category.games': 'Gry i media',
    'category.other': 'Pozostałe projekty',
    'status.release': 'WYDANIE', 'status.beta': 'BETA', 'status.alpha': 'ALPHA',
    'status.pre-alpha': 'PRE-ALPHA', 'status.development': 'W ROZWOJU', 'status.source': 'ŹRÓDŁA',
    'generic.description': 'Poznaj dokumentację, kod i historię projektu na GitHubie.',
    'image.caption': 'Zrzut ekranu z publicznego repozytorium',
    'image.nexus.caption': 'Zrzut z repozytorium · tester połączeń alpha',
    'image.os.caption': 'Zrzut z repozytorium · SWIR OS Web Edition',
    'image.alt': 'Interfejs aplikacji',
    'image.nexus.alt': 'Interfejs testera połączeń KonoNexus',
    'image.os.alt': 'Pulpit SWIR OS Web Edition',
  },
  en: {
    'category.all': 'Everything', 'category.tools': 'Tools', 'category.creators': 'For creators',
    'category.communication': 'Communication', 'category.system': 'System', 'category.games': 'Games & media',
    'category.other': 'More projects',
    'status.release': 'RELEASE', 'status.beta': 'BETA', 'status.alpha': 'ALPHA',
    'status.pre-alpha': 'PRE-ALPHA', 'status.development': 'IN DEVELOPMENT', 'status.source': 'SOURCE',
    'generic.description': 'Explore the documentation, code and project history on GitHub.',
    'image.caption': 'Screenshot from the public repository',
    'image.nexus.caption': 'Repository screenshot · alpha connection tester',
    'image.os.caption': 'Repository screenshot · SWIR OS Web Edition',
    'image.alt': 'Application interface',
    'image.nexus.alt': 'KonoNexus connection tester interface',
    'image.os.alt': 'SWIR OS Web Edition desktop',
  },
};
const label = (key, lang) => labels[lang === 'en' ? 'en' : 'pl'][key] ?? labels.pl[key] ?? key;

export const screenshotPath = name => assets[name]?.image ? `./swir2046/screenshots/${assets[name].image}` : null;
export const logoPath = name => assets[name]?.logo ? `./swir2046/icons/${assets[name].logo}` : null;
export const description = (project, lang = 'pl') => (
  lang === 'en' ? project.description_en || project.description_pl : project.description_pl || project.description_en
) || label('generic.description', lang);
export const categoryLabel = (category, lang = 'pl') => label(`category.${category}`, lang);
export const statusLabel = (stage, lang = 'pl') => label(`status.${stage}`, lang);
export const imageCaption = (name, lang = 'pl') => label(
  name === 'KonoNexus' ? 'image.nexus.caption' : name === 'SWIR_OS' ? 'image.os.caption' : 'image.caption', lang,
);
export const imageAlt = (project, lang = 'pl') => project.name === 'KonoNexus'
  ? label('image.nexus.alt', lang)
  : project.name === 'SWIR_OS'
    ? label('image.os.alt', lang)
    : `${project.displayName} — ${label('image.alt', lang)}`;

export function formatDate(date, lang = 'pl', long = false) {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'pl-PL', {
    day: '2-digit', month: long ? 'long' : 'short', year: 'numeric', timeZone: 'Europe/Oslo',
  }).format(date instanceof Date ? date : new Date(date));
}

export function getReleases(limit = 10) {
  return projects
    .filter(project => project.stage === 'release' && project.release
      && project.release.prerelease !== true && Number.isFinite(Date.parse(project.release.published_at)))
    .sort((left, right) => Date.parse(right.release.published_at) - Date.parse(left.release.published_at))
    .slice(0, limit);
}

const verifiedDate = new Date(`${snapshot.verified_date}T12:00:00Z`);
let metadataMode = 'snapshot';
let repositoryCount = snapshot.public_repository_count;

export function getMetadataState() {
  return { mode: metadataMode, count: repositoryCount, verifiedDate: new Date(verifiedDate) };
}

// Refresh metadata only. Never add repositories or change curated descriptions,
// stages or release links; those remain the manually reviewed snapshot.
const CACHE_KEY = 'swir.public-repositories.v1';
const CACHE_TTL = 6 * 60 * 60 * 1000;

function publicMetadata(repos) {
  return Array.isArray(repos) ? repos.filter(repo => repo && repo.private === false
    && typeof repo.owner?.login === 'string' && repo.owner.login.toLowerCase() === 'swir'
    && typeof repo.name === 'string') : [];
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
  repositoryCount = visibleRepos.length;
  metadataMode = mode;
  return true;
}

export async function refreshPublicMetadata(onUpdate) {
  let cachedApplied = false;
  try {
    const cached = JSON.parse(storage.get(CACHE_KEY) || 'null');
    if (Number.isFinite(cached?.expires) && cached.expires > Date.now()) {
      cachedApplied = applyPublicMetadata(cached.repos, 'cached');
    }
  } catch { /* Invalid storage never prevents browsing the bundled catalog. */ }
  if (cachedApplied) {
    const state = getMetadataState();
    if (typeof onUpdate === 'function') await onUpdate(state);
    return state;
  }

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 6500);
  let refreshed = false;
  try {
    const repos = [];
    for (let page = 1; page <= 3; page++) {
      const response = await fetch(`https://api.github.com/users/Swir/repos?type=owner&sort=full_name&per_page=100&page=${page}`, {
        signal: abort.signal, headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) throw new Error('Public metadata unavailable');
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('Invalid public metadata');
      repos.push(...batch);
      if (batch.length < 100) break;
      if (page === 3) throw new Error('Repository list incomplete');
    }
    if (applyPublicMetadata(repos, 'live')) {
      storage.set(CACHE_KEY, JSON.stringify({
        expires: Date.now() + CACHE_TTL,
        repos: publicMetadata(repos).map(repo => ({
          name: repo.name, private: false, owner: { login: 'Swir' },
          stargazers_count: repo.stargazers_count, language: repo.language,
        })),
      }));
      refreshed = true;
    }
  } catch { /* Offline use and rate limits keep the existing metadata available. */ }
  finally { clearTimeout(timeout); }

  const state = getMetadataState();
  // UI callbacks run outside retrieval error handling: a renderer failure cannot
  // accidentally trigger another fetch or a duplicate notification.
  if (refreshed && typeof onUpdate === 'function') await onUpdate(state);
  return state;
}

