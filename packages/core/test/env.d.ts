// GTM-agents: the bindings available inside the core test suite.
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      KV: KVNamespace;
      BUCKET: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
