export type TrellisOperationKind = "live-sync" | "automation" | "bulk";

export type TrellisOperationStatus =
	| "running"
	| "completed"
	| "partial-failed"
	| "failed"
	| "cancelled"
	| "rolled-back"
	| "interrupted";

export interface TrellisOperationIssue {
	path?: string;
	message: string;
}

/** Small, serializable operation record. It deliberately tracks writes rather
 * than UI details so live sync, automation and bulk commands can share it. */
export interface TrellisOperationReport {
	id: string;
	kind: TrellisOperationKind;
	label: string;
	status: TrellisOperationStatus;
	startedAt: number;
	finishedAt?: number;
	total: number;
	processed: number;
	currentPath?: string;
	issues: TrellisOperationIssue[];
}

export interface OperationProgress {
	processed?: number;
	currentPath?: string;
	issue?: TrellisOperationIssue;
}

export interface OperationFinish {
	status: Exclude<TrellisOperationStatus, "running">;
	processed?: number;
	issues?: TrellisOperationIssue[];
}

function cloneReport(report: TrellisOperationReport): TrellisOperationReport {
	return {
		...report,
		issues: report.issues.map((issue) => ({ ...issue })),
	};
}

export function interruptedReport(
	report: TrellisOperationReport,
	finishedAt = Date.now()
): TrellisOperationReport {
	if (report.status !== "running") return cloneReport(report);
	return {
		...cloneReport(report),
		status: "interrupted",
		finishedAt,
		currentPath: undefined,
		issues: [
			...report.issues,
			{
				path: report.currentPath,
				message: "Trellis stopped before this operation reported completion.",
			},
		],
	};
}

/** One global write owner plus an awaitable completion report. This replaces
 * separate bulk/automation booleans without owning persistence or UI. */
export class TrellisOperationTracker {
	private active: TrellisOperationReport | null = null;
	private last: TrellisOperationReport | null = null;
	private sequence = 0;

	begin(
		kind: TrellisOperationKind,
		label: string,
		total: number,
		startedAt = Date.now()
	): TrellisOperationReport | null {
		if (this.active) return null;
		const report: TrellisOperationReport = {
			id: `${startedAt.toString(36)}-${(++this.sequence).toString(36)}`,
			kind,
			label,
			status: "running",
			startedAt,
			total: Math.max(0, total),
			processed: 0,
			issues: [],
		};
		this.active = report;
		return cloneReport(report);
	}

	progress(id: string, progress: OperationProgress): TrellisOperationReport | null {
		if (!this.active || this.active.id !== id) return null;
		if (progress.processed !== undefined) {
			this.active.processed = Math.max(
				this.active.processed,
				Math.min(this.active.total, progress.processed)
			);
		}
		if (progress.currentPath !== undefined) {
			this.active.currentPath = progress.currentPath;
		}
		if (progress.issue) this.active.issues.push({ ...progress.issue });
		return cloneReport(this.active);
	}

	finish(
		id: string,
		finish: OperationFinish,
		finishedAt = Date.now()
	): TrellisOperationReport | null {
		if (!this.active || this.active.id !== id) return null;
		if (finish.processed !== undefined) {
			this.active.processed = Math.max(
				this.active.processed,
				Math.min(this.active.total, finish.processed)
			);
		}
		if (finish.issues) {
			this.active.issues.push(...finish.issues.map((issue) => ({ ...issue })));
		}
		this.active.status = finish.status;
		this.active.finishedAt = finishedAt;
		this.active.currentPath = undefined;
		const report = cloneReport(this.active);
		this.last = report;
		this.active = null;
		return cloneReport(report);
	}

	current(): TrellisOperationReport | null {
		return this.active ? cloneReport(this.active) : null;
	}

	lastReport(): TrellisOperationReport | null {
		return this.last ? cloneReport(this.last) : null;
	}

	isIdle(): boolean {
		return this.active === null;
	}

}
