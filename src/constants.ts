export const EXTENSION_ID = "pi-subagents";
export const CONFIG_SCHEMA_VERSION = 1 as const;
export const AGENT_SCHEMA_VERSION = 1 as const;

export const DEFAULT_LIMITS = {
	maxDepth: 2,
	maxChildrenPerAgent: 3,
	maxAgentsPerRun: 8,
	maxConcurrent: 4,
} as const;

export const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "stopping"]);
export const RUNNING_STATUSES = new Set(["starting", "running"]);
export const TERMINAL_STATUSES = new Set(["done", "failed", "stopped"]);

export const ENV = {
	runFile: "PI_SUBAGENTS_RUN_FILE",
	runId: "PI_SUBAGENTS_RUN_ID",
	agentId: "PI_SUBAGENTS_AGENT_ID",
	depth: "PI_SUBAGENTS_DEPTH",
	child: "PI_SUBAGENTS_CHILD",
} as const;
