---
component: objections
status: approved
version: 1
updated: 2026-11-01
owner: Head of Sales
---

# Objections

## we-retry
- objection: Our CI already retries failed tests automatically.
- response: Retries hide flakes and make every build slower; quarantine removes the flaky test from the critical path and tracks it until someone fixes it.
- personas: platform-champion, quality-lead

## built-a-script
- objection: We wrote a script that tracks flaky tests.
- response: Many teams start there; the difference is automatic quarantine and ownership, so the script stops being one more thing to maintain.
- personas: platform-champion

## security-access
- objection: We cannot give a vendor access to our code.
- response: Acme reads test reports only and never needs access to source code, which is what most security reviews ask about first.
- personas: security-reviewer

## not-a-priority
- objection: Flaky tests are annoying but not a priority this quarter.
- response: That is fair; a one-month rerun report shows the hours involved, which helps decide whether it belongs in next quarter's plan.
- personas: economic-buyer, engineering-manager

## too-small
- objection: We are too small for this.
- response: If fewer than a few builds a week are rerun, you probably are, and we would say so.
