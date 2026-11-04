import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { RpcProcess } from "../src/rpc-process.ts";

test("RPC adapter handles state, prompts, events, messages, and clean shutdown", async (t) => {
	const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
	const events: string[] = [];
	const rpc = new RpcProcess({
		args: [],
		cwd: process.cwd(),
		cliPath: fixture,
		onEvent: (event) => events.push(event.type),
	});
	t.after(() => rpc.stop());
	const state = await rpc.start();
	assert.equal(state.sessionId, "fake-session");
	await rpc.prompt("do work");
	await rpc.waitForIdle(2_000);
	assert.ok(events.includes("agent_start"));
	assert.ok(events.includes("message_end"));
	assert.ok(events.includes("agent_settled"));
	assert.equal(rpc.messages.length, 1);
	assert.equal((await rpc.getMessages()).length, 1);
	await rpc.stop();
	assert.equal(rpc.isRunning, false);
});
