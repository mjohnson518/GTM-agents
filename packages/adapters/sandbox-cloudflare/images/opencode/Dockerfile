# GTM-agents: the ship sandbox image for the opencode profile (sandbox-cloudflare adapter).
#
# Build context: the images/ directory, so the shared scripts are in reach. In wrangler.jsonc:
#   "images": { "opencode": { "dockerfile": ".../images/opencode/Dockerfile", "build_context": ".../images" } }
#
# The container starts with internet access off and holds no credentials. The baseline x64 OpenCode
# binary is installed directly, pinned exactly: it runs on every x64 CPU, where the opencode-ai
# package would pick a binary for the machine that builds the image. ripgrep is installed so OpenCode
# never tries to download it. The sandbox helper comes from the cloudflare/sandbox image whose tag
# matches the @cloudflare/sandbox version in package.json.
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox

FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends bash ca-certificates coreutils git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install --global --ignore-scripts opencode-linux-x64-baseline@1.19.4 \
	&& ln -s /usr/local/lib/node_modules/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode \
	&& npm cache clean --force

COPY --from=sandbox /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY shared/ship-run.sh /usr/local/bin/ship-run
COPY shared/ship-collect.mjs /usr/local/lib/ship/ship-collect.mjs
RUN chmod 0755 /usr/local/bin/ship-run /usr/local/lib/ship/ship-collect.mjs \
	&& mkdir -p /workspace/task /workspace/home

WORKDIR /workspace
CMD ["sleep", "infinity"]
