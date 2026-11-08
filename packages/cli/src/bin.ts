#!/usr/bin/env node
// GTM-agents: the gtm command. Node 24 runs this TypeScript directly.
import { main } from "./index.ts";

process.exitCode = await main(process.argv.slice(2));
