import {
	projectFilename,
	projectFilenameFromKnownTitle,
	type FilenameProjection,
	type FilenameProjectionIssue,
} from "./filename-projection.ts";
import {
	normalizeSchemaModel,
	normalizeTagList,
	type TrellisSchema,
} from "./tagkey.ts";

export interface ProjectionIndexFile {
	path: string;
	basename: string;
	frontmatterTags: string[];
}

export interface ProjectionIndexRecord {
	file: ProjectionIndexFile;
	projection: FilenameProjection;
}

export interface ProjectionIndexSummary {
	totalNotes: number;
	titleOnly: number;
	consistent: number;
	drift: number;
	blocked: number;
	virtualNames: number;
	issueCounts: Record<FilenameProjectionIssue["code"], number>;
}

function sameStringArray(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeFile(file: ProjectionIndexFile): ProjectionIndexFile {
	return {
		path: file.path,
		basename: file.basename,
		frontmatterTags: normalizeTagList(file.frontmatterTags),
	};
}

/** A read-only, incremental cache of filename projections. The Obsidian
 * adapter decides when to populate it; this class performs no vault I/O. */
export class ProjectionIndex {
	private readonly records = new Map<string, ProjectionIndexRecord>();
	private schema: TrellisSchema;

	constructor(schema: TrellisSchema) {
		this.schema = normalizeSchemaModel(schema);
	}

	get size(): number {
		return this.records.size;
	}

	get(path: string): ProjectionIndexRecord | undefined {
		return this.records.get(path);
	}

	values(): ProjectionIndexRecord[] {
		return [...this.records.values()];
	}

	upsert(file: ProjectionIndexFile): boolean {
		const normalized = normalizeFile(file);
		const previous = this.records.get(normalized.path);
		if (
			previous &&
			previous.file.basename === normalized.basename &&
			sameStringArray(previous.file.frontmatterTags, normalized.frontmatterTags)
		) {
			return false;
		}

		const projection = previous && previous.file.basename === normalized.basename
			? projectFilenameFromKnownTitle(
				normalized.basename,
				previous.projection.title,
				normalized.frontmatterTags,
				this.schema
			)
			: projectFilename(
				normalized.basename,
				normalized.frontmatterTags,
				this.schema
			);
		this.records.set(normalized.path, { file: normalized, projection });
		return true;
	}

	remove(path: string): boolean {
		return this.records.delete(path);
	}

	rename(
		oldPath: string,
		file: Omit<ProjectionIndexFile, "frontmatterTags"> & { frontmatterTags?: string[] }
	): void {
		const previous = this.records.get(oldPath);
		this.records.delete(oldPath);
		// Obsidian can emit rename before metadata is available at the new path.
		// Unknown metadata must not erase indexed tags; a known empty list must.
		const normalized = normalizeFile({
			...file,
			frontmatterTags: file.frontmatterTags ?? previous?.file.frontmatterTags ?? [],
		});
		const projection = previous && previous.file.basename === normalized.basename
			? projectFilenameFromKnownTitle(
				normalized.basename,
				previous.projection.title,
				normalized.frontmatterTags,
				this.schema
			)
			: projectFilename(
				normalized.basename,
				normalized.frontmatterTags,
				this.schema
			);
		this.records.set(normalized.path, { file: normalized, projection });
	}

	replaceSchema(schema: TrellisSchema): void {
		this.schema = normalizeSchemaModel(schema);
		for (const [path, record] of this.records) {
			this.records.set(path, {
				file: record.file,
				projection: projectFilename(
					record.file.basename,
					record.file.frontmatterTags,
					this.schema
				),
			});
		}
	}

	summary(): ProjectionIndexSummary {
		const summary: ProjectionIndexSummary = {
			totalNotes: this.records.size,
			titleOnly: 0,
			consistent: 0,
			drift: 0,
			blocked: 0,
			virtualNames: 0,
			issueCounts: {
				"duplicate-metadata": 0,
				"reverse-mode-not-ready": 0,
				"unsafe-filename": 0,
			},
		};
		for (const { projection } of this.records.values()) {
			if (projection.status === "title-only") summary.titleOnly += 1;
			else summary[projection.status] += 1;
			if (projection.virtualBasename !== projection.actualBasename) {
				summary.virtualNames += 1;
			}
			for (const issue of projection.issues) summary.issueCounts[issue.code] += 1;
		}
		return summary;
	}
}
