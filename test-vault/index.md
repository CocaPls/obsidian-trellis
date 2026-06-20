# Test vault index — cascade test

## How to test the cascade (the whole point of TRELLIS)

Goal: rename **one** parent tag and watch every file in that package follow.

1. Open the **tag pane** (left sidebar, tag icon) — you'll see `trel/S88` with
   `A01 / B07 / B08 / L01` nested under it, plus `trel/S77/A01`.
2. Right-click the parent tag **`trel/S88`** → **"Rename tag…"** → change it to
   **`trel/S99`**.
3. Obsidian rewrites the tag in all 4 S88 notes at once. TRELLIS then renames
   each file:
   - `S88A01-definition` → `S99A01-definition`
   - `S88B07-tree-idea`  → `S99B07-tree-idea`
   - `S88B08-engine-spec`→ `S99B08-engine-spec`
   - `S88L01-session`    → `S99L01-session`
4. **Control check:** `S77A01-other-package` must stay unchanged (different
   package).
5. All the wikilinks between these notes should survive (link-safe).

To restore: rename `trel/S99` back to `trel/S88`.

## Notes in this vault

### Package S88 (these should all cascade)

- [[S99A01-definitioㅇㄹ]]
- [[S99B07-tree-idea]]
- [[S99B08-engine-spec]]
- [[S99L01-session]]

### Package S77 (control — should NOT change)

- [[S77A01-other-package]]
