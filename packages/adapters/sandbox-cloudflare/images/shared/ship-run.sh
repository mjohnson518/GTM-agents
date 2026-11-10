#!/bin/sh
# GTM-agents: runs one ship sandbox step in the background, for the sandbox-cloudflare adapter.
#
# Usage: ship-run <step-dir> <limit-seconds> <command> [args...]
#
# The command runs in its own session under `timeout`, so the whole process group is stopped at the
# limit (exit 124, or 137 when it had to be killed). Its output goes to files instead of back to the
# Durable Object: a process with piped output is stopped once the request that started it ends. The
# step's directory receives, in order:
#   pid         the process id and this container's boot id, written as soon as the command starts
#   stdout.log  and stderr.log, the command's output
#   exit-code   written last, through a rename, so a reader never sees a partial value
set -u
dir=$1
limit=$2
shift 2
mkdir -p "$dir"
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" > "$0/pid"; limit=$1; shift; exec timeout --kill-after=30s "${limit}s" "$@"' \
	"$dir" "$limit" "$@" > "$dir/stdout.log" 2> "$dir/stderr.log" < /dev/null
code=$?
echo "$code" > "$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"
