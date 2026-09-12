/**
 * The two values a delegated step inherits from its parent through the
 * environment. Both are read by code the model never sees, so a wrong answer
 * here is invisible until data lands in the wrong run, or a subagent gets a
 * tool it was never meant to have.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getDepth, resolveRunId } from "../extensions/index.ts";

const RUN_ID = "PI_DELEGATE_RUN_ID";
const DEPTH = "PI_DELEGATE_DEPTH";

afterEach(() => {
	delete process.env[RUN_ID];
	delete process.env[DEPTH];
});

describe("resolveRunId", () => {
	it("takes the run from the environment inside a delegated step", () => {
		process.env[RUN_ID] = "7";
		assert.equal(resolveRunId(undefined), 7);
	});

	it("lets an explicit id win, so a caller can always name the run it means", () => {
		process.env[RUN_ID] = "7";
		assert.equal(resolveRunId(3), 3);
	});

	it("has no run at the top level", () => {
		assert.equal(resolveRunId(undefined), undefined);
	});

	it("refuses anything that is not an integer rather than passing NaN on", () => {
		process.env[RUN_ID] = "not-a-number";
		assert.equal(resolveRunId(undefined), undefined);

		process.env[RUN_ID] = "1.5";
		assert.equal(resolveRunId(undefined), undefined);

		delete process.env[RUN_ID];
		assert.equal(resolveRunId(Number.NaN), undefined);
		assert.equal(resolveRunId(2.5), undefined);
	});
});

describe("getDepth", () => {
	it("is top level when nothing says otherwise", () => {
		assert.equal(getDepth(), 0);
	});

	it("reads the depth its parent set", () => {
		process.env[DEPTH] = "1";
		assert.equal(getDepth(), 1);
	});

	it("falls back to top level on junk, never to a negative or fractional depth", () => {
		for (const raw of ["", "abc", "-1", "1.5"]) {
			process.env[DEPTH] = raw;
			assert.equal(getDepth(), 0, `expected ${JSON.stringify(raw)} to read as top level`);
		}
	});
});
