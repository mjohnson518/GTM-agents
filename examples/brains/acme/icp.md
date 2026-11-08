---
component: icp
status: approved
version: 1
updated: 2026-11-01
owner: Head of Sales
---

# Ideal customer profile

## who
- kind: who
- text: Software companies with 30 to 300 engineers, CI on every pull request, and at least one large test suite.

## why-now
- kind: why_now
- text: The team has grown past the point where people know which tests are flaky, and reruns are eating sprint time.

## must-run-ci
- kind: must_have
- text: Runs CI on a hosted or self-hosted runner that exposes test results in JUnit or a similar report format.

## trigger-platform-hiring
- kind: trigger
- text: The company is hiring platform or developer-experience engineers.

## ignore-tiny-teams
- kind: ignore
- text: Teams under ten engineers rarely have enough flakes to justify a tool.

## never-agencies
- kind: never
- text: Agencies and consultancies build for clients and do not own the CI they run.
- titles: Agency Owner, Account Director

## never-competitors
- kind: never
- text: Never write to companies that sell CI analytics themselves.
- domains: globex.example, initech.example

## unknown-regulated
- kind: unknown
- text: Whether regulated industries can send test metadata to a hosted service is not yet known.
