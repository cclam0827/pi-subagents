import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL_LEVELS, type ModelLevel, type ModelResolution, type ModelSelection, type SubagentsConfig } from "./types.ts";

export function isModelLevel(value: string): value is ModelLevel {
	return (MODEL_LEVELS as readonly string[]).includes(value);
}

export function splitModelReference(reference: string): { provider: string; id: string } {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) {
		throw new Error(`Model must use provider/model-id, received "${reference}"`);
	}
	return { provider: reference.slice(0, slash), id: reference.slice(slash + 1) };
}

export function effectiveSelection(roleModel: ModelSelection, requested: ModelSelection | undefined, config: SubagentsConfig): ModelSelection {
	if (requested) return requested;
	if (roleModel !== "auto") return roleModel;
	return config.defaultModel;
}

export function effectiveLevel(selection: ModelSelection, requestedLevel: ModelLevel | undefined): ModelLevel {
	if (requestedLevel) return requestedLevel;
	return isModelLevel(selection) ? selection : "balanced";
}

export function resolveModel(input: {
	registry: ExtensionContext["modelRegistry"];
	parentModel: Model<any> | undefined;
	selection: ModelSelection;
	level?: ModelLevel;
	config: SubagentsConfig;
}): ModelResolution {
	const { registry, parentModel, selection, config } = input;
	const level = effectiveLevel(selection, input.level);
	const levelConfig = config.levels[level];
	const available = registry.getAvailable();

	if (selection !== "auto" && !isModelLevel(selection)) {
		const { provider, id } = splitModelReference(selection);
		const model = available.find((candidate) => candidate.provider === provider && candidate.id === id);
		if (!model) {
			throw new Error(`Model ${selection} is not available with configured authentication`);
		}
		return {
			provider,
			id,
			reference: selection as `${string}/${string}`,
			level,
			thinking: levelConfig.thinking,
			fallback: false,
		};
	}

	for (const reference of levelConfig.candidates) {
		const { provider, id } = splitModelReference(reference);
		if (available.some((candidate) => candidate.provider === provider && candidate.id === id)) {
			return {
				provider,
				id,
				reference: reference as `${string}/${string}`,
				level,
				thinking: levelConfig.thinking,
				fallback: false,
			};
		}
	}

	if (!parentModel) {
		throw new Error(`No models for level "${level}" are available and the parent session has no model to inherit`);
	}
	const reference = `${parentModel.provider}/${parentModel.id}` as const;
	return {
		provider: parentModel.provider,
		id: parentModel.id,
		reference,
		level,
		thinking: levelConfig.thinking,
		fallback: true,
		warning: `No configured candidate for "${level}" is available; inheriting ${reference}`,
	};
}
