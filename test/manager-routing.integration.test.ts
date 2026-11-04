import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENV } from "../src/constants.ts";
import { SubagentManager } from "../src/manager.ts";
import { RunStore } from "../src/run-store.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await sleep(20);
	}
}

function processIsAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("nested idle follow-up stays with its direct process owner", { timeout: 15_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-routing-"));
	const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
	const environmentKeys = [...Object.values(ENV), "PI_CODING_AGENT_DIR", "PI_SUBAGENTS_PI_CLI"];
	const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
	const parentMessages: unknown[] = [];
	const extensionApi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
	const parentExtensionApi = {
		sendMessage: (message: unknown) => parentMessages.push(message),
	} as unknown as ExtensionAPI;
	const rootManager = new SubagentManager(extensionApi);
	let parentManager: SubagentManager | undefined;
	let grandchildManager: SubagentManager | undefined;

	for (const key of Object.values(ENV)) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_SUBAGENTS_PI_CLI = fixture;

	const fakeModel = { provider: "fake", id: "static" } as Model<any>;
	const ctx = {
		cwd: root,
		mode: "json",
		model: fakeModel,
		modelRegistry: { getAvailable: () => [fakeModel] },
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "routing-e2e" },
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;

	t.after(async () => {
		await grandchildManager?.shutdown().catch(() => undefined);
		await parentManager?.shutdown().catch(() => undefined);
		await rootManager.shutdown().catch(() => undefined);
		for (const key of environmentKeys) {
			const value = previousEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});

	await rootManager.initialize(ctx);
	const runFile = join(root, "agent", "pi-subagents", "state", "routing-e2e.json");
	const store = await RunStore.open(runFile);
	const parent = await store.reserve({
		id: "parent-agent",
		parentId: null,
		depth: 1,
		role: "implement",
		task: "Simulated direct owner",
		model: "fake/static",
		level: "balanced",
		thinking: "medium",
		tools: ["read", "subagent"],
		instructions: "Simulated direct owner",
		extensions: [],
		cwd: root,
		workspace: "shared",
		writer: false,
		status: "done",
		pid: process.pid,
	});

	process.env[ENV.child] = "1";
	process.env[ENV.runFile] = runFile;
	process.env[ENV.runId] = store.current.runId;
	process.env[ENV.agentId] = parent.id;
	process.env[ENV.depth] = "1";
	parentManager = new SubagentManager(parentExtensionApi);
	await parentManager.initialize(ctx);

	const spawned = await parentManager.spawn({ role: "explore", task: "Initial child task", model: "fake/static" }, ctx);
	const child = await parentManager.waitForAgent(spawned.agent.id);
	const originalPid = child.pid;
	assert.ok(originalPid);
	await waitForCondition(() => parentMessages.length === 1, "the initial direct-parent completion");

	await rootManager.messageAgent(child.id, "Follow up through the existing direct owner");
	const followedUp = await rootManager.waitForAgent(child.id);
	assert.equal(followedUp.attempt, 2);
	assert.equal(followedUp.pid, originalPid, "follow-up must not start a replacement RPC process");
	assert.equal(followedUp.sessionFile, child.sessionFile);
	await waitForCondition(() => parentMessages.length === 2, "the follow-up direct-parent completion");

	await rootManager.setRetention(child.id, "released");
	assert.equal(processIsAlive(originalPid), false, "remote release must stop the original owner process");
	await rootManager.messageAgent(child.id, "Resume the released child through its direct owner");
	await waitForCondition(() => {
		const agent = rootManager.getAgent(child.id);
		return agent?.status === "done" && agent.attempt === 3;
	}, "the released nested follow-up");
	const resumed = await rootManager.waitForAgent(child.id);
	assert.equal(resumed.attempt, 3);
	assert.equal(resumed.retention, "reusable");
	assert.notEqual(resumed.pid, originalPid, "a released child should start one replacement process");
	await waitForCondition(() => parentMessages.length === 3, "the resumed direct-parent completion");

	await rootManager.setRetention(child.id, "released");
	assert.equal(processIsAlive(resumed.pid), false);
	await rootManager.resumeAgent(child.id, "Explicitly resume through the direct owner");
	await waitForCondition(() => {
		const agent = rootManager.getAgent(child.id);
		return agent?.status === "done" && agent.attempt === 4;
	}, "the explicit nested resume");
	await waitForCondition(() => parentMessages.length === 4, "completion from the explicit direct-owner resume");

	await store.update((state) => {
		state.limits.maxDepth = 3;
	});
	process.env[ENV.agentId] = child.id;
	process.env[ENV.depth] = "2";
	grandchildManager = new SubagentManager(extensionApi);
	await grandchildManager.initialize(ctx);
	const grandchildSpawn = await grandchildManager.spawn({ role: "explore", task: "Deep cleanup", model: "fake/static" }, ctx);
	const grandchild = await grandchildManager.waitForAgent(grandchildSpawn.agent.id);
	const childPid = rootManager.getAgent(child.id)?.pid;
	assert.equal(processIsAlive(childPid), true);
	assert.equal(processIsAlive(grandchild.pid), true);

	await rootManager.setRetention(child.id, "archived");
	assert.equal(rootManager.getAgent(child.id)?.retention, "archived");
	assert.equal(rootManager.getAgent(grandchild.id)?.retention, "archived");
	assert.equal(processIsAlive(childPid), false, "the selected child process must be stopped");
	assert.equal(processIsAlive(grandchild.pid), false, "deep descendants must also be stopped");
});
