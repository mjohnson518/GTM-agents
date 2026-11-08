---
component: signals
status: approved
version: 1
updated: 2026-11-01
owner: Head of Sales
---

# Signals

## platform-hiring
- type: hiring
- weight: 0.6
- max_age_days: 45
- text: Hiring platform or developer-experience engineers usually means CI pain has reached leadership.

## new-engineering-leader
- type: job_change
- weight: 0.5
- max_age_days: 90
- text: A new engineering leader often reviews tooling in their first quarter.

## funding-round
- type: funding
- weight: 0.4
- max_age_days: 60
- text: A new round usually brings engineering hiring, and a larger test suite soon after.

## ci-incident-post
- type: post
- weight: 0.7
- max_age_days: 14
- text: A public post by an engineer about flaky tests or broken pipelines is the clearest reason to write.

## monorepo-launch
- type: launch
- weight: 0.3
- max_age_days: 60
- text: Announcing a move to a monorepo signals a test suite that is about to grow quickly.
