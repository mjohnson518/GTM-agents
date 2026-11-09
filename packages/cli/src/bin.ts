#!/usr/bin/env node
// GTM-agents: the gtm command. In a checkout Node 24 runs this TypeScript directly; the published
// package ships it compiled to JavaScript (docs/RELEASING.md).
import { main } from "./index.ts";

process.exitCode = await main(process.argv.slice(2));
