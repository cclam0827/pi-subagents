import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

export const MODEL_LEVELS = ["fast", "balanced", "deep", "max"] as const;
export type ModelLevel = (typeof MODEL_LEVELS)[number];
export type ModelSelection = "auto" | ModelLevel | `${string}/${string}`;
export type AgentSource = "builtin" | "user" | "project";
export type AgentScope = "user" | "project" | "both";
export type Isolation = "shared" | "worktree" | "auto";

export interface LevelConfig {
	thinking: ThinkingLevel;
	candidates: string[];
}

export interface Limits {
	maxDepth: number;
	maxChildrenPerAgent: number;
	maxAgentsPerRun: number;
	maxConcurrent: number;
}

export interface SubagentsConfig {
	schemaVersion: 1;
	defaultModel: ModelSelection;
	agentScope: AgentScope;
	allowedTools?: string[];
	childExtensions: string[];
	confirmMax: boolean;
	limits: Limits;
	levels: Record<ModelLevel, LevelConfig>;
}

export interface AgentDefinition {
	schemaVersion: 1;
	name: string;
	description: string;
	tools: string[];
	model: ModelSelection;
	instructions: string;
	isolation: Isolation;
	enabled: boolean;
	source: AgentSource;
	filePath: string;
}

export type AgentStatus = "queued" | "starting" | "running" | "stopping" | "done" | "failed" | "stopped";
export type AgentRetention = "reusable" | "released" | "archived";

export interface AgentReport {
	summary: string;
	findings: string[];
	filesChanged: string[];
	tests: string[];
	risks: string[];
}

export interface AgentCommand {
	id: string;
	targetId: string;
	kind: "message" | "stop" | "retention";
	message?: string;
	retention?: AgentRetention;
	createdAt: string;
}

export interface AgentRecord {
	id: string;
	runId: string;
	parentId: string | null;
	depth: number;
	role: string;
	task: string;
	model: string;
	level: ModelLevel;
	thinking: ThinkingLevel;
	tools: string[];
	instructions: string;
	extensions: string[];
	cwd: string;
	workspace: Isolation;
	writer: boolean;
	repoRoot?: string;
	baseHead?: string;
	status: AgentStatus;
	pid?: number;
	sessionFile?: string;
	attempt: number;
	createdAt: string;
	updatedAt: string;
	lastActivity: string;
	error?: string;
	report?: AgentReport;
	/** Missing on older schema-v1 records, which are treated as reusable. */
	retention?: AgentRetention;
	retentionPending?: Exclude<AgentRetention, "reusable">;
}

export interface RunState {
	schemaVersion: 1;
	runId: string;
	rootSessionId: string;
	createdAt: string;
	limits: Limits;
	agents: Record<string, AgentRecord>;
	commands: AgentCommand[];
}

export interface SpawnRequest {
	role: string;
	task: string;
	model?: ModelSelection;
	level?: ModelLevel;
	wait?: boolean;
	cwd?: string;
}

export interface SpawnResult {
	agent: AgentRecord;
	report?: AgentReport;
	warning?: string;
}

export interface AgentEvent {
	type: "activity" | "status" | "message";
	agentId: string;
	status?: AgentStatus;
	activity?: string;
	message?: AgentMessage;
}

export interface ModelResolution {
	provider: string;
	id: string;
	reference: `${string}/${string}`;
	level: ModelLevel;
	thinking: ThinkingLevel;
	fallback: boolean;
	warning?: string;
}
