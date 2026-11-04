import { ACTIVE_STATUSES } from "./constants.ts";
import type { AgentRecord, Limits } from "./types.ts";

export type AgentView = "panel" | "list" | "all";

export function agentsForView(agents: AgentRecord[], view: AgentView): AgentRecord[] {
	if (view === "all") return agents;
	return agents.filter((agent) => {
		const retention = agent.retention ?? "reusable";
		if (retention === "archived") return false;
		if (view === "list") return true;
		return ACTIVE_STATUSES.has(agent.status) || (agent.status === "done" && retention === "reusable");
	});
}

export function canSpawn(state: { limits: Limits; agents: Record<string, AgentRecord> }, parentId: string | null, depth: number): void {
	if (depth > state.limits.maxDepth) throw new Error(`Maximum subagent depth (${state.limits.maxDepth}) reached`);
	if (Object.keys(state.agents).length >= state.limits.maxAgentsPerRun) {
		throw new Error(`Maximum agents per run (${state.limits.maxAgentsPerRun}) reached`);
	}
	if (parentId) {
		if (!state.agents[parentId]) throw new Error(`Unknown parent agent ${parentId}`);
		const count = Object.values(state.agents).filter((agent) => agent.parentId === parentId).length;
		if (count >= state.limits.maxChildrenPerAgent) {
			throw new Error(`Parent ${parentId} reached its ${state.limits.maxChildrenPerAgent}-child limit`);
		}
	}
}

export function subtreeIds(state: { agents: Record<string, AgentRecord> }, rootId: string): string[] {
	const ids: string[] = [];
	const visit = (id: string) => {
		ids.push(id);
		for (const agent of Object.values(state.agents)) if (agent.parentId === id) visit(agent.id);
	};
	visit(rootId);
	return ids;
}

export function formatAgentTree(agents: AgentRecord[], rootId?: string): string {
	const lines: string[] = [];
	const visit = (agent: AgentRecord, indent: string) => {
		const retention = agent.retention ?? "reusable";
		const retentionLabel = retention === "reusable" ? "" : ` [${retention}]`;
		lines.push(`${indent}${agent.id}  ${agent.role}  ${agent.status}  ${agent.model}  ${agent.lastActivity}${retentionLabel}`);
		for (const child of agents.filter((candidate) => candidate.parentId === agent.id)) visit(child, `${indent}  `);
	};
	if (rootId) {
		const root = agents.find((agent) => agent.id === rootId);
		if (!root) throw new Error(`Unknown agent ${rootId}`);
		visit(root, "");
	} else {
		const visibleIds = new Set(agents.map((agent) => agent.id));
		const roots = agents.filter((agent) => !agent.parentId || !visibleIds.has(agent.parentId));
		for (const root of roots) visit(root, "");
	}
	return lines.join("\n") || "No subagents in this run.";
}
