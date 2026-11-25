/**
 * FilmCraft MCP client — persistent stdio session.
 *
 * WHY MCP AND NOT `filmcraft-cli exec`:
 * Each `exec` invocation is a separate process with a fresh, empty in-memory
 * project. State does not persist between calls, so `timeline.place` after a
 * separate `file.newSequence` fails with "no sequence is open". The MCP server
 * is one long-lived process that holds the project, which is what a build needs.
 *
 * WHY ASSERTIONS:
 * FilmCraft command params are silently permissive — unknown keys are dropped
 * and some wrong types fall back to defaults. `timeline.place` with
 * `time:{"seconds":6}` succeeds and places the clip at 0. A `null` result means
 * "it ran", not "it worked". Every mutation is followed by a read-back in
 * assert.mjs.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export class FilmCraftError extends Error {
  constructor(message, { tool, args, detail } = {}) {
    super(message);
    this.name = "FilmCraftError";
    this.tool = tool;
    this.args = args;
    this.detail = detail;
  }
}

export class TimelineAssertionError extends Error {
  constructor(message, { expected, actual, tool } = {}) {
    super(message);
    this.name = "TimelineAssertionError";
    this.expected = expected;
    this.actual = actual;
    this.tool = tool;
  }
}

const PROTOCOL_VERSION = "2025-06-18";

export class FilmCraftClient {
  /**
   * @param {object} opts
   * @param {string} [opts.bin]      path to filmcraft-cli
   * @param {string} [opts.dataDir]  isolated data dir (preferences, models, recovery)
   * @param {string} [opts.project]      open this project at startup
   * @param {string} [opts.bridge]       connect to live GUI window (e.g. "127.0.0.1:7991")
   * @param {string} [opts.controlToken] 64-char hex FILMCRAFT_CONTROL_TOKEN for bridge mode
   * @param {string} [opts.logPath]      append every tool call + result here
   * @param {number} [opts.timeoutMs]    per-request timeout
   */
  constructor({
    bin = "/usr/bin/filmcraft-cli",
    dataDir,
    project,
    bridge = process.env.FILMCRAFT_BRIDGE,
    controlToken = process.env.FILMCRAFT_CONTROL_TOKEN,
    logPath,
    timeoutMs = 30 * 60 * 1000,
  } = {}) {
    this.bin = bin;
    this.dataDir = dataDir;
    this.project = project;
    this.bridge = bridge || null;
    this.controlToken = controlToken || null;
    this.logPath = logPath;
    this.timeoutMs = timeoutMs;

    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.callCount = 0;
    this.serverInfo = null;
  }

  mcpArgs() {
    const args = ["mcp"];
    if (this.bridge) {
      args.push("--bridge", this.bridge);
    } else {
      if (this.dataDir) args.push("--data-dir", this.dataDir);
      if (this.project) args.push("--project", this.project);
    }
    return args;
  }

  async start() {
    if (this.proc) return this;

    const args = this.mcpArgs();
    const env = { ...process.env };
    if (this.bridge) {
      if (!this.controlToken || !/^[0-9a-fA-F]{64}$/.test(this.controlToken)) {
        throw new FilmCraftError(
          "Bridge mode requires FILMCRAFT_CONTROL_TOKEN (64 hex chars)"
        );
      }
      env.FILMCRAFT_CONTROL_TOKEN = this.controlToken;
    }

    this.proc = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"], env });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.#onData(chunk));

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      const s = chunk.trim();
      if (s) process.stderr.write(`[filmcraft] ${s}\n`);
    });

    this.proc.on("exit", (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new FilmCraftError(`filmcraft MCP exited with code ${code}`));
      }
      this.pending.clear();
      this.proc = null;
    });

    const init = await this.#request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ai-video-editor", version: "0.1.0" },
    });
    this.serverInfo = init?.serverInfo ?? null;

    this.#notify("notifications/initialized", {});
    return this;
  }

  async close() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        p.kill("SIGKILL");
        resolve();
      }, 3000);
      p.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ---- transport ---------------------------------------------------------

  #onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON banner/log noise
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new FilmCraftError(`MCP error ${msg.error.code}: ${msg.error.message}`, { detail: msg.error }));
        } else {
          resolve(msg.result);
        }
      }
    }
  }

  #send(obj) {
    if (!this.proc) throw new FilmCraftError("filmcraft MCP is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  #notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FilmCraftError(`MCP request ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  // ---- MCP tool calls ----------------------------------------------------

  /**
   * Call an MCP tool. Unwraps the content[0].text JSON payload.
   * Throws on isError.
   */
  async tool(name, args = {}) {
    const res = await this.#request("tools/call", { name, arguments: args });
    this.callCount++;

    const text = res?.content?.find((c) => c.type === "text")?.text;
    let parsed = null;
    if (text !== undefined) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    await this.#log({ tool: name, args, result: parsed, isError: !!res?.isError });

    if (res?.isError) {
      const detail = parsed?.__error__ ?? (typeof parsed === "string" ? parsed : JSON.stringify(parsed));
      throw new FilmCraftError(`${name} failed: ${detail}`, { tool: name, args, detail });
    }
    if (parsed && parsed.__error__) {
      throw new FilmCraftError(`${name} failed: ${parsed.__error__}`, { tool: name, args });
    }
    return parsed;
  }

  /** Run one FilmCraft command through command_run. */
  async run(id, params = {}) {
    return this.tool("command_run", { id, params });
  }

  /**
   * Run a batch. command_batch double-encodes its report on failure, so the
   * result is re-parsed when it arrives as a string.
   */
  async runBatch(steps, { stopOnError = true } = {}) {
    const res = await this.tool("command_batch", {
      steps: steps.map((s) => ({ id: s.id, params: s.params ?? {} })),
      stop_on_error: stopOnError,
    });
    // Double-encoded string form (only on failure in some builds)
    if (typeof res === "string") {
      try {
        return JSON.parse(res);
      } catch {
        return res;
      }
    }
    return res;
  }

  // ---- typed reads -------------------------------------------------------

  async sequenceInspect() {
    return this.tool("sequence_inspect");
  }

  async projectInspect() {
    return this.tool("project_inspect");
  }

  async docInspect() {
    return this.tool("doc_inspect");
  }

  async mediaImport(paths, { bin, imageSequence } = {}) {
    return this.tool("media_import", {
      paths,
      ...(bin ? { bin } : {}),
      ...(imageSequence ? { image_sequence: true } : {}),
    });
  }

  async renderFrame({ seconds, maxSide } = {}) {
    return this.tool("render_frame", {
      ...(seconds !== undefined ? { seconds } : {}),
      ...(maxSide ? { max_side: maxSide } : {}),
    });
  }

  async commandList(filter) {
    return this.tool("command_list", filter ? { filter } : {});
  }

  /** Captions are NOT in sequence_inspect; they need their own call. */
  async captionsList(track) {
    return this.run("captions.list", track ? { track } : {});
  }

  /** Presets, so a preset name is never hardcoded. */
  async exportPresets(query) {
    return this.run("export.presets.list", query ? { query } : {});
  }

  async #log(entry) {
    if (!this.logPath) return;
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }
}
