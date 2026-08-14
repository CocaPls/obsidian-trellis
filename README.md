# Trellis

**English** | [한국어](README.ko.md)

Trellis keeps a hierarchical **location tag** as the source of truth for a note,
and mirrors it into the note's **filename prefix** — automatically, and without
breaking any links.

Move a note in the tag tree and its filename prefix follows. No manual
batch-renaming, no broken wikilinks.

```
note tagged  #trel/S88/B07     →  filename  S88B07-meeting-notes.md
retag it     #trel/S88/B99     →  filename  S88B99-meeting-notes.md   (automatic)
```

![Sidebar tree view](screenshots/tree-view.png)

## How it works

Trellis reads a filename as three parts. For `S88B07-meeting-notes.md`:

- `S88B07` is the **tagkey** — the prefix built from the note's location tag
  (`#trel/S88/B07` becomes `S88B07`). This is the only part Trellis controls.
- `-` is the **separator** between the tagkey and the title (default `-`).
- `meeting-notes` is your **title**. Trellis never touches it.

The tag is the source of truth. Change the tag and the tagkey is rewritten to
match; edit the tagkey by hand and it's restored from the tag on the next sync.

## What it does

- **Filename sync.** When a note's location tag changes, its filename prefix is
  rewritten to match, through Obsidian's link-safe rename (so wikilinks update on
  their own). Location tags live in frontmatter. A note has one location tag; if
  it picks up a second, Trellis flags it.
- **Cascade rename.** Rename a tag and its whole subtree follows — you can even
  insert a new parent level. Filenames and wikilinks come along.
- **Sidebar tree.** See your notes in a collapsible, folder-like tree built from
  their location tags rather than from folders. It has two modes: *notes* (the
  default — your notes under their tags) and *tags* (the tag hierarchy itself, so
  you can browse the namespace and open notes from it).
- **Bootstrap.** Onboard a vault that already has filename prefixes but no tags
  yet. Choose the scope with a checkbox tree (the whole vault, some folders, or
  individual notes — drag to sweep-select, search, or show only untagged notes),
  preview it as a dry run, watch live progress with pause / resume / cancel, and
  undo in one step. A bad note is skipped and listed rather than stopping the run.
  Bootstrap splits a prefix at letter/digit boundaries (`S88B07` → `S/88/B/07`,
  `PROJ123` → `PROJ/123`), so it isn't tied to one naming scheme.
- **Duplicate cleanup.** If a note ends up with more than one location tag in the
  same namespace, Trellis finds it and lets you pick which one to keep. Batched
  for large vaults, with undo.
- **Safe filename-format changes.** Choose the slot-boundary symbol, its spacing
  (none / before / after / both), and how hierarchy levels appear inside each
  tagkey (hidden / `.` / `-` / `_`). Trellis previews every affected filename,
  applies through Obsidian's link-safe rename, and rolls the batch back on a
  cancel or failure. One-step undo is retained after success.
- **Korean / English UI**, following Obsidian's language.

Everything above stays on the single-key path by default. Two features are
opt-in — see [Advanced](#advanced) below.

## Install

**From Obsidian:** Settings → Community plugins → Browse, search for *Trellis*,
install, and enable.

**Manually:** download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](../../releases), drop them in
`your-vault/.obsidian/plugins/trellis/`, and enable the plugin in Settings →
Community plugins.

## Usage

- **Tag a note** — add a location tag in frontmatter (`tags: [trel/S88/B07]`) and
  the filename prefix syncs to `S88B07`.
- **Move a level** — run *Move location and descendants* from the command palette
  or a note's right-click menu.
- **Open the tree** — use the ribbon icon; switch between the notes and tags
  modes from the header or settings.
- **New note in place** — from the tree, create a note under a branch. Trellis
  can suggest the next segment for you (see presets under Advanced).
- **Onboard an existing vault** — run *Import existing filenames*, pick a scope,
  preview, and apply.
- **Clean up duplicates** — run *Check duplicate location tags*.
- **Change filename formatting** — set the boundary symbol, spacing, or visible
  hierarchy separator; review the exact vault-wide preview before applying.

## Advanced

These tools live in the collapsed **Experimental filename features** section.
The single-key engine stays the default path.

**Multi-key slots.** By default a filename is one tagkey plus a title. If a note
needs more than one identifier — say a project code *and* a cross-cutting area
code — turn on *Multi-key slots* and define the filename as an ordered list of
slots: one or more tagkey slots (each synced from its own tag namespace), a title
slot, and a separator between them.

```
#trel/AA/01  +  #key2/BB/02      →   AA01-my-note--BB02
retag the second   #key2/BB/09    →   AA01-my-note--BB09   (automatic)
```

The slot editor stages your edits — add or remove slots, set each namespace,
boundary symbol and spacing, and choose a visible hierarchy separator per tag
slot. Nothing changes until you press **Apply** and review the exact rename
preview. Empty, duplicate, illegal, or parse-ambiguous combinations are rejected
before they reach the vault; apply is rollback-safe and undoable. While multi-key
is on, the tree, bootstrap, and cascade still operate on the first tagkey slot.

**Root namespace.** If you want the whole tag tree filed under a top-level root —
everything under `zettel/`, say — turn on a root namespace. Tags become
`#zettel/trel/S88/B07`; the filename prefix stays `S88B07`, since the root
doesn't affect filenames. Turning it on (or changing it) migrates existing tags
across the vault behind a confirmation, with a one-step undo.

**Segment presets.** When you create a note from the tree, Trellis can propose
the next segment: the next number in a sequence, a date, a Zettelkasten
timestamp, or an alternating letter/number scheme. Set a preset per slot — you
can always type your own segment instead.

## Screenshots

**Bootstrap — pick what to onboard.** Already-tagged notes show as done; untagged
notes are selectable (whole vault, folders, or individual notes).

![Bootstrap target picker](screenshots/bootstrap.png)

**Cascade rename — move a whole subtree.** Rename one tag and every note under it
follows, filenames and wikilinks included.

![Cascade rename](screenshots/cascade-rename.png)

**Duplicate cleanup — one location per note.** When a note has more than one
location tag, pick the one to keep; the rest are removed (undoable).

![Duplicate location-tag cleanup](screenshots/dedup.png)

## Settings

![Settings tab](screenshots/settings.png)

- **Location tag** — which tag family is the source of truth (e.g. `trel`).
  Staged and committed with an Apply button.
- **Code–title symbol / spacing** — the boundary between the generated filename
  code and the user's title, with optional spaces on either side.
- **Hierarchy shown in the filename code** — hidden (classic `S88B07`) or joined with
  `.`, `-`, or `_` (for example `S.88.B.07`).
- **Filename code position** — prefix (start) or suffix (end) of the filename.
- **Tree view** — on / off, and which mode (notes or tags) it opens in.
- **Sidebar view name** — a custom title for the tree tab (blank uses the
  default).
- **Tree sort** — by tagkey, modified time, or created time.
- **Tree actions** — New, view mode, current-note navigation, and collapse /
  expand all stay in the header; sorting, import, subtree movement, and
  available undo records share a native **More** menu. Each action can still be
  hidden.
- **Multi-key slots** — off by default; the opt-in slot editor (see Advanced).
- **Root namespace** — off by default; the opt-in top-level root (see Advanced).
- **Language** — auto / Korean / English.
- **Managed notes** — a read-only count of how many notes carry a managed
  location tag and which namespaces are active, so you can check your setup at a
  glance.

## Compatibility

Requires Obsidian **1.8.7** or newer. Desktop and mobile.

## Privacy and safety

Trellis works locally through Obsidian's public vault APIs. It makes no network
requests, collects no telemetry, shows no ads, and requires no account. It does
not access files outside the current vault.

Filename and tag changes can affect many notes, so bulk operations show an exact
preview before writing and keep rollback or undo information. Keep a normal
vault backup as you would for any tool that performs bulk edits.

## Under the hood

A filename is a positional list of slots joined by separators — by default a
two-slot `[tagkey, title]` layout, so multi-key schemes grow without rewriting
the core. The conversion logic lives in `tagkey.ts` (pure and unit-tested);
`main.ts` is the Obsidian glue. The live sync mirrors whatever the tag path is.
Bootstrap reverses a visible hierarchy separator exactly; in classic hidden mode
it splits a flat prefix at letter/digit boundaries, which cannot recover a
boundary inside a run of the same character class.

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for how to build, test, and submit changes.

## License

[MIT](LICENSE)

## Why I made this

My vault leans on short ID prefixes in filenames — each note carries a code for
where it sits in my system. Keeping those prefixes right by hand was tedious and
easy to get wrong, so Trellis drives them from a location tag instead: tag a note
and its filename prefix follows, link-safe. Stable, predictable prefixes make the
vault easy to scan, and let me point a CLI tool at exactly the right files by
their IDs. The tag is the one source of truth; filenames and wikilinks follow on
their own.

## Part of

Trellis is the identification piece of [everything-in-obsidian](https://github.com/CocaPls/everything-in-obsidian) — a personal hub of pluggable systems for running an Obsidian vault with a CLI AI. Trellis works fully on its own; the hub is just optional context on where it fits.
