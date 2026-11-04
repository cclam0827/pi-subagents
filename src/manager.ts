import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { capRoleTools, getRole, loadRuntimeConfig } from "./config.ts";
import { ACTIVE_STATUSES, ENV, RUNNING_STATUSES, TERMINAL_STATUSES } from "./constants.ts";
import { effectiveLevel, effectiveSelection, resolveModel } from "./model.ts";
import { getExtensionEntrypoint, getRunStateDir } from "./paths.ts";
import { formatAgentTree } from "./policy.ts";
import { finalAssistantText, formatAgentReport, parseAgentReport } from "./report.ts";
import { RpcProcess } from "./rpc-process.ts";
import { RunStore } from "./run-store.ts";
import type {
	AgentDefinition,
	AgentEvent,
	AgentRecord,
	AgentReport,
	AgentRetention,
	SpawnRequest,
	SpawnResult,
	SubagentsConfig,
} from "./types.ts";
import { cleanupWorkspace, prepareWorkspace } from "./workspace.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SubagentManager {
	private store?: RunStore;
	private context?: ExtensionContext;
	private handles = new Map<string, RpcProcess>();
	private transcripts = new Map<string, AgentMessage[]>();
	private promptDirs = new Map<string, string>();
	private listeners = new Set<(event: AgentEvent) => void>();
	private notified = new Set<string>();
	private pollTimer?: NodeJS.Timeout;
	private polling = false;
	private stopping = false;
	private readonly childAgentId = process.env[ENV.agentId];
	private readonly childDepth = Number.parseInt(process.env[ENV.depth] ?? "0", 10) || 0;

	constructor(private readonly pi: ExtensionAPI) {}

	get isChild(): boolean {
		return process.env[ENV.child] === "1" && Boolean(this.childAgentId);
	}

	get currentAgentId(): string | null {
		return this.isChild ? (this.childAgentId ?? null) : null;
	}

	get currentDepth(): number {
		return this.childDepth;
	}

	async initialize(ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		if (this.store) return;
		const inheritedRunFile = process.env[ENV.runFile];
		if (inheritedRunFile) {
			this.store = await RunStore.open(inheritedRunFile);
		} else {
			const runtime = await loadRuntimeConfig(ctx.cwd, ctx.isProjectTrusted());
			this.store = await RunStore.create(
				join(getRunStateDir(), `${ctx.sessionManager.getSessionId()}.json`),
				ctx.sessionManager.getSessionId(),
				runtime.config.limits,
			);
			if (Object.keys(this.store.current.agents).length > 0) {
				for (const agent of this.store.list()) {
					if (ACTIVE_STATUSES.has(agent.status)) {
						await this.store.markStopped(agent.id, "stopped", "Previous Pi process exited");
					}
				}
				const pendingAgents = this.store.list().filter((agent) => agent.retentionPending);
				if (pendingAgents.length > 0) {
					for (const agent of pendingAgents) {
						if (!agent.pid || agent.pid === process.pid) continue;
						try {
							process.kill(agent.pid, "SIGTERM");
						} catch {
							// The previous owner already exited.
						}
					}
					await this.store.update((state) => {
						const now = new Date().toISOString();
						for (const agent of pendingAgents) {
							const current = state.agents[agent.id];
							if (current) {
								current.retentionPending = undefined;
								current.updatedAt = now;
							}
						}
						state.commands = state.commands.filter((command) => command.kind !== "retention");
					});
				}
			}
		}
		this.pollTimer = setInterval(() => void this.poll(), 250);
		this.pollTimer.unref();
		this.emit({ type: "status", agentId: this.currentAgentId ?? "root" });
	}

	onEvent(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private requireStore(): RunStore {
		if (!this.store) throw new Error("Subagent manager is not initialized");
		return this.store;
	}

	private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		if (this.context?.mode === "tui") this.context.ui.notify(message, type);
	}

	async listAgents(ctx?: ExtensionContext): Promise<AgentRecord[]> {
		if (ctx) await this.initialize(ctx);
		const store = this.requireStore();
		await store.refresh();
		const currentId = this.currentAgentId;
		if (!currentId) return store.list();
		const self = store.current.agents[currentId];
		return self ? [self, ...store.descendants(currentId)] : store.descendants(currentId);
	}

	async getTranscript(agentId: string): Promise<AgentMessage[]> {
		const local = this.transcripts.get(agentId);
		if (local) return local;
		const handle = this.handles.get(agentId);
		if (handle) {
			const messages = await handle.getMessages();
			this.transcripts.set(agentId, messages);
			return messages;
		}
		const agent = this.getAgent(agentId);
		if (agent?.sessionFile && existsSync(agent.sessionFile)) {
			const session = SessionManager.open(agent.sessionFile);
			const messages = session
				.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message);
			this.transcripts.set(agentId, messages);
			return messages;
		}
		return [];
	}

	getAgent(agentId: string): AgentRecord | undefined {
		return this.requireStore().current.agents[agentId];
	}

	formatList(agents: AgentRecord[]): string {
		return formatAgentTree(agents, this.currentAgentId ?? undefined);
	}

	async spawn(request: SpawnRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<SpawnResult> {
		await this.initialize(ctx);
		if (!request.task.trim()) throw new Error("task is required");
		const runtime = await loadRuntimeConfig(ctx.cwd, ctx.isProjectTrusted());
		for (const warning of runtime.warnings) this.notify(warning, "warning");
		const role = getRole(runtime.agents, request.role);
		const store = this.requireStore();
		await store.refresh();
		const parentId = this.currentAgentId;
		const depth = this.childDepth + 1;
		const selection = effectiveSelection(role.model, request.model, runtime.config);
		const level = effectiveLevel(selection, request.level);
		const resolution = resolveModel({
			registry: ctx.modelRegistry,
			parentModel: ctx.model,
			selection,
			level,
			config: runtime.config,
		});
		if (resolution.warning) this.notify(resolution.warning, "warning");

		const explicitlySelected = Boolean(request.model || request.level);
		if (runtime.config.confirmMax && level === "max" && !explicitlySelected) {
			if (ctx.mode !== "tui") {
				throw new Error("Automatic max-level dispatch requires confirmation in an interactive session or an explicit level/model override");
			}
			const confirmed = await ctx.ui.confirm(
				"Use max-level model?",
				`${role.name}: ${resolution.reference}\n\nTask: ${request.task.slice(0, 500)}`,
			);
			if (!confirmed) throw new Error("Max-level dispatch cancelled");
		}
		if (runtime.projectModelOverride && !explicitlySelected) {
			if (ctx.mode !== "tui") throw new Error("Project model override requires confirmation or an explicit model");
			const confirmed = await ctx.ui.confirm("Allow project model override?", `Use ${resolution.reference} for ${role.name}?`);
			if (!confirmed) throw new Error("Project model override cancelled");
		}

		const id = `agent-${randomUUID()}`;
		const tools = capRoleTools(role, runtime.config.allowedTools, depth, runtime.config.limits.maxDepth);
		let workspace = await prepareWorkspace({
			agentId: id,
			role,
			cwd: request.cwd ?? ctx.cwd,
			agents: store.list(),
		});
		let record: AgentRecord;
		try {
			record = await store.reserve({
				id,
				parentId,
				depth,
				role: role.name,
				task: request.task,
				model: resolution.reference,
				level,
				thinking: resolution.thinking,
				tools,
				instructions: role.instructions,
				extensions: runtime.config.childExtensions,
				...workspace,
				status: "queued",
			});
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Writer checkout conflict") && role.isolation === "auto") {
				workspace = await prepareWorkspace({
					agentId: id,
					role: { ...role, isolation: "worktree" },
					cwd: request.cwd ?? ctx.cwd,
					agents: store.list(),
				});
				record = await store.reserve({
					id,
					parentId,
					depth,
					role: role.name,
					task: request.task,
					model: resolution.reference,
					level,
					thinking: resolution.thinking,
					tools,
					instructions: role.instructions,
					extensions: runtime.config.childExtensions,
					...workspace,
					status: "queued",
				});
			} else {
				await cleanupWorkspace({ id, ...workspace } as AgentRecord);
				throw error;
			}
		}
		this.emit({ type: "status", agentId: id, status: "queued" });
		try {
			await this.waitForSlot(id, signal);
			await this.launch(record, request.task, false);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await store.markStopped(id, "failed", message).catch(() => undefined);
			await cleanupWorkspace(store.current.agents[id]);
			throw error;
		}
		const started = this.getAgent(id);
		if (!started) throw new Error(`Agent ${id} disappeared from its run store`);
		const result: SpawnResult = {
			agent: started,
			warning: resolution.warning,
		};
		if (request.wait) {
			const completed = await this.waitForAgent(id, signal);
			result.agent = completed;
			result.report = completed.report;
		}
		return result;
	}

	private async waitForSlot(agentId: string, signal?: AbortSignal): Promise<void> {
		const store = this.requireStore();
		while (!(await store.tryStart(agentId))) {
			if (signal?.aborted) {
				await store.markStopped(agentId, "stopped", "Spawn aborted");
				throw new Error("Spawn aborted");
			}
			const agent = store.current.agents[agentId];
			if (!agent || agent.status !== "queued") throw new Error(`Agent ${agentId} cannot start from status ${agent?.status}`);
			await sleep(100);
		}
		this.emit({ type: "status", agentId, status: "starting" });
	}

	private async launch(record: AgentRecord, prompt: string, resume: boolean): Promise<void> {
		const store = this.requireStore();
		const promptDir = await mkdtemp(join(tmpdir(), "pi-subagents-"));
		this.promptDirs.set(record.id, promptDir);
		const promptPath = join(promptDir, "instructions.md");
		await writeFile(promptPath, record.instructions, { mode: 0o600 });
		const args = [
			"--provider",
			record.model.split("/")[0],
			"--model",
			record.model.split("/").slice(1).join("/"),
			"--thinking",
			record.thinking,
			"--append-system-prompt",
			promptPath,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"-e",
			getExtensionEntrypoint(),
		];
		for (const extension of record.extensions) args.push("-e", extension);
		if (record.tools.length > 0) args.push("--tools", record.tools.join(","));
		else args.push("--no-tools");
		if (resume && record.sessionFile && existsSync(record.sessionFile)) args.push("--session", record.sessionFile);

		let settling = false;
		const rpc = new RpcProcess({
			args,
			cwd: record.cwd,
			env: {
				[ENV.child]: "1",
				[ENV.runFile]: store.filePath,
				[ENV.runId]: record.runId,
				[ENV.agentId]: record.id,
				[ENV.depth]: String(record.depth),
			},
			onEvent: (event) => {
				if (event.type === "message_end" && event.message) {
					this.transcripts.set(record.id, [...rpc.messages]);
					this.emit({ type: "message", agentId: record.id, message: event.message });
				}
				if (event.type === "tool_execution_start") {
					void store.patch(record.id, { lastActivity: `${event.toolName} ${this.compactArgs(event.args)}` }).catch(() => undefined);
					this.emit({ type: "activity", agentId: record.id, activity: event.toolName });
				}
				if (event.type === "agent_settled" && !settling) {
					settling = true;
					void this.finalize(record.id, event.aborted).finally(() => {
						settling = false;
					});
				}
			},
			onExit: (_code, _signal, stderr) => {
				const current = store.current.agents[record.id];
				if (current && RUNNING_STATUSES.has(current.status)) {
					void store.markStopped(record.id, "failed", stderr || "RPC process exited unexpectedly");
					this.emit({ type: "status", agentId: record.id, status: "failed" });
				}
			},
		});
		this.handles.set(record.id, rpc);
		try {
			const state = await rpc.start();
			await store.patch(record.id, {
				status: "running",
				pid: rpc.pid,
				sessionFile: state.sessionFile,
				lastActivity: resume ? "Resumed" : "Running",
			});
			if (resume) this.transcripts.set(record.id, await rpc.getMessages());
			this.notified.delete(record.id);
			this.emit({ type: "status", agentId: record.id, status: "running" });
			await rpc.prompt(this.taskPrompt(record, prompt));
		} catch (error) {
			await rpc.stop();
			this.handles.delete(record.id);
			throw error;
		}
	}

	private compactArgs(args: unknown): string {
		const text = typeof args === "string" ? args : JSON.stringify(args);
		return text.length > 80 ? `${text.slice(0, 77)}...` : text;
	}

	private taskPrompt(record: AgentRecord, prompt: string): string {
		return [
			`Task: ${prompt}`,
			"",
			`Agent ID: ${record.id}`,
			`Run ID: ${record.runId}`,
			`Depth: ${record.depth}`,
			`Working directory: ${record.cwd}`,
			"Report only to your direct parent. Keep the final response within the requested structured report format.",
		].join("\n");
	}

	private async finalize(agentId: string, aborted: boolean): Promise<void> {
		const store = this.requireStore();
		await store.refresh();
		const agent = store.current.agents[agentId];
		if (!agent || TERMINAL_STATUSES.has(agent.status)) return;
		const messages = this.transcripts.get(agentId) ?? [];
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
		const errorMessage =
			lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error"
				? lastAssistant.errorMessage || "Model error"
				: undefined;
		if (aborted || agent.status === "stopping") {
			await store.markStopped(agentId, "stopped", agent.error || "Aborted");
		} else if (errorMessage) {
			await store.markStopped(agentId, "failed", errorMessage);
		} else {
			const report = parseAgentReport(finalAssistantText(messages));
			await store.patch(agentId, { status: "done", report, lastActivity: "Completed" });
		}
		const completed = store.current.agents[agentId];
		this.emit({ type: "status", agentId, status: completed.status });
		if (completed.parentId === this.currentAgentId && !this.notified.has(agentId)) {
			this.notified.add(agentId);
			this.deliverCompletion(completed);
		}
	}

	private deliverCompletion(agent: AgentRecord): void {
		const text = agent.report
			? formatAgentReport(agent.report)
			: `Agent ${agent.id} ${agent.status}: ${agent.error ?? "No report"}`;
		this.pi.sendMessage(
			{
				customType: "pi-subagents.completion",
				content: `Subagent ${agent.id} (${agent.role}) ${agent.status}.\n\n${text}`,
				display: true,
				details: { agentId: agent.id, status: agent.status, report: agent.report },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	async waitForAgent(agentId: string, signal?: AbortSignal): Promise<AgentRecord> {
		const store = this.requireStore();
		while (true) {
			await store.refresh();
			const agent = store.current.agents[agentId];
			if (!agent) throw new Error(`Unknown agent ${agentId}`);
			if (TERMINAL_STATUSES.has(agent.status)) {
				this.notified.add(agentId);
				if (agent.status === "failed") throw new Error(agent.error || `Agent ${agentId} failed`);
				return agent;
			}
			if (signal?.aborted) {
				await this.stopSubtree(agentId, "Wait aborted");
				throw new Error("Wait aborted");
			}
			await sleep(100);
		}
	}

	private isProcessAlive(pid: number | undefined): boolean {
		if (!pid) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	async messageAgent(agentId: string, message: string): Promise<void> {
		if (!message.trim()) throw new Error("message is required");
		const store = this.requireStore();
		await store.refresh();
		const agent = store.current.agents[agentId];
		if (!agent) throw new Error(`Unknown agent ${agentId}`);
		if (agent.retentionPending) throw new Error(`Agent ${agentId} has a ${agent.retentionPending} transition in progress`);
		if (agent.retention && agent.retention !== "reusable") await store.patch(agentId, { retention: "reusable" });
		const handle = this.handles.get(agentId);
		if (!handle) {
			await this.resumeAgent(agentId, message);
			return;
		}
		if (TERMINAL_STATUSES.has(agent.status)) {
			await store.patch(agentId, { status: "running", attempt: agent.attempt + 1, error: undefined, report: undefined });
		} else {
			await store.patch(agentId, { status: "running", lastActivity: "Received steering message" });
		}
		this.notified.delete(agentId);
		await handle.send(message);
	}

	async resumeAgent(agentId: string, message: string): Promise<void> {
		const store = this.requireStore();
		await store.refresh();
		let agent = store.current.agents[agentId];
		if (!agent) throw new Error(`Unknown agent ${agentId}`);
		if (agent.retentionPending) throw new Error(`Agent ${agentId} has a ${agent.retentionPending} transition in progress`);
		if (agent.status === "stopping") throw new Error(`Agent ${agentId} is stopping`);
		if (agent.retention && agent.retention !== "reusable") {
			agent = await store.patch(agentId, { retention: "reusable" });
		}
		const owner = agent.parentId ? store.current.agents[agent.parentId] : undefined;
		// Idle agents are done, but their long-lived owner process can still route follow-ups.
		const remoteOwnerIsLive = Boolean(
			agent.parentId !== this.currentAgentId && owner && (RUNNING_STATUSES.has(owner.status) || this.isProcessAlive(owner.pid)),
		);
		if (remoteOwnerIsLive) {
			if (TERMINAL_STATUSES.has(agent.status)) {
				await store.patch(agentId, {
					status: "running",
					attempt: agent.attempt + 1,
					error: undefined,
					report: undefined,
					lastActivity: "Received follow-up message",
				});
			} else {
				await store.patch(agentId, { lastActivity: "Received steering message" });
			}
			this.notified.delete(agentId);
			await store.enqueue(agentId, "message", message);
			return;
		}
		await this.resumeAgentProcess(agentId, message, true);
	}

	private async resumeAgentProcess(agentId: string, message: string, advanceAttempt: boolean): Promise<void> {
		const store = this.requireStore();
		await store.refresh();
		let agent = store.current.agents[agentId];
		if (!agent) throw new Error(`Unknown agent ${agentId}`);
		if (agent.retentionPending) throw new Error(`Agent ${agentId} has a ${agent.retentionPending} transition in progress`);
		if (this.handles.has(agentId)) {
			await this.messageAgent(agentId, message);
			return;
		}
		if (ACTIVE_STATUSES.has(agent.status) && this.isProcessAlive(agent.pid)) {
			throw new Error(`Agent ${agentId} is ${agent.status} and its RPC process is still alive; refusing to start a duplicate`);
		}
		agent = await store.patch(agentId, {
			status: "queued",
			retention: "reusable",
			attempt: agent.attempt + (advanceAttempt ? 1 : 0),
			error: undefined,
			report: undefined,
			lastActivity: "Queued for resume",
		});
		await this.waitForSlot(agentId);
		await this.launch(agent, message, true);
	}

	async setRetention(agentId: string, retention: AgentRetention): Promise<AgentRecord[]> {
		return this.transitionRetention(agentId, retention, false);
	}

	private async transitionRetention(agentId: string, retention: AgentRetention, continuation: boolean): Promise<AgentRecord[]> {
		const store = this.requireStore();
		await store.refresh();
		const root = store.current.agents[agentId];
		if (!root) throw new Error(`Unknown agent ${agentId}`);
		if (retention === "reusable") {
			if (root.retentionPending) throw new Error(`Agent ${agentId} has a ${root.retentionPending} transition in progress`);
			const records = await store.setRetention([agentId], retention);
			this.emit({ type: "status", agentId, status: records[0].status });
			return records;
		}

		if (continuation && root.retentionPending !== retention) {
			throw new Error(`Agent ${agentId} is not waiting for ${retention} cleanup`);
		}
		const subtree = continuation ? [root, ...store.descendants(agentId)] : await store.beginRetention(agentId, retention);
		const agentIds = subtree.map((agent) => agent.id);
		let cleanupStarted = false;
		try {
			const owner = root.parentId ? store.current.agents[root.parentId] : undefined;
			const remoteOwnerIsLive = Boolean(
				root.parentId !== this.currentAgentId && owner && (RUNNING_STATUSES.has(owner.status) || this.isProcessAlive(owner.pid)),
			);
			if (remoteOwnerIsLive) {
				await store.enqueue(agentId, "retention", undefined, retention);
				cleanupStarted = true;
				const deadline = Date.now() + 5_000;
				while (true) {
					await store.refresh();
					const current = store.current.agents[agentId];
					if (current?.retention === retention && !current.retentionPending) {
						const records = [current, ...store.descendants(agentId)];
						for (const agent of records) this.emit({ type: "status", agentId: agent.id, status: agent.status });
						return records;
					}
					if (Date.now() >= deadline) {
						throw new Error(`Timed out waiting for the direct owner to ${retention} ${agentId}; cleanup remains pending and can be recovered by restarting the root session`);
					}
					await sleep(50);
				}
			}

			cleanupStarted = true;
			await store.refresh();
			const children = store.list().filter((agent) => agent.parentId === agentId);
			for (const child of children) {
				if (child.retention === retention && !child.retentionPending) continue;
				if (child.retentionPending === retention) await this.transitionRetention(child.id, retention, true);
			}

			await this.stopSubtree(agentId, retention === "released" ? "Released by orchestrator" : "Archived by orchestrator");
			const records = await store.setRetention(agentIds, retention);
			for (const agent of records) this.emit({ type: "status", agentId: agent.id, status: agent.status });
			return records;
		} catch (error) {
			if (!cleanupStarted) await store.clearRetentionPending(agentIds).catch(() => undefined);
			throw error;
		}
	}

	async stopSubtree(agentId: string, reason = "Stopped by user or parent"): Promise<void> {
		const store = this.requireStore();
		const ids = await store.stopSubtree(agentId, reason);
		for (const id of ids) this.emit({ type: "status", agentId: id, status: "stopping" });
		await Promise.all(
			ids.map(async (id) => {
				const handle = this.handles.get(id);
				if (handle) {
					await handle.stop();
					this.handles.delete(id);
					const current = store.current.agents[id];
					if (current && !TERMINAL_STATUSES.has(current.status)) await store.markStopped(id, "stopped", reason);
					await cleanupWorkspace(store.current.agents[id]);
					this.emit({ type: "status", agentId: id, status: store.current.agents[id]?.status ?? "stopped" });
				}
			}),
		);
		setTimeout(() => {
			for (const id of ids) {
				if (id === this.currentAgentId || this.handles.has(id)) continue;
				const agent = store.current.agents[id];
				if (agent?.status === "stopping" && agent.pid) {
					try {
						process.kill(agent.pid, "SIGTERM");
					} catch {
						// Already exited.
					}
				}
			}
		}, 1_000).unref();
	}

	private async poll(): Promise<void> {
		if (this.polling || !this.store || this.stopping) return;
		this.polling = true;
		try {
			const store = this.store;
			await store.refresh();
			const own = this.currentAgentId ? store.current.agents[this.currentAgentId] : undefined;
			if (own?.status === "stopping" && this.context) {
				this.stopping = true;
				this.context.abort();
				await this.stopLocalProcesses();
				this.context.shutdown();
				return;
			}
			for (const agent of store.list()) this.emit({ type: "status", agentId: agent.id, status: agent.status });
			const ownedIds = new Set(
				store.list().filter((agent) => agent.parentId === this.currentAgentId).map((agent) => agent.id),
			);
			const commands = await store.takeCommands(ownedIds);
			for (const command of commands) {
				if (command.kind === "message" && command.message) {
					const handle = this.handles.get(command.targetId);
					if (handle) {
						this.notified.delete(command.targetId);
						await handle.send(command.message);
					} else {
						// The requester already advanced the attempt when it queued this command.
						await this.resumeAgentProcess(command.targetId, command.message, false);
					}
				} else if (command.kind === "stop") {
					await this.stopSubtree(command.targetId, "Stopped through run command");
				} else if (command.kind === "retention" && command.retention) {
					await this.transitionRetention(command.targetId, command.retention, true);
				}
			}
		} catch {
			// A process may exit while another process replaces the run file. The next poll retries.
		} finally {
			this.polling = false;
		}
	}

	private async stopLocalProcesses(): Promise<void> {
		const ids = [...this.handles.keys()];
		await Promise.all(
			ids.map(async (id) => {
				const handle = this.handles.get(id);
				await handle?.stop();
				this.handles.delete(id);
				const current = this.requireStore().current.agents[id];
				if (current && !TERMINAL_STATUSES.has(current.status)) {
					await this.requireStore().markStopped(id, "stopped", "Parent process exited").catch(() => undefined);
				}
			}),
		);
	}

	async shutdown(): Promise<void> {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		if (!this.store) return;
		if (this.currentAgentId) {
			await this.stopSubtree(this.currentAgentId, "Parent Pi session shut down");
		} else {
			const roots = this.store.list().filter((agent) => !agent.parentId);
			for (const root of roots) await this.stopSubtree(root.id, "Parent Pi session shut down");
		}
		await this.stopLocalProcesses();
		for (const dir of this.promptDirs.values()) await rm(dir, { recursive: true, force: true });
		this.promptDirs.clear();
	}
}
