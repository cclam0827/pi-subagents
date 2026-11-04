import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../src/run-store.ts";
import type { AgentRecord, Limits } from "../src/types.ts";

const limits: Limits = { maxDepth: 2, maxChildrenPerAgent: 1, maxAgentsPerRun: 2, maxConcurrent: 1 };

function record(id: string, parentId: string | null, depth: number, overrides: Partial<AgentRecord> = {}) {
	return {
		id,
		parentId,
		depth,
		role: "implement",
		task: "test",
		model: "provider/model",
		level: "balanced" as const,
		thinking: "medium" as const,
		tools: ["read"],
		instructions: "test",
		extensions: [],
		cwd: "/repo",
		workspace: "shared" as const,
		writer: false,
		...overrides,
	};
}

async function fixture(t: test.TestContext, customLimits = limits) {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-store-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return RunStore.create(join(directory, "run.json"), "root-session", customLimits);
}

test("enforces depth, child count, and run-wide concurrency", async (t) => {
	const store = await fixture(t);
	await store.reserve(record("parent", null, 1));
	assert.equal(await store.tryStart("parent"), true);
	await store.reserve(record("child", "parent", 2));
	assert.equal(await store.tryStart("child"), false);
	await assert.rejects(store.reserve(record("grandchild", "child", 3)), /Maximum subagent depth/);
	await store.markStopped("parent", "done");
	assert.equal(await store.tryStart("child"), true);
});

test("rejects a second writer in one checkout but permits a worktree writer", async (t) => {
	const store = await fixture(t, { ...limits, maxAgentsPerRun: 3, maxChildrenPerAgent: 3 });
	await store.reserve(record("writer-a", null, 1, { writer: true, repoRoot: "/repo" }));
	await assert.rejects(
		store.reserve(record("writer-b", null, 1, { writer: true, repoRoot: "/repo", cwd: "/repo/subdir" })),
		/Writer checkout conflict/,
	);
	await store.reserve(record("writer-c", null, 1, { writer: true, repoRoot: "/repo", cwd: "/worktrees/c", workspace: "worktree" }));
});

test("stopSubtree includes every descendant and ignores completed agents", async (t) => {
	const store = await fixture(t, { ...limits, maxAgentsPerRun: 4, maxChildrenPerAgent: 3 });
	await store.reserve(record("parent", null, 1));
	await store.reserve(record("child", "parent", 2, { status: "running" }));
	await store.reserve(record("sibling", null, 1, { status: "done" }));
	const ids = await store.stopSubtree("parent");
	assert.deepEqual(ids.sort(), ["child", "parent"]);
	assert.equal(store.current.agents.parent.status, "stopping");
	assert.equal(store.current.agents.child.status, "stopping");
	assert.equal(store.current.agents.sibling.status, "done");
});

test("routes commands only once to their direct process owner", async (t) => {
	const store = await fixture(t);
	await store.reserve(record("parent", null, 1));
	await store.enqueue("parent", "message", "change direction");
	assert.deepEqual(await store.takeCommands(new Set(["other"])), []);
	const commands = await store.takeCommands(new Set(["parent"]));
	assert.equal(commands.length, 1);
	assert.equal(commands[0].message, "change direction");
	assert.deepEqual(await store.takeCommands(new Set(["parent"])), []);
});

test("retention transitions block new work and revalidate terminal state before commit", async (t) => {
	const store = await fixture(t, { ...limits, maxAgentsPerRun: 3, maxChildrenPerAgent: 3 });
	await store.reserve(record("parent", null, 1, { status: "done" }));
	await store.reserve(record("child", "parent", 2, { status: "done" }));
	const pending = await store.beginRetention("parent", "archived");
	assert.deepEqual(pending.map((agent) => agent.id), ["parent", "child"]);
	assert.ok(pending.every((agent) => agent.retentionPending === "archived"));
	await assert.rejects(store.reserve(record("new-child", "parent", 2, { status: "done" })), /retention transition/);

	await assert.rejects(store.patch("child", { status: "running" }), /retention transition/);
	await store.update((state) => {
		state.agents.child.status = "running";
	});
	await assert.rejects(store.setRetention(["parent", "child"], "archived"), /still active/);
	assert.equal(store.current.agents.parent.retentionPending, "archived");
	await store.clearRetentionPending(["parent", "child"]);
	assert.equal(store.current.agents.parent.retentionPending, undefined);
	await assert.rejects(store.beginRetention("parent", "archived"), /still active/);
});

test("concurrent reservations cannot exceed the shared run agent budget", async (t) => {
	const store = await fixture(t);
	await Promise.allSettled([
		store.reserve(record("a", null, 1)),
		store.reserve(record("b", null, 1)),
		store.reserve(record("c", null, 1)),
	]);
	assert.equal(Object.keys(store.current.agents).length, 2);
});
