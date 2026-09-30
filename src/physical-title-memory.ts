import {
	projectFilename,
	projectFilenameFromKnownTitle,
} from "./filename-projection.ts";
import { physicalSlotTagkeys, type TrellisSchema } from "./tagkey.ts";

export interface PhysicalTitleFile {
	path: string;
	basename: string;
	frontmatterTags: string[];
}

/** Minimal runtime memory needed to remove the final physical tag slot without
 * losing the filename's free title. It is intentionally separate from the
 * optional full-vault projection index used by the inspector. */
export class PhysicalTitleMemory {
	private readonly titles = new Map<string, string>();
	private schemaFingerprint = "";

	get(path: string): string | undefined {
		return this.titles.get(path);
	}

	set(path: string, title: string): void {
		this.titles.set(path, title);
	}

	delete(path: string): void {
		this.titles.delete(path);
	}

	remember(file: PhysicalTitleFile, schema: TrellisSchema): void {
		if (!physicalSlotTagkeys(file.frontmatterTags, schema).some(Boolean)) return;
		const rememberedTitle = this.titles.get(file.path);
		const projection = rememberedTitle !== undefined
			? projectFilenameFromKnownTitle(
					file.basename,
					rememberedTitle,
					file.frontmatterTags,
					schema
				)
			: projectFilename(file.basename, file.frontmatterTags, schema);
		this.titles.set(file.path, projection.title);
	}

	refresh(files: Iterable<PhysicalTitleFile>, schema: TrellisSchema): void {
		this.titles.clear();
		for (const file of files) this.remember(file, schema);
		this.schemaFingerprint = JSON.stringify(schema);
	}

	syncSchema(files: Iterable<PhysicalTitleFile>, schema: TrellisSchema): void {
		const fingerprint = JSON.stringify(schema);
		if (fingerprint === this.schemaFingerprint) return;
		this.refresh(files, schema);
	}
}
