/**
 * Delegate Tool - hand work to a fresh, isolated subagent.
 *
 * Spawns a separate `pi` process per task, giving it its own context window
 * with no access to the parent conversation (`--no-session`). Streams the
 * child's progress back via onUpdate so the terminal shows live activity
 * instead of freezing while the subagent works.
 *
 * Trimmed from the official `examples/extensions/subagent` reference: one
 * fixed role, no agent definitions, no parallel mode. `tasks` takes one item
 * for a single bounded task, or several to run as a fixed sequence of steps,
 * each in its own fresh, isolated context.
 *
 * Steps share no memory. Passing data between them is not automatic (no
 * {previous} magic): a step writes with handoff_write and a later step reads
 * with handoff_read, both scoped to the current run id, which is inferred
 * from the environment inside a delegated step - see handoff-db.ts. This
 * keeps the data flow explicit and inspectable, by the parent too, after the
 * fact, instead of silently spliced in.
 *
 * Subagents do not delegate further: at MAX_DEPTH the tool is not registered
 * at all, so recursion is impossible rather than merely refused.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DB_PATH_ENV_VAR, getDbPath, hasHandoff, listHandoff, mintRunId, readLatestHandoff, writeHandoff } from "./handoff-db.ts";

/** Run the delegated step belongs to. Read by the handoff tools, never shown to the model. */
const RUN_ID_ENV_VAR = "PI_DELEGATE_RUN_ID";

/** How far down the delegation tree this process sits. Top-level is 0. */
const DEPTH_ENV_VAR = "PI_DELEGATE_DEPTH";

/**
 * Deepest level still allowed to delegate. 1 means the top-level session
 * delegates to subagents, and those subagents do not delegate further:
 * without parallelism, nesting only multiplies serial work inside a call the
 * parent cannot re-enter or observe.
 */
export const MAX_DEPTH = 1;

const COLLAPSED_ITEM_COUNT = 10;
const COLLAPSED_STEP_ITEM_COUNT = 5;

const KILL_GRACE_MS = 5000;

export function getDepth(): number {
	const raw = process.env[DEPTH_ENV_VAR];
	if (raw === undefined) return 0;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, theme: Theme): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = asString(args.command, "...");
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
		}
		case "read": {
			const filePath = shortenPath(asString(args.file_path ?? args.path, "..."));
			const offset = asNumber(args.offset);
			const limit = asNumber(args.limit);
			let text = theme.fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return theme.fg("muted", "read ") + text;
		}
		case "write": {
			const filePath = shortenPath(asString(args.file_path ?? args.path, "..."));
			const lines = asString(args.content, "").split("\n").length;
			let text = theme.fg("muted", "write ") + theme.fg("accent", filePath);
			if (lines > 1) text += theme.fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			return theme.fg("muted", "edit ") + theme.fg("accent", shortenPath(asString(args.file_path ?? args.path, "...")));
		}
		case "ls": {
			return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath(asString(args.path, ".")));
		}
		case "find": {
			const pattern = asString(args.pattern, "*");
			return theme.fg("muted", "find ") + theme.fg("accent", pattern) + theme.fg("dim", ` in ${shortenPath(asString(args.path, "."))}`);
		}
		case "grep": {
			const pattern = asString(args.pattern, "");
			return (
				theme.fg("muted", "grep ") + theme.fg("accent", `/${pattern}/`) + theme.fg("dim", ` in ${shortenPath(asString(args.path, "."))}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return theme.fg("accent", toolName) + theme.fg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface DelegateResult {
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface DelegateDetails {
	mode: "single" | "chain";
	results: DelegateResult[];
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * A step's totals across the whole run. contextTokens is the peak rather than
 * a sum: each step has its own context window, so adding them means nothing.
 */
export function aggregateUsage(results: DelegateResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
		total.contextTokens = Math.max(total.contextTokens, r.usage.contextTokens);
	}
	return total;
}

/**
 * Detach a result from the live one the reader keeps mutating, so whoever
 * receives it sees the state as it was at that moment. Message objects come
 * from pi already finished, so copying the array is enough.
 */
export function snapshotResult(result: DelegateResult): DelegateResult {
	return { ...result, messages: [...result.messages], usage: { ...result.usage } };
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const texts: string[] = [];
		for (const part of msg.content) {
			if (part.type === "text") texts.push(part.text);
		}
		if (texts.length > 0) return texts.join("\n\n");
	}
	return "";
}

export function isFailedResult(result: DelegateResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: DelegateResult): string {
	if (isFailedResult(result)) return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	return getFinalOutput(result.messages) || "(no output)";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

/** The subset of pi's NDJSON stream this extension consumes. */
interface PiEvent {
	type: string;
	message: Message;
}

export function parseEvent(line: string): PiEvent | undefined {
	if (!line.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const candidate = parsed as { type?: unknown; message?: unknown };
	if (typeof candidate.type !== "string" || typeof candidate.message !== "object" || candidate.message === null) return undefined;
	return { type: candidate.type, message: candidate.message as Message };
}

type StepUpdateCallback = (current: DelegateResult) => void;

interface StepContext {
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	runId: number;
	dbPath: string;
	depth: number;
}

async function runDelegate(
	step: StepContext,
	task: string,
	signal: AbortSignal | undefined,
	onStepUpdate: StepUpdateCallback | undefined,
): Promise<DelegateResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (step.model) args.push("--model", step.model);
	if (step.thinkingLevel) args.push("--thinking", step.thinkingLevel);
	args.push(`Task: ${task}`);

	const currentResult: DelegateResult = {
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: step.model,
	};

	const emitUpdate = () => onStepUpdate?.(snapshotResult(currentResult));
	let wasAborted = false;

	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: step.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				[RUN_ID_ENV_VAR]: String(step.runId),
				[DB_PATH_ENV_VAR]: step.dbPath,
				[DEPTH_ENV_VAR]: String(step.depth + 1),
			},
		});

		let buffer = "";
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let detachSignal: (() => void) | undefined;

		const finish = (code: number) => {
			if (killTimer) clearTimeout(killTimer);
			detachSignal?.();
			resolve(code);
		};

		const processLine = (line: string) => {
			const event = parseEvent(line);
			if (!event) return;

			if (event.type === "message_end") {
				const msg = event.message;
				currentResult.messages.push(msg);

				if (msg.role === "assistant") {
					currentResult.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						currentResult.usage.input += usage.input || 0;
						currentResult.usage.output += usage.output || 0;
						currentResult.usage.cacheRead += usage.cacheRead || 0;
						currentResult.usage.cacheWrite += usage.cacheWrite || 0;
						currentResult.usage.cost += usage.cost?.total || 0;
						currentResult.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!currentResult.model && msg.model) currentResult.model = msg.model;
					if (msg.stopReason) currentResult.stopReason = msg.stopReason;
					if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
				}
				emitUpdate();
			}

			if (event.type === "tool_result_end") {
				currentResult.messages.push(event.message);
				emitUpdate();
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			currentResult.stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});

		proc.on("error", (error) => {
			// Spawn never got off the ground: the reason is only here.
			currentResult.errorMessage = error.message;
			finish(1);
		});

		if (signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, KILL_GRACE_MS);
				// Never hold the event loop open just to wait out a grace period.
				killTimer.unref();
			};
			if (signal.aborted) killProc();
			else {
				signal.addEventListener("abort", killProc, { once: true });
				detachSignal = () => signal.removeEventListener("abort", killProc);
			}
		}
	});

	currentResult.exitCode = exitCode;
	if (wasAborted) {
		// Report the abort as a result rather than an exception, so the steps
		// that already finished survive in the details the parent receives.
		currentResult.stopReason = "aborted";
	}
	return snapshotResult(currentResult);
}

const DelegateParams = Type.Object({
	tasks: Type.Array(Type.String({ description: "Task for this step." }), {
		minItems: 1,
		description:
			"One item for a single task, or several to run as a fixed sequence of steps. " +
			"See the tool description for how data passes between steps.",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process(es). Defaults to the current working directory." })),
});

/**
 * An explicit id wins, so a caller can always name the run it means. Inside a
 * delegated step there is no explicit id and the environment supplies it.
 */
export function resolveRunId(explicit: number | undefined): number | undefined {
	if (explicit !== undefined && Number.isInteger(explicit)) return explicit;
	const fromEnv = process.env[RUN_ID_ENV_VAR];
	if (fromEnv === undefined) return undefined;
	const parsed = Number(fromEnv);
	return Number.isInteger(parsed) ? parsed : undefined;
}

export function formatTimestamp(ms: number): string {
	return new Date(ms).toISOString();
}

function noRunIdResult(): AgentToolResult<Record<string, never>> {
	return {
		content: [{ type: "text", text: "No active delegate run and no runId provided." }],
		details: {},
		isError: true,
	};
}

export default function (pi: ExtensionAPI) {
	const depth = getDepth();
	const isTopLevel = depth === 0;
	const canDelegate = depth < MAX_DEPTH;

	if (canDelegate) {
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
				"Hand off one or more tasks to subagents, each with a fresh, isolated context window (no parent conversation history). " +
				"Use it to keep exploratory or verbose work out of the main context, or to make independent progress on a self-contained piece of work. " +
				"Pass one item in `tasks` for a single task. Pass several to run them as a fixed sequence: all steps are declared up front in this one call " +
				"and then run to completion without coming back to you in between, so plan the whole sequence before calling this. " +
				"Steps have no memory of each other and nothing is handed between them automatically: whenever a later step needs an earlier step's " +
				"actual output (not just 'assume it worked'), you must write that instruction into the task text yourself - tell the earlier step to call " +
				"handoff_write with its result, and tell the later step to call handoff_read before doing its work (no id needed inside a step, it is " +
				"inferred automatically). If you skip writing that instruction, the steps will not share data.",
			parameters: DelegateParams,

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const tasks = params.tasks ?? [];
				if (tasks.length === 0) {
					return {
						content: [{ type: "text", text: "Invalid parameters. Provide at least one item in tasks." }],
						details: { mode: "single", results: [] },
						isError: true,
					};
				}

				const minted = mintRunId();
				if (!minted.ok) {
					return {
						content: [{ type: "text", text: `Delegate failed: handoff store unavailable: ${minted.error}` }],
						details: { mode: "single", results: [] },
						isError: true,
					};
				}
				const runId = minted.value;
				const dbPath = getDbPath();
				if (!dbPath) {
					return {
						content: [{ type: "text", text: "Delegate failed: handoff store path unavailable." }],
						details: { mode: "single", results: [] },
						isError: true,
					};
				}

				const isChain = tasks.length > 1;
				const mode: DelegateDetails["mode"] = isChain ? "chain" : "single";
				const step: StepContext = {
					cwd: params.cwd ?? ctx.cwd,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinkingLevel: ctx.thinkingLevel,
					runId,
					dbPath,
					depth,
				};

				// Report the run id only when a step actually saved something, so a
				// parent is never handed an id with nothing behind it.
				const runIdSuffix = () => {
					const used = hasHandoff(runId);
					return used.ok && used.value ? ` (handoff run: ${runId})` : "";
				};

				const results: DelegateResult[] = [];

				for (let i = 0; i < tasks.length; i++) {
					const result = await runDelegate(step, tasks[i], signal, (current) => {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: getFinalOutput(current.messages) || (isChain ? `(running step ${i + 1}/${tasks.length}...)` : "(running...)"),
								},
							],
							details: { mode, results: [...results, { ...current, step: i + 1 }] },
						});
					});
					result.step = i + 1;
					results.push(result);

					if (isFailedResult(result)) {
						const where = isChain ? ` at step ${i + 1}/${tasks.length}` : "";
						const text =
							result.stopReason === "aborted"
								? `Delegate aborted${where}.${runIdSuffix()}`
								: `Delegate failed${where}: ${getResultOutput(result)}${runIdSuffix()}`;
						return {
							content: [{ type: "text", text }],
							details: { mode, results },
							isError: true,
						};
					}
				}

				const finalOutput = getFinalOutput(results[results.length - 1].messages) || "(no output)";
				const suffix = runIdSuffix();
				return {
					content: [{ type: "text", text: suffix ? `${finalOutput}\n\n${suffix.trim()}` : finalOutput }],
					details: { mode, results },
				};
			},

			renderCall(args, theme) {
				const tasks = args.tasks ?? [];
				if (tasks.length > 1) {
					let text = theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", `chain (${tasks.length} steps)`);
					for (let i = 0; i < Math.min(tasks.length, 3); i++) {
						const preview = tasks[i].length > 40 ? `${tasks[i].slice(0, 40)}...` : tasks[i];
						text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("dim", preview)}`;
					}
					if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
					return new Text(text, 0, 0);
				}
				const task = tasks[0];
				const preview = task ? (task.length > 60 ? `${task.slice(0, 60)}...` : task) : "...";
				const text = theme.fg("toolTitle", theme.bold("delegate")) + `\n  ${theme.fg("dim", preview)}`;
				return new Text(text, 0, 0);
			},

			renderResult(result, { expanded }, theme) {
				const details = result.details as DelegateDetails | undefined;
				if (!details || details.results.length === 0) {
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
				}

				const mdTheme = getMarkdownTheme();

				const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
					const toShow = limit ? items.slice(-limit) : items;
					const skipped = limit && items.length > limit ? items.length - limit : 0;
					let text = "";
					if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
					for (const item of toShow) {
						if (item.type === "text") {
							const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
							text += `${theme.fg("toolOutput", preview)}\n`;
						} else {
							text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme)}\n`;
						}
					}
					return text.trimEnd();
				};

				if (details.mode === "single") {
					const r = details.results[0];
					const isError = isFailedResult(r);
					const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalOutput(r.messages);

					if (expanded) {
						const container = new Container();
						let header = `${icon} ${theme.fg("toolTitle", theme.bold("delegate"))}`;
						if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
						container.addChild(new Text(header, 0, 0));
						if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
						container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
						if (displayItems.length === 0 && !finalOutput) {
							container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
						} else {
							for (const item of displayItems) {
								if (item.type === "toolCall") {
									container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme), 0, 0));
								}
							}
							if (finalOutput) {
								container.addChild(new Spacer(1));
								container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
							}
						}
						const usageStr = formatUsageStats(r.usage, r.model);
						if (usageStr) {
							container.addChild(new Spacer(1));
							container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
						}
						return container;
					}

					let text = `${icon} ${theme.fg("toolTitle", theme.bold("delegate"))}`;
					if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else {
						text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
						if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
					return new Text(text, 0, 0);
				}

				// Chain mode
				const results = details.results;
				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const icon = successCount === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${results.length} steps`)}`,
							0,
							0,
						),
					);

					for (const r of results) {
						const isError = isFailedResult(r);
						const rIcon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", `─── Step ${r.step} `)}${rIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme), 0, 0));
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${results.length} steps`)}`;
				for (const r of results) {
					const isError = isFailedResult(r);
					const rIcon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step} `)}${rIcon}`;
					if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, COLLAPSED_STEP_ITEM_COUNT)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			},
		});
	}

	pi.registerTool({
		name: "handoff_write",
		label: "Handoff Write",
		description:
			"Save data for another step of the current delegate run to read later, without routing it through the parent's conversation. " +
			"Called from inside a delegated step, the run is inferred automatically - do not pass runId. " +
			"Called from the top-level session (outside any delegate run), pass the runId from a prior delegate result.",
		parameters: Type.Object({
			content: Type.String({ description: "The data to save." }),
			runId: Type.Optional(Type.Integer({ description: "Only needed outside of an active delegate run." })),
		}),
		async execute(_toolCallId, params) {
			const runId = resolveRunId(params.runId);
			if (runId === undefined) return noRunIdResult();
			const written = writeHandoff(runId, params.content);
			if (!written.ok) {
				return { content: [{ type: "text", text: `Could not save handoff data: ${written.error}` }], details: {}, isError: true };
			}
			return { content: [{ type: "text", text: `Saved to run ${runId}.` }], details: {} };
		},
	});

	pi.registerTool({
		name: "handoff_read",
		label: "Handoff Read",
		description:
			"Read the most recently saved handoff data for the current delegate run. " +
			"Called from inside a delegated step, the run is inferred automatically - do not pass runId. " +
			"Called from the top-level session (outside any delegate run), pass the runId from a prior delegate result.",
		parameters: Type.Object({
			runId: Type.Optional(Type.Integer({ description: "Only needed outside of an active delegate run." })),
		}),
		async execute(_toolCallId, params) {
			const runId = resolveRunId(params.runId);
			if (runId === undefined) return noRunIdResult();
			const read = readLatestHandoff(runId);
			if (!read.ok) {
				return { content: [{ type: "text", text: `Could not read handoff data: ${read.error}` }], details: {}, isError: true };
			}
			if (!read.value) return { content: [{ type: "text", text: `No handoff data for run ${runId}.` }], details: {} };
			return { content: [{ type: "text", text: read.value.content }], details: {} };
		},
	});

	// Inspecting a whole run is the parent's job: a step is meant to get on with
	// its own task, reading at most what the step before it left behind.
	if (isTopLevel) {
		pi.registerTool({
			name: "handoff_list",
			label: "Handoff List",
			description:
				"List everything saved via handoff_write for a delegate run, in order, with timestamps. " +
				"Use it to inspect what a chain's steps actually produced, for example when the final result looks wrong. Requires runId.",
			parameters: Type.Object({
				runId: Type.Integer({ description: "The run id from a delegate result." }),
			}),
			async execute(_toolCallId, params) {
				const listed = listHandoff(params.runId);
				if (!listed.ok) {
					return { content: [{ type: "text", text: `Could not read handoff data: ${listed.error}` }], details: {}, isError: true };
				}
				if (listed.value.length === 0) {
					return { content: [{ type: "text", text: `No handoff data for run ${params.runId}.` }], details: {} };
				}
				const text = listed.value.map((r, i) => `[${i + 1}] (${formatTimestamp(r.createdAt)})\n${r.content}`).join("\n\n---\n\n");
				return { content: [{ type: "text", text }], details: {} };
			},
		});
	}
}
