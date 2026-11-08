# Example brains

A brain is the company-specific knowledge a deployment's prompts read: market profile, personas, ICP, message pillars, objections, competitors, influencers, keyword portfolio, voice, signals, stack, hiring, facts and commercial terms. Each component is one short Markdown file of typed items, served to a task only when the operator has approved it and its hash matches the lock file.

`acme/` is a complete example for a fictional developer-tools company. To start your own brain, copy it and replace every item. `gtm brain validate <dir>` checks the result against the schema and the per-task byte budgets.
