import type { SubagentsConfig } from "./types.ts";
import { CONFIG_SCHEMA_VERSION, DEFAULT_LIMITS } from "./constants.ts";

export const DEFAULT_CONFIG: SubagentsConfig = {
	schemaVersion: CONFIG_SCHEMA_VERSION,
	defaultModel: "auto",
	agentScope: "user",
	childExtensions: [],
	confirmMax: true,
	limits: { ...DEFAULT_LIMITS },
	levels: {
		fast: {
			thinking: "low",
			candidates: ["anthropic/claude-haiku-5-5"],
		},
		balanced: {
			thinking: "medium",
			candidates: ["anthropic/claude-sonnet-5-5"],
		},
		deep: {
			thinking: "high",
			candidates: ["anthropic/claude-opus-5-5"],
		},
		max: {
			thinking: "max",
			candidates: ["anthropic/claude-fable-5-1"],
		},
	},
};
