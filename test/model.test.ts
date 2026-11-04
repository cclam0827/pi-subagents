import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { effectiveLevel, effectiveSelection, resolveModel, splitModelReference } from "../src/model.ts";

function model(provider: string, id: string): Model<any> {
	return { provider, id } as Model<any>;
}

function registry(models: Model<any>[]): ExtensionContext["modelRegistry"] {
	return { getAvailable: () => models } as ExtensionContext["modelRegistry"];
}

const config = structuredClone(DEFAULT_CONFIG);
config.levels.fast.candidates = ["anthropic/fast", "openai/fast"];
config.levels.deep.candidates = ["anthropic/deep"];

test("selects the first authenticated candidate for a level", () => {
	const resolved = resolveModel({
		registry: registry([model("openai", "fast")]),
		parentModel: model("parent", "current"),
		selection: "fast",
		config,
	});
	assert.equal(resolved.reference, "openai/fast");
	assert.equal(resolved.level, "fast");
	assert.equal(resolved.fallback, false);
});

test("exact provider/model references never silently fall back", () => {
	assert.throws(
		() =>
			resolveModel({
				registry: registry([]),
				parentModel: model("parent", "current"),
				selection: "openai/missing",
				config,
			}),
		/not available/,
	);
	const resolved = resolveModel({
		registry: registry([model("ccr", "CPA/custom-model")]),
		parentModel: undefined,
		selection: "ccr/CPA/custom-model",
		config,
	});
	assert.equal(resolved.provider, "ccr");
	assert.equal(resolved.id, "CPA/custom-model");
});

test("deep fallback is explicit and inherits the parent model", () => {
	const resolved = resolveModel({
		registry: registry([]),
		parentModel: model("parent", "current"),
		selection: "deep",
		config,
	});
	assert.equal(resolved.reference, "parent/current");
	assert.equal(resolved.fallback, true);
	assert.match(resolved.warning ?? "", /inheriting parent\/current/);
});

test("role, request, and level selection are independent", () => {
	assert.equal(effectiveSelection("auto", undefined, config), "auto");
	assert.equal(effectiveSelection("fast", "max", config), "max");
	assert.equal(effectiveSelection("auto", "openai/exact", config), "openai/exact");
	assert.equal(effectiveLevel("deep", undefined), "deep");
	assert.equal(effectiveLevel("auto", undefined), "balanced");
	assert.equal(effectiveLevel("auto", "max"), "max");
	assert.deepEqual(splitModelReference("ccr/CPA/model"), { provider: "ccr", id: "CPA/model" });
});
