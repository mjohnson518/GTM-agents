# Acceptable use

This page is for anyone deciding whether to deploy GTM-agents, operating a deployment, or contributing to it. GTM-agents automates business development: finding companies that might need a product, writing to the right people there, and following up. Done carelessly, that is spam. This policy describes what the system is for and what it must not be used for. Its defaults are built to make the right thing the easy thing. The operator remains responsible for how a deployment is used.

## What it is for

- **Business-to-business outreach** about a real product or service, to people whose job makes it plausibly relevant to them.
- **Work email addresses only.** The system refuses personal mail domains and never collects, enriches or emails personal addresses or phone numbers.
- **Honest, plain-text email from a real sender,** with a real reply address, a postal address and a one-click unsubscribe.

## Defaults that respect consent

These ship on, and should stay on:

- **Opt-outs are permanent.** An unsubscribe, a complaint or a hard bounce suppresses the address. There is no tool to remove an address from suppression. An opt-out also keeps the rest of that account out of cold outreach.
- **A polite decline holds the account for 90 days,** rather than continuing to write.
- **One-click unsubscribe (RFC 8058)** and a postal footer on every cold email.
- **No tracking pixels and no click tracking.** Replies are the measure of interest.
- **Volume is capped** per sending domain and per account, ramped up only on evidence of healthy delivery, and paused automatically on bounce or complaint spikes.
- **Erasure is honored everywhere.** An erased person is tombstoned and never re-added by any sourcing path.
- **A person approves every send** until a class of action has earned autonomy from evidence. Some actions are always human.

## What it must not be used for

- **Automating LinkedIn, ever,** or any other platform whose terms forbid automated messaging, connection requests or scraping. The system can draft a short note for a person to send by hand; it never posts or messages on such platforms itself.
- **Scraping behind logins,** bypassing paywalls or access controls, or harvesting data in breach of a site's terms.
- **Consumer outreach,** or contacting people at personal addresses.
- **Purchased or rented lists of personal data,** or lists whose provenance you cannot account for.
- **Deception:** misleading subject lines, impersonating another person or company, fake "re:" or "fwd:" threads, or invented claims. The quality gate holds claims that are not in your approved facts.
- **Evading filters or consent,** for example by rotating domains to escape reputation, removing the unsubscribe headers, or disabling suppression or the kill switch.
- **Sensitive targeting:** selecting or messaging people based on health, religion, ethnicity, sexuality, political views or other special-category data.
- **Harassment:** continuing to contact anyone who has asked you to stop, by any channel.

## The operator's responsibility

The person or company that runs a deployment is responsible for it. In particular:

- **Email and privacy law in every market you send to.** For example CAN-SPAM in the United States, GDPR and PECR in the UK and EU, and CASL in Canada. Record the legal basis you rely on for each market. The system's defaults help, but they are not legal advice and do not make any particular use lawful.
- **Your providers' terms:** the email provider, the data providers, the model providers and Cloudflare. The agent never accepts provider terms on your behalf.
- **The content you approve.** Templates, copy lines, facts and offers are yours.
- **Data requests.** Respond to access and erasure requests. [docs/DEPLOYING.md](docs/DEPLOYING.md#data-erasure-requests) shows how to erase a person from a deployment, and [docs/EVENT-CONTRACT.md](docs/EVENT-CONTRACT.md) how your product's own deletions reach it.

## Reporting misuse

If you believe a deployment of this software is being used against this policy, contact the operator of that deployment first. Use their unsubscribe link or reply-to address, which every email carries. The maintainers of this repository do not operate deployments and cannot stop one. Changes to the software that would make misuse harder are welcome as issues or pull requests.
