import type { TrellisSchema } from "./tagkey.ts";
import {
	assembleBasenameMulti,
	extractNameMulti,
	matchTagKey,
	nsPath,
	schemaTagDefinitions,
	slotTagkeys,
} from "./tagkey.ts";

export interface TagInventoryFile {
	path: string;
	/** Cache-visible explicit tags, including frontmatter and inline tags. */
	allTags: string[];
	/** Frontmatter tags only. */
	frontmatterTags: string[];
}

export interface TagKeyInventory {
	tagDefinitionId: string;
	displayName: string;
	/** Filename slot index, or -1 when this definition is sidebar-only. */
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
	combinations: {
		definitionIds: string[];
		slotIndexes: number[];
		namespaces: string[];
		notes: number;
	}[];
	filenameCollisions: {
		targetPath: string;
		notePaths: string[];
	}[];
	filenameDrift: {
		path: string;
		targetPath: string;
	}[];
}

function basenameOf(path: string): string {
	const filename = path.split("/").pop() ?? path;
	return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function notePath(parent: string, basename: string): string {
	return `${parent ? `${parent}/` : ""}${basename}.md`;
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

interface MutableDefinitionRow {
	tagDefinitionId: string;
	displayName: string;
	slotIndex: number;
	namespace: string;
	fullNamespace: string;
	notePaths: Set<string>;
	occurrences: number;
	pathCounts: Map<string, number>;
	duplicateNotes: number;
	inlineOnlyNotes: number;
	namespaceNodeNotes: number;
}

/**
 * Settings-lifetime inventory. Registered tag definitions are counted even
 * when no filename slot references them. Frontmatter is the management source;
 * inline matches are reported separately and never drive filename targets.
 */
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
		const rows: MutableDefinitionRow[] = schemaTagDefinitions(this.schema).map(
			(definition) => ({
				tagDefinitionId: definition.id,
				displayName: definition.name || definition.namespace,
				slotIndex: this.schema.slots.findIndex(
					(slot) =>
						slot.role === "tag" &&
						(slot.tagDefinitionId === definition.id ||
							(!slot.tagDefinitionId && slot.namespace === definition.namespace))
				),
				namespace: definition.namespace,
				fullNamespace: nsPath(this.schema, definition.namespace),
				notePaths: new Set<string>(),
				occurrences: 0,
				pathCounts: new Map<string, number>(),
				duplicateNotes: 0,
				inlineOnlyNotes: 0,
				namespaceNodeNotes: 0,
			})
		);
		const rowByDefinition = new Map(rows.map((row) => [row.tagDefinitionId, row]));
		const managedNotePaths = new Set<string>();
		const managedPaths = new Set<string>();
		const generalTags = new Set<string>();
		let managedOccurrences = 0;
		let generalOccurrences = 0;
		let rootOwnedUnmatchedOccurrences = 0;
		const ownerRoot = (this.schema.rootNamespace ?? "").trim();
		const combinationCounts = new Map<string, number>();
		const combinationDefinitions = new Map<string, string[]>();
		const targetSources = new Map<string, Set<string>>();
		const filenameDrift: { path: string; targetPath: string }[] = [];

		for (const file of this.files.values()) {
			const frontmatter = new Set(file.frontmatterTags);
			const inlineDefinitions = new Set<string>();

			for (const tag of file.allTags) {
				const match = matchTagKey(tag, this.schema);
				if (match) {
					if (!frontmatter.has(tag) && match.tagDefinitionId) {
						inlineDefinitions.add(match.tagDefinitionId);
					}
					continue;
				}
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
			}

			const valuesByDefinition = new Map<string, Set<string>>();
			const namespaceNodes = new Set<string>();
			for (const tag of file.frontmatterTags) {
				const match = matchTagKey(tag, this.schema);
				if (!match?.tagDefinitionId) continue;
				if (match.keyPath === "") {
					namespaceNodes.add(match.tagDefinitionId);
					continue;
				}
				const values = valuesByDefinition.get(match.tagDefinitionId) ?? new Set<string>();
				values.add(match.tagPath);
				valuesByDefinition.set(match.tagDefinitionId, values);
			}

			let ambiguous = false;
			for (const [definitionId, values] of valuesByDefinition) {
				const row = rowByDefinition.get(definitionId);
				if (!row) continue;
				managedNotePaths.add(file.path);
				row.notePaths.add(file.path);
				row.occurrences += values.size;
				managedOccurrences += values.size;
				if (values.size > 1) {
					row.duplicateNotes++;
					ambiguous = true;
				}
				for (const tagPath of values) {
					managedPaths.add(tagPath);
					row.pathCounts.set(tagPath, (row.pathCounts.get(tagPath) ?? 0) + 1);
				}
			}
			for (const definitionId of inlineDefinitions) {
				if (!valuesByDefinition.has(definitionId)) {
					const row = rowByDefinition.get(definitionId);
					if (row) row.inlineOnlyNotes++;
				}
			}
			for (const definitionId of namespaceNodes) {
				const row = rowByDefinition.get(definitionId);
				if (row) row.namespaceNodeNotes++;
			}

			const activeDefinitions = [...valuesByDefinition.keys()].sort();
			if (activeDefinitions.length > 0) {
				const combinationKey = activeDefinitions.join(",");
				combinationCounts.set(
					combinationKey,
					(combinationCounts.get(combinationKey) ?? 0) + 1
				);
				combinationDefinitions.set(combinationKey, activeDefinitions);
			}

			if (!ambiguous) {
				const keys = slotTagkeys(file.frontmatterTags, this.schema);
				const hasFilenameValue = this.schema.slots.some(
					(slot, index) => slot.role === "tag" && keys[index]
				);
				if (hasFilenameValue) {
					const name = extractNameMulti(basenameOf(file.path), keys, this.schema);
					const values = this.schema.slots.map((slot, index) =>
						slot.role === "name" ? name : keys[index]
					);
					const targetBasename = assembleBasenameMulti(values, this.schema);
					if (targetBasename) {
						const targetPath = notePath(parentOf(file.path), targetBasename);
						const sources = targetSources.get(targetPath) ?? new Set<string>();
						sources.add(file.path);
						targetSources.set(targetPath, sources);
						if (targetPath !== file.path) filenameDrift.push({ path: file.path, targetPath });
					}
				}
			}
		}

		for (const [targetPath, sources] of targetSources) {
			if (this.files.has(targetPath)) sources.add(targetPath);
		}

		return {
			totalNotes: this.files.size,
			managedNotes: managedNotePaths.size,
			managedOccurrences,
			uniqueManagedPaths: managedPaths.size,
			generalOccurrences,
			uniqueGeneralTags: generalTags.size,
			rootOwnedUnmatchedOccurrences,
			combinations: [...combinationCounts.entries()]
				.map(([key, notes]) => {
					const definitionIds = combinationDefinitions.get(key) ?? [];
					return {
						definitionIds,
						slotIndexes: definitionIds.map(
							(id) => rowByDefinition.get(id)?.slotIndex ?? -1
						),
						namespaces: definitionIds.map(
							(id) => rowByDefinition.get(id)?.namespace ?? ""
						),
						notes,
					};
				})
				.sort(
					(a, b) =>
						b.notes - a.notes ||
						a.definitionIds.join(",").localeCompare(b.definitionIds.join(","))
				),
			filenameCollisions: [...targetSources.entries()]
				.filter(([, paths]) => paths.size > 1)
				.map(([targetPath, paths]) => ({
					targetPath,
					notePaths: [...paths].sort(),
				}))
				.sort((a, b) => a.targetPath.localeCompare(b.targetPath)),
			filenameDrift: filenameDrift.sort((a, b) => a.path.localeCompare(b.path)),
			tagKeys: rows.map((row) => ({
				tagDefinitionId: row.tagDefinitionId,
				displayName: row.displayName,
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
