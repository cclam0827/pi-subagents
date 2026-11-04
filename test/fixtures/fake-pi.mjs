import readline from "node:readline";

const reader = readline.createInterface({ input: process.stdin });
let messages = [];
function send(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}
function response(id, command, data) {
	send({ id, type: "response", command, success: true, data });
}
reader.on("line", (line) => {
	const command = JSON.parse(line);
	if (command.type === "get_state") {
		response(command.id, "get_state", {
			model: { provider: "fake", id: "model" }, thinkingLevel: "medium", isStreaming: false,
			isCompacting: false, steeringMode: "all", followUpMode: "one-at-a-time",
			sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake-session", autoCompactionEnabled: false,
			messageCount: messages.length, pendingMessageCount: 0,
		});
	} else if (command.type === "prompt") {
		response(command.id, "prompt", { disposition: "started" });
		send({ type: "agent_start" });
		const message = { role: "assistant", content: [{ type: "text", text: "Summary: fake complete" }], stopReason: "end" };
		messages.push(message);
		send({ type: "message_end", message });
		send({ type: "agent_settled", aborted: false });
	} else if (command.type === "steer") {
		response(command.id, "steer", { disposition: "queued" });
	} else if (command.type === "get_messages") {
		response(command.id, "get_messages", { messages });
	} else if (command.type === "abort") {
		response(command.id, "abort", undefined);
		send({ type: "agent_settled", aborted: true });
	}
});
