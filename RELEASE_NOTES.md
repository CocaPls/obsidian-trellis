# Trellis 0.7.0: filename rules and optional display names

## What's new

- Build names from managed tags and an optional free title. Tag slots can affect
  the physical filename or contribute only to the displayed name.
- Optionally show Trellis names in the file explorer, tabs, note titles, search
  results, backlinks, and Quick Switcher. Quick Switcher can find display names.
- Configure each display surface separately. All six display options start off.
- Review filename changes before applying an edited naming structure. The
  current-note preview appears while structure edits are pending.
- Inspect naming projections and blocked metadata without changing notes.

## Reliability improvements

- Reject stale change previews when files, tags, or naming rules have changed.
- Preserve newer tag edits when an automatic rename fails, and report incomplete
  recovery instead of overwriting those edits.
- Clarify cancellation and recovery results for bulk operations.
- Restore normal labels when display options or the plugin are disabled, and
  clean up queued callbacks and window-specific event handlers on unload.

## Updating from 0.5.2

Existing settings are migrated when loaded. Keep a backup of your vault and the
Trellis plugin settings before applying bulk filename changes. Updating does not
turn on the new native display options automatically.

Changing a slot between physical filename and display-only mode can change
existing filenames after you confirm the structure change. Turning a native
display switch on or off changes labels only; it does not change stored filenames
or link destinations. Custom link aliases, link text, bookmarks, Graph, and Canvas
are outside the native display-name feature.

## Recovery and support

Disabling Trellis restores the native labels it decorates; it does not undo
physical file renames. Use the relevant undo operation when available. To restore
a vault backup, stop Trellis first and restore the related notes and plugin
settings together. Replacing only the plugin executable with an older version
does not restore renamed notes or earlier settings.

For a problem report, include the Obsidian version, operating system, steps, and a
small non-sensitive example of the naming rules and tags involved:
https://github.com/CocaPls/obsidian-trellis/issues
