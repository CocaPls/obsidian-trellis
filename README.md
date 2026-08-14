# Trellis

**English** | [한국어](README.ko.md)

[![CI](https://github.com/CocaPls/obsidian-trellis/actions/workflows/ci.yml/badge.svg)](https://github.com/CocaPls/obsidian-trellis/actions/workflows/ci.yml)
· [Community plugin page](https://community.obsidian.md/plugins/trellis)

Trellis keeps a hierarchical **location tag** as the source of truth for a note
and mirrors it into the note's **filename code**. Move a note in the tag tree and
its filename follows through Obsidian's link-safe rename.

```text
tag  #trel/S88/B07  →  file  S88B07-meeting-notes.md
tag  #trel/S88/B99  →  file  S88B99-meeting-notes.md  (automatic)
```

![Sidebar tree view](screenshots/tree-view.png)

## Why Trellis

My vault uses short filename codes to show where each note belongs. Maintaining
those codes by hand was tedious and error-prone, so Trellis derives them from one
location tag. The result stays easy to scan for people and precise to address
from CLI and AI tools.

## How it works

For `S88B07-meeting-notes.md`:

- `S88B07` is the managed **filename code**, built from `#trel/S88/B07`.
- `-` is the configurable boundary between the code and title.
- `meeting-notes` is your free **title**; Trellis does not rewrite it.

The tag is authoritative. Change the tag and the code follows. Edit the managed
code by hand and Trellis restores it from the tag on the next sync.

## Highlights

- **Filename sync** through Obsidian's link-safe rename, with duplicate-location
  detection when a note carries more than one managed tag.
- **Sidebar tree** built from tags rather than folders, with note and tag modes,
  new-note creation, current-note reveal, and collapse controls.
- **Subtree moves** that preview and migrate a location and every descendant,
  including filenames and wikilinks, with rollback and undo.
- **Existing-vault import** that derives tags from filename codes for a selected
  vault, folder, or note scope, with dry run, progress controls, and undo.
- **Safe formatting changes** for the code–title symbol, surrounding spacing,
  code position, and visible hierarchy (`S88B07`, `S.88.B.07`, and more).
- **Korean and English UI**, following Obsidian's language by default.

## Install

**From Obsidian:** Settings → Community plugins → Browse, search for *Trellis*,
then install and enable it.

**Manually:** download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/CocaPls/obsidian-trellis/releases/latest),
put them in `your-vault/.obsidian/plugins/trellis/`, and enable the plugin.

## Quick start

1. Add a location tag in frontmatter, for example `tags: [trel/S88/B07]`.
2. Trellis syncs the filename code to `S88B07`.
3. Open the tree from the ribbon and move through the hierarchy.
4. Use **Move location and descendants** to relocate a whole subtree.
5. Use **Import existing filenames** to onboard notes that already have codes.
6. Review every bulk preview before applying it; completed operations retain an
   undo record where supported.

## Advanced features

Advanced filename features are opt-in and stay collapsed in settings. The
single-code path remains the default.

- **Multi-key slots** combine more than one managed namespace with one free title:

  ```text
  #trel/AA/01 + #area/BB/02  →  AA01-my-note--BB02
  ```

  Each tag slot has its own namespace and hierarchy display. Applying a schema
  change requires a preview; ambiguous or orphaning layouts are rejected.
- **Root namespace** places every managed tag below a shared root such as
  `#zettel/trel/...` without adding that root to filenames. Changes are migrated
  behind confirmation and are undoable.
- **Segment presets** can suggest the next sequence number, date, Zettelkasten
  timestamp, or alternating letter/number segment when creating a note.

Tree, import, and subtree operations use the first tag slot while multi-key mode
is enabled.

## Screenshots

**Import existing filenames — choose exactly what to onboard.**

![Import target picker](screenshots/bootstrap.png)

**Move a location and its descendants — preview the whole subtree.**

![Subtree move preview](screenshots/cascade-rename.png)

**Duplicate cleanup — keep one location per namespace.**

![Duplicate location-tag cleanup](screenshots/dedup.png)

## Settings

![Settings tab](screenshots/settings.png)

The everyday controls cover the managed location namespace, filename-code
format, tree behavior, visible header actions, language, and a read-only managed
note count. Multi-key slots, root namespaces, and segment presets remain in the
collapsed experimental section.

Vault-wide setting changes are staged first. Trellis shows the exact affected
files, checks collisions and parse ambiguity, then applies through Obsidian's
rename API. A cancel or failure rolls the transaction back.

## Automation for AI and scripts

Trellis exposes an experimental, in-process `inspectNote → planChange →
applyChange` surface for tools that already run inside Obsidian. It opens no
network, REST, URI, or MCP endpoint. Plans are rejected if the note or schema
changed after inspection.

See [Guarded automation](docs/automation.md) for examples, result shapes, and
safety boundaries.

## Compatibility, privacy, and safety

Requires Obsidian **1.8.7** or newer. Desktop and mobile.

Trellis works locally through Obsidian's public vault APIs. It makes no network
requests, collects no telemetry, shows no ads, requires no account, and does not
access files outside the current vault.

Bulk filename and tag changes can affect many notes. Review the preview and keep
a normal vault backup as you would for any bulk-editing tool.

## Development

The pure filename and schema logic lives in [`src/tagkey.ts`](src/tagkey.ts);
[`src/main.ts`](src/main.ts) connects it to Obsidian. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the local build, tests, and contribution
workflow.

## Part of

Trellis is the identification component of
[everything-in-obsidian](https://github.com/CocaPls/everything-in-obsidian), a
personal hub of pluggable systems for operating an Obsidian vault with a CLI AI.
Trellis works fully on its own; the hub is optional context.

## License

[MIT](LICENSE)
