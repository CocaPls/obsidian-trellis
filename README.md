# TRELLIS

Tag-driven filename sync for [Obsidian](https://obsidian.md). Keep a hierarchical
**location tag** as the single source of truth, and TRELLIS mirrors it into the
**filename prefix** (the *trekey*) automatically — link-safe.

Move a note in the tag tree, and its filename prefix follows. No manual
batch-renaming, no broken wikilinks.

```
note tagged  #trel/S88/B07     →  filename  S88B07-tree-idea.md
retag it     #trel/S88/B99     →  filename  S88B99-tree-idea.md   (automatic)
```

![Sidebar tree view](screenshots/tree-view.png)

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
  errors are isolated so one bad note never stops the run.
- **Duplicate location-tag cleanup** — when a note carries more than one location
  tag in the same namespace, TRELLIS flags it and offers a cleanup command: pick
  which tag to keep and the rest are removed. Batched for large vaults, with undo.
- **Separator batch-change** — change the separator in settings and only the
  trekey-boundary separator is swapped across the whole vault (symbols inside
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

## ⚙️ Settings

![Settings tab](screenshots/settings.png)

- **Location tag namespace** — which tags are the source of truth (e.g. `trel`)
- **Separator** — the character(s) between the trekey and the title (e.g. `-`)
- **Key position** — prefix (start) or suffix (end) of the filename
- **Sidebar tree view** — on / off
- **Tree sort** — trekey / modified time / created time
- **Language** — auto / Korean / English

## 🔧 Compatibility

Requires Obsidian **1.4.0** or newer.

## 🧱 Design

TRELLIS is **format-agnostic** — it does not define what a trekey means, only how
to keep it in sync. The conversion logic lives in `trekey.ts` (pure, unit-tested);
`main.ts` is the Obsidian glue. The filename key model is a positional array of
slots + separators, so the single-key default is just a 2-slot `[tag, name]`
special case and multi-key support can grow without rewriting the core.

## 🛠 Develop

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production build → main.js
npm test         # unit tests for the conversion logic
```

A throwaway `test-vault/` is included so you can exercise the engine safely.

## 📄 License

[MIT](LICENSE)

## 💡 Why

Managing a large flat vault, I wanted folder-like hierarchy *without* folders —
with tags as the single source of truth and filenames kept in sync automatically.
Moving a note in the hierarchy shouldn't mean manual renaming or broken links; the
tag should drive everything else.
