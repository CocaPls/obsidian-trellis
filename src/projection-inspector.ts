import { App, Modal } from "obsidian";
import { t } from "./i18n";
import type {
	ProjectionIndexRecord,
	ProjectionIndexSummary,
} from "./projection-index";

const ROW_LIMIT = 100;

function statusLabel(record: ProjectionIndexRecord): string {
	return t(`projection.status.${record.projection.status}`);
}

function sourceLabel(record: ProjectionIndexRecord): string {
	const parts = [
		`${t("projection.freeTitle")}: ${record.projection.title || t("projection.none")}`,
	];
	for (const slot of record.projection.slots) {
		if (slot.kind !== "metadata" || !slot.metadataValue) continue;
		parts.push(
			t("projection.sourceSlot", {
				n: slot.index + 1,
				value: slot.metadataValue,
			})
		);
	}
	return parts.join("\n");
}

function issueLabel(record: ProjectionIndexRecord): string {
	const labels = record.projection.issues.map((issue) => {
		if (issue.code === "duplicate-metadata") {
			return t("projection.issue.duplicate", {
				slots: issue.slotIndexes.map((index) => index + 1).join(", "),
			});
		}
		if (issue.code === "reverse-mode-not-ready") {
			return t("projection.issue.reverse");
		}
		return t("projection.issue.unsafe", { reason: issue.issue });
	});
	return labels.join("\n") || t("projection.none");
}

function statusIssueLabel(record: ProjectionIndexRecord): string {
	const issue = issueLabel(record);
	return issue === t("projection.none")
		? statusLabel(record)
		: `${statusLabel(record)}\n${issue}`;
}

/** Read-only vault overview. Opening it may populate the lazy projection index,
 * but it never changes metadata or filenames. */
export class ProjectionInspectorModal extends Modal {
	constructor(
		app: App,
		private readonly summary: ProjectionIndexSummary,
		private readonly records: ProjectionIndexRecord[]
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("trellis-projection-dialog");
		contentEl.addClass("trellis-projection-modal");
		contentEl.createEl("h3", { text: t("projection.title") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("projection.desc"),
		});

		const summary = contentEl.createDiv({ cls: "trellis-projection-summary" });
		const items: [string, number][] = [
			[t("projection.total"), this.summary.totalNotes],
			[t("projection.titleOnly"), this.summary.titleOnly],
			[t("projection.consistent"), this.summary.consistent],
			[t("projection.drift"), this.summary.drift],
			[t("projection.blocked"), this.summary.blocked],
			[t("projection.virtual"), this.summary.virtualNames],
		];
		for (const [label, value] of items) {
			const item = summary.createSpan();
			item.createSpan({ cls: "trellis-projection-count", text: String(value) });
			item.appendText(` ${label}`);
		}

		const attention = this.records
			.filter(
				({ projection }) =>
					projection.status === "drift" ||
					projection.status === "blocked" ||
					projection.virtualBasename !== projection.actualBasename
			)
			.sort((left, right) => left.file.path.localeCompare(right.file.path));
		contentEl.createEl("h4", {
			text: t("projection.attention", { n: attention.length }),
		});
		if (attention.length === 0) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: t("projection.attentionEmpty"),
			});
			return;
		}

		const wrap = contentEl.createDiv({ cls: "trellis-projection-table-wrap" });
		const table = wrap.createEl("table", { cls: "trellis-projection-table" });
		const header = table.createEl("thead").createEl("tr");
		for (const label of [
			t("projection.note"),
			t("projection.physical"),
			t("projection.virtualName"),
			t("projection.sources"),
			t("projection.issue"),
		]) header.createEl("th", { text: label });
		const body = table.createEl("tbody");
		for (const record of attention.slice(0, ROW_LIMIT)) {
			const row = body.createEl("tr");
			const noteCell = row.createEl("td");
			noteCell.createDiv({ text: record.file.basename });
			noteCell.createDiv({
				cls: "trellis-projection-path",
				text: record.file.path,
			});
			row.createEl("td", {
				text: record.projection.physicalBasename ?? t("projection.unavailable"),
			});
			row.createEl("td", { text: record.projection.virtualBasename });
			row.createEl("td", {
				cls: "trellis-projection-multiline",
				text: sourceLabel(record),
			});
			row.createEl("td", {
				cls: "trellis-projection-multiline",
				text: statusIssueLabel(record),
			});
		}
		if (attention.length > ROW_LIMIT) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: t("projection.more", { n: attention.length - ROW_LIMIT }),
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
