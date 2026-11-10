# GTM-agents: the ship sandbox image for the claude-code profile (sandbox-cloudflare adapter).
#
# Build context: the images/ directory, so the shared scripts are in reach. In wrangler.jsonc:
#   "images": { "claude-code": { "dockerfile": ".../images/claude-code/Dockerfile", "build_context": ".../images" } }
#
# The container starts with internet access off and holds no credentials. Everything the agent needs
# at run time is installed here; at run time it reaches only the model API, the package registry and,
# for the clone only, the git host, all through the Worker. The Claude Code version is pinned exactly
# (its flags and event format change between releases), and the sandbox helper comes from the
# cloudflare/sandbox image whose tag matches the @cloudflare/sandbox version in package.json.
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox

FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends bash ca-certificates coreutils git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install --global @anthropic-ai/claude-code@2.1.308 \
	&& npm cache clean --force

COPY --from=sandbox /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY shared/ship-run.sh /usr/local/bin/ship-run
COPY shared/ship-collect.mjs /usr/local/lib/ship/ship-collect.mjs
RUN chmod 0755 /usr/local/bin/ship-run /usr/local/lib/ship/ship-collect.mjs \
	&& mkdir -p /workspace/task /workspace/home

WORKDIR /workspace
CMD ["sleep", "infinity"]
