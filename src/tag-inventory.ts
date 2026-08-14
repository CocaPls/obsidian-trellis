import type { TrellisSchema } from "./tagkey.ts";
import { matchTagKey, nsPath } from "./tagkey.ts";

export interface TagInventoryFile {
	path: string;
	/** Cache-visible explicit tags, including frontmatter and inline tags. */
	allTags: string[];
	/** Frontmatter tags only. */
	frontmatterTags: string[];
}

export interface TagKeyInventory {
	slotIndex: number;
	namespace: string;
	fullNamespace: string;
	notes: number;
	occurrences: number;
	uniquePaths: number;
	duplicateNotes: number;
	inlineOnlyNotes: number;
	namespaceNodeNotes: number;
	paths: { tagPath: string; count: number }[];
}

export interface TagInventorySnapshot {
	totalNotes: number;
	managedNotes: number;
	managedOccurrences: number;
	uniqueManagedPaths: number;
	generalOccurrences: number;
	uniqueGeneralTags: number;
	rootOwnedUnmatchedOccurrences: number;
	tagKeys: TagKeyInventory[];
}

function normalizedTags(tags: string[]): string[] {
	return [
		...new Set(
			tags
				.map((tag) => tag.trim())
				.filter(Boolean)
				.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
		),
	].sort();
}

function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Settings-lifetime inventory. It stores one normalized snapshot per note;
 * metadata events replace only the changed note, and aggregate counts are
 * rebuilt only after an actual tag change. */
export class TagInventory {
	private readonly files = new Map<string, TagInventoryFile>();
	readonly schema: TrellisSchema;

	constructor(schema: TrellisSchema) {
		this.schema = schema;
	}

	upsertFile(file: TagInventoryFile): boolean {
		const next: TagInventoryFile = {
			path: file.path,
			allTags: normalizedTags(file.allTags),
			frontmatterTags: normalizedTags(file.frontmatterTags),
		};
		const previous = this.files.get(file.path);
		if (
			previous &&
			sameStrings(previous.allTags, next.allTags) &&
			sameStrings(previous.frontmatterTags, next.frontmatterTags)
		) {
			return false;
		}
		this.files.set(file.path, next);
		return true;
	}

	removeFile(path: string): boolean {
		return this.files.delete(path);
	}

	renameFile(oldPath: string, file: TagInventoryFile): boolean {
		const removed = this.files.delete(oldPath);
		return this.upsertFile(file) || removed;
	}

	snapshot(): TagInventorySnapshot {
		const keyRows = this.schema.slots.flatMap((slot, slotIndex) =>
			slot.role === "tag" && slot.namespace
				? [
						{
							slotIndex,
							namespace: slot.namespace,
							fullNamespace: nsPath(this.schema, slot.namespace),
							notePaths: new Set<string>(),
							occurrences: 0,
							pathCounts: new Map<string, number>(),
							duplicateNotes: 0,
							inlineOnlyNotes: 0,
							namespaceNodeNotes: 0,
						},
					]
				: []
		);
		const rowBySlot = new Map(keyRows.map((row) => [row.slotIndex, row]));
		const managedNotePaths = new Set<string>();
		const managedPaths = new Set<string>();
		const generalTags = new Set<string>();
		let managedOccurrences = 0;
		let generalOccurrences = 0;
		let rootOwnedUnmatchedOccurrences = 0;
		const ownerRoot = (this.schema.rootNamespace ?? "").trim();

		for (const file of this.files.values()) {
			const frontmatter = new Set(file.frontmatterTags);
			const valuesBySlot = new Map<number, Set<string>>();
			const inlineSlots = new Set<number>();
			const namespaceNodeSlots = new Set<number>();

			for (const tag of file.allTags) {
				const match = matchTagKey(tag, this.schema);
				if (!match) {
					const tagPath = tag.replace(/^#/, "");
					if (
						ownerRoot &&
						(tagPath === ownerRoot || tagPath.startsWith(`${ownerRoot}/`))
					) {
						rootOwnedUnmatchedOccurrences++;
					} else {
						generalOccurrences++;
						generalTags.add(tag);
					}
					continue;
				}

				const row = rowBySlot.get(match.slotIndex);
				if (!row) continue;
				row.fullNamespace = match.fullNamespace;
				if (match.keyPath === "") {
					namespaceNodeSlots.add(match.slotIndex);
					continue;
				}
				const values = valuesBySlot.get(match.slotIndex) ?? new Set<string>();
				values.add(match.tagPath);
				valuesBySlot.set(match.slotIndex, values);
				if (!frontmatter.has(tag)) inlineSlots.add(match.slotIndex);
			}

			for (const [slotIndex, values] of valuesBySlot) {
				const row = rowBySlot.get(slotIndex);
				if (!row) continue;
				managedNotePaths.add(file.path);
				row.notePaths.add(file.path);
				row.occurrences += values.size;
				managedOccurrences += values.size;
				if (values.size > 1) row.duplicateNotes++;
				if (inlineSlots.has(slotIndex)) row.inlineOnlyNotes++;
				for (const tagPath of values) {
					managedPaths.add(tagPath);
					row.pathCounts.set(tagPath, (row.pathCounts.get(tagPath) ?? 0) + 1);
				}
			}
			for (const slotIndex of namespaceNodeSlots) {
				const row = rowBySlot.get(slotIndex);
				if (row) row.namespaceNodeNotes++;
			}
		}

		return {
			totalNotes: this.files.size,
			managedNotes: managedNotePaths.size,
			managedOccurrences,
			uniqueManagedPaths: managedPaths.size,
			generalOccurrences,
			uniqueGeneralTags: generalTags.size,
			rootOwnedUnmatchedOccurrences,
			tagKeys: keyRows.map((row) => ({
				slotIndex: row.slotIndex,
				namespace: row.namespace,
				fullNamespace: row.fullNamespace,
				notes: row.notePaths.size,
				occurrences: row.occurrences,
				uniquePaths: row.pathCounts.size,
				duplicateNotes: row.duplicateNotes,
				inlineOnlyNotes: row.inlineOnlyNotes,
				namespaceNodeNotes: row.namespaceNodeNotes,
				paths: [...row.pathCounts.entries()]
					.map(([tagPath, count]) => ({ tagPath, count }))
					.sort((a, b) => b.count - a.count || a.tagPath.localeCompare(b.tagPath)),
			})),
		};
	}
}
