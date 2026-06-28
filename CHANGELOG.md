# Changelog

All notable changes to TRELLIS. Versions in the `0.0.x` range are pre-release
development milestones; `0.1.0` will be the first public release.

> Note: `0.0.3` and `0.0.4` were developed in one working tree and landed in the
> `0.0.4` commit, but are tracked as separate logical versions here. Git tags
> exist for `0.0.1`, `0.0.2`, `0.0.4`, `0.0.5`, and `0.0.6`.

## 0.0.7 — Separator batch-change + bulk-op robustness

- **Change the filename separator across the whole vault.** Editing the
  separator in settings now opens a confirm dialog and rewrites *only the
  trekey-boundary separator* on every location-tagged file — symbols inside the
  title are preserved — via the link-safe rename API. One-directional, like the
  tag engine. Includes a dry-run count + collapsible file list and a one-step
  undo command.
- **Separator validation relaxed** — any non-empty value with no letters,
  digits, or `/` (was "exactly one character"); multi-character separators are
  allowed.
- **Bulk operations are now robust and observable:**
  - **Per-file error isolation** — one broken file (e.g. duplicate YAML keys)
    no longer aborts a bootstrap or separator pass; failures are collected and
    listed in a "skipped files" modal.
  - **Live progress** — a progress notice (`N/total`) during bootstrap and
    separator change.
  - **Undo preserved on interruption** — the undo record is saved even if the
    pass is cut short.
- Internal: shared `assembleBasename` helper (slot order + separator) and
  `separatorMigratedName` (decompose with the old separator, re-emit with the
  new one).

## 0.0.6 — Multi-key data model (schema-based)

- **The filename key config is now a positional slot array** — `TrellisSchema
  { slots: KeySlot[]; separators: string[] }` — instead of three scalar fields.
  The single-key default is a 2-slot `[tag, name]` schema; runtime behaviour is
  unchanged.
- **`keyPosition` (prefix/suffix) is absorbed into slot order** — prefix =
  `[tag, name]`, suffix = `[name, tag]`. No separate field.
- **Existing settings migrate automatically** (`schemaFromLegacy`): saved
  `namespace` / `separator` / `keyPosition` data is converted to a schema on
  load, losslessly.
- Lays the general-form foundation for multi-key (multiple tag slots, multiple
  separators). The multi-key UI and multi-separator parsing are deferred to an
  advanced mode, so the core never needs rewriting again.
- Fix: settings no longer share the module-level default-schema object (an edit
  to the namespace/position could previously mutate the shared default).

## 0.0.5 — Internationalization (i18n)

- **Korean / English UI** via a small i18n layer (`i18n.ts`). Auto-detects
  Obsidian's UI language; a language setting can force `ko`/`en`.
- All commands, notices, modals, settings, and tree-view labels are translated.

## 0.0.4 — Bootstrap onboarding

- **Bootstrap an existing vault** (filename trekey prefixes, no tags yet):
  decompose a filename trekey into a hierarchical location tag
  (`S88B07` → `#trel/S88/B/07`). Placeholder slots (`0`/`00`) are kept as tag
  segments so the tag ↔ trekey round-trip stays exact.
- **Dry-run preview** command — lists every file's proposed tag (and files
  skipped because they're already tagged or have no recognizable trekey).
  Writes nothing.
- **Apply** writes the tag into each file's frontmatter (existing content
  preserved) and records what it wrote.
- **Undo last bootstrap** command reverts exactly those writes.

## 0.0.3 — Tree-view polish & header new-note

- Tree-view indent guides now match the core file explorer pixel-for-pixel
  (top-level items are no longer wrapped in an extra `.tree-item-children`,
  which had added a spurious top-level guide line and indent step).
- Header **New note** button: prefills the parent from the active note
  (an index note → child, a leaf note → sibling), with the parent editable via
  tag autocomplete.
- The new-note **segment is entered by hand** (no auto-guess) — TRELLIS stays
  format-agnostic about the trekey scheme rather than forcing a guessed value.

## 0.0.2 — Sidebar tree view

- Collapsible sidebar tree of the location-tag hierarchy (notes only;
  segment-only levels are transparent).
- Header actions (sort direction, collapse/expand all, reveal active file),
  sort options, and debounced refresh with a tree cache.

## 0.0.1 — MVP

- Rename engine: a location tag drives the filename trekey prefix (link-safe via
  Obsidian's rename API), with an infinite-loop guard.
- Cascade rename of a parent tag (and everything under it) across the vault.
- Settings: namespace, separator, key position.
- Filename-edit restore (the tag is the source of truth) and title-key
  preservation on re-assembly.
