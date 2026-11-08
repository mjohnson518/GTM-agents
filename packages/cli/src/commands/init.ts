// GTM-agents: `gtm init <dir>`, which creates a new deployment from the worker template.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REQUIRED_BINDINGS } from "@gtm-agents/core/config";
import { EXIT, type Io } from "../lib/io.ts";
import { parseJsonc } from "../lib/jsonc.ts";
import { hasBinding } from "../lib/wrangler-config.ts";

export interface InitOptions {
  /** The worker template to copy. Defaults to apps/worker in this repository. */
  templateDir?: string;
}

const USAGE = "Usage: gtm init <dir> [--name <worker-name>] [--local <path-to-gtm-agents-checkout>]";
const DEFAULT_TEMPLATE = fileURLToPath(new URL("../../../../apps/worker/", import.meta.url));
const WORKER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Files copied from the template, relative to it. */
const TEMPLATE_FILES = ["wrangler.jsonc", "src/index.ts", "gtm.config.ts", ".dev.vars.example", "brain/README.md", "templates/README.md"];

const TOOLING = { wrangler: "4.152.0", "@cloudflare/workers-types": "5.20261024.1", typescript: "6.0.3" };

export function initCommand(args: string[], io: Io, options: InitOptions = {}): number {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { name: { type: "string" }, local: { type: "string" } } });
  } catch (err) {
    io.err(`gtm init: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const target = parsed.positionals[0];
  if (!target) {
    io.err(USAGE);
    return EXIT.usage;
  }
  const dir = resolve(io.cwd, target);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    io.err(`gtm init: ${dir} is not empty; choose a new or empty directory`);
    return EXIT.usage;
  }
  const name = parsed.values.name ?? slug(basename(dir));
  if (!WORKER_NAME.test(name) || name.length > 48) {
    io.err(`gtm init: "${name}" is not a valid Worker name; use lowercase letters, digits and hyphens, at most 48 characters (--name)`);
    return EXIT.usage;
  }
  const templateDir = options.templateDir ?? DEFAULT_TEMPLATE;
  const local = parsed.values.local ? resolve(io.cwd, parsed.values.local) : undefined;

  mkdirSync(dir, { recursive: true });
  for (const file of TEMPLATE_FILES) {
    const from = join(templateDir, file);
    if (!existsSync(from)) {
      io.err(`gtm init: the template is missing ${file} (looked in ${templateDir})`);
      return EXIT.failed;
    }
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), rewrite(file, readFileSync(from, "utf8"), name));
  }

  const config = parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
  const missing = REQUIRED_BINDINGS.filter((b) => !hasBinding(config, b));
  if (missing.length) {
    io.err(`gtm init: the template's wrangler.jsonc is missing bindings: ${missing.map((b) => b.name).join(", ")}`);
    return EXIT.failed;
  }

  writeFileSync(join(dir, "package.json"), `${JSON.stringify(packageJson(name, local), null, 2)}\n`);
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n.wrangler/\n.dev.vars\n.dev.vars.*\n!.dev.vars.example\n");
  writePublicAssets(dir, templateDir);

  const shown = relative(io.cwd, dir) || ".";
  io.out(`Created ${shown} (Worker name: ${name}).`);
  io.out("");
  io.out("Next steps:");
  io.out(`  cd ${shown}`);
  io.out(local ? "  npm install" : "  npm install            (the @gtm-agents packages are not published yet; rerun init with --local <checkout> to install from a local copy)");
  io.out("  edit gtm.config.ts      your company, sending addresses, adapters and models");
  io.out("  add brain/ and templates/ files, then: npx gtm brain validate");
  io.out("  npx gtm doctor");
  return EXIT.ok;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "gtm-agent";
}

/** Adjust template files for a standalone project outside this repository. */
function rewrite(file: string, content: string, name: string): string {
  if (file === "wrangler.jsonc") {
    return content
      .replace('"$schema": "../../node_modules/wrangler/config-schema.json"', '"$schema": "node_modules/wrangler/config-schema.json"')
      .replace(/^\s*"build": \{[^\n]*\},\n/m, "")
      .replaceAll('"migrations_dir": "../../packages/core/migrations"', '"migrations_dir": "node_modules/@gtm-agents/core/migrations"')
      .replace('"name": "gtm-agent-staging"', `"name": "${name}-staging"`)
      .replace('"name": "gtm-agent"', `"name": "${name}"`)
      .replace('"bucket_name": "gtm-agent-staging-bucket"', `"bucket_name": "${name}-staging-bucket"`)
      .replace('"bucket_name": "gtm-agent-bucket"', `"bucket_name": "${name}-bucket"`);
  }
  if (file.endsWith("README.md")) {
    return content.replace("[docs/BRAIN-SCHEMA.md](../../../docs/BRAIN-SCHEMA.md)", "`docs/BRAIN-SCHEMA.md` in the GTM-agents repository");
  }
  return content;
}

function packageJson(name: string, local: string | undefined): Record<string, unknown> {
  const dep = (pkg: string) => (local ? `file:${join(local, "packages", pkg)}` : "0.0.0");
  return {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { dev: "wrangler dev", deploy: "wrangler deploy", "deploy:staging": "wrangler deploy --env staging", check: "gtm brain validate && gtm doctor" },
    dependencies: { "@gtm-agents/adapters": dep("adapters"), "@gtm-agents/core": dep("core") },
    devDependencies: { "@gtm-agents/cli": dep("cli"), ...TOOLING },
  };
}

const TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    lib: ["ES2023"],
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["@cloudflare/workers-types"],
  },
  include: ["src/**/*.ts", "gtm.config.ts"],
};

/** The Worker serves public/ as static assets; copy the built dashboard when it is available. */
function writePublicAssets(dir: string, templateDir: string): void {
  const built = join(templateDir, "public", "admin");
  const target = join(dir, "public", "admin");
  if (existsSync(join(built, "index.html"))) {
    cpSync(built, target, { recursive: true });
    return;
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "index.html"),
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>GTM-agents</title></head>\n<body><p>The operator dashboard has not been built into this deployment yet.</p></body></html>\n',
  );
}
