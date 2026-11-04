import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonAgentSessionEvent, RpcSessionState } from "@earendil-works/pi-coding-agent";

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface RpcProcessOptions {
	args: string[];
	cwd: string;
	/** Test or custom Pi entrypoint. Defaults to the currently running Pi installation. */
	cliPath?: string;
	env?: Record<string, string>;
	onEvent?: (event: JsonAgentSessionEvent) => void;
	onExit?: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

export class RpcProcess {
	private child?: ChildProcess;
	private buffer = "";
	private stderr = "";
	private requestCounter = 0;
	private pending = new Map<string, PendingRequest>();
	private idleWaiters = new Set<() => void>();
	private streaming = false;
	private exited = false;
	readonly messages: AgentMessage[] = [];

	constructor(private readonly options: RpcProcessOptions) {}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get isRunning(): boolean {
		return Boolean(this.child && !this.exited);
	}

	get diagnostics(): string {
		return this.stderr;
	}

	async start(): Promise<RpcSessionState> {
		if (this.child) throw new Error("RPC process already started");
		const cliPath = this.options.cliPath ?? process.env.PI_SUBAGENTS_PI_CLI;
		const invocation = cliPath
			? { command: process.execPath, args: [cliPath, "--mode", "rpc", ...this.options.args] }
			: getPiInvocation(["--mode", "rpc", ...this.options.args]);
		const child = spawn(invocation.command, invocation.args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout.on("data", (data: Buffer) => {
			this.buffer += data.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) this.handleLine(line);
		});
		child.stderr.on("data", (data: Buffer) => {
			this.stderr = `${this.stderr}${data.toString()}`.slice(-64 * 1024);
		});
		child.on("error", (error) => {
			this.exited = true;
			this.rejectAll(new Error(`RPC process error: ${error.message}`));
		});
		child.on("close", (code, signal) => {
			this.exited = true;
			this.streaming = false;
			if (this.buffer.trim()) this.handleLine(this.buffer);
			this.buffer = "";
			const error = new Error(`RPC process exited (${code ?? signal ?? "unknown"}). ${this.stderr}`.trim());
			this.rejectAll(error);
			for (const resolve of this.idleWaiters) resolve();
			this.idleWaiters.clear();
			this.options.onExit?.(code, signal, this.stderr);
		});
		const state = await this.request<RpcSessionState>("get_state", {}, 20_000);
		this.streaming = state.isStreaming;
		return state;
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let record: any;
		try {
			record = JSON.parse(line);
		} catch {
			return;
		}
		if (record.type === "response" && record.id) {
			const pending = this.pending.get(record.id);
			if (!pending) return;
			this.pending.delete(record.id);
			clearTimeout(pending.timer);
			if (record.success) pending.resolve(record.data);
			else pending.reject(new Error(record.error ?? "RPC command failed"));
			return;
		}
		if (record.type === "extension_ui_request" && record.id) {
			this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
			return;
		}
		if (record.type === "agent_start") this.streaming = true;
		if (record.type === "agent_settled") {
			this.streaming = false;
			for (const resolve of this.idleWaiters) resolve();
			this.idleWaiters.clear();
		}
		if (record.type === "message_end" && record.message) {
			this.messages.push(record.message as AgentMessage);
			if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
		}
		this.options.onEvent?.(record as JsonAgentSessionEvent);
	}

	private write(record: Record<string, unknown>): void {
		const stdin = this.child?.stdin;
		if (!stdin?.writable) throw new Error("RPC process stdin is not writable");
		stdin.write(`${JSON.stringify(record)}\n`);
	}

	private request<T>(type: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
		if (this.exited) return Promise.reject(new Error(`RPC process is not running. ${this.stderr}`));
		const id = `pi-subagents-${++this.requestCounter}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${type} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write({ id, type, ...payload });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async prompt(message: string): Promise<void> {
		const wasStreaming = this.streaming;
		this.streaming = true;
		try {
			await this.request("prompt", { message, ...(wasStreaming ? { streamingBehavior: "steer" } : {}) });
		} catch (error) {
			this.streaming = false;
			throw error;
		}
	}

	async steer(message: string): Promise<void> {
		await this.request("steer", { message });
	}

	async send(message: string): Promise<void> {
		if (this.streaming) await this.steer(message);
		else await this.prompt(message);
	}

	async abort(): Promise<void> {
		await this.request("abort", {}, 5_000);
		this.streaming = false;
	}

	async getState(): Promise<RpcSessionState> {
		return this.request<RpcSessionState>("get_state", {});
	}

	async getMessages(): Promise<AgentMessage[]> {
		const data = await this.request<{ messages: AgentMessage[] }>("get_messages", {});
		return data.messages;
	}

	async waitForIdle(timeoutMs = 0): Promise<void> {
		if (!this.streaming || this.exited) return;
		await new Promise<void>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const done = () => {
				if (timer) clearTimeout(timer);
				this.idleWaiters.delete(done);
				resolve();
			};
			this.idleWaiters.add(done);
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					this.idleWaiters.delete(done);
					reject(new Error(`Agent did not settle within ${timeoutMs}ms`));
				}, timeoutMs);
			}
		});
	}

	async stop(): Promise<void> {
		if (!this.child || this.exited) return;
		try {
			await this.abort();
		} catch {
			// Process termination below is the fallback when abort cannot settle.
		}
		const child = this.child;
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				done();
			}, 1_500);
			child.once("close", done);
		});
		this.pending.clear();
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
