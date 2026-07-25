import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type RpcId = number;
export type RpcWireId = string | number;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type RpcResponse = {
  jsonrpc?: string;
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: unknown;
};

export type RpcMessageHandler = (method: string, params: unknown) => void;
export type RpcRequestHandler = (
  id: RpcWireId,
  method: string,
  params: unknown,
) => void;
export type RpcExitHandler = (error: Error, expected: boolean) => void;
export type RpcProtocolErrorHandler = (error: Error) => void;

export type JsonRpcProcessOptions = {
  command: string;
  args: string[];
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxIncomingBytes?: number;
};

export class RpcRequestTimeoutError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`JSON-RPC request timed out: ${method}`);
    this.name = "RpcRequestTimeoutError";
    this.method = method;
  }
}

export class JsonRpcProcess {
  readonly command: string;
  readonly args: string[];
  readonly requestTimeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly maxIncomingBytes: number;
  #child: ChildProcessWithoutNullStreams | null = null;
  #stdout = Buffer.alloc(0);
  #expectedExit = false;
  #nextId = 1;
  #pending = new Map<RpcId, Pending>();
  #notificationHandlers = new Set<RpcMessageHandler>();
  #requestHandlers = new Set<RpcRequestHandler>();
  #exitHandlers = new Set<RpcExitHandler>();
  #protocolErrorHandlers = new Set<RpcProtocolErrorHandler>();

  constructor(options: JsonRpcProcessOptions) {
    this.command = options.command;
    this.args = options.args;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.env = { ...safeParentEnvironment(), ...options.env };
    this.maxIncomingBytes = options.maxIncomingBytes ?? 1024 * 1024;
  }

  start(): void {
    if (this.#child) return;
    this.#stdout = Buffer.alloc(0);
    this.#expectedExit = false;
    const child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    let finished = false;
    const finish = (error: Error): void => {
      if (finished) return;
      finished = true;
      if (this.#child === child) this.#child = null;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      for (const handler of this.#exitHandlers) {
        handler(error, this.#expectedExit);
      }
    };
    child.stdin.on("error", () => {
      // Process exit/error is the single failure signal for pending requests.
    });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => this.#receiveChunk(chunk));
    child.once("error", (cause) => {
      finish(
        new Error(`Unable to start Codex app-server: ${cause.message}`, {
          cause,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      finish(
        new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).`),
      );
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.#requireChild();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcRequestTimeoutError(method));
      }, this.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  notify(method: string, params?: unknown): void {
    const message =
      params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params };
    this.#requireChild().stdin.write(`${JSON.stringify(message)}\n`);
  }

  respond(id: RpcWireId, result: unknown): void {
    this.#requireChild().stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`,
    );
  }

  respondError(id: RpcWireId, code: number, message: string): void {
    this.#requireChild().stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
    );
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#expectedExit = true;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  terminate(): void {
    this.#expectedExit = false;
    this.#child?.kill("SIGKILL");
  }

  onNotification(handler: RpcMessageHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  onRequest(handler: RpcRequestHandler): () => void {
    this.#requestHandlers.add(handler);
    return () => this.#requestHandlers.delete(handler);
  }

  onExit(handler: RpcExitHandler): () => void {
    this.#exitHandlers.add(handler);
    return () => this.#exitHandlers.delete(handler);
  }

  onProtocolError(handler: RpcProtocolErrorHandler): () => void {
    this.#protocolErrorHandlers.add(handler);
    return () => this.#protocolErrorHandlers.delete(handler);
  }

  #requireChild(): ChildProcessWithoutNullStreams {
    if (!this.#child) throw new Error("Codex app-server is not running.");
    return this.#child;
  }

  #receive(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#fatalProtocol("Malformed JSON from Codex app-server.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.#fatalProtocol("Invalid JSON-RPC envelope from Codex app-server.");
      return;
    }
    const message = parsed as RpcResponse;
    if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0") {
      this.#fatalProtocol("Invalid JSON-RPC version from Codex app-server.");
      return;
    }
    if (typeof message.method === "string") {
      if (
        message.id !== undefined &&
        typeof message.id !== "string" &&
        typeof message.id !== "number"
      ) {
        this.#fatalProtocol(
          "Invalid JSON-RPC request id from Codex app-server.",
        );
        return;
      }
      if (message.id !== undefined) {
        for (const handler of this.#requestHandlers) {
          handler(message.id, message.method, message.params);
        }
      } else {
        for (const handler of this.#notificationHandlers) {
          handler(message.method, message.params);
        }
      }
      return;
    }
    if (typeof message.id !== "number") {
      this.#fatalProtocol("Invalid JSON-RPC response from Codex app-server.");
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          `JSON-RPC ${message.error.code ?? "error"}: ${
            message.error.message ?? "unknown error"
          }`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #receiveChunk(chunk: Buffer): void {
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    if (this.#stdout.byteLength > this.maxIncomingBytes) {
      this.#fatalProtocol("Codex app-server output exceeded the line limit.");
      return;
    }
    let newline = this.#stdout.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#stdout
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/, "");
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (Buffer.byteLength(line) > this.maxIncomingBytes) {
        this.#fatalProtocol("Codex app-server output exceeded the line limit.");
        return;
      }
      if (line.trim()) this.#receive(line);
      newline = this.#stdout.indexOf(0x0a);
    }
  }

  #fatalProtocol(message: string): void {
    const error = new Error(message);
    for (const handler of this.#protocolErrorHandlers) handler(error);
    this.#child?.kill("SIGTERM");
  }
}

function safeParentEnvironment(): NodeJS.ProcessEnv {
  const safeNames = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "CODEX_HOME",
  ];
  return Object.fromEntries(
    safeNames.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
