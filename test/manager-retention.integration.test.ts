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

function processIsAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("orchestrator can release and archive agents without losing their transcripts", { timeout: 15_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-retention-"));
	const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
	const environmentKeys = [...Object.values(ENV), "PI_CODING_AGENT_DIR", "PI_SUBAGENTS_PI_CLI"];
	const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
	for (const key of Object.values(ENV)) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_SUBAGENTS_PI_CLI = fixture;

	const extensionApi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
	const manager = new SubagentManager(extensionApi);
	const fakeModel = { provider: "fake", id: "static" } as Model<any>;
	const ctx = {
		cwd: root,
		mode: "json",
		model: fakeModel,
		modelRegistry: { getAvailable: () => [fakeModel] },
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "retention-e2e" },
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

	const spawned = await manager.spawn({ role: "explore", task: "Retention lifecycle", model: "fake/static" }, ctx);
	const completed = await manager.waitForAgent(spawned.agent.id);
	const originalPid = completed.pid;
	assert.equal(completed.retention, "reusable");
	assert.equal(processIsAlive(originalPid), true);
	assert.ok((await manager.getTranscript(completed.id)).length > 0);

	const [released] = await manager.setRetention(completed.id, "released");
	assert.equal(released.retention, "released");
	assert.equal(released.status, "done");
	assert.equal(processIsAlive(originalPid), false);
	assert.ok((await manager.getTranscript(completed.id)).length > 0);

	const [retained] = await manager.setRetention(completed.id, "reusable");
	assert.equal(retained.retention, "reusable");
	await manager.messageAgent(completed.id, "Reuse the released agent");
	const reused = await manager.waitForAgent(completed.id);
	assert.equal(reused.attempt, 2);
	assert.equal(reused.retention, "reusable");
	assert.equal(processIsAlive(reused.pid), true);

	const [archived] = await manager.setRetention(completed.id, "archived");
	assert.equal(archived.retention, "archived");
	assert.equal(archived.status, "done");
	assert.equal(processIsAlive(reused.pid), false);
	assert.ok(manager.getAgent(completed.id));
	assert.ok((await manager.getTranscript(completed.id)).length > 0);

	const [restored] = await manager.setRetention(completed.id, "reusable");
	assert.equal(restored.retention, "reusable");
	assert.ok(manager.getAgent(completed.id));
});
