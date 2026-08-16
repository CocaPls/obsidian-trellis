import { test } from "node:test";
import assert from "node:assert/strict";
import {
	TrellisOperationTracker,
	interruptedReport,
	type TrellisOperationReport,
} from "../src/operation-state.ts";

test("only one write operation can own the tracker", () => {
	const tracker = new TrellisOperationTracker();
	const first = tracker.begin("bulk", "Move tags", 3, 100);
	assert.ok(first);
	assert.equal(tracker.begin("automation", "AI apply", 1, 101), null);
	assert.equal(tracker.current()?.id, first.id);
});

test("progress and completion produce a stable report", () => {
	const tracker = new TrellisOperationTracker();
	const operation = tracker.begin("bulk", "Move tags", 3, 100);
	assert.ok(operation);
	tracker.progress(operation.id, { processed: 1, currentPath: "A.md" });
	tracker.progress(operation.id, {
		processed: 2,
		currentPath: "B.md",
		issue: { path: "B.md", message: "collision" },
	});
	const report = tracker.finish(
		operation.id,
		{ status: "partial-failed", processed: 2 },
		200
	);
	assert.deepEqual(report, {
		id: operation.id,
		kind: "bulk",
		label: "Move tags",
		status: "partial-failed",
		startedAt: 100,
		finishedAt: 200,
		total: 3,
		processed: 2,
		currentPath: undefined,
		issues: [{ path: "B.md", message: "collision" }],
	});
	assert.equal(tracker.isIdle(), true);
});

test("a persisted running operation becomes an explicit interruption", () => {
	const running: TrellisOperationReport = {
		id: "op-1",
		kind: "bulk",
		label: "Move tags",
		status: "running",
		startedAt: 100,
		total: 10,
		processed: 4,
		currentPath: "E.md",
		issues: [],
	};
	const interrupted = interruptedReport(running, 200);
	assert.equal(interrupted.status, "interrupted");
	assert.equal(interrupted.finishedAt, 200);
	assert.equal(interrupted.issues[0]?.path, "E.md");
	assert.match(interrupted.issues[0]?.message ?? "", /before.*completion/i);
});
