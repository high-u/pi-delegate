/**
 * The handoff store, against a real SQLite file in a temporary directory.
 * PI_DELEGATE_DB is how a child is told which file to open, so pointing it at
 * a scratch file is all the isolation these need.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-test-"));
process.env.PI_DELEGATE_DB = path.join(dir, "handoff.db");

const { getDbPath, hasHandoff, listHandoff, mintRunId, readLatestHandoff, writeHandoff } = await import("../extensions/handoff-db.ts");

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(): number {
	const minted = mintRunId();
	assert.equal(minted.ok, true);
	return minted.ok ? minted.value : -1;
}

describe("run ids", () => {
	it("are sequential within a session, so they stay short enough to quote back", () => {
		const first = run();
		const second = run();
		assert.equal(second, first + 1);
	});

	it("name the file every child of this process must open", () => {
		assert.equal(getDbPath(), process.env.PI_DELEGATE_DB);
	});
});

describe("handoff", () => {
	it("reports nothing saved until a step actually saves something", () => {
		// This is what decides whether the parent is handed a run id at all.
		const runId = run();
		assert.deepEqual(hasHandoff(runId), { ok: true, value: false });

		writeHandoff(runId, "x");
		assert.deepEqual(hasHandoff(runId), { ok: true, value: true });
	});

	it("reads back the most recent entry, not the first", () => {
		const runId = run();
		writeHandoff(runId, "older");
		writeHandoff(runId, "newer");

		const read = readLatestHandoff(runId);
		assert.equal(read.ok && read.value?.content, "newer");
	});

	it("keeps runs apart", () => {
		const a = run();
		const b = run();
		writeHandoff(a, "mine");

		const read = readLatestHandoff(b);
		assert.equal(read.ok && read.value, undefined);
	});

	it("lists a run in the order it was written, with millisecond timestamps", () => {
		const runId = run();
		writeHandoff(runId, "one");
		writeHandoff(runId, "two");

		const listed = listHandoff(runId);
		assert.equal(listed.ok, true);
		if (!listed.ok) return;
		assert.deepEqual(
			listed.value.map((entry) => entry.content),
			["one", "two"],
		);
		assert.equal(Number.isInteger(listed.value[0].createdAt), true);
	});

	it("has nothing to list for a run that saved nothing", () => {
		assert.deepEqual(listHandoff(run()), { ok: true, value: [] });
	});
});

describe("failures", () => {
	it("reports a broken store as a value instead of throwing", async () => {
		// Same contract as the real failure paths: a caller of this module never
		// has to guard against an exception.
		const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-broken-"));
		const broken = path.join(brokenDir, "handoff.db");
		fs.writeFileSync(broken, "this is not a database");

		const previous = process.env.PI_DELEGATE_DB;
		process.env.PI_DELEGATE_DB = broken;
		try {
			// A fresh module instance, so it opens the broken file rather than the
			// connection the tests above already cached.
			const fresh = await import(`../extensions/handoff-db.ts?broken=${Date.now()}`);
			const minted = fresh.mintRunId();
			assert.equal(minted.ok, false);
			assert.equal(typeof minted.error, "string");
		} finally {
			process.env.PI_DELEGATE_DB = previous;
			fs.rmSync(brokenDir, { recursive: true, force: true });
		}
	});
});
