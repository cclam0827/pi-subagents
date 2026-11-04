import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capRoleTools, getRole, loadRuntimeConfig } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/defaults.ts";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "repo");
	await mkdir(cwd, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});
	return { root, agentDir, cwd };
}

test("loads built-in roles with auto models and no user setup", async (t) => {
	const { cwd } = await fixture(t);
	const runtime = await loadRuntimeConfig(cwd, false);
	assert.deepEqual(runtime.agents.map((agent) => agent.name), ["explore", "implement", "verify"]);
	assert.equal(getRole(runtime.agents, "explore").model, "auto");
	assert.equal(getRole(runtime.agents, "implement").isolation, "auto");
	assert.equal(runtime.config.limits.maxDepth, 2);
	assert.equal(runtime.config.agentScope, "user");
});

test("user role overlays inherit unspecified built-in fields and custom roles are supported", async (t) => {
	const { cwd, agentDir } = await fixture(t);
	const agentsDir = join(agentDir, "pi-subagents", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(join(agentsDir, "explore.yaml"), "name: explore\nmodel: deep\n");
	await writeFile(
		join(agentsDir, "security-review.yaml"),
		"schemaVersion: 1\nname: security-review\ndescription: Security review\nmodel: max\nisolation: shared\ntools: [read]\ninstructions: Review security.\n",
	);
	const runtime = await loadRuntimeConfig(cwd, false);
	const explore = getRole(runtime.agents, "explore");
	assert.equal(explore.model, "deep");
	assert.equal(explore.source, "user");
	assert.deepEqual(explore.tools, ["read", "grep", "find", "ls"]);
	assert.match(explore.instructions, /exploration subagent/);
	assert.equal(getRole(runtime.agents, "security-review").source, "user");
});

test("trusted project can add agents but cannot increase limits or tool caps", async (t) => {
	const { cwd, agentDir } = await fixture(t);
	const userDir = join(agentDir, "pi-subagents");
	await mkdir(userDir, { recursive: true });
	await writeFile(
		join(userDir, "config.json"),
		JSON.stringify({
			schemaVersion: 1,
			agentScope: "both",
			allowedTools: ["read", "grep", "bash", "edit", "subagent"],
			limits: { maxDepth: 2, maxChildrenPerAgent: 3, maxAgentsPerRun: 8, maxConcurrent: 4 },
		}),
	);
	const projectDir = join(cwd, ".pi", "pi-subagents");
	await mkdir(join(projectDir, "agents"), { recursive: true });
	await writeFile(
		join(projectDir, "config.json"),
		JSON.stringify({
			schemaVersion: 1,
			allowedTools: ["read", "write", "subagent"],
			limits: { maxDepth: 7, maxChildrenPerAgent: 2, maxAgentsPerRun: 50, maxConcurrent: 2 },
		}),
	);
	await writeFile(
		join(projectDir, "agents", "repo-review.yaml"),
		"name: repo-review\ndescription: Repo review\ntools: [read, write, bash, subagent]\nmodel: auto\ninstructions: Review this repo.\n",
	);
	const runtime = await loadRuntimeConfig(cwd, true);
	assert.equal(runtime.config.limits.maxDepth, 2);
	assert.equal(runtime.config.limits.maxChildrenPerAgent, 2);
	assert.equal(runtime.config.limits.maxAgentsPerRun, 8);
	assert.equal(runtime.config.limits.maxConcurrent, 2);
	assert.deepEqual(runtime.config.allowedTools, ["read", "subagent"]);
	const role = getRole(runtime.agents, "repo-review");
	assert.equal(role.source, "project");
	assert.deepEqual(capRoleTools(role, runtime.config.allowedTools, 1, 2), ["read", "subagent"]);
	assert.deepEqual(capRoleTools(role, runtime.config.allowedTools, 2, 2), ["read"]);
});

test("project overlays cannot turn a built-in read-only role into a writer", async (t) => {
	const { cwd, agentDir } = await fixture(t);
	await mkdir(join(agentDir, "pi-subagents"), { recursive: true });
	await writeFile(join(agentDir, "pi-subagents", "config.json"), JSON.stringify({ agentScope: "both" }));
	const projectDir = join(cwd, ".pi", "pi-subagents", "agents");
	await mkdir(projectDir, { recursive: true });
	await writeFile(
		join(projectDir, "explore.yaml"),
		"name: explore\ntools: [read, edit, write, bash]\nisolation: shared\n",
	);
	const runtime = await loadRuntimeConfig(cwd, true);
	const explore = getRole(runtime.agents, "explore");
	assert.deepEqual(explore.tools, ["read"]);
});

test("untrusted project resources and project scope are handled independently", async (t) => {
	const { cwd, agentDir } = await fixture(t);
	await mkdir(join(agentDir, "pi-subagents"), { recursive: true });
	await writeFile(join(agentDir, "pi-subagents", "config.json"), JSON.stringify({ agentScope: "both" }));
	const projectDir = join(cwd, ".pi", "pi-subagents", "agents");
	await mkdir(projectDir, { recursive: true });
	await writeFile(
		join(projectDir, "repo.yaml"),
		"name: repo\ndescription: Repo agent\ntools: [read]\nmodel: auto\ninstructions: Inspect.\n",
	);
	const untrusted = await loadRuntimeConfig(cwd, false);
	assert.throws(() => getRole(untrusted.agents, "repo"), /Unknown agent role/);
	assert.equal(untrusted.warnings.length, 1);
	const trusted = await loadRuntimeConfig(cwd, true);
	assert.equal(getRole(trusted.agents, "repo").source, "project");
});

test("role tools are capped at maximum depth", async (t) => {
	const { cwd } = await fixture(t);
	const runtime = await loadRuntimeConfig(cwd, false);
	const implement = getRole(runtime.agents, "implement");
	assert.ok(capRoleTools(implement, undefined, 1, 2).includes("subagent"));
	assert.ok(!capRoleTools(implement, undefined, 2, 2).includes("subagent"));
	assert.ok(!capRoleTools(implement, ["read", "subagent"], 2, 2).includes("bash"));
	assert.equal(DEFAULT_CONFIG.defaultModel, "auto");
});
