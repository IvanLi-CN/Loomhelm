import { isoTimestamp, systemClock } from "../core/clock";
import { runProcess, type ProcessResult } from "../core/process";
import { redactProviderValue } from "./redact";
import { HostingError, type RepositoryBinding } from "./types";

export interface ProviderResponse {
  status: number | null;
  payload: unknown;
  exitCode: number;
  observedAt: string;
  etag?: string;
}

export type ProviderRunner = (request: {
  command: string;
  args: string[];
  cwd?: string;
  stdin?: string;
}) => Promise<ProcessResult>;

export interface HostingBackend {
  readonly binding: RepositoryBinding;
  request(
    endpoint: string,
    options?: {
      method?: string;
      data?: Record<string, unknown>;
      include?: boolean;
      requireStatus?: boolean;
      check?: boolean;
      operation?: string;
      headers?: Record<string, string>;
    },
  ): Promise<ProviderResponse>;
}

function statusFromOutput(stdout: string, stderr: string): number | null {
  const matches = [
    ...`${stdout}\n${stderr}`.matchAll(/HTTP\/[0-9.]+\s+(\d{3})/g),
  ];
  const raw = matches.at(-1)?.[1];
  return raw ? Number(raw) : null;
}

function etagFromOutput(stdout: string, stderr: string): string | undefined {
  const match = `${stdout}\n${stderr}`.match(
    /(?:^|\r?\n)\s*etag:\s*([^\r\n]+)/i,
  );
  const value = match?.[1]?.trim();
  return value || undefined;
}

function headerArgs(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n]/.test(value))
      throw new HostingError(
        "invalid_arguments",
        "provider request header is malformed",
        "api",
      );
    return ["--header", `${name}: ${value}`];
  });
}

function parsePayload(stdout: string, preserveRawText = false): unknown {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    for (const marker of ["{", "[", '"']) {
      const index = stdout.indexOf(marker);
      if (index < 0) continue;
      try {
        return JSON.parse(stdout.slice(index));
      } catch {}
    }
    return preserveRawText ? stdout.trim() : null;
  }
}

abstract class CliHostingBackend implements HostingBackend {
  constructor(
    readonly binding: RepositoryBinding,
    protected readonly cwd?: string,
    protected readonly runner: ProviderRunner = runProcess,
  ) {}

  protected abstract command(
    endpoint: string,
    method: string,
    include: boolean,
    headers: Record<string, string>,
  ): string[];
  protected bodyArgs(): string[] {
    return ["--input", "-"];
  }

  async request(
    endpoint: string,
    options: {
      method?: string;
      data?: Record<string, unknown>;
      include?: boolean;
      requireStatus?: boolean;
      check?: boolean;
      operation?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ProviderResponse> {
    const normalized = endpoint.replace(/^\/+/, "");
    let segments: string[];
    try {
      segments = normalized.split("/").map(decodeURIComponent);
    } catch {
      throw new HostingError(
        "invalid_endpoint",
        "provider endpoint is malformed",
        options.operation,
      );
    }
    const allowed =
      normalized === "user" ||
      normalized === "markdown" ||
      normalized.startsWith(`repos/${this.binding.fullName}/`);
    const refPrefix = [
      `repos/${this.binding.fullName}/branches/`,
      `repos/${this.binding.fullName}/git/refs/heads/`,
    ].find((prefix) => normalized.startsWith(prefix));
    const refSegmentIndex = refPrefix
      ? refPrefix.slice(0, -1).split("/").length
      : -1;
    const finalRefParts =
      refPrefix && segments[refSegmentIndex]
        ? segments[refSegmentIndex].split("/")
        : undefined;
    const unsafeSegment = (segment: string): boolean =>
      segment === "." || segment === ".." || /[\\\0-\x1f\x7f]/.test(segment);
    if (
      !allowed ||
      segments.some((segment, index) =>
        segment.includes("/")
          ? index !== refSegmentIndex
          : unsafeSegment(segment),
      ) ||
      finalRefParts?.some((segment) => !segment || unsafeSegment(segment))
    ) {
      throw new HostingError(
        "invalid_endpoint",
        "provider endpoint is outside the bound repository",
        options.operation,
      );
    }
    const method = (options.method ?? "GET").toUpperCase();
    const args = this.command(
      normalized,
      method,
      options.include ?? false,
      options.headers ?? {},
    );
    const stdin =
      options.data === undefined ? undefined : JSON.stringify(options.data);
    if (stdin !== undefined) args.push(...this.bodyArgs());
    let result: ProcessResult;
    try {
      result = await this.runner({
        command: this.binding.provider === "github" ? "gh" : "tea",
        args,
        ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
        ...(stdin === undefined ? {} : { stdin }),
      });
    } catch {
      throw new HostingError(
        "command_unavailable",
        "provider command is unavailable",
        options.operation,
        { provider: this.binding.provider },
      );
    }
    const status = result.timedOut
      ? null
      : (statusFromOutput(result.stdout, result.stderr) ??
        (result.exitCode === 0 && !options.requireStatus ? 200 : null));
    if (options.requireStatus && status === null) {
      throw new HostingError(
        "provider_request_failed",
        `${options.operation ?? "api"} provider response has no HTTP status`,
        options.operation,
        { status: null, provider: this.binding.provider },
      );
    }
    if (
      result.timedOut ||
      ((options.check ?? true) &&
        (result.exitCode !== 0 || (status !== null && status >= 400)))
    ) {
      throw new HostingError(
        "provider_request_failed",
        `${options.operation ?? "api"} provider request failed`,
        options.operation,
        { status, provider: this.binding.provider },
      );
    }
    const etag = etagFromOutput(result.stdout, result.stderr);
    return {
      status,
      payload: redactProviderValue(
        parsePayload(result.stdout, normalized === "markdown"),
      ),
      exitCode: result.exitCode,
      observedAt: isoTimestamp(systemClock),
      ...(etag ? { etag } : {}),
    };
  }
}

export class GitHubBackend extends CliHostingBackend {
  protected command(
    endpoint: string,
    method: string,
    include: boolean,
    headers: Record<string, string>,
  ): string[] {
    return [
      "api",
      endpoint,
      "--method",
      method,
      ...(include ? ["--include"] : []),
      ...headerArgs(headers),
    ];
  }
}

export class GiteaBackend extends CliHostingBackend {
  protected command(
    endpoint: string,
    method: string,
    include: boolean,
    headers: Record<string, string>,
  ): string[] {
    return [
      "api",
      "--remote",
      this.binding.remote,
      "--method",
      method,
      ...(include ? ["--include"] : []),
      ...headerArgs(headers),
      endpoint,
    ];
  }

  protected bodyArgs(): string[] {
    return ["--data", "@-"];
  }
}

export function backendFor(
  binding: RepositoryBinding,
  options: { cwd?: string; runner?: ProviderRunner } = {},
): HostingBackend {
  if (binding.provider === "github") {
    return new GitHubBackend(binding, options.cwd, options.runner);
  }
  return new GiteaBackend(binding, options.cwd, options.runner);
}
