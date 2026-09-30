import {
	normalizeTagList,
	sameTagPath,
	tagPathInNamespace,
} from "./tagkey.ts";

export interface TagListChange {
	tags: string[];
	changed: boolean;
}

export interface DuplicateTagResolution extends TagListChange {
	removed: string[];
}

/** Normalize frontmatter tags and add one value only when its Obsidian tag
 * identity is not already present. The existing display casing wins. */
export function addFrontmatterTag(raw: unknown, tag: string): TagListChange {
	const tags = normalizeTagList(raw);
	if (tags.some((candidate) => sameTagPath(candidate, tag))) {
		return { tags, changed: false };
	}
	return { tags: [...tags, tag], changed: true };
}

/** Add restored values without creating case-only duplicates. */
export function restoreFrontmatterTags(
	raw: unknown,
	restored: string[]
): TagListChange {
	const tags = normalizeTagList(raw);
	let changed = false;
	for (const tag of restored) {
		if (tags.some((candidate) => sameTagPath(candidate, tag))) continue;
		tags.push(tag);
		changed = true;
	}
	return { tags, changed };
}

/** Remove one Obsidian tag identity regardless of stored display casing. */
export function removeFrontmatterTag(raw: unknown, removed: string): TagListChange {
	const tags = normalizeTagList(raw);
	const next = tags.filter((tag) => !sameTagPath(tag, removed));
	return { tags: next, changed: next.length !== tags.length };
}

/** Apply reviewed duplicate choices while preserving unrelated tags. Namespace
 * and keep-value comparisons follow Obsidian's case-insensitive tag identity. */
export function resolveDuplicateFrontmatterTags(
	raw: unknown,
	keepByNamespace: Record<string, string>
): DuplicateTagResolution {
	const tags = normalizeTagList(raw);
	const choices = Object.entries(keepByNamespace);
	const removed: string[] = [];
	const next = tags.filter((tag) => {
		const choice = choices.find(([namespace]) =>
			tagPathInNamespace(tag, namespace)
		);
		if (!choice || sameTagPath(tag, choice[1])) return true;
		removed.push(tag);
		return false;
	});
	return { tags: next, removed, changed: removed.length > 0 };
}

export function hashedFrontmatterTags(raw: unknown): string[] {
	return normalizeTagList(raw).map((tag) =>
		tag.startsWith("#") ? tag : `#${tag}`
	);
}
