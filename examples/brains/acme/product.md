---
component: product
status: approved
version: 1
updated: 2026-11-01
owner: Head of Sales
---

# Product

## summary
- kind: summary
- text: Acme Quarantine finds flaky tests in CI and quarantines them automatically, so one unreliable test stops blocking every merge.

## problem
- kind: problem
- text: Flaky tests fail at random, so engineers rerun pipelines and stop trusting red builds.

## capability-detection
- kind: capability
- text: Watches every CI run, scores each test for flakiness from its pass and fail history, and names the worst offenders.

## capability-quarantine
- kind: capability
- text: Moves a flaky test out of the blocking path until its owner fixes it, then puts it back.

## outcome
- kind: outcome
- text: Fewer reruns, faster merges and a build that people believe again.

## use-case-platform
- kind: use_case
- text: Platform and developer-experience teams that own CI for many product teams.

## not-for-tiny-teams
- kind: not_for
- text: Teams without a sizable automated test suite, or without CI on every pull request.
