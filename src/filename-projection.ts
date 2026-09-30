import {
	assembleBasenameMulti,
	duplicateLocationGroups,
	extractNameMulti,
	matchTagKey,
	physicalSlotTagkeys,
	portableBasenameIssue,
	slotKind,
	slotSyncMode,
	slotTagkeys,
	type DuplicateTagGroup,
	type PortableBasenameIssue,
	type SlotKind,
	type SlotSyncMode,
	type TrellisSchema,
} from "./tagkey.ts";

export type FilenameProjectionStatus =
	| "title-only"
	| "consistent"
	| "drift"
	| "blocked";

export type FilenameProjectionIssue =
	| {
			code: "duplicate-metadata";
			slotIndexes: number[];
			groups: DuplicateTagGroup[];
			affectsPhysical: boolean;
	  }
	| { code: "reverse-mode-not-ready"; slotIndexes: number[] }
	| {
			code: "unsafe-filename";
			basename: string;
			issue: PortableBasenameIssue;
	  };

export interface ProjectedSlot {
	id: string;
	index: number;
	kind: SlotKind;
	mode: SlotSyncMode | null;
	metadataValue: string | null;
	physicalValue: string | null;
	virtualValue: string | null;
}

/** Read-only filename interpretation shared by the future sidebar, inventory,
 * and write planner. It never reads files and never mutates tags or paths. */
export interface FilenameProjection {
	actualBasename: string;
	title: string;
	physicalBasename: string | null;
	virtualBasename: string;
	status: FilenameProjectionStatus;
	hasManagedMetadata: boolean;
	issues: FilenameProjectionIssue[];
	slots: ProjectedSlot[];
}

function projectedValues(
	title: string,
	tagValues: (string | null)[],
	schema: TrellisSchema,
	target: "physical" | "virtual"
): (string | null)[] {
	return schema.slots.map((slot, index) => {
		if (slot.role === "name") return title;
		const mode = slotSyncMode(slot);
		if (target === "physical") {
			return mode === "metadata-to-filename" ? tagValues[index] : null;
		}
		return mode === "display-only" || mode === "metadata-to-filename"
			? tagValues[index]
			: null;
	});
}

/** Assemble from an already-known title. This is the lossless transition path
 * used when a final managed tag disappears during the current session. */
export function projectKnownTitle(
	title: string,
	frontmatterTags: string[],
	schema: TrellisSchema,
	target: "physical" | "virtual"
): string {
	const tagValues = slotTagkeys(frontmatterTags, schema);
	return assembleBasenameMulti(projectedValues(title, tagValues, schema, target), schema);
}

/** Interpret one current basename. Filename -> metadata is deliberately
 * read-only-blocked in the first foundation bundle: reverse parsing needs its
 * own ambiguity contract before any property write is allowed. */
export function projectFilename(
	actualBasename: string,
	frontmatterTags: string[],
	schema: TrellisSchema
): FilenameProjection {
	return projectFilenameWithTitle(
		actualBasename,
		frontmatterTags,
		schema,
		extractProjectedTitle(actualBasename, frontmatterTags, schema)
	);
}

/** Reproject a note while retaining a title already parsed in this session.
 * This avoids treating a stale managed prefix as title text after its final
 * metadata value is removed. */
export function projectFilenameFromKnownTitle(
	actualBasename: string,
	title: string,
	frontmatterTags: string[],
	schema: TrellisSchema
): FilenameProjection {
	return projectFilenameWithTitle(actualBasename, frontmatterTags, schema, title);
}

function extractProjectedTitle(
	actualBasename: string,
	frontmatterTags: string[],
	schema: TrellisSchema
): string {
	const physicalAnchors = physicalSlotTagkeys(frontmatterTags, schema);
	return extractNameMulti(actualBasename, physicalAnchors, schema);
}

function projectFilenameWithTitle(
	actualBasename: string,
	frontmatterTags: string[],
	schema: TrellisSchema,
	title: string
): FilenameProjection {
	const tagValues = slotTagkeys(frontmatterTags, schema);
	const reverseSlotIndexes = schema.slots.flatMap((slot, index) =>
		slot.role === "tag" && slotSyncMode(slot) === "filename-to-metadata"
			? [index]
			: []
	);
	const physicalValues = projectedValues(title, tagValues, schema, "physical");
	const virtualValues = projectedValues(title, tagValues, schema, "virtual");
	const computedPhysical = assembleBasenameMulti(physicalValues, schema);
	const virtualBasename = assembleBasenameMulti(virtualValues, schema) || actualBasename;
	const hasPhysicalManagedMetadata = schema.slots.some(
		(slot, index) =>
			slot.role === "tag" &&
			slotSyncMode(slot) === "metadata-to-filename" &&
			Boolean(tagValues[index])
	);
	const duplicateGroups = duplicateLocationGroups(frontmatterTags, schema);
	const issues: FilenameProjectionIssue[] = [];
	const slottedDuplicateGroups = duplicateGroups.filter((group) => {
		const match = matchTagKey(group.tags[0] ?? "", schema);
		return match !== null && match.slotIndex >= 0;
	});
	const duplicateSlotIndexes = slottedDuplicateGroups.flatMap((group) => {
		const match = matchTagKey(group.tags[0] ?? "", schema);
		return match ? [match.slotIndex] : [];
	});
	if (duplicateSlotIndexes.length > 0) {
		issues.push({
			code: "duplicate-metadata",
			slotIndexes: duplicateSlotIndexes,
			groups: slottedDuplicateGroups,
			affectsPhysical: duplicateSlotIndexes.some(
				(index) => slotSyncMode(schema.slots[index]) === "metadata-to-filename"
			),
		});
	}
	if (reverseSlotIndexes.length > 0) {
		issues.push({ code: "reverse-mode-not-ready", slotIndexes: reverseSlotIndexes });
	}
	const portableIssue = hasPhysicalManagedMetadata && computedPhysical
		? portableBasenameIssue(computedPhysical)
		: null;
	if (portableIssue) {
		issues.push({
			code: "unsafe-filename",
			basename: computedPhysical,
			issue: portableIssue,
		});
	}

	const physicalBlocked = issues.some(
		(issue) => issue.code !== "duplicate-metadata" || issue.affectsPhysical
	);
	const physicalBasename = physicalBlocked ? null : computedPhysical || actualBasename;
	const hasManagedMetadata = tagValues.some(Boolean);
	const status: FilenameProjectionStatus = issues.length > 0
		? "blocked"
		: !hasManagedMetadata
			? "title-only"
			: physicalBasename === actualBasename
				? "consistent"
				: "drift";

	return {
		actualBasename,
		title,
		physicalBasename,
		virtualBasename,
		status,
		hasManagedMetadata,
		issues,
		slots: schema.slots.map((slot, index) => ({
			id: slot.id ?? `slot-${index + 1}`,
			index,
			kind: slotKind(slot),
			mode: slotSyncMode(slot),
			metadataValue: slot.role === "tag" ? tagValues[index] : null,
			physicalValue: physicalValues[index],
			virtualValue: virtualValues[index],
		})),
	};
}
