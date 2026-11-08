#!/usr/bin/env bash
# GTM-agents: secrets scan.
#
# Looks for well-known credential formats in the files a commit would contain. It prints the
# location and the kind of credential, never the value, so its output is safe to show in CI logs.
# Secrets belong in `wrangler secret put` (or .dev.vars for local development, which is ignored).
#
# Usage: scripts/secrets-scan.sh [--staged | --files <paths...>]
#   (no flag)  tracked files plus untracked files that are not ignored
#   --staged   staged contents only
#   --files    explicit files
#
# A line that must show a credential-shaped example can carry the marker "secrets-scan:allow".
set -eo pipefail

patterns=(
  "Anthropic API key|sk-ant-[A-Za-z0-9_-]{20,}"
  "OpenAI API key|sk-(proj-)?[A-Za-z0-9_-]{32,}"
  "GitHub token|gh[pousr]_[A-Za-z0-9]{36,}"
  "GitHub fine-grained token|github_pat_[A-Za-z0-9_]{40,}"
  "AWS access key id|AKIA[0-9A-Z]{16}"
  "Google API key|AIza[0-9A-Za-z_-]{35}"
  "Slack token|xox[abprs]-[A-Za-z0-9-]{10,}"
  "Stripe live key|(sk|rk)_live_[A-Za-z0-9]{16,}"
  "Stripe webhook secret|whsec_[A-Za-z0-9]{24,}"
  "Resend API key|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}"
  "xAI API key|xai-[A-Za-z0-9]{32,}"
  "Telegram bot token|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}"
  "Private key block|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----"
)

mode="tree"
case "${1:-}" in
  --staged) mode="staged" ;;
  --files) mode="files"; shift ;;
  "") ;;
  *) echo "usage: scripts/secrets-scan.sh [--staged | --files <paths...>]" >&2; exit 2 ;;
esac

if [ "$mode" != "files" ]; then
  root="$(git rev-parse --show-toplevel)"
  cd "$root"
fi

self="scripts/secrets-scan.sh"
found=0

for entry in "${patterns[@]}"; do
  name="${entry%%|*}"
  regex="${entry#*|}"
  case "$mode" in
    staged) out="$(git grep --cached -n -I -E -e "$regex" -- . ":(exclude)$self" || true)" ;;
    tree) out="$(git grep --untracked -n -I -E -e "$regex" -- . ":(exclude)$self" || true)" ;;
    files)
      if [ "$#" -eq 0 ]; then out=""; else out="$(grep -n -I -E -H -e "$regex" -- "$@" || true)"; fi
      ;;
  esac
  [ -z "$out" ] && continue
  while IFS= read -r line; do
    case "$line" in *secrets-scan:allow*) continue ;; esac
    location="$(printf '%s' "$line" | cut -d: -f1,2)"
    echo "$location: possible $name" >&2
    found=1
  done <<< "$out"
done

if [ "$found" -ne 0 ]; then
  echo "secrets-scan: credential-shaped values found; move them to wrangler secrets or .dev.vars" >&2
  exit 1
fi
echo "secrets-scan: clean"
