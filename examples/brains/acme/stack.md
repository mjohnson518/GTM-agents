---
component: stack
status: approved
version: 1
updated: 2026-11-01
owner: Head of Product
---

# Stack

## github-actions
- technology: GitHub Actions
- relation: integrates
- text: Acme reads test reports from workflow runs through a lightweight step added to the workflow.

## buildkite
- technology: Buildkite
- relation: integrates
- text: Acme reads test reports from Buildkite pipelines through an upload step.

## junit-reports
- technology: JUnit XML reports
- relation: requires
- text: Any test framework that writes JUnit-style reports works, which covers most languages.

## ci-retries
- technology: Built-in CI retries
- relation: replaces
- text: Teams usually turn blanket retries off once quarantine is running.

## ci-dashboards
- technology: CI analytics dashboards
- relation: complements
- text: Dashboards keep reporting build metrics; Acme handles the flaky tests they surface.
