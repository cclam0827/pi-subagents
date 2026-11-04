import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentReport } from "./types.ts";

export const MAX_PARENT_REPORT_BYTES = 50 * 1024;

export function finalAssistantText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let output = text.slice(0, maxBytes);
	while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
	return `${output}\n\n[Output truncated to ${maxBytes} bytes. Full transcript remains in the child session.]`;
}

function sectionLines(lines: string[], headings: RegExp): string[] {
	const start = lines.findIndex((line) => headings.test(line));
	if (start < 0) return [];
	const output: string[] = [];
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index];
		if (/^#{1,6}\s+/.test(line) || /^(summary|findings|files changed|tests|risks)\s*:/i.test(line)) break;
		output.push(line);
	}
	return output;
}

function bullets(lines: string[]): string[] {
	return lines
		.map((line) => line.replace(/^\s*(?:[-*+] |\d+[.)] )/, "").trim())
		.filter(Boolean);
}

export function parseAgentReport(text: string): AgentReport {
	const capped = truncateUtf8(text.trim() || "(no output)", MAX_PARENT_REPORT_BYTES);
	const lines = capped.split("\n");
	const summarySection = sectionLines(lines, /^(?:#{1,6}\s*)?summary\s*:?$/i);
	const inlineSummary = capped.match(/(?:^|\n)summary\s*:\s*([^\n]+)/i)?.[1];
	const findings = sectionLines(lines, /^(?:#{1,6}\s*)?findings\s*:?$/i);
	const files = sectionLines(lines, /^(?:#{1,6}\s*)?files changed\s*:?$/i);
	const tests = sectionLines(lines, /^(?:#{1,6}\s*)?tests\s*:?$/i);
	const risks = sectionLines(lines, /^(?:#{1,6}\s*)?risks\s*:?$/i);
	return {
		summary: inlineSummary?.trim() || summarySection.join("\n").trim() || capped,
		findings: bullets(findings),
		filesChanged: bullets(files),
		tests: bullets(tests),
		risks: bullets(risks),
	};
}

export function formatAgentReport(report: AgentReport): string {
	const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "- None reported");
	return [
		`Summary: ${report.summary}`,
		`Findings:\n${list(report.findings)}`,
		`Files changed:\n${list(report.filesChanged)}`,
		`Tests:\n${list(report.tests)}`,
		`Risks:\n${list(report.risks)}`,
	].join("\n\n");
}
