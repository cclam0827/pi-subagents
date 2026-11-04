import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentPanelController } from "../src/panel.ts";
import type { SubagentManager } from "../src/manager.ts";
import type { AgentRecord, AgentRetention, AgentStatus } from "../src/types.ts";

function record(id: string, status: AgentStatus, retention: AgentRetention, parentId: string | null = null): AgentRecord {
	return {
		id,
		runId: "run",
		parentId,
		depth: parentId ? 2 : 1,
		role: id.replace(/-.*/, ""),
		task: "task",
		model: "fake/static",
		level: "balanced",
		thinking: "medium",
		tools: ["read"],
		instructions: "test",
		extensions: [],
		cwd: "/repo",
		workspace: "shared",
		writer: false,
		status,
		attempt: 1,
		createdAt: "",
		updatedAt: "",
		lastActivity: status === "done" ? "Completed" : "Stopped",
		retention,
	};
}

test("docked panel shows active and reusable agents while retaining history", async (t) => {
	let agents = [
		record("implement-one", "done", "reusable"),
		record("explore-child", "done", "reusable", "implement-one"),
		record("explore-stopped", "stopped", "reusable"),
		record("verify-stopped", "stopped", "reusable"),
		record("verify-done", "done", "reusable"),
		record("explore-released", "done", "released"),
		record("explore-archived", "done", "archived"),
	];
	let widgetFactory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
	const manager = {
		isChild: false,
		listAgents: async () => agents,
		onEvent: () => () => undefined,
	} as unknown as SubagentManager;
	const ctx = {
		mode: "tui",
		ui: {
			setWidget: (_id: string, factory: unknown) => {
				widgetFactory = factory as typeof widgetFactory;
			},
			getEditorComponent: () => undefined,
			setEditorComponent: () => undefined,
		},
	} as unknown as ExtensionContext;
	const controller = new AgentPanelController(manager, ctx);
	t.after(() => controller.dispose());
	controller.install();
	await new Promise((resolve) => setImmediate(resolve));
	const tui = { requestRender: () => undefined, setFocus: () => undefined };
	const theme = { fg: (_color: string, text: string) => text };
	const panel = widgetFactory?.(tui, theme);
	assert.ok(panel);

	const lines = panel.render(120).join("\n");
	assert.match(lines, /Agents 0 active · 3 reusable · 4 in history/);
	assert.match(lines, /implement-one|implement/);
	assert.doesNotMatch(lines, /stopped|released|archived/);

	agents = agents.map((agent) => ({ ...agent, retention: "archived" }));
	await controller.refresh();
	const archivedLines = panel.render(120).join("\n");
	assert.equal(archivedLines, "No active agents · 7 in history · /agents all");
});
