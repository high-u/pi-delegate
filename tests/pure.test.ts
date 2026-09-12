/**
 * The logic that decides what the parent is told and what the terminal shows.
 * Everything here is a pure function, so these run with no process, no DB and
 * no pi session behind them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { aggregateUsage, emptyUsage, formatTimestamp, getFinalOutput, getResultOutput, isFailedResult, parseEvent, snapshotResult } from "../extensions/index.ts";

function assistant(...content: unknown[]): Message {
	return { role: "assistant", content } as unknown as Message;
}

function text(value: string) {
	return { type: "text", text: value };
}

function toolCall(name: string) {
	return { type: "toolCall", name, arguments: {} };
}

function result(overrides: Record<string, unknown> = {}) {
	return {
		task: "t",
		exitCode: 0,
		messages: [] as Message[],
		stderr: "",
		usage: emptyUsage(),
		...overrides,
	} as Parameters<typeof isFailedResult>[0];
}

describe("getFinalOutput", () => {
	it("joins every text part of the answer, not just the first", () => {
		// The regression that matters: returning only the first part silently
		// dropped the half of the answer that came after a tool call.
		const messages = [assistant(text("first"), toolCall("read"), text("second"))];
		assert.equal(getFinalOutput(messages), "first\n\nsecond");
	});

	it("takes the last assistant message that actually said something", () => {
		const messages = [assistant(text("older")), assistant(toolCall("bash")), assistant(text("newest"))];
		assert.equal(getFinalOutput(messages), "newest");
	});

	it("skips assistant messages that only called tools", () => {
		const messages = [assistant(text("spoken")), assistant(toolCall("bash"))];
		assert.equal(getFinalOutput(messages), "spoken");
	});

	it("returns an empty string when nothing was said", () => {
		assert.equal(getFinalOutput([]), "");
		assert.equal(getFinalOutput([assistant(toolCall("bash"))]), "");
	});
});

describe("parseEvent", () => {
	it("accepts a well-formed event", () => {
		const event = parseEvent('{"type":"message_end","message":{"role":"assistant","content":[]}}');
		assert.equal(event?.type, "message_end");
		assert.equal(event?.message.role, "assistant");
	});

	it("ignores anything it cannot use instead of failing", () => {
		// A child's stdout is not a trusted stream: partial lines, blank lines
		// and non-JSON noise all arrive here and must not stop the run.
		for (const line of ["", "   ", "not json", "null", "[]", '"text"', '{"type":"message_end"}', '{"message":{}}', '{"type":1,"message":{}}']) {
			assert.equal(parseEvent(line), undefined, `expected ${JSON.stringify(line)} to be ignored`);
		}
	});
});

describe("aggregateUsage", () => {
	it("sums the counters and keeps the peak context, never their sum", () => {
		// Each step has its own context window, so adding them means nothing.
		const results = [
			result({ usage: { ...emptyUsage(), input: 10, output: 1, cost: 0.5, turns: 2, contextTokens: 3000 } }),
			result({ usage: { ...emptyUsage(), input: 5, output: 2, cost: 0.25, turns: 1, contextTokens: 1000 } }),
		];
		const total = aggregateUsage(results);
		assert.equal(total.input, 15);
		assert.equal(total.output, 3);
		assert.equal(total.cost, 0.75);
		assert.equal(total.turns, 3);
		assert.equal(total.contextTokens, 3000);
	});

	it("is zero for no results", () => {
		assert.deepEqual(aggregateUsage([]), emptyUsage());
	});
});

describe("snapshotResult", () => {
	it("detaches from the live result the reader keeps mutating", () => {
		const live = result({ messages: [assistant(text("one"))] });
		const snapshot = snapshotResult(live);

		live.messages.push(assistant(text("two")));
		live.usage.input += 100;

		assert.equal(snapshot.messages.length, 1);
		assert.equal(snapshot.usage.input, 0);
	});
});

describe("isFailedResult", () => {
	it("fails on a non-zero exit, an error, or an abort", () => {
		assert.equal(isFailedResult(result({ exitCode: 1 })), true);
		assert.equal(isFailedResult(result({ stopReason: "error" })), true);
		assert.equal(isFailedResult(result({ stopReason: "aborted" })), true);
	});

	it("succeeds on a clean stop", () => {
		assert.equal(isFailedResult(result({ stopReason: "stop" })), false);
	});
});

describe("getResultOutput", () => {
	it("prefers the error message when the step failed", () => {
		const failed = result({ exitCode: 1, errorMessage: "boom", stderr: "noise", messages: [assistant(text("ignored"))] });
		assert.equal(getResultOutput(failed), "boom");
	});

	it("falls back to stderr, then to whatever was said", () => {
		assert.equal(getResultOutput(result({ exitCode: 1, stderr: "noise" })), "noise");
		assert.equal(getResultOutput(result({ exitCode: 1, messages: [assistant(text("said"))] })), "said");
		assert.equal(getResultOutput(result({ exitCode: 1 })), "(no output)");
	});

	it("returns the answer when the step succeeded", () => {
		assert.equal(getResultOutput(result({ messages: [assistant(text("answer"))] })), "answer");
	});
});

describe("formatTimestamp", () => {
	it("renders stored milliseconds as UTC, marked as UTC", () => {
		assert.equal(formatTimestamp(1789208360374), "2026-09-12T10:19:20.374Z");
	});
});
