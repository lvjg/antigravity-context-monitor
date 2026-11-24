---
name: context-window-monitor
description: Open the Antigravity Context Window Monitor UI panel or check real-time context window usage, model quotas, reset countdowns, and token costs. Use when the user asks to view context usage, model quotas, token consumption, or open the context monitor.
---

# Antigravity Context Window Monitor

When the user asks to open the Context Window Monitor, check context window usage, or inspect model quotas/costs in Antigravity:

1. Surface the one-click UI pill in chat so the user can open the monitor in the right-hand Auxiliary Pane:
   `[Context Window Monitor](sidecar://antigravity-context-monitor/monitor/)`
2. Saved account snapshots and custom pricing preferences live in `~/.gemini/antigravity/sidecar_data/antigravity-context-monitor/monitor/data/accounts.json` (<5 KB). All runtime conversation usage is read directly on-demand from Antigravity's local `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` files without duplicating runtime state on disk.
