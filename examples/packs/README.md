# Domain packs

This page is for contributors who want to adapt GTM-agents to a vertical. A domain pack does that without changing core. A pack can contribute:

- **discovery sources** for that market (public filings, industry registries, niche directories), registered as a `DiscoverySource` or `SignalSource`;
- **a domain wiki** compiled from database aggregates, with its own lint rules;
- **vertical adapters** for data providers that only make sense in that market.

Everything in a pack goes through the same ports, taint classification, budgets and gates as the core adapters. A pack that adds tables ships its own migrations and keeps per-record fields in `attributes` ([docs/DATA-MODEL.md](../../docs/DATA-MODEL.md#what-is-not-in-core)). No pack ships with this release; [docs/INTERFACES.md](../../docs/INTERFACES.md) has the ports a pack implements.
