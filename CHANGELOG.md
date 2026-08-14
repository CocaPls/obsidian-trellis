# Changelog

All notable changes to TRELLIS. Versions in the `0.0.x` range are pre-release
development milestones; `0.1.0` is the first public release.

> Note: `0.0.3` and `0.0.4` were developed in one working tree and landed in the
> `0.0.4` commit, but are tracked as separate logical versions here. Git tags
> exist for `0.0.1`, `0.0.2`, `0.0.4` through `0.0.8`, and `0.1.0`
> through `0.1.4`.

## 0.4.2 — Cross-platform filename safety

- Reject generated filenames that would fail on another supported platform,
  including Windows device names and terminal dots or spaces, while preserving
  the original note.
- Run the normal CI checks on both Ubuntu and Windows, and clarify that every
  descendant tag under the configured namespace is managed immediately.

## 0.4.1 — Tree view hot-update repair

- Recreate an already-open Trellis sidebar view when Obsidian hot-updates the
  plugin and leaves that tab as an unknown view, avoiding an app restart or
  manual tab repair after upgrading.
- Reorganize source, tests, and release scripts into focused directories and
  document the guarded in-process automation surface in English and Korean.

## 0.4.0 — Safe automation and filename formatting

- **Flexible filename formatting.** Configure the code–title boundary symbol,
  spacing on either side, and a visible hierarchy separator (`.`, `-`, `_`, or
  hidden) for each managed tag slot. Every vault-wide formatting change is
  previewed, collision-checked, rollback-safe, and undoable.
- **Guarded automation API.** AI tools and scripts can inspect a note, prepare a
  read-only plan, and apply only that exact plan. Writes are rejected when the
  note or schema changed after planning, when inline tags conflict, or when
  another managed write is in progress.
- **Transactional migrations.** Namespace, root, slot-schema, and bulk tag
  changes now share stricter validation, serialized writes, rollback reporting,
  and retryable undo records instead of leaving partial state behind.
- **Simpler settings and tree controls.** Everyday single-key controls stay
  prominent while experimental schema tools are collapsed. Tree sorting,
  import, subtree movement, and undo records share one More menu; the five
  frequent navigation and creation actions remain directly in the tree header.
- **Accessibility and review hardening.** Keyboard paths, labels, notices, and
  rollback results were clarified. Official Obsidian ESLint rules, release
  metadata checks, and expanded unit coverage now guard the public build.
- **Documentation refresh.** English and Korean guides now use the simplified
  terminology and explain previews, safety boundaries, and advanced features.

## 0.3.3 — Public-repository and review hardening

- Rewrote the English and Korean guides around the stable 0.3 feature set and
  standardized the public name as Trellis.
- Built new-note frontmatter through Obsidian's API instead of raw YAML and
  resolved review findings in tree and CSS code.
- Added contributor guidance and a tag-triggered draft-release workflow with
  build provenance.

## 0.3.2 — Nested tags, root namespace, and ID presets

- Promoted the 0.3 line to stable with opt-in nested tag view, shared root
  namespace migrations, and per-slot segment presets.
- Added strict new-note tag/segment validation with Unicode support and retained
  root undo records when an undo is cancelled.
- Required Obsidian 1.8.7 or newer; default single-key behavior stayed unchanged.

## 0.3.1 — Experimental 0.3 line with review cleanup

- Combined the experimental 0.3 features with the 0.2.2 compatibility and lint
  cleanup. This prerelease was superseded by stable 0.3.2.

## 0.3.0 — Experimental nested-tree feature set

- Introduced opt-in nested tag view, shared root namespace migrations, and ID
  segment presets on the experimental branch.
- This snapshot predates the 0.2.2 review cleanup and is retained for history;
  use a later release.

## 0.2.2 — Compatibility and lint cleanup

- Removed remaining version-gated or deprecated UI paths, used CSS classes for
  destructive actions, and switched locale detection to Obsidian's official API.
- Raised the minimum supported Obsidian version to 1.8.7 without changing sync,
  tree, cascade, import, or separator behavior.

## 0.2.1 — Settings UX and polish

- Added staged advanced-setting apply, inline schema validation, and a read-only
  managed-note and active-namespace summary.
- Restored robust language fallback and removed deprecated styling helpers.

## 0.2.0 — Multi-key & bulk UX (experimental)

- **Multi-key slots (advanced mode, experimental)** — a settings toggle exposes
  the slot editor over the 0.0.6 schema foundation: add/remove/reorder tag-key
  and name-key slots, per-slot tag namespaces, and per-gap separators. Each tag
  slot syncs from its own namespace; the (single) name slot stays free. Tree
  view, bootstrap, cascade and separator migration still follow tag slot 1.
  The battle-tested 2-slot single-key engine remains the default path.
- **Bulk pass progress modal** — bootstrap apply and separator migration now
  show a small modal with a live count + progress bar, Pause/Resume and Cancel
  buttons, elapsed time and error count (plus a slow-run hint after 10s), and a
  Done state that lists the notes it had to skip so they can be reviewed. This
  replaces the old progress Notice (which poked the unofficial `Notice.noticeEl`).
- **Quieter bulk passes** — per-file rename notices are suppressed while a bulk
  pass (bootstrap / separator change / cascade) runs, so the top-right no longer
  floods; the modal shows aggregate status instead.
- **Explicit Apply in settings** — the namespace and separator settings are now
  staged in their field and committed by an Apply button (separator still opens
  its confirm dialog), instead of applying on every keystroke / on blur.
- **Settings tab grouped into sections** — General, Filename scheme, and Sidebar
  tree view headings for a cleaner top-to-bottom layout.
- **No-separator title protection** — assigning a tag to a file whose name has
  no separator no longer overwrites the name: if the basename doesn't look like
  a bare tagkey (character-class runs that round-trip), the tagkey is prepended
  and the name is preserved (`trellisupgradecheck` → `ZZ99-trellisupgradecheck`
  instead of `ZZ99`). Names that DO look like a stale tagkey (index notes,
  e.g. `S88`) are still replaced.

Hardening from a multi-angle code review, before any real-vault use:

- **Multi-key name extraction is boundary-aware** — a tag slot is consumed only
  when its value sits on a separator boundary, so a title that coincidentally
  ends/begins with a tag slot's text (`S88B07-ideaP09Z01`) is preserved whole
  instead of being truncated.
- **Multi-key tagkey-only filenames stay intact** — a bare index note whose name
  is exactly its tagkey (`BT01`, no separator, no title) no longer folds the
  tagkey into the name slot and duplicates it (`BT01-BT01`) under a multi-key
  schema. This mirrors the single-key no-separator protection, which the
  multi-key path was missing (found by dogfooding a bootstrap in a dummy vault).
- **Separator-change cancel rolls back cleanly** — cancelling a separator
  migration now reverts the renames already made and does NOT commit the new
  separator, so the vault and the setting can't end up half-applied. Undo keeps
  its record when a restore fails, so it can be retried, and respects each
  rename's success instead of assuming it worked.
- **Rename collision guard** — sync and separator migration refuse to rename a
  file onto a different existing file, matching the check new-note creation
  already had.
- **Undo error isolation** — bootstrap and dedup undo now isolate per-file
  frontmatter errors (like apply already did), so one malformed YAML file can't
  abort the whole undo.
- **Namespace validation** — tag namespaces are restricted to letters, digits,
  `-` and `_`, rejecting `/`, whitespace, control characters and YAML/tag
  metacharacters that could corrupt tag matching or inject into new-note
  frontmatter.
- **Multi-key boundary matching is longest-separator-first** — with separators
  like `-` and `--`, an empty name slot drops its own separator, so the filename
  carries the longer gap separator; shortest-first matching half-consumed it and
  folded the leftover into the name (`AA01--BB02` → `AA01--BB02--BB02`,
  permanently). Boundaries now try every schema separator longest-first, and the
  right-side consume no longer strips an extra separator, so a title's own
  trailing separator characters (`demo-`) survive a sync.
- **Collision notice fires once per clash** — a file that can't sync because its
  target name is taken warned again on every edit (the duplicate-tag pass kept
  clearing the warned flag); the collision warning now has its own flag, cleared
  when the clash resolves, and is suppressed during bulk passes like every other
  per-file notice.

## 0.1.4 — Frontmatter tag dedupe hotfix

- Deduplicate exact repeated frontmatter tags while preserving tag order.
- Let bootstrap normalize existing duplicate tag arrays even when the target
  location tag is already present.
- Record bootstrap undo entries only for tags actually added by that bootstrap
  run, so cleanup-only normalization is not treated as newly added tags.

## 0.1.3 — Separator migration hotfix

- Fix separator batch-change producing mixed boundaries such as `S88_-Title`,
  `S88-_Title`, or repeated variants like `S88_-_Title` when moving between
  separators. The migration now treats any contiguous run of old/new separators
  immediately next to the tagkey as boundary residue and normalizes it to the
  new separator, while preserving separators inside the title.
- Keep normal tag-to-filename sync suppressed while a separator migration owns
  the rename pass, so follow-up rename/metadata events cannot re-process files
  with the wrong live separator.
- Record only successfully renamed files in the separator undo record.
- Allow changing the separator even when the dry-run finds no affected files.

## 0.1.2 — Marketplace review cleanup

- Replace `workspace.revealLeaf()` (Obsidian 1.7.2) with the older public
  `setActiveLeaf(..., { focus: true })` path, keeping `minAppVersion` at
  `1.4.10` while clearing the unsupported-API review error.
- Tighten saved-settings and frontmatter handling types to avoid unsafe
  `any`-style access around `loadData()` and `processFrontMatter()`.
- Remove the `builtin-modules` dev dependency and use Node's built-in
  `node:module` `builtinModules` list in the build config.

Review notes intentionally deferred: `getLanguage()` would require Obsidian
1.8.7, and replacing imperative settings `display()` / `setWarning()` would
require 1.13.0 APIs, so those remain warnings for 0.1.x compatibility.

## 0.1.1 — Marketplace review fixes

- Raise `minAppVersion` to `1.4.10` to match the APIs actually used
  (`processFrontMatter`, added in 1.4.4; `AbstractInputSuggest`, in 1.4.10) —
  clears the community review's unsupported-API check.
- Use `activeDocument` instead of `document` for the bootstrap picker's
  drag-select listeners, for pop-out window compatibility.

## 0.1.0 — First public release

First public release, built on the 0.0.8 feature set (one-directional
tag → filename sync, cascade rename, sidebar tree view, scoped bootstrap,
duplicate location-tag cleanup, separator batch-change, and Korean / English
i18n) plus two tree-view customization options.

- **Sidebar view name** — set a custom title for the tree view's tab in
  settings (blank keeps the default).
- **Per-button header visibility** — show or hide each of the tree view
  header's action buttons individually in settings.
- README screenshots (tree view, settings, bootstrap, cascade rename, duplicate
  cleanup) and a Korean translation (`README.ko.md`).
- Pinned the `obsidian` dev dependency to a fixed version and added a CI
  workflow (build + tests on every push / PR).
- Guard against a duplicate tree-view registration — a stale registration from
  a not-fully-unloaded prior instance (e.g. plugin files replaced without an
  Obsidian restart) no longer aborts the whole plugin load.
- Bootstrap decomposition is now scheme-general — it splits a filename prefix
  at letter/digit boundaries (`S88B07` → `S/88/B/07`, `PROJ123` → `PROJ/123`)
  instead of assuming one fixed pattern, and skips prefixes it can't round-trip.
- Dropped the demo `test-vault/` from the repo (local scratch only).

## 0.0.8 — Scoped bootstrap, duplicate-tag cleanup, robustness

- **Scoped bootstrap target picker** — onboard a folder/module subtree instead
  of only the whole vault. Checkbox tree with drag-to-select, filename search, a
  "notes without a tag only" toggle, a selection count, and already-tagged
  badges. Sidebar header buttons (bootstrap / rename tag / undo) and a "new
  note" command round out the entry points.
- **Duplicate location-tag cleanup** — one note = one location per namespace.
  Sync warns when a note carries duplicate location tags, and a new "check
  duplicate location tags" command opens a modal to pick which tag to keep per
  note; the rest are removed from frontmatter (undoable, with an "undo last
  duplicate-tag cleanup" command). The modal shows the total count, scrolls
  within the viewport, and batches at 50 notes for large runs.
- **Location tags belong in frontmatter** — settings and README now state that
  cascade and bootstrap read and rewrite frontmatter tags, one per note.
- **Robustness / cleanup** — every assembled vault path goes through
  `normalizePath()`; cascade rename now isolates per-file frontmatter errors
  (try/catch + skipped-files modal), matching bootstrap and separator change.

## 0.0.7 — Separator batch-change + bulk-op robustness

- **Change the filename separator across the whole vault.** Editing the
  separator in settings now opens a confirm dialog and rewrites *only the
  tagkey-boundary separator* on every location-tagged file — symbols inside the
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

- **Bootstrap an existing vault** (filename tagkey prefixes, no tags yet):
  decompose a filename tagkey into a hierarchical location tag
  (`S88B07` → `#trel/S88/B/07`). Placeholder slots (`0`/`00`) are kept as tag
  segments so the tag ↔ tagkey round-trip stays exact.
- **Dry-run preview** command — lists every file's proposed tag (and files
  skipped because they're already tagged or have no recognizable tagkey).
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
  format-agnostic about the tagkey scheme rather than forcing a guessed value.

## 0.0.2 — Sidebar tree view

- Collapsible sidebar tree of the location-tag hierarchy (notes only;
  segment-only levels are transparent).
- Header actions (sort direction, collapse/expand all, reveal active file),
  sort options, and debounced refresh with a tree cache.

## 0.0.1 — MVP

- Rename engine: a location tag drives the filename tagkey prefix (link-safe via
  Obsidian's rename API), with an infinite-loop guard.
- Cascade rename of a parent tag (and everything under it) across the vault.
- Settings: namespace, separator, key position.
- Filename-edit restore (the tag is the source of truth) and title-key
  preservation on re-assembly.
