import assert from "node:assert/strict";
import test from "node:test";
import { finalAssistantText, formatAgentReport, parseAgentReport } from "../src/report.ts";
import { agentsForView, formatAgentTree, subtreeIds } from "../src/policy.ts";
import { needsWorktree } from "../src/workspace.ts";
import type { AgentRecord } from "../src/types.ts";

const text = `Summary: Implemented the feature.\n\nFindings:\n- Used the existing API\n- Added coverage\n\nFiles changed:\n- src/feature.ts\n\nTests:\n- npm test (passed)\n\nRisks:\n- None`;

test("parses bounded structured reports and preserves no-output diagnostics", () => {
	const report = parseAgentReport(text);
	assert.equal(report.summary, "Implemented the feature.");
	assert.deepEqual(report.filesChanged, ["src/feature.ts"]);
	assert.deepEqual(report.tests, ["npm test (passed)"]);
	assert.match(formatAgentReport(report), /Used the existing API/);
	assert.equal(parseAgentReport("").summary, "(no output)");
});

test("extracts only the final assistant text", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "old" }] },
		{ role: "user", content: "next" },
		{ role: "assistant", content: [{ type: "text", text: "final" }] },
	];
	assert.equal(finalAssistantText(messages as never), "final");
});

function agent(id: string, parentId: string | null, depth: number): AgentRecord {
	return {
		id, runId: "run", parentId, depth, role: "implement", task: "task", model: "p/m", level: "balanced",
		thinking: "medium", tools: [], instructions: "", extensions: [], cwd: "/repo/subdir", workspace: "shared",
		writer: true, repoRoot: "/repo", status: "running", attempt: 1, createdAt: "", updatedAt: "", lastActivity: "working",
	};
}

test("separates reusable agents from history without deleting archived records", () => {
	const running = { ...agent("running", null, 1), retention: "released" as const };
	const reusable = { ...agent("reusable", "archived", 2), status: "done" as const, retention: "reusable" as const };
	const released = { ...agent("released", null, 1), status: "done" as const, retention: "released" as const };
	const stopped = { ...agent("stopped", null, 1), status: "stopped" as const, retention: "reusable" as const };
	const archived = { ...agent("archived", null, 1), status: "done" as const, retention: "archived" as const };
	const agents = [running, reusable, released, stopped, archived];

	assert.deepEqual(agentsForView(agents, "panel").map((entry) => entry.id), ["running", "reusable"]);
	assert.deepEqual(agentsForView(agents, "list").map((entry) => entry.id), ["running", "reusable", "released", "stopped"]);
	assert.equal(agentsForView(agents, "all").length, 5);
	assert.match(formatAgentTree(agentsForView(agents, "list")), /reusable/);
	assert.match(formatAgentTree(agentsForView(agents, "all")), /archived.*\[archived\]/);
});

test("computes subtrees and detects writer collisions across directories in one checkout", () => {
	const parent = agent("parent", null, 1);
	const child = agent("child", "parent", 2);
	assert.deepEqual(subtreeIds({ agents: { parent, child } }, "parent"), ["parent", "child"]);
	assert.match(formatAgentTree([parent, child]), /parent.*\n  child/);
	const role = { isolation: "auto" } as never;
	assert.equal(needsWorktree(role, "/repo/other", [parent], "/repo"), true);
	assert.equal(needsWorktree(role, "/another", [parent], "/another"), false);
});
