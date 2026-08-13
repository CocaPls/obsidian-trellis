import type { TrellisSchema } from "./tagkey.ts";
import {
	assembleBasenameMulti,
	duplicateLocationGroups,
	extractNameMulti,
	isValidTagPath,
	isValidTagSegmentForSlot,
	nsPath,
	normalizeTagList,
	slotTagkeys,
	syncedBasenameMulti,
	tagNamespaces,
} from "./tagkey.ts";

export type AutomationErrorCode =
	| "note-not-found"
	| "not-a-markdown-file"
	| "metadata-unavailable"
	| "stale-plan"
	| "invalid-request"
	| "unknown-namespace"
	| "invalid-tag-path"
	| "inline-tag-conflict"
	| "duplicate-location-tags"
	| "name-slot-unavailable"
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
	role: "tag" | "name";
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
	/** Logical slot namespace from the schema, without a root namespace. */
	namespace: string;
	/** Full tag path without '#', or null to remove this slot's frontmatter tag. */
	tagPath: string | null;
}

export interface TrellisChangeRequest {
	path: string;
	tagChanges?: TagSlotChange[];
	/** Exact free name-key value. Empty string is allowed for an index note. */
	nameChange?: string;
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

function pathInNamespace(tagPath: string, fullNamespace: string): boolean {
	return tagPath === fullNamespace || tagPath.startsWith(`${fullNamespace}/`);
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
	const keys = slotTagkeys(state.allTags, schema);
	const nameKey = extractNameMulti(state.basename, keys, schema);
	const expectedBasename =
		syncedBasenameMulti(state.basename, state.allTags, schema) ?? state.basename;
	const duplicates = duplicateLocationGroups(state.allTags, schema);
	const frontmatter = new Set(state.frontmatterTags.map(withoutHash));
	const managedNamespaces = tagNamespaces(schema).map((namespace) =>
		nsPath(schema, namespace)
	);
	const inlineManaged = state.allTags
		.map(withoutHash)
		.filter(
			(tag) =>
				!frontmatter.has(tag) &&
				managedNamespaces.some((namespace) => pathInNamespace(tag, namespace))
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
		managed: keys.some((key) => key !== null),
		nameKey,
		slots: schema.slots.map((slot, index) => ({
			index,
			role: slot.role,
			namespace: slot.namespace,
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
	const requestedNamespaces = new Set<string>();
	let nextFrontmatter = normalizeTagList(state.frontmatterTags).map(withoutHash);
	const inlineTags = state.allTags
		.map(withoutHash)
		.filter((tag) => !state.frontmatterTags.map(withoutHash).includes(tag));

	for (const change of changes) {
		if (requestedNamespaces.has(change.namespace)) {
			return {
				ok: false,
				error: {
					code: "invalid-request",
					message: `Namespace '${change.namespace}' is changed more than once.`,
				},
			};
		}
		requestedNamespaces.add(change.namespace);
		const slot = schema.slots.find(
			(candidate) =>
				candidate.role === "tag" && candidate.namespace === change.namespace
		);
		if (!slot) {
			return {
				ok: false,
				error: {
					code: "unknown-namespace",
					message: `No tag slot uses namespace '${change.namespace}'.`,
				},
			};
		}
		const fullNamespace = nsPath(schema, change.namespace);
		if (change.tagPath !== null) {
			const tagPath = withoutHash(change.tagPath);
			const segments = tagPath.slice(fullNamespace.length + 1).split("/");
			if (
				!tagPath.startsWith(`${fullNamespace}/`) ||
				!isValidTagPath(tagPath) ||
				segments.some((segment) => !isValidTagSegmentForSlot(segment, slot))
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
			pathInNamespace(tag, fullNamespace)
		);
		if (conflictingInline.length > 0) {
			return {
				ok: false,
				error: {
					code: "inline-tag-conflict",
					message: `Inline tags prevent a safe change in '${change.namespace}'.`,
					details: { tags: conflictingInline },
				},
			};
		}
		nextFrontmatter = nextFrontmatter.filter(
			(tag) => !pathInNamespace(tag, fullNamespace)
		);
		if (change.tagPath !== null) nextFrontmatter.push(withoutHash(change.tagPath));
	}

	nextFrontmatter = [...new Set(nextFrontmatter)];
	const nextAllTags = [
		...new Set([...inlineTags, ...nextFrontmatter].map((tag) => `#${tag}`)),
	];
	const unresolvedDuplicates = duplicateLocationGroups(nextAllTags, schema).filter(
		(group) => !requestedNamespaces.has(group.namespace.split("/").pop() ?? "")
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
	const name = request.nameChange ?? current.nameKey;
	const values = schema.slots.map((slot, index) =>
		slot.role === "name" ? name : keys[index]
	);
	const nextBasename = assembleBasenameMulti(values, schema) || state.basename;
	const nextPath = notePath(parentPath(state.path), nextBasename, state.extension);
	const frontmatterChanged = !sameStrings(state.frontmatterTags, nextFrontmatter);
	const renameChanged = nextPath !== state.path;
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
