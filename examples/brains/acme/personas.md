---
component: personas
status: approved
version: 1
updated: 2026-11-01
owner: Head of Sales
---

# Personas

## economic-buyer
- role: economic_buyer
- seat: decision_maker
- titles: VP Engineering, Head of Engineering, CTO, Director of Engineering
- seniority: c_level, vp, head, director
- text: Owns the engineering tooling budget and cares about delivery speed and developer retention.

## platform-champion
- role: champion
- seat: influencer
- titles: Staff Engineer, Principal Engineer, Platform Lead, Head of Developer Experience
- seniority: senior, lead, head
- text: Feels flaky pipelines every day and can run a trial without asking anyone.

## engineering-manager
- role: user
- seat: influencer
- titles: Engineering Manager, Team Lead
- seniority: manager, lead
- text: Watches the team lose focus to reruns and wants fewer interruptions in the sprint.

## quality-lead
- role: influencer
- seat: influencer
- titles: QA Lead, Test Engineering Manager, SDET Lead
- seniority: lead, manager
- exclude_titles: QA Intern
- text: Owns the test suite's health and wants flaky tests tracked, not silently retried.

## security-reviewer
- role: blocker
- seat: other
- titles: Security Engineer, Head of Security, CISO
- text: Reviews any tool that reads CI data and needs to know what access it requires.
