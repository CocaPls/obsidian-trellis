# TRELLIS

**English** | [한국어](README.ko.md)

Tag-driven filename sync for [Obsidian](https://obsidian.md). Keep a hierarchical
**location tag** as the single source of truth, and TRELLIS mirrors it into the
**filename prefix** (the *tagkey*) automatically — link-safe.

Move a note in the tag tree, and its filename prefix follows. No manual
batch-renaming, no broken wikilinks.

```
note tagged  #trel/S88/B07     →  filename  S88B07-meeting-notes.md
retag it     #trel/S88/B99     →  filename  S88B99-meeting-notes.md   (automatic)
```

![Sidebar tree view](screenshots/tree-view.png)

## 🧩 How it works

TRELLIS reads a filename as three parts — for example `S88B07-meeting-notes.md`:

- **`S88B07`** — the **tagkey**: the identifier built from the note's location
  tag (`#trel/S88/B07` → `S88B07`). This is the only part TRELLIS controls.
- **`-`** — the **separator** between the tagkey and the name (default `-`).
- **`meeting-notes`** — the **namekey**: your title. TRELLIS never touches it.

The tag is the source of truth: change the tag and the tagkey is rewritten to
match; edit the tagkey by hand and it's restored from the tag.

## ✨ Features

- **One-directional sync** — when a note's location tag changes, its filename
  prefix is rewritten to match, through Obsidian's link-safe rename API
  (wikilinks update automatically). Edit the filename or title by hand and it's
  restored from the tag. The tag is always the source of truth. Keep location
  tags in frontmatter — that's what cascade and bootstrap read and rewrite.
  One note = one location tag (extras are flagged with a notice).
- **Cascade rename** — rename a tag and its whole subtree follows; inserting a
  new parent level works too. Filenames and wikilinks follow along.
- **Sidebar tree view** — see your tag hierarchy as a collapsible, folder-like
  tree, with no real folders.
- **Bootstrap** — onboard an existing vault that already has filename prefixes
  but no tags yet. Pick the scope with a checkbox tree (whole vault, folders, or
  individual notes; drag to sweep-select, search, or show only untagged notes),
  preview as a dry-run, watch live progress, and undo in one step. Per-file
  errors are isolated so one bad note never stops the run. Bootstrap recognizes
  prefixes shaped like `S88B07` (a letter, two digits, an optional letter and
  two digits); other schemes aren't auto-decomposed yet, and the dry-run lists
  anything it skips.
- **Duplicate location-tag cleanup** — when a note carries more than one location
  tag in the same namespace, TRELLIS flags it and offers a cleanup command: pick
  which tag to keep and the rest are removed. Batched for large vaults, with undo.
- **Separator batch-change** — change the separator in settings and only the
  tagkey-boundary separator is swapped across the whole vault (symbols inside
  titles are preserved). Undo supported.
- **Internationalization** — Korean / English UI, auto-detected from Obsidian's
  language.

## 📦 Installation

**Manual (current):**

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest
   [release](../../releases).
2. Put them in your vault's `.obsidian/plugins/trellis/` folder.
3. Enable the plugin in **Settings → Community plugins**.

*(A community-plugin marketplace listing is planned for 0.1.0.)*

## 🚀 Usage

1. **Tag a note** — add a location tag in frontmatter (e.g. `tags: [trel/S88/B07]`)
   and the filename prefix syncs to `S88B07` automatically.
2. **Change a level** — run **"Rename location tag (cascade)"** from the command
   palette or a note's right-click menu; filenames and wikilinks follow.
3. **Tree view** — open the sidebar tree from the ribbon icon.
4. **Onboard an existing vault** — run **"Bootstrap"** to derive tags from
   filename prefixes (choose a scope, dry-run first, then apply).
5. **Clean up duplicates** — run **"Check duplicate location tags"** to find notes
   with more than one location tag and pick which to keep.
6. **Change the separator** — change it in settings; after a confirmation, it's
   applied vault-wide.

## 📸 Screenshots

**Bootstrap — pick what to onboard.** Already-tagged notes are shown as done;
untagged notes are selectable (whole vault, folders, or individual notes).

![Bootstrap target picker](screenshots/bootstrap.png)

**Cascade rename — move a whole subtree.** Rename one tag and every note under it
follows, filenames and wikilinks included.

![Cascade rename](screenshots/cascade-rename.png)

**Duplicate cleanup — one location per note.** When a note has more than one
location tag, pick the one to keep; the rest are removed (undoable).

![Duplicate location-tag cleanup](screenshots/dedup.png)

## ⚙️ Settings

![Settings tab](screenshots/settings.png)

- **Location tag namespace** — which tags are the source of truth (e.g. `trel`)
- **Separator** — the character(s) between the tagkey and the title (e.g. `-`)
- **Key position** — prefix (start) or suffix (end) of the filename
- **Sidebar tree view** — on / off
- **Tree sort** — tagkey / modified time / created time
- **Language** — auto / Korean / English

## 🔧 Compatibility

Requires Obsidian **1.4.0** or newer.

## 🧱 Design (internals)

Under the hood, a filename is a positional array of **slots** joined by
**separators** — the default is a 2-slot `[tag slot, name slot]` layout, so
multi-key schemes can grow without rewriting the core. The conversion logic
lives in `tagkey.ts` (pure, unit-tested); `main.ts` is the Obsidian glue.
The live sync is format-agnostic — it mirrors whatever the tag path is, so any
scheme works. (Bootstrap, the reverse direction, assumes the default prefix
pattern above; generalizing it to arbitrary schemes is a later addition.)

## 🛠 Develop

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production build → main.js
npm test         # unit tests for the conversion logic
```

Create a throwaway vault to exercise the engine safely before pointing it at
real notes.

## 📄 License

[MIT](LICENSE)

## 💡 Why

I run my vault as a knowledge base *without* folders — the hierarchy lives in
tags, and each note carries a short ID prefix in its filename that encodes where
it sits. Those stable, predictable filenames earn their keep twice: the vault
stays navigable without folders, and when I drive it with a CLI AI tool I can
point the assistant at exactly the right files and folders by their IDs.

I used to keep those prefixes in sync by hand. TRELLIS automates it — the tag is
the single source of truth, and filenames (and wikilinks) follow on their own.
