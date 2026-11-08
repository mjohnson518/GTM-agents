# Security policy

GTM-agents sends email on someone's behalf, reads untrusted text from the web and from inboxes, holds people's contact data, and spends money on model and data providers. Its security model exists to make sure none of that can be turned against the operator or the people it contacts. Reports that help keep it that way are very welcome.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through one of these channels:

1. GitHub private vulnerability reporting: the **Report a vulnerability** button on this repository's **Security** tab.
2. Email `<security contact>`. If you operate a deployment or a fork, replace this with your own security contact.

Please include:
- what you found;
- the component and commit;
- steps to reproduce, or a proof of concept that uses only synthetic data;
- what an attacker could achieve.

The maintainers will acknowledge your report, keep you updated while it is investigated, and credit you in the fix unless you prefer otherwise. Please give a reasonable window for a fix before disclosing publicly.

## What counts as a vulnerability here

Anything that defeats one of the system's safety controls, including:

- **Taint or action-gate bypass:** untrusted text (a web page, an inbound email, a provider response, product feedback) causes a send, a write, a spend or code execution. This includes laundering taint through delegation.
- **Prompt injection that escapes the fence:** content that closes its own quarantine block, or reaches a system prompt.
- **Approval bypass:** sending content that differs from what was approved, reusing an approval for changed content, or releasing a batch without its manifest.
- **A gate that fails open:** the halt flag, kill switch, suppression check, budget gate or verification policy allowing an action when its state cannot be read.
- **Suppression bypass:** emailing an opted-out, bounced, complained or erased address by any path.
- **Webhook signature bypass,** replay outside the allowed window, or a webhook that acts before verifying.
- **Unauthenticated access** to the dashboard RPC, the run status API or operator commands, or a way around the operator chat allowlist.
- **SSRF or data exfiltration** through URL-fetching or search tools, including data carried out in URLs or queries.
- **Secret exposure** in logs, errors, stored memory, prompts or responses.
- **Erasure that does not hold:** an erased person re-added by sourcing, the product bridge, billing or referrals.
- **Escalation of a permanently human-only action** (merging code, pricing, billing, auth, offers, proof-of-value sends, data deletion) to automatic.

## Usually out of scope

- Deliverability problems, spam-folder placement or provider policy decisions.
- Misuse by an operator of their own deployment. [ACCEPTABLE-USE.md](ACCEPTABLE-USE.md) covers that.
- Vulnerabilities in a third-party service itself, rather than in how this system uses it.
- Issues that require an attacker who already controls the operator's Cloudflare account, the deployment's secrets or the operator chat.
- Missing hardening with no demonstrated impact. Suggestions are still welcome as regular issues.

## Supported versions

The project is pre-1.0. Security fixes land on the default branch. Deployments should track it.

## Testing safely

Use your own deployment, synthetic data and `*.example` addresses. Never test against a deployment you do not operate, and never send email to real people as part of a test.
