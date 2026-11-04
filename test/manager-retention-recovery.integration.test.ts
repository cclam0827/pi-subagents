import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENV } from "../src/constants.ts";
import { SubagentManager } from "../src/manager.ts";
import { RunStore } from "../src/run-store.ts";

test("root initialization recovers orphaned retention transitions", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-retention-recovery-"));
	const environmentKeys = [...Object.values(ENV), "PI_CODING_AGENT_DIR"];
	const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
	for (const key of Object.values(ENV)) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const runFile = join(root, "agent", "pi-subagents", "state", "recovery-e2e.json");
	const store = await RunStore.create(runFile, "recovery-e2e", {
		maxDepth: 2,
		maxChildrenPerAgent: 3,
		maxAgentsPerRun: 8,
		maxConcurrent: 4,
	});
	await store.reserve({
		id: "orphaned-agent",
		parentId: null,
		depth: 1,
		role: "explore",
		task: "Interrupted archive",
		model: "fake/static",
		level: "balanced",
		thinking: "medium",
		tools: ["read"],
		instructions: "test",
		extensions: [],
		cwd: root,
		workspace: "shared",
		writer: false,
		status: "done",
	});
	await store.beginRetention("orphaned-agent", "archived");
	await store.enqueue("orphaned-agent", "retention", undefined, "archived");

	const manager = new SubagentManager({ sendMessage: () => undefined } as unknown as ExtensionAPI);
	const fakeModel = { provider: "fake", id: "static" } as Model<any>;
	const ctx = {
		cwd: root,
		mode: "json",
		model: fakeModel,
		modelRegistry: { getAvailable: () => [fakeModel] },
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "recovery-e2e" },
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;
	t.after(async () => {
		await manager.shutdown().catch(() => undefined);
		for (const key of environmentKeys) {
			const value = previousEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});

	await manager.initialize(ctx);
	await store.refresh();
	assert.equal(store.current.agents["orphaned-agent"].retentionPending, undefined);
	assert.equal(store.current.agents["orphaned-agent"].retention, "reusable");
	assert.equal(store.current.commands.length, 0);
});
