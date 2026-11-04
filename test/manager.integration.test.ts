import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENV } from "../src/constants.ts";
import { SubagentManager } from "../src/manager.ts";
import { RunStore } from "../src/run-store.ts";

const piEntrypoint = join(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"bundle",
	"cli.js",
);

async function fakeOpenAi(): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			const text = "Summary: offline integration complete\n\nFindings:\n- Real Pi RPC child responded\n\nFiles changed:\n- None\n\nTests:\n- Offline fake endpoint\n\nRisks:\n- None";
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "static" };
			response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			response.write("data: [DONE]\n\n");
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fake server has no port");
	return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

test("real Pi child completes an offline end-to-end subagent run", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-e2e-"));
	const environmentKeys = [...Object.values(ENV), "PI_CODING_AGENT_DIR", "PI_SUBAGENTS_PI_CLI"];
	const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
	const externalRunFile = join(root, "external-run.json");
	const externalStore = await RunStore.create(externalRunFile, "external-root", {
		maxDepth: 2,
		maxChildrenPerAgent: 3,
		maxAgentsPerRun: 8,
		maxConcurrent: 4,
	});
	await externalStore.reserve({
		id: "external-parent",
		parentId: null,
		depth: 0,
		role: "implement",
		task: "External run that must remain untouched",
		model: "fake/static",
		level: "balanced",
		thinking: "medium",
		tools: ["read"],
		instructions: "External run",
		extensions: [],
		cwd: root,
		workspace: "shared",
		writer: false,
		status: "done",
	});
	const externalRunBefore = await readFile(externalRunFile, "utf8");
	process.env[ENV.child] = "1";
	process.env[ENV.runFile] = externalRunFile;
	process.env[ENV.runId] = externalStore.current.runId;
	process.env[ENV.agentId] = "external-parent";
	process.env[ENV.depth] = "0";
	const { server, baseUrl } = await fakeOpenAi();
	const completions: unknown[] = [];
	const fakeModel = { provider: "fake", id: "static" } as Model<any>;
	const extensionApi = {
		sendMessage: (message: unknown) => completions.push(message),
	} as unknown as ExtensionAPI;
	// This test owns an independent root run, even when npm test itself runs inside a subagent.
	for (const key of Object.values(ENV)) delete process.env[key];
	let manager = new SubagentManager(extensionApi);
	const ctx = {
		cwd: root,
		mode: "json",
		model: fakeModel,
		modelRegistry: { getAvailable: () => [fakeModel] },
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "offline-e2e" },
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;

	t.after(async () => {
		await manager.shutdown();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		for (const key of environmentKeys) {
			const value = previousEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});

	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_SUBAGENTS_PI_CLI = piEntrypoint;
	await mkdir(join(root, "agent"), { recursive: true });
	await writeFile(
		join(root, "agent", "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl,
					api: "openai-completions",
					apiKey: "fake",
					models: [
						{
							id: "static",
							name: "Offline static model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 16_000,
							maxTokens: 2_000,
						},
					],
				},
			},
		}),
	);

	const spawned = await manager.spawn({ role: "explore", task: "Return the offline report", model: "fake/static" }, ctx);
	assert.equal(spawned.agent.status, "running");
	const completed = await manager.waitForAgent(spawned.agent.id);
	assert.equal(completed.status, "done");
	assert.equal(completed.report?.summary, "offline integration complete");
	assert.ok(completed.sessionFile);
	assert.equal(completions.length, 1);

	await manager.messageAgent(completed.id, "Send an idle follow-up");
	const followedUp = await manager.waitForAgent(completed.id);
	assert.equal(followedUp.attempt, 2);
	assert.equal(completions.length, 2);

	await manager.shutdown();
	manager = new SubagentManager(extensionApi);
	await manager.initialize(ctx);
	const restoredTranscript = await manager.getTranscript(completed.id);
	assert.ok(restoredTranscript.length > 0);
	await manager.resumeAgent(completed.id, "Resume after the parent manager was replaced");
	const resumed = await manager.waitForAgent(completed.id);
	assert.equal(resumed.status, "done");
	assert.equal(resumed.attempt, 3);
	assert.equal(resumed.sessionFile, completed.sessionFile);
	assert.equal(completions.length, 3);
	assert.equal(
		await readFile(externalRunFile, "utf8"),
		externalRunBefore,
		"an offline test run must not mutate the subagent run that invoked it",
	);
});
