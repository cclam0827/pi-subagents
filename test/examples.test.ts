import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getRole, loadRuntimeConfig } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examples = join(root, "examples");

async function fixture(t: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-examples-"));
	const agentDir = join(directory, "agent");
	const cwd = join(directory, "repo");
	await mkdir(cwd, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	});
	return { directory, agentDir, cwd };
}

test("every shipped config example passes real config loading", async (t) => {
	const files = (await readdir(examples)).filter((file) => /^config\..*\.json$/.test(file));
	assert.deepEqual(files.sort(), [
		"config.anthropic.json",
		"config.ccr.json",
		"config.mixed-providers.json",
		"config.openai-codex.json",
		"config.project.json",
	]);
	const { agentDir, cwd } = await fixture(t);
	const targetDir = join(agentDir, "pi-subagents");
	await mkdir(targetDir, { recursive: true });
	for (const file of files) {
		await copyFile(join(examples, file), join(targetDir, "config.json"));
		const runtime = await loadRuntimeConfig(cwd, false);
		assert.equal(runtime.config.schemaVersion, 1, file);
		assert.equal(runtime.agents.length, 3, file);
		for (const level of ["fast", "balanced", "deep", "max"] as const) {
			assert.ok(runtime.config.levels[level].candidates.length > 0, `${file}: ${level}`);
		}
		if (file === "config.ccr.json") {
			assert.deepEqual(runtime.config.childExtensions, ["git:github.com/cclam0827/pi-ccr-provider"]);
		}
	}
});

test("every role example parses through discovery and built-in overlays remain partial", async (t) => {
	const { agentDir, cwd } = await fixture(t);
	const targetDir = join(agentDir, "pi-subagents", "agents");
	await mkdir(targetDir, { recursive: true });
	const files = (await readdir(join(examples, "agents"))).filter((file) => file.endsWith(".yaml"));
	assert.equal(files.length, 8);
	for (const file of files) await copyFile(join(examples, "agents", file), join(targetDir, file));
	const runtime = await loadRuntimeConfig(cwd, false);
	assert.equal(getRole(runtime.agents, "explore").model, "fast");
	assert.match(getRole(runtime.agents, "explore").instructions, /exploration subagent/);
	assert.equal(getRole(runtime.agents, "implement").model, "deep");
	assert.equal(getRole(runtime.agents, "security-review").source, "user");
	assert.equal(getRole(runtime.agents, "refactor-worker").isolation, "worktree");
	assert.equal(getRole(runtime.agents, "migration-reviewer").model, "deep");
	assert.equal(runtime.agents.length, 9);
});

test("package distribution includes the examples directory", async () => {
	const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { files: string[] };
	assert.ok(packageJson.files.includes("examples"));
});
