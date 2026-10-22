<!-- SWIR-README-STANDARD:v2 -->
<div align="center">

<img src="swir2046/mark.svg" width="88" height="88" alt="SWIR logo">

# SWIR / ORBIT

**Independent software. A different orbit.**

An interactive space desktop for exploring projects by Swir.

Polish / English · Responsive static website · Real project screenshots

[**Enter the desktop →**](https://swir.github.io/) · [**Browse projects**](https://github.com/Swir?tab=repositories) · [**SWIR OS presentation**](https://swir.github.io/swir-os.html)

</div>

![SWIR ORBIT desktop preview](swir2046/preview-studio.jpg)

## A workspace for discovering independent software

SWIR / ORBIT presents the portfolio as a spatial desktop: a procedural blue planet, deep navy windows, cyan controls, original application icons and a translucent dock. It is a portfolio interface. The separate SWIR OS product and its existing presentation retain their own links and identity.

**KonoNexus** leads the explorer, with its actual alpha tester screenshot. **SWIR OS, Konofix and Dragon DiskForge** are one click away. The original labeled illustrations for **BrokeDJ, OCRYON and SwirEngine** are retained. A searchable library contains all **22 curated projects**.

### Explore and navigate

| Feature | Behavior |
| --- | --- |
| Desktop | Open a project from its shortcut, the explorer, search or dock. |
| Project windows | Open multiple projects, drag their title bars, minimize, maximize and close. Double-click a title bar to maximize or restore it. |
| Dock | Open pinned projects or restore their windows. The open-windows control lists other open or minimized projects. |
| Explorer | Switch between Discover, Library, Releases and Terminal. Restore it from the launcher after closing or minimizing. |
| Library | Search names, descriptions and technologies; filter by primary or additional category. |
| Project details | Read the description and stage, inspect the actual screenshot, and follow repository or available release links. |
| Image viewer | Enlarge a screenshot and return to its project window. |
| Quick search | Use `/` or `Ctrl/Cmd + K`; navigate results with arrow keys and open with Enter. |
| Terminal | Use `help`, `ls`, `open <project name>`, `about` and `clear` to explore this portfolio. |
| PL / EN | Translate the interface, project descriptions and all open windows. The browser remembers the choice. |
| Motion | Pause visual effects; reduced-motion preferences and hidden-tab suspension are respected. |
| Mobile | A touch-oriented explorer and fixed project panels replace desktop dragging. The dock remains available. |

The backdrop is rendered with Canvas2D and cached procedural textures; it needs no external image or graphics library. Animation is capped at 30 FPS on desktop and 24 FPS on mobile, with pixel-budget limits and a static fallback. The clock shows the visitor's local time.

KonoNexus is labeled an **alpha connection tester**. The SWIR OS screenshot is labeled **Web Edition**. BrokeDJ remains pre-alpha and Dragon DiskForge remains in development. A project window previews the portfolio entry; repository and release actions follow the corresponding GitHub links.

## Catalog data

Descriptions, stages and release links are a manually reviewed snapshot from **21 October 2026**, stored in `swir2046/projects.js`. Update that file when adding projects or changing release information.

On a page visit, the browser can refresh the **public repository count, stars and primary languages** through GitHub's public API. Results are cached locally for six hours. The bundled catalog remains usable if the API is unavailable or rate-limited. This refresh does not add projects, rewrite descriptions or discover releases.

## Local preview

The portfolio needs no package installation or build step. In the source checkout, serve its static directory:

```sh
python -m http.server 8000 --directory dist
```

Open [http://localhost:8000/](http://localhost:8000/). In an exported GitHub Pages checkout where `index.html` is already at the root, omit `--directory dist`.

Use HTTP instead of opening the HTML directly so JavaScript modules load normally. Screenshots and project icons are local assets. Google Fonts supplies Manrope, Space Grotesk and IBM Plex Mono, with system font fallbacks; the GitHub metadata request is optional to the browsing experience.

### Main files

Paths below are relative to the published site root, or to `dist/` in the source checkout.

```text
index.html                    ORBIT desktop shell
swir2046/style.css            Spatial layout, windows, dock and responsive UI
swir2046/app.js               Window manager, explorer, search, terminal and languages
swir2046/project-store.js     Catalog helpers, assets and optional metadata refresh
swir2046/orbit-sky.js         Procedural cosmic wallpaper
swir2046/project-art.js       Original labeled project illustrations
swir2046/project-art.css      Original illustration styles
swir2046/projects.js          Reviewed project and release snapshot
swir2046/mark.svg              Portfolio identity
swir2046/icons/                Original project logos and icons
swir2046/screenshots/          Actual application screenshots
swir2046/preview-studio.jpg    Website preview
swir-os.html                  Preserved SWIR OS presentation
```

The site is compatible with GitHub Pages and uses `.nojekyll` for static serving. The previous OS presentation and its dependencies remain available at `swir-os.html`.

## Original project assets

The project icons below are copied from their public source repositories. Their identities are preserved; the portfolio mark and labeled CSS illustrations belong to this website.

| Local asset in `swir2046/icons/` | Original source |
| --- | --- |
| `swir-os-logo.svg` | [SWIR_OS/assets/branding/swir-os-logo.svg](https://github.com/Swir/SWIR_OS/blob/main/assets/branding/swir-os-logo.svg) |
| `swir-os-icon.svg` | [SWIR_OS/swir-icon.svg](https://github.com/Swir/SWIR_OS/blob/main/swir-icon.svg), retained from the existing site |
| `kononexus-icon.png` | [KonoNexus/assets/kononexus-tester.png](https://github.com/Swir/KonoNexus/blob/main/assets/kononexus-tester.png) |
| `konofix-icon.ico` | [Konofix/src-tauri/icons/icon.ico](https://github.com/Swir/Konofix/blob/main/src-tauri/icons/icon.ico) |
| `swirui-icon.svg` | [Swirui/assets/swirui-icon.svg](https://github.com/Swir/Swirui/blob/main/assets/swirui-icon.svg) |
| `ocryon-icon.svg` | [OCRYON/src/ocryon/assets/ocryon.svg](https://github.com/Swir/OCRYON/blob/main/src/ocryon/assets/ocryon.svg) |
| `brokedj-icon.svg` | [BrokeDJ/assets/icon.svg](https://github.com/Swir/BrokeDJ/blob/main/assets/icon.svg) |
| `dragon-diskforge-sigil.svg` | [Dragon-DiskForge/docs/branding/dragon-sigil.svg](https://github.com/Swir/Dragon-DiskForge/blob/main/docs/branding/dragon-sigil.svg) |

Screenshots come from `docs/screenshots/application.jpg` in [Konofix](https://github.com/Swir/Konofix/blob/main/docs/screenshots/application.jpg), [Swirui](https://github.com/Swir/Swirui/blob/main/docs/screenshots/application.jpg), [KonoNexus](https://github.com/Swir/KonoNexus/blob/main/docs/screenshots/application.jpg), [SWIR_OS](https://github.com/Swir/SWIR_OS/blob/main/docs/screenshots/application.jpg), [BrokeDJ](https://github.com/Swir/BrokeDJ/blob/main/docs/screenshots/application.jpg) and [Dragon-DiskForge](https://github.com/Swir/Dragon-DiskForge/blob/main/docs/screenshots/application.jpg). OCRYON uses [docs/screenshots/application.png](https://github.com/Swir/OCRYON/blob/main/docs/screenshots/application.png). They show the actual interfaces and states described by their source READMEs.

## SWIR OS is a separate product

**[Swir/SWIR_OS](https://github.com/Swir/SWIR_OS)** is the canonical repository for operating-system implementation, architecture, builds, qualification and roadmap. This portfolio promotes the project; its screenshots and links do not establish a new OS release or hardware qualification.

The retained [OS preview documentation](SWIR-OS-PREVIEW.md), [OS presentation](swir-os.html) and [canonical architecture](https://github.com/Swir/SWIR_OS/blob/main/SWIR-OS-ARCHITECTURE.md) provide the relevant context. Historical web/retro experiments and the independent desktop application remain separate from this portfolio homepage.

## 🔎 Search Keywords

`SWIR projects` · `KonoNexus mesh network` · `SWIR OS` · `Konofix P2P chat` · `SwirUI Python interface` · `SwirEngine Python game engine` · `OCRYON OCR` · `BrokeDJ` · `Dragon DiskForge` · `independent software`

<div align="center">

**Independent mindset. Built by Swir.**

[GitHub profile](https://github.com/Swir) · [All repositories](https://github.com/Swir?tab=repositories)

</div>
