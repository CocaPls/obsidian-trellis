# TRELLIS

Tag-driven identifier sync for [Obsidian](https://obsidian.md). Keep a
hierarchical **location tag** as the single source of truth, and TRELLIS mirrors
it into the **filename prefix** (the *trekey*) automatically — link-safe.

Move a note in the tag tree, and its filename prefix follows. No manual
batch-renaming, no broken wikilinks.

```
note tagged  #trel/S88/B07     →  filename  S88B07-tree-idea.md
retag it     #trel/S88/B99     →  filename  S88B99-tree-idea.md   (automatic)
```

## What it does (MVP — v0.1.0)

- Watches notes for a location tag under a configured namespace (default `trel`).
- Converts the tag to a trekey (`#trel/S88/B07` → `S88B07`: drop the namespace,
  strip the `/` hierarchy separators).
- Rewrites the filename prefix (everything before the first `-`) to match, via
  Obsidian's link-safe rename API. The title key and any trailing segments are
  preserved.
- One direction only: **the tag is the source of truth.** Editing the prefix by
  hand gets corrected back on the next tag change.
- Cascade is free: bulk-rename a parent tag (e.g. with Tag Wrangler) and every
  affected note re-syncs on its own.

### Not yet (deferred)

Multi-key, title-key upward sync, settings UI (namespace/separator are hard-coded
for now), bootstrap onboarding for existing vaults, and drift warnings.

## Design

TRELLIS is **format-agnostic** — it does not define what a trekey means, only
how to keep it in sync. The conversion logic lives in `trekey.ts` (pure, unit-
tested); `main.ts` is the Obsidian glue.

## Develop

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production build → main.js
npm test         # unit tests for the conversion logic
```

A throwaway `test-vault/` is included with the plugin symlinked in and a dummy
note carrying instructions. Open it in Obsidian to exercise the engine safely.

## Status

Early MVP. Built as a reference plugin — quality over reach. Part of the TRELLIS
system (an app-agnostic definition + this Obsidian implementation).

## License

MIT
