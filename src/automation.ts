import type { TrellisSchema } from "./tagkey.ts";
import {
	assembleBasenameMulti,
	duplicateLocationGroups,
	extractNameMulti,
	isValidTagPath,
	isValidTagSegment,
	isValidTagSegmentForSlot,
	nsPath,
	normalizeTagList,
	portableBasenameIssue,
	slotTagkeys,
	syncedBasenameMulti,
	matchTagKey,
	schemaTagDefinitions,
	tagDefinitionById,
	slotNamespace,
	sameTagPath,
	tagPathIdentity,
	tagPathInNamespace,
	tagPathRelativeToNamespace,
} from "./tagkey.ts";

export type AutomationErrorCode =
	| "note-not-found"
	| "not-a-markdown-file"
	| "metadata-unavailable"
	| "stale-plan"
	| "write-in-progress"
	| "invalid-request"
	| "unknown-namespace"
	| "archived-namespace"
	| "invalid-tag-path"
	| "inline-tag-conflict"
	| "duplicate-location-tags"
	| "name-slot-unavailable"
	| "would-unmanage-note"
	| "invalid-name"
	| "target-exists"
	| "frontmatter-write-failed"
	| "rename-failed";

export interface AutomationError {
	code: AutomationErrorCode;
	message: string;
	details?: Record<string, unknown>;
}

export type AutomationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: AutomationError };

/** Immutable data gathered from Obsidian before pure inspection/planning. */
export interface TrellisNoteState {
	path: string;
	basename: string;
	extension: string;
	mtime: number;
	/** All cache-visible tags, including inline tags, with leading '#'. */
	allTags: string[];
	/** Frontmatter tags only, without leading '#'. */
	frontmatterTags: string[];
}

export interface InspectionIssue {
	code: "filename-drift" | "duplicate-location-tags" | "inline-managed-tag";
	message: string;
	details?: Record<string, unknown>;
}

export interface InspectedSlot {
	index: number;
	slotId?: string;
	role: "tag" | "name";
	tagDefinitionId?: string;
	displayName?: string;
	namespace?: string;
	value: string | null;
}

export interface TrellisNoteInspection {
	state: TrellisNoteState;
	managed: boolean;
	nameKey: string;
	slots: InspectedSlot[];
	expectedBasename: string;
	issues: InspectionIssue[];
}

export interface TagSlotChange {
	/** Stable managed-tag identity (preferred). */
	tagDefinitionId?: string;
	/** Backward-compatible lookup. New callers should use tagDefinitionId. */
	namespace?: string;
	/** Full tag path without '#', or null to remove this slot's frontmatter tag. */
	tagPath: string | null;
}

export interface TrellisChangeRequest {
	path: string;
	tagChanges?: TagSlotChange[];
	/** Exact free name-key value. Empty string is allowed for an index note. */
	nameChange?: string;
	/** False changes frontmatter only. Omitted follows the plugin's global live
	 * sync setting when called through the public automation surface. */
	syncFilename?: boolean;
	/** Explicitly allow removing the final managed tag from a schema that has no
	 * name-key. The current basename is then preserved and the note leaves
	 * Trellis management. Omitted/false keeps this surprising transition blocked. */
	allowUnmanaged?: boolean;
}

export interface TrellisChangePlan {
	request: TrellisChangeRequest;
	expected: {
		path: string;
		basename: string;
		mtime: number;
		frontmatterTags: string[];
		schemaFingerprint: string;
	};
	next: {
		path: string;
		basename: string;
		frontmatterTags: string[];
	};
	changes: {
		frontmatter: boolean;
		rename: boolean;
	};
	status: "ready" | "noop";
}

export interface TrellisApplyResult {
	status: "applied" | "noop";
	previousPath: string;
	path: string;
	changes: TrellisChangePlan["changes"];
}

function withoutHash(tag: string): string {
	return tag.replace(/^#/, "");
}

function parentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function notePath(parent: string, basename: string, extension: string): string {
	return `${parent ? `${parent}/` : ""}${basename}.${extension}`;
}

function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Pure, read-only interpretation of one Obsidian note under a schema. */
export function inspectNoteState(
	state: TrellisNoteState,
	schema: TrellisSchema
): TrellisNoteInspection {
	const frontmatterTags = state.frontmatterTags.map((tag) => `#${withoutHash(tag)}`);
	const keys = slotTagkeys(frontmatterTags, schema);
	const nameKey = extractNameMulti(state.basename, keys, schema);
	const expectedBasename =
		syncedBasenameMulti(state.basename, frontmatterTags, schema) ?? state.basename;
	const duplicates = duplicateLocationGroups(frontmatterTags, schema);
	const frontmatter = new Set(state.frontmatterTags.map((tag) => tagPathIdentity(withoutHash(tag))));
	const inlineManaged = state.allTags
		.map(withoutHash)
		.filter(
			(tag) => !frontmatter.has(tagPathIdentity(tag)) && matchTagKey(tag, schema) !== null
		);
	const issues: InspectionIssue[] = [];
	if (expectedBasename !== state.basename) {
		issues.push({
			code: "filename-drift",
			message: "The filename does not match the current managed tags.",
			details: { expectedBasename },
		});
	}
	if (duplicates.length > 0) {
		issues.push({
			code: "duplicate-location-tags",
			message: "At least one namespace has multiple location tags.",
			details: { groups: duplicates },
		});
	}
	if (inlineManaged.length > 0) {
		issues.push({
			code: "inline-managed-tag",
			message: "Managed inline tags cannot be safely rewritten through frontmatter.",
			details: { tags: inlineManaged },
		});
	}
	return {
		state,
		managed: frontmatterTags.some((tag) => {
			const match = matchTagKey(tag, schema);
			return match !== null && match.keyPath !== "";
		}),
		nameKey,
		slots: schema.slots.map((slot, index) => ({
			index,
			slotId: slot.id,
			role: slot.role,
			tagDefinitionId: slot.role === "tag" ? slot.tagDefinitionId : undefined,
			displayName:
				slot.role === "tag"
					? tagDefinitionById(schema, slot.tagDefinitionId)?.name
					: undefined,
			namespace: slot.role === "tag" ? slotNamespace(schema, slot) : undefined,
			value: slot.role === "name" ? nameKey : keys[index],
		})),
		expectedBasename,
		issues,
	};
}

function invalidName(name: string): boolean {
	return [...name].some(
		(character) => character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character)
	);
}

/** Pure dry-run. It never writes frontmatter or renames a file. */
export function planNoteChange(
	state: TrellisNoteState,
	schema: TrellisSchema,
	request: TrellisChangeRequest
): AutomationResult<TrellisChangePlan> {
	if (request.path !== state.path) {
		return {
			ok: false,
			error: { code: "invalid-request", message: "Request path does not match note state." },
		};
	}
	if (request.nameChange !== undefined) {
		if (request.syncFilename === false) {
			return {
				ok: false,
				error: {
					code: "invalid-request",
					message: "A name-slot change requires syncFilename to be enabled.",
				},
			};
		}
		if (!schema.slots.some((slot) => slot.role === "name")) {
			return {
				ok: false,
				error: {
					code: "name-slot-unavailable",
					message: "The filename schema has no free name slot.",
				},
			};
		}
		if (invalidName(request.nameChange)) {
			return {
				ok: false,
				error: {
					code: "invalid-name",
					message: "The requested name contains a control or filename-illegal character.",
				},
			};
		}
	}

	const changes = request.tagChanges ?? [];
	const requestedDefinitions = new Set<string>();
	const requestedFullNamespaces = new Set<string>();
	let nextFrontmatter = normalizeTagList(state.frontmatterTags).map(withoutHash);
	const frontmatterIdentities = new Set(nextFrontmatter.map(tagPathIdentity));
	const inlineTags = state.allTags
		.map(withoutHash)
		.filter((tag) => !frontmatterIdentities.has(tagPathIdentity(tag)));

	for (const change of changes) {
		const definition = change.tagDefinitionId
			? tagDefinitionById(schema, change.tagDefinitionId)
			: schemaTagDefinitions(schema).find(
					(candidate) => sameTagPath(candidate.namespace, change.namespace ?? "")
				);
		if (!definition) {
			return {
				ok: false,
				error: {
					code: "unknown-namespace",
					message: `No managed Trellis tag matches '${change.tagDefinitionId ?? change.namespace ?? ""}'.`,
				},
			};
		}
		if (definition.archived && change.tagPath !== null) {
			return {
				ok: false,
				error: {
					code: "archived-namespace",
					message: `Managed tag '${definition.id}' is archived and cannot receive new values.`,
				},
			};
		}
		if (requestedDefinitions.has(definition.id)) {
			return {
				ok: false,
				error: {
					code: "invalid-request",
					message: `Managed tag '${definition.id}' is changed more than once.`,
				},
			};
		}
		requestedDefinitions.add(definition.id);
		const slot = schema.slots.find(
			(candidate) =>
				candidate.role === "tag" &&
				(candidate.tagDefinitionId === definition.id ||
					(!candidate.tagDefinitionId &&
						sameTagPath(candidate.namespace ?? "", definition.namespace)))
		);
		const fullNamespace = nsPath(schema, definition.namespace);
		requestedFullNamespaces.add(tagPathIdentity(fullNamespace));
		if (change.tagPath !== null) {
			const tagPath = withoutHash(change.tagPath);
			const relative = tagPathRelativeToNamespace(tagPath, fullNamespace);
			const segments = relative?.split("/") ?? [];
			if (
				!relative ||
				!isValidTagPath(tagPath) ||
				segments.some((segment) =>
					slot
						? !isValidTagSegmentForSlot(segment, slot)
						: !isValidTagSegment(segment)
				)
			) {
				return {
					ok: false,
					error: {
						code: "invalid-tag-path",
						message: `Tag path '${change.tagPath}' is not a reversible child of '${fullNamespace}'.`,
					},
				};
			}
		}
		const conflictingInline = inlineTags.filter((tag) =>
			tagPathInNamespace(tag, fullNamespace)
		);
		if (conflictingInline.length > 0) {
			return {
				ok: false,
				error: {
					code: "inline-tag-conflict",
					message: `Inline tags prevent a safe change in '${definition.namespace}'.`,
					details: { tags: conflictingInline },
				},
			};
		}
		nextFrontmatter = nextFrontmatter.filter(
			(tag) => !tagPathInNamespace(tag, fullNamespace)
		);
		if (change.tagPath !== null) nextFrontmatter.push(withoutHash(change.tagPath));
	}

	nextFrontmatter = normalizeTagList(nextFrontmatter);
	const nextAllTags = [
		...new Set([...inlineTags, ...nextFrontmatter].map((tag) => `#${tag}`)),
	];
	const unresolvedDuplicates = duplicateLocationGroups(nextAllTags, schema).filter(
		(group) => !requestedFullNamespaces.has(tagPathIdentity(group.namespace))
	);
	if (unresolvedDuplicates.length > 0) {
		return {
			ok: false,
			error: {
				code: "duplicate-location-tags",
				message: "Resolve every duplicate managed location before applying another change.",
				details: { groups: unresolvedDuplicates },
			},
		};
	}

	const current = inspectNoteState(state, schema);
	const keys = slotTagkeys(nextAllTags, schema);
	const nextManaged = nextAllTags.some((tag) => {
		const match = matchTagKey(tag, schema);
		return match !== null && match.keyPath !== "";
	});
	if (
		current.managed &&
		!schema.slots.some((slot) => slot.role === "name") &&
		!nextManaged &&
		!request.allowUnmanaged
	) {
		return {
			ok: false,
			error: {
				code: "would-unmanage-note",
				message:
					"Removing the final managed tag would leave this no-name-key note unmanaged. Retry with allowUnmanaged to preserve the current filename explicitly.",
			},
		};
	}
	const name = request.nameChange ?? current.nameKey;
	const values = schema.slots.map((slot, index) =>
		slot.role === "name" ? name : keys[index]
	);
	const nextBasename =
		request.syncFilename === false
			? state.basename
			: assembleBasenameMulti(values, schema) || state.basename;
	const nextPath = notePath(parentPath(state.path), nextBasename, state.extension);
	const frontmatterChanged = !sameStrings(state.frontmatterTags, nextFrontmatter);
	const renameChanged = nextPath !== state.path;
	const filenameIssue = renameChanged ? portableBasenameIssue(nextBasename) : null;
	if (filenameIssue) {
		return {
			ok: false,
			error: {
				code: "invalid-name",
				message: "The planned filename is not portable across supported platforms.",
				details: { basename: nextBasename, issue: filenameIssue },
			},
		};
	}
	return {
		ok: true,
		value: {
			request,
			expected: {
				path: state.path,
				basename: state.basename,
				mtime: state.mtime,
				frontmatterTags: [...state.frontmatterTags],
				schemaFingerprint: JSON.stringify(schema),
			},
			next: {
				path: nextPath,
				basename: nextBasename,
				frontmatterTags: nextFrontmatter,
			},
			changes: { frontmatter: frontmatterChanged, rename: renameChanged },
			status: frontmatterChanged || renameChanged ? "ready" : "noop",
		},
	};
}

/** Optimistic-concurrency guard shared by the live apply method and tests. */
export function validatePlanSnapshot(
	state: TrellisNoteState,
	schema: TrellisSchema,
	plan: TrellisChangePlan
): AutomationResult<true> {
	const stale =
		state.path !== plan.expected.path ||
		state.basename !== plan.expected.basename ||
		state.mtime !== plan.expected.mtime ||
		!sameStrings(state.frontmatterTags, plan.expected.frontmatterTags) ||
		JSON.stringify(schema) !== plan.expected.schemaFingerprint;
	return stale
		? {
				ok: false,
				error: {
					code: "stale-plan",
					message: "The note or Trellis schema changed after this plan was created.",
				},
			}
		: { ok: true, value: true };
}
