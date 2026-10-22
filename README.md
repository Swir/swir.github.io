<!-- SWIR-README-STANDARD:v2 -->
<div align="center">

<img src="swir2046/mark.svg" width="88" height="88" alt="SWIR logo">

# SWIR / ORBIT

**Your code. New dimension.**

A cinematic sci-fi command bridge for exploring projects by Swir.

Polish / English · Responsive static website · Real project screenshots

[**Enter the bridge →**](https://swir.github.io/) · [**Browse projects**](https://github.com/Swir?tab=repositories) · [**SWIR OS presentation**](https://swir.github.io/swir-os.html)

</div>

![SWIR ORBIT command bridge preview](swir2046/preview-studio.jpg)

## A command bridge for independent software

SWIR / ORBIT presents the portfolio through a cinematic command interface: deep navy panels, a cyan holographic core, angular controls, original application icons and a persistent project rail. It is a portfolio interface. The separate SWIR OS product and its existing presentation retain their own links and identity.

The interactive map connects six featured modules: **KonoNexus, SWIR OS, Konofix, Dragon DiskForge, BrokeDJ and OCRYON**. KonoNexus is selected initially. Choosing a module updates the holographic focus, its description and stage on the left, and its actual application screenshot and source link on the right. The screenshot opens at a larger size; the project action opens a detailed window.

The original labeled illustrations for **BrokeDJ, OCRYON and SwirEngine** are retained in a separate creative section. The searchable library contains all **22 curated projects**, with their existing descriptions, stages, links and artwork.

### Explore and navigate

| Feature | Behavior |
| --- | --- |
| Holographic map | Select one of six project nodes to update the core's focus, selected-project details and real screenshot. The controls work with pointer, touch and keyboard. |
| Command readouts | Show catalog-derived counts: 22 projects, five primary categories and ten projects with a stable release record. |
| Project windows | Open multiple projects. On desktop, drag their title bars, minimize, maximize and close; double-click a title bar to maximize or restore its size. |
| Project rail | Open pinned projects or restore their windows. The open-windows control lists open or minimized projects, including those without a pinned control. |
| Navigation | Switch between Bridge, Projects, Releases and Terminal. |
| Library | Search names, descriptions and technologies; filter by primary or additional category. |
| Project details | Read the description and stage, inspect the actual screenshot, and follow repository or available release links. |
| Image viewer | Enlarge an actual screenshot from the bridge or a project window, then return to its trigger. |
| Quick search | Use `/` or `Ctrl/Cmd + K`; navigate results with arrow keys and open with Enter. |
| Terminal | Use `help`, `ls`, `open <project name>`, `about` and `clear` to explore this portfolio. |
| PL / EN | Translate the interface, project descriptions and all open windows. The browser remembers the choice. |
| Motion | Pause visual effects; reduced-motion preferences and hidden-tab suspension are respected. |
| Mobile | The map and information panels reflow for touch. Project details use fixed panels, and the project rail remains available. |

The holographic core draws its wireframe geometry, orbital rings and particles directly with Canvas2D, without an external image or graphics library. Animation is capped at **24 FPS**. Canvas resolution uses a **device-pixel-ratio cap of 1.5**, or **1.25 for a small canvas**, with an approximately **1.1-million-pixel budget**. Selecting a module still updates the focus while motion is paused. Reduced-motion preferences and hidden tabs suspend animation; the CSS reticle and project controls remain available without Canvas2D. The clock shows the visitor's local time.

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

Use HTTP instead of opening the HTML directly so JavaScript modules load normally. Screenshots and project icons are local assets. Google Fonts supplies **Rajdhani** for display text, **Manrope** for body text and **IBM Plex Mono** for interface readouts; **Space Grotesk** is retained as a display fallback, followed by system fonts. The GitHub metadata request is optional to the browsing experience.

### Main files

Paths below are relative to the published site root, or to `dist/` in the source checkout.

```text
index.html                    Command bridge shell, navigation and dialogs
swir2046/style.css             Shared controls, windows and base responsive styles
swir2046/command-deck.css      Cinematic layout, holographic map and project rail
swir2046/app.js                Selection, windows, search, terminal and languages
swir2046/bridge-ui.js          Six-module map, details, previews and bridge content
swir2046/holo-core.js          Procedural Canvas2D core and selection focus
swir2046/project-store.js      Catalog helpers, assets and optional metadata refresh
swir2046/project-art.js        Original labeled project illustrations
swir2046/project-art.css       Original illustration styles
swir2046/projects.js           Reviewed project and release snapshot
swir2046/mark.svg              Portfolio identity
swir2046/icons/                Original project logos and icons
swir2046/screenshots/          Actual application screenshots
swir2046/preview-studio.jpg     Website preview
swir-os.html                  Preserved SWIR OS presentation
```

`index.html` loads the base styles and `command-deck.css`; `app.js` imports the bridge renderer and holographic core. The earlier `swir2046/orbit-sky.js` module is retained but unused by the current homepage.

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
