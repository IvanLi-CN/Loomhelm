import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import type { ClientConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import type { ProcessOptions } from "../runtime/process.ts";
import { SkillsRuntime } from "../toolkit.ts";
import {
	enrichFlowContract,
	flowHelp,
} from "./flow-contract.ts";

export function flowProcessOptions(
	config: Pick<ClientConfig, "processTimeoutMs" | "maxOutputBytes" | "maxOutputBytesExplicit" | "processTimeoutExplicit">,
	input: Uint8Array,
	socket?: string,
	command?: string,
): ProcessOptions {
	let timeoutMs = config.processTimeoutMs;
	if (command === "conversation-create" || command === "initialization-recover") {
		const configured = Number(process.env.MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS ?? 300_000);
		const initializationMs = Number.isFinite(configured) && configured >= 1000 && configured <= 600_000
			? configured : 300_000;
		const minimumMs = initializationMs + 200_000;
		if (config.processTimeoutExplicit && timeoutMs < minimumMs)
			throw new Error("FLOW_PROCESS_BUDGET_TOO_SHORT: creation requires initialization and reconciliation time before starting");
		timeoutMs = Math.max(timeoutMs, minimumMs);
	}
	return {
		input,
		cwd: process.cwd(),
		timeoutMs,
		...(config.maxOutputBytesExplicit ? { maxOutputBytes: config.maxOutputBytes } : {}),
		env: {
			...process.env,
			...(socket ? { LOOMHELM_CODEX_APP_SERVER_SOCKET: socket } : {}),
		},
	};
}

export async function runFlowCommand(
	args: string[],
	configPath?: string,
): Promise<void> {
	if (
		!args.length ||
		args[0] === "help" ||
		args[1] === "--help" ||
		args[0] === "--help"
	) {
		console.log(
			flowHelp(
				args[0] === "help" || args[0] === "--help" ? undefined : args[0],
			),
		);
		return;
	}
	if (args[0] === "schema") {
		if (args.length !== 3 || args[1] !== "--format" || args[2] !== "json")
			throw new Error("Usage: flow schema --format json");
		const domainPath = resolve(
			new SkillsRuntime().root,
			"skills/multi-task-flow/lib/flow-domain-schemas.json",
		);
		let domain: Record<string, unknown>;
		try {
			domain = JSON.parse(await readFile(domainPath, "utf8")) as Record<string, unknown>;
		} catch (error) {
			throw new Error(`FLOW_SCHEMA_UNAVAILABLE: cannot read packaged domain schema at ${domainPath}`, {
				cause: error,
			});
		}
		if (
			typeof domain.$schema !== "string" ||
			typeof domain.$id !== "string" ||
			![
				"plan",
				"group",
				"task",
				"ledger",
				"execution_profile",
				"baseline_receipt",
				"notification",
				"fact",
				"resource",
				"atomic_node",
				"atomic_edge",
			].every(
				(name) => name in domain,
			)
		)
			throw new Error("FLOW_SCHEMA_INVALID: packaged domain schema is incomplete");
		const contract = enrichFlowContract(domain);
		console.log(JSON.stringify(contract));
		return;
	}
	let socket: string | undefined;
	const index = args.indexOf("--socket");
	if (index >= 0) {
		socket = args[index + 1];
		if (!socket) throw new Error("Missing socket path");
		args = [...args.slice(0, index), ...args.slice(index + 2)];
	}
	if (args.length !== 3 || args[1] !== "--input" || args[2] !== "-")
		throw new Error(
			"FLOW_LEGACY_ARGUMENTS_UNSUPPORTED: use COMMAND --input - with the original JSON contract; existing state is unchanged",
		);
	const config = await loadConfig(configPath);
	if (process.stdin.isTTY)
		throw new Error("Flow requires a JSON request on stdin");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		const data = Buffer.from(chunk);
		size += data.length;
		if (size > 16 * 1024 * 1024) throw new Error("Flow input too large");
		chunks.push(data);
	}
	const selected = socket ?? config.codexAppServerSocket;
	const sinks = { stdout: process.stdout, stderr: process.stderr };
	let outputStarted = false;
	const options = flowProcessOptions(config, Buffer.concat(chunks), selected, args[0]);
	options.outputSink = async (stream, bytes) => {
		if (stream === "stdout") outputStarted = true;
		const target: Writable = sinks[stream];
		// Serialize bounded writes and wait for each callback, including EPIPE.
		for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
			await new Promise<void>((resolve, reject) => {
				target.write(bytes.subarray(offset, offset + 64 * 1024), error => error ? reject(error) : resolve());
			});
		}
	};
	// Writable errors must be handled even after a failed write callback.
	const sinkError = () => {};
	process.stdout.on("error", sinkError);
	process.stderr.on("error", sinkError);
	try {
	const result = await new SkillsRuntime().run(
		"skills/multi-task-flow/scripts/orchestrate.ts",
		args,
		options,
	);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exitCode = result.code ?? 1;
	} catch (error) {
		if (!outputStarted) throw error;
		await new Promise<void>(resolve => process.stderr.write(JSON.stringify({ ok: false, code: "FLOW_OUTPUT_FAILED", message: String(error) }) + "\n", () => resolve()));
		process.exitCode = 1;
	} finally {
		// Writable emits an error after its write callback; keep handlers through that turn.
		await new Promise<void>(resolve => setImmediate(resolve));
		process.stdout.off("error", sinkError);
		process.stderr.off("error", sinkError);
	}
}
