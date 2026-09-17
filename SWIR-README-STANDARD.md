<!-- SWIR-README-STANDARD:v1 -->
# SWIR README PRO Standard v1

This document defines the presentation and SEO standard for README files across active SWIR software, game, OS, tooling and library repositories.

The goal is not to make every README identical. The goal is to make every project immediately understandable, visually professional, technically honest and easy to discover.

---

## Core rules

Every actively maintained SWIR repository should use the following principles where relevant:

1. **Project-specific hero section**
   - centered icon/logo when available
   - clear project name
   - one-line value proposition
   - short platform / category line
   - useful badges only
   - avoid badge spam

2. **Clear project state near the top**
   - Stable / Beta / Alpha / Pre-Alpha / Foundation / Experimental
   - current release or development version when meaningful
   - roadmap/progress badge only when backed by real tracked data
   - never imply a build, release, platform or capability that was not verified

3. **Fast navigation / CTA**
   - Releases / Download when a real release exists
   - Documentation
   - Roadmap
   - Changelog
   - Issues / Discussions where relevant

4. **First-screen clarity**
   Within the first screenful, a visitor should understand:
   - what the project is
   - why it exists
   - current status
   - primary platform / runtime
   - how to install, run, download or test it

5. **Feature presentation**
   Prefer concise tables, grouped capability sections or cards over long unstructured bullet walls.

6. **Professional installation section**
   - preferred install / download path first
   - developer/source setup second
   - minimum requirements
   - exact commands when known
   - do not tell users to hunt manually for dependencies if the project provides bootstrap/install automation

7. **Screenshots / demo / preview**
   Include a visual section when assets exist. Do not add broken placeholders.

8. **Architecture / technology**
   Add only useful information:
   - major languages/frameworks/engines
   - important architecture choices
   - platform scope
   - compatibility boundaries

9. **Quality and verification**
   For technical projects, summarize the real verification surface:
   - CI
   - tests
   - supported OS/runtime matrix
   - packaging/build state
   - important known limitations

10. **Roadmap and release status**
    Link to canonical roadmap instead of duplicating large evolving checklists in README unless the README is itself the canonical roadmap.

11. **Search Keywords / SEO**
    Every actively maintained public repository should contain a discoverability section near the bottom.

    Preferred heading:

    ```md
    ## 🔎 Search Keywords
    ```

    Use a compact backtick/inline list of relevant phrases separated by bullets (`•`). Keywords must be genuinely related to the project and should include useful combinations such as:
    - project category
    - language/framework
    - platform
    - major user intent
    - notable capability

    Example:

    ```md
    `python game engine` • `2d game engine python` • `3d game engine python` • `windows python engine`
    ```

    Avoid keyword stuffing, unrelated trending terms and deceptive SEO.

12. **Footer / branding**
    Use a clean centered footer when appropriate:
    - short project tagline
    - star call-to-action only for public user-facing repositories
    - author/profile link
    - optional browse-all-projects link

---

## Recommended README structure

Adapt this order to the repository type.

```text
Hero / logo / title
One-line value proposition
Badges
Primary CTA links

What is it?
Why this project? / Project goals
Current status
Highlights / Features
Preview / Screenshots (when available)
Quick start / Download / Install
Usage / Example
Requirements / Compatibility
Architecture / Tech stack
Project structure (only when useful)
Verification / CI / Tests
Roadmap / Releases
Known limitations / Safety notes (when relevant)
Documentation links
Search Keywords
License
Professional footer
```

---

## Hero example

```html
<div align="center">

<img src="assets/app_icon.png" width="128" alt="Project icon">

# ⚡ Project Name

### One clear sentence explaining what the project does

**Windows 11 • Python • Open Source**

[![CI](...)](...)
![Version](...)
![Platform](...)
![License](...)

[**Download latest release**](...) · [**Documentation**](...) · [**Roadmap**](...)

</div>
```

Only include links that actually exist.

---

## Writing style

- Repository-facing content should be **English** unless the project has a strong reason to document another language.
- Use short paragraphs.
- Prefer concrete capability descriptions over hype.
- Avoid excessive emoji; use them as section markers, not decoration everywhere.
- Avoid repeated claims.
- Avoid giant top-of-file technical dumps.
- Keep important safety/compatibility limitations prominent but concise.
- Use tables when they improve scanning.
- Use code blocks for commands and examples.
- Keep terminology and capitalization consistent.

---

## Visual style

Default SWIR visual language:

- dark / electric / modern tone
- restrained blue/cyan accents in shields when custom colors are used
- project icon near the hero whenever available
- consistent badge styles within one README
- strong whitespace and section separators
- no giant ASCII art unless the project specifically benefits from it

Project identity comes first: game READMEs may be more atmospheric, developer libraries more technical, and OS projects more product-like.

---

## Honesty rule

A professional README is not marketing fiction.

Do not claim:
- a supported platform that is not verified
- a downloadable build that does not exist
- completed roadmap items without evidence
- performance gains without measurement
- hardware compatibility without testing
- releases that were not actually published

Use explicit development-state wording when something is planned, source-ready, experimental or awaiting hardware/runtime verification.

---

## Maintenance rule

Whenever an active project's capabilities, release state, installation flow or roadmap materially changes, review README consistency in the same milestone.

When touching an older README, preserve accurate historical/project-specific information while upgrading presentation and discoverability.

---

<div align="center">

### Professional presentation. Honest capabilities. Better discoverability.

**SWIR README PRO Standard v1**

[SWIR GitHub](https://github.com/Swir)

</div>
