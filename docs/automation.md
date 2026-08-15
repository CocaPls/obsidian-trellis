# Guarded automation

[한국어](automation.ko.md)

Trellis 0.5 exposes an experimental, in-process surface for an AI tool or script
that already has access to the running Obsidian app. It is designed for one
reviewable note change at a time:

```text
inspectNote → planChange → applyChange
```

This is not a network API. Trellis opens no REST server, URI handler, MCP server,
or remote-control port. The caller must already be running inside Obsidian's
JavaScript process, for example through a trusted local developer tool.

> **Note**
> The surface is experimental before Trellis 1.0. Pin the plugin version and
> inspect the returned result instead of assuming fields will never change.

## Access

From Obsidian's developer console or another trusted in-process caller:

```js
const trellis = app.plugins.plugins.trellis;
const automation = trellis.automation;
```

If either value is missing, Trellis is not installed, enabled, or loaded. Do not
reach into private plugin methods; use only the frozen `automation` object.

Read the current stable IDs and filename structure before planning:

```js
const model = automation.describe();
console.log(model.tagDefinitions, model.filenameSlots, model.filenameSyncEnabled);
```

Each tag definition includes its stable ID and current `archived` state. An
archived definition remains identifiable so existing tags can be removed safely,
but it is not an active target for new values.

`filenameSlots` also includes filename-only formatting for each tag slot.
`filenameTextTransform: "underscore-to-space"` displays `_` as a normal space
in the filename while leaving the frontmatter tag unchanged. For the boundary
after slot `i`, read `separators[i]` together with `separatorSpacing[i]`:

- a non-empty separator is a symbol with the configured surrounding spacing;
- an empty separator with `"after"` is one plain space;
- an empty separator with `"none"` joins populated slots directly.

Empty slots collapse together with their unused boundaries.

## 1. Inspect

Inspection is read-only:

```js
const inspected = automation.inspectNote("Projects/PRJ01DOC01-meeting-notes.md");

if (!inspected.ok) {
  console.error(inspected.error.code, inspected.error.message);
} else {
  console.log(inspected.value);
}
```

The successful value includes the current path, filename, modification time,
frontmatter and cache-visible tags, resolved tag/name slots, expected filename,
and issues such as filename drift, duplicate managed tags, or managed inline
tags.

## 2. Plan

Planning is also read-only. Prefer the stable managed-tag definition ID returned
by `describe()`, plus the complete desired tag path without `#`:

```js
const planned = automation.planChange({
  path: "Projects/PRJ01DOC01-meeting-notes.md",
  tagChanges: [
    { tagDefinitionId: "tag-projects", tagPath: "projects/PRJ/01/DOC/02" },
  ],
  nameChange: "meeting-notes",
});

if (planned.ok) console.log(planned.value);
```

- Omit `tagChanges` or `nameChange` when that part should stay unchanged.
- Use `tagPath: null` to remove the frontmatter tag for that slot.
- Set `syncFilename: false` for a reviewed frontmatter-only change. When omitted
  through the plugin surface, the current global filename-sync setting applies.
- In a schema without a name-key, removing the final managed tag would leave
  the note unmanaged. Trellis returns `would-unmanage-note` unless the reviewed
  request explicitly sets `allowUnmanaged: true`; the current filename is then
  preserved.
- `namespace` remains as a compatibility lookup, but stable
  `tagDefinitionId` is preferred and also supports sidebar-only Trellis tags.
- An archived definition accepts only `tagPath: null`; assigning or changing a
  value returns `archived-namespace` until the definition is restored in settings.
- `tagPath` must include the configured root when one exists, for example
  `work/projects/PRJ/01/DOC/02`.
- An empty `nameChange` is allowed for an index note.

A successful plan contains the exact before/after paths and frontmatter tags,
whether a rename or frontmatter write is needed, and `ready` or `noop` status.
It also carries a snapshot of the note and Trellis schema used to create it.

## 3. Apply

Apply only the exact plan that was reviewed:

```js
if (!planned.ok) throw new Error(planned.error.message);

const applied = await automation.applyChange(planned.value);
if (!applied.ok) {
  console.error(applied.error.code, applied.error.message, applied.error.details);
} else {
  console.log(applied.value.status, applied.value.path);
}
```

Do not construct or edit a plan by hand. Trellis recomputes it from the original
request and rejects modified output.

## Safety contract

- One call changes at most one Markdown note.
- `inspectNote` and `planChange` never write.
- Apply rechecks path, filename, modification time, frontmatter tags, and the
  complete Trellis schema.
- A note or schema change after planning returns `stale-plan` without writing.
- Unknown definition IDs/namespaces, irreversible tag paths, illegal filename characters,
  duplicate managed locations, inline managed-tag conflicts, and target-path
  collisions are rejected.
- Frontmatter is written through Obsidian's API and renames use Obsidian's
  link-safe file manager.
- If a rename fails after a frontmatter write, Trellis attempts to restore the
  previous frontmatter and reports any rollback failure.
- Automation applies are globally serialized with one another and with Trellis
  bulk operations. A competing request returns `write-in-progress`.

Common error codes include `note-not-found`, `metadata-unavailable`,
`invalid-request`, `archived-namespace`, `stale-plan`, `write-in-progress`,
`inline-tag-conflict`, `duplicate-location-tags`, `would-unmanage-note`,
`target-exists`, `frontmatter-write-failed`, and `rename-failed`. Always branch
on `ok` and retain the structured error for logs.

## Operational guidance

- Keep the inspect, human/tool review, plan, and apply cycle short.
- Re-plan instead of retrying a stale plan.
- Show the computed path and tag changes to the user before apply.
- Use Trellis's built-in bulk UI for subtree, namespace, root, or formatting
  migrations. This surface intentionally does not provide unattended batch
  mutation.
- Maintain normal vault backups for any automated editing workflow.
