/**
 * Handoff store - lets delegated steps hand data to each other, and lets the
 * parent inspect afterwards what those steps actually produced, without
 * routing any of it through the parent's conversation context.
 *
 * Backed by node:sqlite (built into Node, no extra dependency). There is one
 * database file per top-level `pi` process. Every process in that tree opens
 * the same file - the path is inherited through PI_DELEGATE_DB - and pi runs
 * tool calls strictly one at a time, so the file never has two writers at
 * once. Independent `pi` sessions get their own file and never touch each
 * other's.
 *
 * Nothing here throws: every entry point returns a Result.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Path of the session database. Set on the children we spawn, read on startup. */
export const DB_PATH_ENV_VAR = "PI_DELEGATE_DB";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HandoffEntry {
	content: string;
	/** Milliseconds since the epoch. */
	createdAt: number;
}

function ok<T>(value: T): Result<T> {
	return { ok: true, value };
}

function failed(error: unknown): Result<never> {
	return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Milliseconds since the epoch at which this process started. */
const processStartedAt = Math.round(Date.now() - process.uptime() * 1000);

let db: DatabaseSync | undefined;
let dbPath: string | undefined;

function resolveDbPath(): string {
	const inherited = process.env[DB_PATH_ENV_VAR];
	if (inherited) return inherited;
	// Top-level process: name the file after ourselves. A pid on its own can be
	// recycled by the OS once we exit, so the start time separates the reuses.
	return path.join(getAgentDir(), "extensions", "delegate", "sessions", `${process.pid}-${processStartedAt}.db`);
}

function getDb(): Result<DatabaseSync> {
	if (db) return ok(db);
	try {
		const file = resolveDbPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const opened = new DatabaseSync(file);
		opened.exec(`
			CREATE TABLE IF NOT EXISTS runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS handoff (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id INTEGER NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
		// Cache only a connection that initialised cleanly, so a failure here is
		// retried on the next call instead of poisoning the rest of the process.
		db = opened;
		dbPath = file;
		return ok(opened);
	} catch (error) {
		return failed(error);
	}
}

/** The file every child of this process must open. Set once the database has been opened. */
export function getDbPath(): string | undefined {
	return dbPath;
}

/**
 * Mint a run id, called once per `delegate` invocation. Ids are sequential
 * within a session, so they stay short enough to quote back accurately.
 */
export function mintRunId(): Result<number> {
	const handle = getDb();
	if (!handle.ok) return handle;
	try {
		const inserted = handle.value.prepare("INSERT INTO runs (created_at) VALUES (?)").run(Date.now());
		return ok(Number(inserted.lastInsertRowid));
	} catch (error) {
		return failed(error);
	}
}

export function writeHandoff(runId: number, content: string): Result<void> {
	const handle = getDb();
	if (!handle.ok) return handle;
	try {
		handle.value.prepare("INSERT INTO handoff (run_id, content, created_at) VALUES (?, ?, ?)").run(runId, content, Date.now());
		return ok(undefined);
	} catch (error) {
		return failed(error);
	}
}

export function readLatestHandoff(runId: number): Result<HandoffEntry | undefined> {
	const handle = getDb();
	if (!handle.ok) return handle;
	try {
		const row = handle.value
			.prepare("SELECT content, created_at AS createdAt FROM handoff WHERE run_id = ? ORDER BY id DESC LIMIT 1")
			.get(runId) as HandoffEntry | undefined;
		return ok(row);
	} catch (error) {
		return failed(error);
	}
}

/** Every entry of a run, in insertion order. Ordered by id rather than time, which cannot tie. */
export function listHandoff(runId: number): Result<HandoffEntry[]> {
	const handle = getDb();
	if (!handle.ok) return handle;
	try {
		const rows = handle.value
			.prepare("SELECT content, created_at AS createdAt FROM handoff WHERE run_id = ? ORDER BY id ASC")
			.all(runId) as HandoffEntry[];
		return ok(rows);
	} catch (error) {
		return failed(error);
	}
}

/** Whether a run saved anything at all - decides if its id is worth reporting to the parent. */
export function hasHandoff(runId: number): Result<boolean> {
	const handle = getDb();
	if (!handle.ok) return handle;
	try {
		const row = handle.value.prepare("SELECT 1 AS present FROM handoff WHERE run_id = ? LIMIT 1").get(runId);
		return ok(row !== undefined);
	} catch (error) {
		return failed(error);
	}
}
