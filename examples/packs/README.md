# Domain packs

A domain pack adapts GTM-agents to a vertical without changing core. A pack can contribute:

- **discovery sources** for that market (public filings, industry registries, niche directories), registered as a `DiscoverySource` or `SignalSource`;
- **a domain wiki** compiled from database aggregates, with its own lint rules;
- **vertical adapters** for data providers that only make sense in that market.

Everything in a pack goes through the same ports, taint classification, budgets and gates as the core adapters. Packs arrive after the sourcing and signals milestones.
