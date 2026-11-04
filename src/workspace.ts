import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TERMINAL_STATUSES } from "./constants.ts";
import { getUserExtensionDir } from "./paths.ts";
import type { AgentDefinition, AgentRecord, Isolation } from "./types.ts";

const exec = promisify(execFile);

export interface WorkspaceDecision {
	cwd: string;
	workspace: Isolation;
	writer: boolean;
	repoRoot?: string;
	baseHead?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
	return stdout.trim();
}

export function needsWorktree(role: AgentDefinition, cwd: string, agents: AgentRecord[], repoRoot?: string): boolean {
	if (role.isolation === "worktree") return true;
	if (role.isolation !== "auto") return false;
	const checkout = repoRoot ?? cwd;
	return agents.some(
		(agent) =>
			agent.writer &&
			(agent.repoRoot ?? agent.cwd) === checkout &&
			!TERMINAL_STATUSES.has(agent.status),
	);
}

export async function prepareWorkspace(input: {
	agentId: string;
	role: AgentDefinition;
	cwd: string;
	agents: AgentRecord[];
}): Promise<WorkspaceDecision> {
	const { agentId, role, cwd } = input;
	const writer = role.isolation !== "shared" || role.tools.includes("edit") || role.tools.includes("write");
	let detectedRepoRoot: string | undefined;
	try {
		detectedRepoRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		// A non-git directory can host one shared writer, but cannot create a worktree.
	}
	if (!needsWorktree(role, cwd, input.agents, detectedRepoRoot)) {
		return { cwd, workspace: "shared", writer, repoRoot: detectedRepoRoot };
	}
	if (!detectedRepoRoot) throw new Error(`Cannot create a worktree outside a git repository: ${cwd}`);
	const repoRoot = detectedRepoRoot;
	const baseHead = await git(cwd, ["rev-parse", "HEAD"]);
	const directory = join(getUserExtensionDir(), "worktrees", agentId);
	await mkdir(dirname(directory), { recursive: true });
	await git(cwd, ["worktree", "add", "-b", `pi-subagents/${agentId}`, directory, baseHead]);
	return { cwd: directory, workspace: "worktree", writer, repoRoot, baseHead };
}

export async function cleanupWorkspace(agent: AgentRecord): Promise<boolean> {
	if (agent.workspace !== "worktree" || !agent.repoRoot || !agent.baseHead) return false;
	try {
		const [status, head] = await Promise.all([
			git(agent.cwd, ["status", "--porcelain"]),
			git(agent.cwd, ["rev-parse", "HEAD"]),
		]);
		if (status || head !== agent.baseHead) return false;
		await git(agent.repoRoot, ["worktree", "remove", agent.cwd]);
		await git(agent.repoRoot, ["branch", "-D", `pi-subagents/${agent.id}`]);
		return true;
	} catch {
		return false;
	}
}
