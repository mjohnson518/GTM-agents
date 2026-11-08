---
id: cold-intro
kind: cold_intro
status: approved
step: 1
angle: none
subject: Flaky builds at {{account_name}}
volume_weight: 1
personas: platform-champion, engineering-manager, economic-buyer
updated: 2026-11-01
---
Hi {{first_name}},

When a build fails for a reason unrelated to the change, someone reruns it, waits, and loses the thread of what they were doing.
{{persona_line}}

Acme spots tests that pass and fail on the same commit and quarantines them until someone fixes them, so a red build means a real problem again.

Is flaky-test time something your team tracks at {{account_name}}, or does it mostly show up as frustration in standup?

{{sender_name}}
