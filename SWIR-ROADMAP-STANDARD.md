# SWIR Roadmap Standard v1

This document defines the default roadmap format for current and future SWIR projects.

## Required dashboard

Every active project should have a roadmap containing one protected progress block:

```md
<!-- SWIR-ROADMAP-STANDARD:v1 -->
<!-- ROADMAP-PROGRESS:START -->
<p align="center">
  <a href="CI_WORKFLOW_URL"><img alt="CI" src="CI_BADGE_URL"></a>
  <img alt="Roadmap progress" src="https://img.shields.io/badge/ROADMAP-PERCENT%25-2ea043?style=for-the-badge">
  <img alt="Completed" src="https://img.shields.io/badge/DONE-DONE%2FTOTAL-1f6feb?style=for-the-badge">
  <img alt="Status" src="https://img.shields.io/badge/STATUS-IN%20PROGRESS-7c3aed?style=for-the-badge">
</p>

## 📊 Overall progress

```text
████████████░░░░░░░░ 60.0%
```

| ✅ Completed | ⏳ Remaining | 📦 Total | 🎯 Progress |
|---:|---:|---:|---:|
| **DONE** | **LEFT** | **TOTAL** | **PERCENT%** |

> **Progress rule:** calculate progress from explicit roadmap deliverables only: `[x] / ([x] + [ ])`. Update the checklist first, then badges, numbers, percentage and the 20-segment bar. Never estimate progress from version numbers, commit count, elapsed time or activity.
<!-- ROADMAP-PROGRESS:END -->
```

## Calculation rules

- `[x]` means implemented and verified, not merely started.
- `[ ]` means incomplete, blocked, planned or not yet verified.
- `progress = completed / total * 100`.
- The text bar always has exactly 20 segments. Filled segments are `█`; remaining segments are `░`.
- Round displayed percentage to one decimal place unless the project has a stronger domain-specific reason.
- At 100%, change the status badge to `COMPLETE`; before 100%, keep an appropriate in-progress status.
- If major scope is added, add it as unchecked deliverables first so the denominator remains honest.

## Style lock for automated development

Hourly or recurring project agents must preserve the dashboard structure and the markers exactly. They may update:

- checklist state and scope,
- completed / remaining / total values,
- percentage,
- 20-segment bar,
- ROADMAP / DONE / STATUS badge values,
- CI badge target only if the authoritative workflow changes.

They must not replace the dashboard with another format, remove the CI-style badges, remove the table, move the progress block away from the top of the roadmap, or claim progress from subjective estimates.

## New-project rule

For every new SWIR project, create a Roadmap at project start using this standard before long-running autonomous development begins. If the project has CI, show the real workflow badge. If CI does not exist yet, omit only the CI badge until a real workflow is added; keep the rest of the dashboard unchanged.
