import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { randomUUID } from "node:crypto";
import { ACTIVE_STATUSES, RUNNING_STATUSES, TERMINAL_STATUSES } from "./constants.ts";
import { subtreeIds } from "./policy.ts";
import type { AgentCommand, AgentRecord, AgentRetention, AgentStatus, Limits, RunState } from "./types.ts";

export class RunStore {
	private state?: RunState;

	private constructor(readonly filePath: string) {}

	static async create(filePath: string, rootSessionId: string, limits: Limits): Promise<RunStore> {
		const store = new RunStore(filePath);
		const now = new Date().toISOString();
		const initial: RunState = {
			schemaVersion: 1,
			runId: randomUUID(),
			rootSessionId,
			createdAt: now,
			limits,
			agents: {},
			commands: [],
		};
		await mkdir(dirname(filePath), { recursive: true });
		try {
			await writeFile(filePath, JSON.stringify(initial, null, 2), { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		store.state = await store.read();
		return store;
	}

	static async open(filePath: string): Promise<RunStore> {
		const store = new RunStore(filePath);
		store.state = await store.read();
		return store;
	}

	get current(): RunState {
		if (!this.state) throw new Error("Run store is not initialized");
		return this.state;
	}

	private async read(): Promise<RunState> {
		const state = JSON.parse(await readFile(this.filePath, "utf8")) as RunState;
		if (state.schemaVersion !== 1 || !state.agents) throw new Error(`${this.filePath}: invalid run state`);
		state.commands ??= [];
		return state;
	}

	async refresh(): Promise<RunState> {
		this.state = await this.read();
		return this.state;
	}

	async update<T>(mutate: (state: RunState) => T | Promise<T>): Promise<T> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const release = await lockfile.lock(this.filePath, {
			realpath: false,
			retries: { retries: 40, factor: 1.15, minTimeout: 20, maxTimeout: 250 },
		});
		try {
			const state = await this.read();
			const result = await mutate(state);
			const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
			await rename(temporary, this.filePath);
			this.state = state;
			return result;
		} finally {
			await release();
		}
	}

	async reserve(input: Omit<AgentRecord, "runId" | "createdAt" | "updatedAt" | "lastActivity" | "status" | "attempt"> & { status?: AgentStatus; attempt?: number }): Promise<AgentRecord> {
		return this.update((state) => {
			const parent = input.parentId ? state.agents[input.parentId] : undefined;
			if (input.parentId && !parent) throw new Error(`Parent agent ${input.parentId} is not in this run`);
			if (parent?.retentionPending) throw new Error(`Parent agent ${parent.id} has a retention transition in progress`);
			if (input.depth > state.limits.maxDepth) throw new Error(`Maximum subagent depth (${state.limits.maxDepth}) reached`);
			if (Object.keys(state.agents).length >= state.limits.maxAgentsPerRun) {
				throw new Error(`Maximum agents per run (${state.limits.maxAgentsPerRun}) reached`);
			}
			if (input.parentId) {
				const children = Object.values(state.agents).filter((agent) => agent.parentId === input.parentId).length;
				if (children >= state.limits.maxChildrenPerAgent) {
					throw new Error(`Parent ${input.parentId} reached its ${state.limits.maxChildrenPerAgent}-child limit`);
				}
			}
			if (input.writer && input.workspace === "shared") {
				const checkout = input.repoRoot ?? input.cwd;
				const conflict = Object.values(state.agents).some(
					(agent) =>
						agent.writer &&
						(agent.repoRoot ?? agent.cwd) === checkout &&
						!TERMINAL_STATUSES.has(agent.status),
				);
				if (conflict) throw new Error(`Writer checkout conflict: ${checkout}`);
			}
			const now = new Date().toISOString();
			const record: AgentRecord = {
				...input,
				runId: state.runId,
				status: input.status ?? "queued",
				attempt: input.attempt ?? 1,
				retention: input.retention ?? "reusable",
				createdAt: now,
				updatedAt: now,
				lastActivity: "Queued",
			};
			state.agents[record.id] = record;
			return record;
		});
	}

	async tryStart(agentId: string): Promise<boolean> {
		return this.update((state) => {
			const agent = state.agents[agentId];
			if (!agent || agent.status !== "queued") return false;
			if (agent.retentionPending) throw new Error(`Agent ${agentId} has a retention transition in progress`);
			const running = Object.values(state.agents).filter((candidate) => RUNNING_STATUSES.has(candidate.status)).length;
			if (running >= state.limits.maxConcurrent) return false;
			agent.status = "starting";
			agent.updatedAt = new Date().toISOString();
			agent.lastActivity = "Starting RPC process";
			return true;
		});
	}

	async patch(agentId: string, patch: Partial<Pick<AgentRecord, "status" | "pid" | "sessionFile" | "lastActivity" | "error" | "report" | "attempt" | "retention">>): Promise<AgentRecord> {
		return this.update((state) => {
			const agent = state.agents[agentId];
			if (!agent) throw new Error(`Unknown agent ${agentId}`);
			const restartsAgent = patch.status === "running" || patch.status === "queued" || patch.status === "starting";
			if (agent.retentionPending && (restartsAgent || patch.retention === "reusable")) {
				throw new Error(`Agent ${agentId} has a retention transition in progress`);
			}
			Object.assign(agent, patch, { updatedAt: new Date().toISOString() });
			return agent;
		});
	}

	async beginRetention(agentId: string, retention: Exclude<AgentRetention, "reusable">): Promise<AgentRecord[]> {
		return this.update((state) => {
			if (!state.agents[agentId]) throw new Error(`Unknown agent ${agentId}`);
			const records = subtreeIds(state, agentId).map((id) => state.agents[id]);
			const active = records.find((agent) => ACTIVE_STATUSES.has(agent.status));
			if (active) throw new Error(`Agent ${active.id} is still active (${active.status})`);
			const transitioning = records.find((agent) => agent.retentionPending);
			if (transitioning) throw new Error(`Agent ${transitioning.id} already has a retention transition in progress`);
			const now = new Date().toISOString();
			for (const agent of records) {
				agent.retentionPending = retention;
				agent.updatedAt = now;
			}
			return records;
		});
	}

	async clearRetentionPending(agentIds: string[]): Promise<void> {
		await this.update((state) => {
			for (const id of agentIds) {
				const agent = state.agents[id];
				if (agent) agent.retentionPending = undefined;
			}
		});
	}

	async setRetention(agentIds: string[], retention: AgentRetention): Promise<AgentRecord[]> {
		return this.update((state) => {
			const records = agentIds.map((id) => {
				const agent = state.agents[id];
				if (!agent) throw new Error(`Unknown agent ${id}`);
				return agent;
			});
			if (retention !== "reusable") {
				const active = records.find((agent) => ACTIVE_STATUSES.has(agent.status));
				if (active) throw new Error(`Agent ${active.id} is still active (${active.status})`);
			}
			const now = new Date().toISOString();
			for (const agent of records) {
				agent.retention = retention;
				agent.retentionPending = undefined;
				agent.updatedAt = now;
			}
			return records;
		});
	}

	async enqueue(targetId: string, kind: AgentCommand["kind"], message?: string, retention?: AgentRetention): Promise<AgentCommand> {
		return this.update((state) => {
			if (!state.agents[targetId]) throw new Error(`Unknown agent ${targetId}`);
			const command: AgentCommand = {
				id: randomUUID(),
				targetId,
				kind,
				message,
				retention,
				createdAt: new Date().toISOString(),
			};
			state.commands.push(command);
			return command;
		});
	}

	async takeCommands(targetIds: Set<string>): Promise<AgentCommand[]> {
		if (!this.current.commands.some((command) => targetIds.has(command.targetId))) return [];
		return this.update((state) => {
			const commands = state.commands.filter((command) => targetIds.has(command.targetId));
			if (commands.length === 0) return [];
			const ids = new Set(commands.map((command) => command.id));
			state.commands = state.commands.filter((command) => !ids.has(command.id));
			return commands;
		});
	}

	async stopSubtree(agentId: string, error = "Stopped by user or parent"): Promise<string[]> {
		return this.update((state) => {
			const ids: string[] = [];
			const visit = (id: string) => {
				ids.push(id);
				for (const child of Object.values(state.agents)) if (child.parentId === id) visit(child.id);
			};
			visit(agentId);
			for (const id of ids) {
				const agent = state.agents[id];
				if (!TERMINAL_STATUSES.has(agent.status)) {
					agent.status = "stopping";
					agent.error = error;
					agent.lastActivity = "Stopping subtree";
					agent.updatedAt = new Date().toISOString();
				}
			}
			return ids;
		});
	}

	async markStopped(agentId: string, status: Extract<AgentStatus, "done" | "failed" | "stopped">, error?: string): Promise<void> {
		await this.patch(agentId, {
			status,
			error,
			lastActivity: status === "done" ? "Completed" : status === "failed" ? "Failed" : "Stopped",
		});
	}

	list(): AgentRecord[] {
		return Object.values(this.current.agents).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	descendants(agentId: string): AgentRecord[] {
		const output: AgentRecord[] = [];
		const visit = (id: string) => {
			for (const child of Object.values(this.current.agents).filter((agent) => agent.parentId === id)) {
				output.push(child);
				visit(child.id);
			}
		};
		visit(agentId);
		return output;
	}
}
