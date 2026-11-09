// GTM-agents: an in-memory stand-in for Wrangler and a Cloudflare account, for CLI tests. It answers
// the commands the CLI runs (list, create, KV bulk reads and writes, secrets, migrations, deploy),
// records every call, and reads the temporary files bulk calls pass while they still exist. Ids are
// generated at runtime, so no id-shaped literal appears in the source.
import { existsSync, readFileSync } from "node:fs";
import type { CommandResult, CommandRunner } from "../src/lib/io.ts";

export interface Call {
  args: string[];
  cwd: string;
  /** For bulk calls: the parsed contents of the temp file, read during the call. */
  file?: unknown;
  /** For bulk calls: the temp file's path, to check it was removed afterwards. */
  filePath?: string;
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });

export function fakeUuid(n: number): string {
  const h = n.toString(16).padStart(32, "0");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-");
}

export class FakeAccount {
  calls: Call[] = [];
  d1 = new Map<string, string>();
  kvNamespaces = new Map<string, string>();
  buckets = new Set<string>();
  indexes = new Map<string, number>();
  queues = new Set<string>();
  /** KV contents per environment ("production" or the env name). */
  kv = new Map<string, Map<string, string>>();
  /** Secret names per environment; undefined means the Worker does not exist yet. */
  secrets = new Map<string, string[]>();
  /** Return a result to make a call fail (or behave differently); undefined runs it normally. */
  intercept?: (args: string[], call: Call) => CommandResult | undefined;
  private next = 1;

  store(env = "production"): Map<string, string> {
    let s = this.kv.get(env);
    if (!s) {
      s = new Map();
      this.kv.set(env, s);
    }
    return s;
  }

  /** Calls whose arguments start with these words. */
  callsTo(...prefix: string[]): Call[] {
    return this.calls.filter((c) => prefix.every((p, i) => c.args[i] === p));
  }

  runner: CommandRunner = async (command, argv, options) => {
    if (command !== "npx" || argv[0] !== "--no-install" || argv[1] !== "wrangler") return fail(`unexpected command ${command} ${argv.join(" ")}`);
    const args = argv.slice(2);
    const call: Call = { args, cwd: options.cwd };
    const bulkFile = args[0] === "kv" && args[1] === "bulk" ? args[3] : undefined;
    if (bulkFile && existsSync(bulkFile)) {
      call.filePath = bulkFile;
      call.file = JSON.parse(readFileSync(bulkFile, "utf8")) as unknown;
    }
    this.calls.push(call);
    const intercepted = this.intercept?.(args, call);
    if (intercepted) return intercepted;
    return this.handle(args, call);
  };

  private env(args: string[]): string {
    const i = args.indexOf("--env");
    return i === -1 ? "production" : (args[i + 1] ?? "production");
  }

  private handle(args: string[], call: Call): CommandResult {
    const [a, b, c] = args;
    const words = `${a ?? ""} ${b ?? ""}`;
    switch (words) {
      case "d1 list":
        return ok(JSON.stringify([...this.d1].map(([name, uuid]) => ({ uuid, name, version: "production" })), null, 2));
      case "d1 create": {
        if (!c || this.d1.has(c)) return fail(`A database with name "${c ?? ""}" already exists`);
        this.d1.set(c, fakeUuid(this.next++));
        return ok(`Successfully created DB '${c}'`);
      }
      case "kv namespace": {
        if (c === "list") return ok(JSON.stringify([...this.kvNamespaces].map(([title, id]) => ({ id, title })), null, "  "));
        if (c === "create") {
          const title = args[3] ?? "";
          if (this.kvNamespaces.has(title)) return fail(`A KV namespace with the title "${title}" already exists.`);
          this.kvNamespaces.set(title, (this.next++).toString(16).padStart(32, "a"));
          return ok(`Creating namespace with title "${title}"\nSuccess!`);
        }
        break;
      }
      case "r2 bucket": {
        if (c === "info") {
          const name = args[3] ?? "";
          return this.buckets.has(name) ? ok(JSON.stringify({ name, created: "2026-11-01T00:00:00.000Z" })) : fail("X [ERROR] The specified bucket does not exist. [code: 10006]");
        }
        if (c === "create") {
          const name = args[3] ?? "";
          if (this.buckets.has(name)) return fail("The bucket you tried to create already exists");
          this.buckets.add(name);
          return ok(`Created bucket '${name}'`);
        }
        break;
      }
      case "vectorize list":
        return ok(JSON.stringify([...this.indexes].map(([name, dimensions]) => ({ name, config: { dimensions, metric: "cosine" } }))));
      case "vectorize create": {
        const dims = Number(args.find((x) => x.startsWith("--dimensions="))?.split("=")[1]);
        if (!c || this.indexes.has(c)) return fail("index already exists");
        this.indexes.set(c, dims);
        return ok(`Successfully created index '${c}'`);
      }
      case "queues info":
        return c && this.queues.has(c) ? ok(`Queue Name: ${c}\nQueue ID: q${this.next++}\nNumber of Producers: 0`) : fail(`X [ERROR] Queue "${c ?? ""}" does not exist. To create it, run: wrangler queues create ${c ?? ""}`);
      case "queues create": {
        if (!c || this.queues.has(c)) return fail("queue already exists");
        this.queues.add(c);
        return ok(`Created queue '${c}'`);
      }
      case "secret list": {
        const names = this.secrets.get(this.env(args));
        return names ? ok(JSON.stringify(names.map((name) => ({ name, type: "secret_text" })))) : fail("X [ERROR] This Worker does not exist on your account. [code: 10007]");
      }
      case "kv bulk": {
        const store = this.store(this.env(args));
        if (c === "get") {
          const keys = (call.file as string[]) ?? [];
          return ok(JSON.stringify(Object.fromEntries(keys.map((k) => [k, store.get(k) ?? null])), null, 2));
        }
        if (c === "put") {
          for (const e of (call.file as Array<{ key: string; value: string }>) ?? []) store.set(e.key, e.value);
          return ok("Success!");
        }
        break;
      }
      case "kv key": {
        const store = this.store(this.env(args));
        if (c === "list") return ok(JSON.stringify([...store.keys()].map((name) => ({ name }))));
        if (c === "delete") {
          store.delete(args[3] ?? "");
          return ok(`Deleting the key "${args[3] ?? ""}"`);
        }
        break;
      }
      case "d1 migrations":
        return ok(c === "apply" ? "Migrations to be applied:\n0001_baseline.sql\nOK" : "Migrations to be applied:\n0001_baseline.sql");
      default:
        if (a === "deploy") return ok(args.includes("--dry-run") ? "--dry-run: exiting now." : "Deployed gtm-agent triggers\n  schedule: * * * * *");
    }
    return fail(`fake wrangler does not know: ${args.join(" ")}`);
  }
}
