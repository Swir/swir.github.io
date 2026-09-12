# SWIR OS Internationalization Contract 1.0

## Goal

SWIR OS treats language and locale as a platform capability, not as per-app decoration. Web Edition, Desktop Edition and future Linux-based System Edition must share the same locale semantics so applications do not need separate localization logic for each runtime.

The long-term target is global language coverage. A locale may be selected even when a complete UI translation pack is not installed: regional formatting and text direction still follow the selected BCP-47 locale while untranslated messages safely fall back to English. Translation coverage can therefore grow independently from the runtime.

## Runtime contract

The browser/Desktop shell exposes `window.SwirI18n` with contract `swir.i18n/1.0`.

Required capabilities:

- BCP-47 canonicalization using the platform `Intl` implementation.
- Exact locale -> base language -> English fallback chain.
- Persistent user locale selection.
- Automatic `html[lang]` and `html[dir]` propagation.
- LTR and RTL support.
- Locale-aware date/time, number, currency, relative-time and list formatting.
- Runtime registration of translation packs.
- Locale-change events for shell applications and services.
- Declarative DOM translation hooks through `data-i18n*` attributes.

The first built-in message packs are English (`en`), Polish (`pl`) and Norwegian Bokmål (`nb`). This is bootstrap coverage, not the final supported-language list.

## All-language model

SWIR OS must not hard-code a closed list of system locales. Any structurally valid BCP-47 locale accepted by the runtime can be selected. This allows regional variants, scripts and future locale additions without a system update.

Translation packs are layered:

1. exact locale, for example `pt-BR`;
2. language fallback, for example `pt`;
3. platform fallback `en`.

A locale without an installed translation pack remains fully valid for formatting, collation-ready APIs and directionality. Missing UI strings fall back instead of breaking the shell.

## Future language packages

Translation packs should become signed SWIR packages distributed through the common Store/Package layer. A language package should contain only declarative messages, locale metadata, optional fonts/input-method metadata and integrity information. It must not require arbitrary native code.

Proposed package identity:

`system.locale.<bcp47>`

Future package metadata should include:

- locale and aliases;
- native language name and localized display name;
- direction (`ltr`/`rtl`);
- translation coverage and contract version;
- optional font dependencies;
- optional keyboard/IME descriptors;
- checksum/signature provenance;
- minimum compatible SWIR i18n contract.

## Desktop Edition

Desktop releases must stage `swir-i18n.js` as a required runtime asset. The locale engine is therefore present in the signed deterministic Desktop package and cannot silently disappear from a release.

Desktop-native adapters should eventually expose OS-level locale, keyboard and input-method information without changing the application-facing `swir.i18n` semantics.

## System Edition

The Linux-based System Edition should map the same contract to native services such as:

- Unicode/ICU or equivalent locale data;
- system locale configuration;
- keyboard layouts and IME frameworks;
- timezone services;
- font fallback and script coverage;
- accessibility and bidirectional text settings.

Native Linux applications keep their own locale integration, while SWIR applications consume the common SWIR locale contract. Windows applications running through Wine/Proton should receive locale configuration through their compatibility prefix rather than pretending Windows locale APIs are native Linux APIs.

## Safety and quality rules

- Never download executable language components from unverified websites.
- Translation packs distributed by SWIR Store must use the same trust/integrity principles as other packages.
- Locale selection must never require elevated privileges for a normal user profile.
- Invalid locale tags must fail closed with a clear error.
- Missing translations must fall back; they must not produce blank controls.
- RTL must be treated as a first-class layout mode, not a CSS afterthought.
- User-generated content is never automatically translated or rewritten by the system locale engine.

## Next contract milestones

1. Settings language/region UI backed by `SwirI18n.setLocale()`.
2. Extraction of shell strings into translation packs.
3. App SDK locale namespace and isolated-app bridge support.
4. Signed locale packages in SWIR Store.
5. Keyboard/IME and font-pack metadata.
6. Native Desktop/System adapters for locale, timezone, keyboards and input methods.
7. Automated translation-coverage, placeholder-consistency and RTL visual tests.
