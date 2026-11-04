import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	SelectList,
	type Component,
	type EditorComponent,
	type SelectItem,
	type Theme,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "./tui.ts";
import type { SubagentManager } from "./manager.ts";
import { ACTIVE_STATUSES } from "./constants.ts";
import { agentsForView } from "./policy.ts";
import type { AgentRecord } from "./types.ts";

function messageText(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.map((part) => {
				if (part.type === "text") return part.text;
				if (part.type === "toolCall") return `→ ${part.name} ${JSON.stringify(part.arguments)}`;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (message.role === "toolResult") {
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	if (message.role === "custom") return typeof message.content === "string" ? message.content : "(custom message)";
	return "(message)";
}

class TranscriptView implements Component {
	private _focused = false;
	capturesViewportInput = true;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}
	private messages: AgentMessage[] = [];
	private scroll = 0;
	private input = new Input({ prompt: "> ", placeholder: "Message this agent…" });
	private loading = true;

	constructor(
		private readonly manager: SubagentManager,
		private agent: AgentRecord,
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			const message = value.trim();
			if (!message) return;
			this.input.setValue("");
			void this.manager.messageAgent(this.agent.id, message).then(() => this.reload());
		};
		this.input.onEscape = () => {
			if (this.input.getValue()) this.input.setValue("");
			else this.done();
		};
		void this.reload();
	}

	async reload(): Promise<void> {
		this.messages = await this.manager.getTranscript(this.agent.id);
		this.agent = this.manager.getAgent(this.agent.id) ?? this.agent;
		this.loading = false;
		this.scroll = 0;
		this.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (!this.input.getValue()) this.done();
			else this.input.handleInput(data);
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
			this.scroll += 5;
			return;
		}
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
			this.scroll = Math.max(0, this.scroll - 5);
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const title = ` ${this.agent.role} · ${this.agent.id} · ${this.agent.status} `;
		const model = ` ${this.agent.level} → ${this.agent.model} · attempt ${this.agent.attempt} `;
		const lines = this.messages.flatMap((message) => {
			const role = message.role === "assistant" ? "Agent" : message.role === "user" ? "Parent" : message.role;
			return `${role}: ${messageText(message)}`.split("\n");
		});
		const visibleCount = 18;
		const end = Math.max(0, lines.length - this.scroll);
		const start = Math.max(0, end - visibleCount);
		const visible = this.loading ? ["Loading transcript…"] : lines.slice(start, end);
		if (visible.length === 0) visible.push("No messages yet.");
		const scrollHint = this.scroll > 0 ? ` · ${this.scroll} lines from bottom` : "";
		return [
			truncateToWidth(title, width),
			truncateToWidth(model, width),
			"─".repeat(Math.max(1, width)),
			...visible.map((line) => truncateToWidth(line, width)),
			"─".repeat(Math.max(1, width)),
			truncateToWidth(`↑↓/PgUp/PgDn scroll${scrollHint} · Enter send · Esc back`, width),
			...this.input.render(width),
		].map((line) => truncateToWidth(line, width));
	}
}

export class AgentPanelController {
	private panel?: Component & { focused: boolean; handleInput(data: string): void };
	private editor?: EditorComponent;
	private agents: AgentRecord[] = [];
	private selectedId?: string;
	private unsubscribe?: () => void;
	private restoreEditor?: () => void;
	private opening = false;
	private tui?: TUI;

	constructor(
		private readonly manager: SubagentManager,
		private readonly ctx: ExtensionContext,
	) {}

	install(): void {
		if (this.manager.isChild || this.ctx.mode !== "tui") return;
		this.ctx.ui.setWidget(
			"pi-subagents.panel",
			(tui, theme) => {
				this.tui = tui;
				this.panel = this.createPanel(tui, theme);
				return this.panel;
			},
			{ placement: "belowEditor" },
		);
		const previous = this.ctx.ui.getEditorComponent();
		this.restoreEditor = () => this.ctx.ui.setEditorComponent(previous);
		this.ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			this.tui = tui;
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			this.editor = editor;
			const original = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				if (this.shouldEnterPanel(editor, data) && this.panel) {
					tui.setFocus(this.panel);
					this.panel.focused = true;
					return;
				}
				original(data);
			};
			return editor;
		});
		this.unsubscribe = this.manager.onEvent(() => void this.refresh());
		void this.refresh();
	}

	private shouldEnterPanel(editor: EditorComponent, data: string): boolean {
		if (agentsForView(this.agents, "panel").length === 0 || !matchesKey(data, Key.down)) return false;
		const candidate = editor as EditorComponent & {
			isShowingAutocomplete?: () => boolean;
			getCursor?: () => { line: number; col: number };
			getLines?: () => string[];
		};
		if (!candidate.getCursor || !candidate.getLines || candidate.isShowingAutocomplete?.()) return false;
		const cursor = candidate.getCursor();
		return cursor.line === candidate.getLines().length - 1;
	}

	private createPanel(tui: TUI, theme: Theme): Component & { focused: boolean; handleInput(data: string): void } {
		const controller = this;
		return {
			focused: false,
			invalidate() {},
			render(width: number): string[] {
				if (controller.agents.length === 0) {
					return [theme.fg("dim", truncateToWidth("No subagents · the orchestrator can spawn them automatically", width))];
				}
				const visibleAgents = agentsForView(controller.agents, "panel");
				const historyCount = controller.agents.length - visibleAgents.length;
				if (visibleAgents.length === 0) {
					return [theme.fg("dim", truncateToWidth(`No active agents · ${historyCount} in history · /agents all`, width))];
				}
				const activeCount = visibleAgents.filter((agent) => ACTIVE_STATUSES.has(agent.status)).length;
				const reusableCount = visibleAgents.length - activeCount;
				const selectedIndex = Math.max(0, visibleAgents.findIndex((agent) => agent.id === controller.selectedId));
				const start = Math.max(0, Math.min(selectedIndex - 2, visibleAgents.length - 6));
				const end = Math.min(visibleAgents.length, start + 6);
				const range = visibleAgents.length > 6 ? ` · ${start + 1}–${end}/${visibleAgents.length}` : "";
				const lines = [
					theme.fg(
						"muted",
						truncateToWidth(
							`Agents ${activeCount} active · ${reusableCount} reusable · ${historyCount} in history${range} · ↓ select · /agents list`,
							width,
						),
					),
				];
				for (const agent of visibleAgents.slice(start, end)) {
					const selected = agent.id === controller.selectedId;
					const marker = selected ? "›" : " ";
					const active = ACTIVE_STATUSES.has(agent.status);
					const status = active ? "◐" : "✓";
					const indent = "  ".repeat(Math.max(0, agent.depth - 1));
					const activity = active
						? `${agent.status} · ${agent.lastActivity}`
						: `reusable${agent.attempt > 1 ? ` · ${agent.attempt} attempts` : ""}`;
					const text = `${marker} ${status} ${indent}${agent.role} · ${activity}`;
					const line = truncateToWidth(text, width);
					lines.push(selected ? theme.fg("accent", line) : theme.fg("muted", line));
				}
				if (controller.panel?.focused) {
					lines.push(theme.fg("dim", truncateToWidth("↑↓ select · Enter transcript · x stop · Esc input", width)));
				}
				return lines;
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					controller.focusEditor();
					return;
				}
				if (matchesKey(data, Key.up)) {
					controller.moveSelection(-1);
					return;
				}
				if (matchesKey(data, Key.down)) {
					controller.moveSelection(1);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					void controller.openSelected();
					return;
				}
				if (data === "x") {
					void controller.stopSelected();
				}
			},
		};
	}

	private focusEditor(): void {
		if (this.panel) this.panel.focused = false;
		if (this.panel && this.editor) this.tui?.setFocus(this.editor);
	}

	private moveSelection(delta: number): void {
		const visibleAgents = agentsForView(this.agents, "panel");
		if (visibleAgents.length === 0) return;
		const current = visibleAgents.findIndex((agent) => agent.id === this.selectedId);
		const next = (Math.max(0, current) + delta + visibleAgents.length) % visibleAgents.length;
		this.selectedId = visibleAgents[next].id;
	}

	private async stopSelected(): Promise<void> {
		const agent = agentsForView(this.agents, "panel").find((candidate) => candidate.id === this.selectedId);
		if (!agent) return;
		if (agent.writer && ACTIVE_STATUSES.has(agent.status)) {
			const confirmed = await this.ctx.ui.confirm(
				"Stop writing agent?",
				`${agent.id} and all its descendants will be stopped. Existing file changes are kept.`,
			);
			if (!confirmed) return;
		}
		await this.manager.stopSubtree(agent.id);
		await this.refresh();
	}

	private async openSelected(): Promise<void> {
		const agent = agentsForView(this.agents, "panel").find((candidate) => candidate.id === this.selectedId);
		if (agent) await this.openTranscript(agent.id);
	}

	async openTranscript(agentId: string): Promise<void> {
		if (this.opening || this.ctx.mode !== "tui") return;
		this.opening = true;
		try {
			await this.manager.listAgents(this.ctx);
			const agent = this.manager.getAgent(agentId);
			if (!agent) throw new Error(`Unknown agent ${agentId}`);
			const unsubscribe = this.manager.onEvent((event) => {
				if (event.agentId === agentId) void refreshTranscript();
			});
			let refreshTranscript = async () => {};
			try {
				await this.ctx.ui.custom<void>((tui, _theme, _kb, done) => {
					const view = new TranscriptView(this.manager, agent, () => done(), () => tui.requestRender());
					refreshTranscript = () => view.reload();
					return view;
				});
			} finally {
				unsubscribe();
			}
			if (this.panel) this.tui?.setFocus(this.panel);
		} finally {
			this.opening = false;
		}
	}

	async openList(includeArchived = false): Promise<void> {
		if (this.ctx.mode !== "tui") return;
		await this.refresh();
		const agents = agentsForView(this.agents, includeArchived ? "all" : "list");
		if (agents.length === 0) {
			this.ctx.ui.notify(this.agents.length === 0 ? "No subagents in this run" : "All subagents are archived", "info");
			return;
		}
		const items: SelectItem[] = agents.map((agent) => {
			const retention = agent.retention ?? "reusable";
			return {
				value: agent.id,
				label: `${"  ".repeat(Math.max(0, agent.depth - 1))}${agent.role} · ${agent.status} · ${retention}`,
				description: `${agent.id} · ${agent.level} → ${agent.model} · ${agent.lastActivity}`,
			};
		});
		const selected = await this.ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
			const list = new SelectList(items, Math.min(12, items.length), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			return list;
		});
		if (selected) {
			this.selectedId = selected;
			await this.openTranscript(selected);
		}
	}

	async refresh(): Promise<void> {
		this.agents = await this.manager.listAgents(this.ctx);
		const visibleAgents = agentsForView(this.agents, "panel");
		if (!this.selectedId || !visibleAgents.some((agent) => agent.id === this.selectedId)) {
			this.selectedId = visibleAgents[0]?.id;
		}
		this.tui?.requestRender();
	}

	async stop(agentId: string): Promise<void> {
		await this.manager.stopSubtree(agentId);
		await this.refresh();
	}

	dispose(): void {
		this.unsubscribe?.();
		this.ctx.ui.setWidget("pi-subagents.panel", undefined);
		this.restoreEditor?.();
	}
}

// Ensure styled rows never exceed the terminal width after ANSI formatting.
export function panelLineWidth(line: string, width: number): number {
	return visibleWidth(truncateToWidth(line, width));
}
