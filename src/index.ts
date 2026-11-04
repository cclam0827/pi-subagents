import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadRuntimeConfig } from "./config.ts";
import { EXTENSION_ID } from "./constants.ts";
import { SubagentManager } from "./manager.ts";
import { AgentPanelController } from "./panel.ts";
import { getUserExtensionDir } from "./paths.ts";
import { agentsForView } from "./policy.ts";
import { formatAgentReport } from "./report.ts";
import { MODEL_LEVELS, type ModelLevel, type ModelSelection } from "./types.ts";

function textResult(text: string, details?: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: details ?? {},
		...(isError ? { isError: true } : {}),
	};
}

function required(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`${name} is required for this action`);
	return value;
}

function formatSpawn(result: Awaited<ReturnType<SubagentManager["spawn"]>>): string {
	const agent = result.agent;
	const lines = [
		`Agent ${agent.id} ${agent.status}`,
		`Role: ${agent.role}`,
		`Model: ${agent.level} → ${agent.model} (thinking: ${agent.thinking})`,
		`Working directory: ${agent.cwd}`,
		`Workspace: ${agent.workspace}`,
	];
	if (result.warning) lines.push(`Warning: ${result.warning}`);
	if (result.report) lines.push("", formatAgentReport(result.report));
	else lines.push("", `Use subagent { action: "wait", agentId: "${agent.id}" } to collect the result.`);
	return lines.join("\n");
}

async function createAgentScaffold(name: string): Promise<string> {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Agent name must match ^[a-z][a-z0-9-]*$");
	const directory = join(getUserExtensionDir(), "agents");
	const filePath = join(directory, `${name}.yaml`);
	await mkdir(directory, { recursive: true });
	const yaml = `schemaVersion: 1\nname: ${name}\ndescription: Describe when the orchestrator should use this agent.\nmodel: auto\nisolation: shared\ntools: [read, grep, find, ls]\ninstructions: |\n  You are a specialized subagent. Perform only the delegated task.\n  Finish with Summary, Findings, Files changed, Tests, and Risks sections.\n`;
	await withFileMutationQueue(filePath, async () => {
		await writeFile(filePath, yaml, { encoding: "utf8", flag: "wx", mode: 0o600 });
	});
	return filePath;
}

async function showDoctor(ctx: ExtensionContext): Promise<string> {
	const runtime = await loadRuntimeConfig(ctx.cwd, ctx.isProjectTrusted());
	const lines = [
		`Extension: ${EXTENSION_ID}`,
		`User config: ${join(getUserExtensionDir(), "config.json")}`,
		`Project trusted: ${ctx.isProjectTrusted()}`,
		`Agent scope: ${runtime.config.agentScope}`,
		`Default model: ${runtime.config.defaultModel}`,
		`Limits: depth=${runtime.config.limits.maxDepth}, children=${runtime.config.limits.maxChildrenPerAgent}, agents=${runtime.config.limits.maxAgentsPerRun}, concurrent=${runtime.config.limits.maxConcurrent}`,
		`Project model override: ${runtime.projectModelOverride ? "yes" : "no"}`,
		"",
		"Roles:",
	];
	for (const agent of runtime.agents) {
		lines.push(`- ${agent.name} [${agent.source}] model=${agent.model} isolation=${agent.isolation} tools=${agent.tools.join(",") || "none"}`);
	}
	if (runtime.warnings.length) lines.push("", ...runtime.warnings.map((warning) => `Warning: ${warning}`));
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager(pi);
	let panel: AgentPanelController | undefined;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to an isolated Pi RPC agent with its own context and transcript.",
			"Actions: spawn {role, task, model?, level?, wait?}, wait {agentId}, message {agentId, message}, stop {agentId}, release {agentId}, archive {agentId}, retain {agentId}, list {includeArchived?}.",
			"Built-in roles: explore (read-only research), implement (focused coding), verify (review and tests).",
			"Spawn is asynchronous by default; use wait only when the result is needed before continuing.",
			"model defaults to auto. Levels are fast, balanced, deep, max; an exact provider/model-id may be supplied instead.",
			"Nested agents share run-wide depth, agent-count, and concurrency limits. Results go to the direct parent.",
		].join(" "),
		promptSnippet: "Delegate isolated research, implementation, or verification to RPC subagents",
		promptGuidelines: [
			"Use subagent for bounded, independently useful tasks; keep direct control of integration and final verification.",
			"Use subagent spawn with wait omitted or false for background work, and wait only when the parent needs the result.",
			"Use subagent message to steer an existing agent instead of spawning a duplicate for the same task.",
			"After collecting a result, release agents whose idle process is no longer needed and archive agents that should leave the default panel; retain agents likely to receive follow-ups. Reports and transcripts remain available after release or archive.",
		],
		executionMode: "parallel",
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["spawn", "wait", "message", "stop", "release", "archive", "retain", "list"] as const, { default: "spawn" })),
			role: Type.Optional(Type.String({ description: "Role name for spawn, such as explore, implement, or verify" })),
			task: Type.Optional(Type.String({ description: "Bounded delegated task for spawn" })),
			agentId: Type.Optional(Type.String({ description: "Existing agent ID for wait, message, stop, release, archive, or retain" })),
			message: Type.Optional(Type.String({ description: "Steering or follow-up message" })),
			model: Type.Optional(Type.String({ description: "auto, fast, balanced, deep, max, or provider/model-id" })),
			level: Type.Optional(StringEnum(MODEL_LEVELS, { description: "Explicit model level when model is auto" })),
			wait: Type.Optional(Type.Boolean({ description: "Wait for the spawned agent to finish; default false" })),
			includeArchived: Type.Optional(Type.Boolean({ description: "Include archived agents in list results; default false" })),
			cwd: Type.Optional(Type.String({ description: "Working directory; parallel writers are moved to worktrees" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const action = params.action ?? "spawn";
				if (action === "list") {
					const allAgents = await manager.listAgents(ctx);
					const agents = agentsForView(allAgents, params.includeArchived ? "all" : "list");
					const text = allAgents.length > 0 && agents.length === 0
						? "All subagents are archived. Use includeArchived: true to show them."
						: manager.formatList(agents);
					return textResult(text, { agents });
				}
				if (action === "spawn") {
					const result = await manager.spawn(
						{
							role: required(params.role, "role"),
							task: required(params.task, "task"),
							model: params.model as ModelSelection | undefined,
							level: params.level as ModelLevel | undefined,
							wait: params.wait ?? false,
							cwd: params.cwd,
						},
						ctx,
						signal,
					);
					return textResult(formatSpawn(result), result);
				}
				const agentId = required(params.agentId, "agentId");
				if (action === "wait") {
					const agent = await manager.waitForAgent(agentId, signal);
					return textResult(
						`Agent ${agent.id} ${agent.status}\n\n${agent.report ? formatAgentReport(agent.report) : (agent.error ?? "No report")}`,
						{ agent },
						agent.status === "failed",
					);
				}
				if (action === "message") {
					await manager.messageAgent(agentId, required(params.message, "message"));
					return textResult(`Message accepted for ${agentId}`, { agentId });
				}
				if (action === "stop") {
					await manager.stopSubtree(agentId, "Stopped by parent agent");
					return textResult(`Stopped ${agentId} and its descendants`, { agentId });
				}
				if (action === "release" || action === "archive" || action === "retain") {
					const retention = action === "retain" ? "reusable" : action === "release" ? "released" : "archived";
					const agents = await manager.setRetention(agentId, retention);
					const text = action === "retain"
						? `Retained ${agentId} for reuse; the next message will resume it if needed`
						: `${action === "release" ? "Released" : "Archived"} ${agentId} and its descendants; reports and transcripts retained`;
					return textResult(text, { agentId, retention, agents });
				}
				return textResult(`Unknown action ${action}`, {}, true);
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error), {}, true);
			}
		},
	});

	pi.registerCommand("agents", {
		description: "Manage subagents: /agents [list] | all | stop <id> | release <id> | archive <id> | retain <id> | resume <id> [message] | new <name> | doctor",
		handler: async (args, ctx) => {
			try {
				await manager.initialize(ctx);
				const [command = "list", ...rest] = args.trim().split(/\s+/);
				if (command === "list" || command === "all" || command === "") {
					const view = command === "all" ? "all" : "list";
					if (panel && ctx.mode === "tui") await panel.openList(command === "all");
					else ctx.ui.notify(manager.formatList(agentsForView(await manager.listAgents(ctx), view)), "info");
					return;
				}
				if (command === "stop") {
					const id = required(rest[0], "agent ID");
					if (panel) await panel.stop(id);
					else await manager.stopSubtree(id, "Stopped by user command");
					ctx.ui.notify(`Stopped ${id}`, "info");
					return;
				}
				if (command === "release" || command === "archive" || command === "retain") {
					const id = required(rest[0], "agent ID");
					const retention = command === "retain" ? "reusable" : command === "release" ? "released" : "archived";
					await manager.setRetention(id, retention);
					ctx.ui.notify(`${command === "retain" ? "Retained" : command === "release" ? "Released" : "Archived"} ${id}; reports and transcripts retained`, "info");
					return;
				}
				if (command === "resume") {
					const id = required(rest[0], "agent ID");
					const message = rest.slice(1).join(" ") || "Continue your delegated task. Reassess the current state before proceeding.";
					await manager.resumeAgent(id, message);
					ctx.ui.notify(`Resumed ${id}`, "info");
					return;
				}
				if (command === "new") {
					const path = await createAgentScaffold(required(rest[0], "agent name"));
					ctx.ui.notify(`Created ${path}`, "info");
					return;
				}
				if (command === "doctor") {
					ctx.ui.notify(await showDoctor(ctx), "info");
					return;
				}
				ctx.ui.notify("Usage: /agents [list] | all | stop <id> | release <id> | archive <id> | retain <id> | resume <id> [message] | new <name> | doctor", "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const runtime = await loadRuntimeConfig(ctx.cwd, ctx.isProjectTrusted());
			if (manager.currentDepth >= runtime.config.limits.maxDepth) return undefined;
			const catalog = runtime.agents
				.map((agent) => `- ${agent.name} [${agent.source}]: ${agent.description}`)
				.join("\n");
			return {
				systemPrompt: `${event.systemPrompt}\n\nAvailable subagent roles (use the subagent tool to delegate):\n${catalog}`,
			};
		} catch {
			return undefined;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await manager.initialize(ctx);
			if (!manager.isChild && ctx.mode === "tui") {
				panel = new AgentPanelController(manager, ctx);
				panel.install();
			}
		} catch (error) {
			if (ctx.mode === "tui") ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_shutdown", async () => {
		panel?.dispose();
		panel = undefined;
		await manager.shutdown();
	});
}
