import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { EXTENSION_ID } from "./constants.ts";

export function getUserExtensionDir(): string {
	return join(getAgentDir(), EXTENSION_ID);
}

export function getProjectExtensionDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, EXTENSION_ID);
}

export function getBuiltInAgentsDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

export function getExtensionEntrypoint(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "index.ts");
}

export function getRunStateDir(): string {
	return join(getUserExtensionDir(), "state");
}
