/**
 * Which tools each level of the tree is given. The depth limit is enforced by
 * not registering `delegate` at all rather than by refusing the call, so this
 * is the only place that enforcement can be checked.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../extensions/index.ts";

const DEPTH = "PI_DELEGATE_DEPTH";

function registeredToolNames(): string[] {
	const names: string[] = [];
	const pi = { registerTool: (tool: { name: string }) => names.push(tool.name) } as unknown as ExtensionAPI;
	register(pi);
	return names;
}

afterEach(() => {
	delete process.env[DEPTH];
});

describe("tool registration", () => {
	it("gives the top-level session everything", () => {
		assert.deepEqual(registeredToolNames(), ["delegate", "handoff_write", "handoff_read", "handoff_list"]);
	});

	it("leaves a subagent only the handoff tools it needs for its own step", () => {
		// No `delegate`, so a subagent cannot delegate further: recursion is
		// impossible rather than refused. No `handoff_list` either: inspecting a
		// whole run is the parent's job.
		process.env[DEPTH] = "1";
		assert.deepEqual(registeredToolNames(), ["handoff_write", "handoff_read"]);
	});
});
