# Changelog

All notable changes to TRELLIS. Versions in the `0.0.x` range are pre-release
development milestones; `0.1.0` will be the first public release.

> Note: `0.0.3` and `0.0.4` were developed in one working tree and landed in the
> `0.0.4` commit, but are tracked as separate logical versions here. Git tags
> exist for `0.0.1`, `0.0.2`, and `0.0.4`.

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
