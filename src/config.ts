import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { AGENT_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION } from "./constants.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { getBuiltInAgentsDir, getProjectExtensionDir, getUserExtensionDir } from "./paths.ts";
import {
	MODEL_LEVELS,
	type AgentDefinition,
	type AgentScope,
	type LevelConfig,
	type Limits,
	type ModelLevel,
	type ModelSelection,
	type SubagentsConfig,
} from "./types.ts";

export interface RuntimeConfig {
	config: SubagentsConfig;
	agents: AgentDefinition[];
	warnings: string[];
	projectModelOverride: boolean;
}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelSelection(value: unknown): value is ModelSelection {
	return (
		value === "auto" ||
		(typeof value === "string" && (MODEL_LEVELS as readonly string[]).includes(value)) ||
		(typeof value === "string" && value.includes("/") && !value.startsWith("/") && !value.endsWith("/"))
	);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
		throw new Error(`${label} must be an array of non-empty strings`);
	}
	return value.map((entry) => entry.trim());
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${label} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function parseLimits(value: unknown, base: Limits): Limits {
	if (value === undefined) return base;
	if (!isRecord(value)) throw new Error("limits must be an object");
	return {
		maxDepth:
			value.maxDepth === undefined ? base.maxDepth : boundedInteger(value.maxDepth, "limits.maxDepth", 0, 8),
		maxChildrenPerAgent:
			value.maxChildrenPerAgent === undefined
				? base.maxChildrenPerAgent
				: boundedInteger(value.maxChildrenPerAgent, "limits.maxChildrenPerAgent", 1, 16),
		maxAgentsPerRun:
			value.maxAgentsPerRun === undefined
				? base.maxAgentsPerRun
				: boundedInteger(value.maxAgentsPerRun, "limits.maxAgentsPerRun", 1, 64),
		maxConcurrent:
			value.maxConcurrent === undefined
				? base.maxConcurrent
				: boundedInteger(value.maxConcurrent, "limits.maxConcurrent", 1, 16),
	};
}

function parseLevel(value: unknown, base: LevelConfig, label: string): LevelConfig {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const thinking = value.thinking ?? base.thinking;
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinking))) {
		throw new Error(`${label}.thinking is invalid`);
	}
	return {
		thinking: thinking as LevelConfig["thinking"],
		candidates: value.candidates === undefined ? base.candidates : stringArray(value.candidates, `${label}.candidates`),
	};
}

function mergeConfig(base: SubagentsConfig, raw: RawRecord, source: string): SubagentsConfig {
	if (raw.schemaVersion !== undefined && raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
		throw new Error(`${source}: unsupported schemaVersion ${String(raw.schemaVersion)}`);
	}
	if (raw.defaultModel !== undefined && !isModelSelection(raw.defaultModel)) {
		throw new Error(`${source}: defaultModel must be auto, a level, or provider/model-id`);
	}
	if (raw.agentScope !== undefined && !["user", "project", "both"].includes(String(raw.agentScope))) {
		throw new Error(`${source}: agentScope must be user, project, or both`);
	}
	if (raw.confirmMax !== undefined && typeof raw.confirmMax !== "boolean") {
		throw new Error(`${source}: confirmMax must be boolean`);
	}
	const levels = { ...base.levels };
	if (raw.levels !== undefined) {
		if (!isRecord(raw.levels)) throw new Error(`${source}: levels must be an object`);
		for (const level of MODEL_LEVELS) {
			if (raw.levels[level] !== undefined) {
				levels[level] = parseLevel(raw.levels[level], levels[level], `levels.${level}`);
			}
		}
	}
	return {
		schemaVersion: CONFIG_SCHEMA_VERSION,
		defaultModel: raw.defaultModel === undefined ? base.defaultModel : raw.defaultModel,
		agentScope: raw.agentScope === undefined ? base.agentScope : (raw.agentScope as AgentScope),
		allowedTools: raw.allowedTools === undefined ? base.allowedTools : stringArray(raw.allowedTools, "allowedTools"),
		childExtensions:
			raw.childExtensions === undefined ? base.childExtensions : stringArray(raw.childExtensions, "childExtensions"),
		confirmMax: raw.confirmMax === undefined ? base.confirmMax : raw.confirmMax,
		limits: parseLimits(raw.limits, base.limits),
		levels,
	};
}

async function readJsonObject(path: string): Promise<RawRecord | undefined> {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error(`${path}: config must be a JSON object`);
	return parsed;
}

function intersectLimits(user: Limits, project: Limits): Limits {
	return {
		maxDepth: Math.min(user.maxDepth, project.maxDepth),
		maxChildrenPerAgent: Math.min(user.maxChildrenPerAgent, project.maxChildrenPerAgent),
		maxAgentsPerRun: Math.min(user.maxAgentsPerRun, project.maxAgentsPerRun),
		maxConcurrent: Math.min(user.maxConcurrent, project.maxConcurrent),
	};
}

function intersectTools(user: string[] | undefined, project: string[] | undefined): string[] | undefined {
	if (!user) return project;
	if (!project) return user;
	const allowed = new Set(user);
	return project.filter((tool) => allowed.has(tool));
}

async function readAgentFile(filePath: string): Promise<RawRecord> {
	let parsed: unknown;
	try {
		parsed = parse(await readFile(filePath, "utf8"));
	} catch (error) {
		throw new Error(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error(`${filePath}: agent definition must be an object`);
	return parsed;
}

function normalizeAgent(raw: RawRecord, base: AgentDefinition | undefined, source: AgentDefinition["source"], filePath: string): AgentDefinition {
	if (raw.schemaVersion !== undefined && raw.schemaVersion !== AGENT_SCHEMA_VERSION) {
		throw new Error(`${filePath}: unsupported schemaVersion ${String(raw.schemaVersion)}`);
	}
	const name = raw.name ?? base?.name;
	if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) {
		throw new Error(`${filePath}: name must match ^[a-z][a-z0-9-]*$`);
	}
	const description = raw.description ?? base?.description;
	const instructions = raw.instructions ?? base?.instructions;
	const model = raw.model ?? base?.model ?? "auto";
	const isolation = raw.isolation ?? base?.isolation ?? "shared";
	const tools = raw.tools === undefined ? base?.tools : stringArray(raw.tools, `${filePath}: tools`);
	if (typeof description !== "string" || !description.trim()) {
		throw new Error(`${filePath}: a new agent requires a non-empty description`);
	}
	if (typeof instructions !== "string" || !instructions.trim()) {
		throw new Error(`${filePath}: a new agent requires non-empty instructions`);
	}
	if (!tools) throw new Error(`${filePath}: a new agent requires a tools array (which may be empty)`);
	if (!isModelSelection(model)) throw new Error(`${filePath}: model must be auto, a level, or provider/model-id`);
	if (!["shared", "worktree", "auto"].includes(String(isolation))) {
		throw new Error(`${filePath}: isolation must be shared, worktree, or auto`);
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		throw new Error(`${filePath}: enabled must be boolean`);
	}
	return {
		schemaVersion: AGENT_SCHEMA_VERSION,
		name,
		description,
		tools: [...tools],
		model,
		instructions,
		isolation: isolation as AgentDefinition["isolation"],
		enabled: raw.enabled === undefined ? (base?.enabled ?? true) : raw.enabled,
		source,
		filePath,
	};
}

async function loadAgentsFromDir(dir: string, source: AgentDefinition["source"]): Promise<RawRecord[]> {
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const records: RawRecord[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if ((!entry.isFile() && !entry.isSymbolicLink()) || !/\.ya?ml$/.test(entry.name)) continue;
		const raw = await readAgentFile(join(dir, entry.name));
		raw.__filePath = join(dir, entry.name);
		records.push(raw);
	}
	return records;
}

export async function loadRuntimeConfig(cwd: string, projectTrusted: boolean): Promise<RuntimeConfig> {
	const warnings: string[] = [];
	const userDir = getUserExtensionDir();
	const projectDir = getProjectExtensionDir(cwd);
	const userPath = join(userDir, "config.json");
	const userRaw = (await readJsonObject(userPath)) ?? {};
	let config = mergeConfig(DEFAULT_CONFIG, userRaw, userPath);
	const scope = config.agentScope;
	let projectRaw: RawRecord | undefined;
	let projectModelOverride = false;

	if (scope !== "user" && projectTrusted) {
		const projectPath = join(projectDir, "config.json");
		projectRaw = await readJsonObject(projectPath);
		if (projectRaw) {
			projectModelOverride = projectRaw.defaultModel !== undefined || projectRaw.levels !== undefined;
			const merged = mergeConfig(config, projectRaw, projectPath);
			config = {
				...merged,
				agentScope: scope,
				confirmMax: config.confirmMax,
				allowedTools: intersectTools(config.allowedTools, merged.allowedTools),
				limits: intersectLimits(config.limits, merged.limits),
			};
		}
	} else if (scope !== "user" && existsSync(projectDir)) {
		warnings.push(`Ignored ${projectDir}: project is not trusted`);
	}

	const layers: Array<{ records: RawRecord[]; source: AgentDefinition["source"] }> = [
		{ records: await loadAgentsFromDir(getBuiltInAgentsDir(), "builtin"), source: "builtin" },
	];
	if (scope !== "project") {
		layers.push({ records: await loadAgentsFromDir(join(userDir, "agents"), "user"), source: "user" });
	}
	if (scope !== "user" && projectTrusted) {
		layers.push({ records: await loadAgentsFromDir(join(projectDir, "agents"), "project"), source: "project" });
	}

	const agents = new Map<string, AgentDefinition>();
	const disabledByUser = new Set<string>();
	for (const layer of layers) {
		for (const raw of layer.records) {
			const filePath = String(raw.__filePath);
			delete raw.__filePath;
			const name = raw.name;
			if (typeof name !== "string") throw new Error(`${filePath}: name is required`);
			if (layer.source === "project" && disabledByUser.has(name)) {
				warnings.push(`Ignored project agent "${name}": disabled by user policy`);
				continue;
			}
			const base = agents.get(name);
			const agent = normalizeAgent(raw, base, layer.source, filePath);
			if (layer.source === "project" && base) {
				if (raw.tools !== undefined) agent.tools = agent.tools.filter((tool) => base.tools.includes(tool));
				if (base.isolation === "worktree" || (base.isolation === "auto" && agent.isolation === "shared")) {
					agent.isolation = base.isolation;
				}
			}
			if (agent.enabled) agents.set(agent.name, agent);
			else {
				agents.delete(agent.name);
				if (layer.source === "user") disabledByUser.add(agent.name);
			}
		}
	}
	return { config, agents: [...agents.values()], warnings, projectModelOverride };
}

export function getRole(agents: AgentDefinition[], name: string): AgentDefinition {
	const role = agents.find((agent) => agent.name === name);
	if (!role) {
		throw new Error(`Unknown agent role "${name}". Available: ${agents.map((agent) => agent.name).join(", ") || "none"}`);
	}
	return role;
}

export function capRoleTools(role: AgentDefinition, allowedTools: string[] | undefined, depth: number, maxDepth: number): string[] {
	const allowed = allowedTools ? new Set(allowedTools) : undefined;
	return role.tools.filter((tool) => {
		if (tool === "subagent" && depth >= maxDepth) return false;
		return !allowed || allowed.has(tool);
	});
}
