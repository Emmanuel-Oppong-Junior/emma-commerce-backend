# ADR-0016 — Hosting region and data residency

Status: **Proposed** · Date: 2026-11-16 · Needs legal input

## Context
Customer PII is processed by foreign processors: Paystack, Cloudinary, Resend, Google and Facebook. Hosting is not defined in the repo. The research notes say:
- **Act 843** requires the controller to register with the Data Protection Commission and constrains cross-border transfers. The retention and transfer details are unverified.
- **The Pharmacy Council's 2021 Electronic Pharmacy Policy** requires data to be stored locally and the storefront to be linked to the national e-pharmacy platform.

Latency from Ghana to EU regions is acceptable at about 100–150 ms. In-country cloud options are limited.

## Options
1. EU region (for example Frankfurt or Ireland) for the app and database, with cross-border transfer safeguards.
2. In-country hosting (local data centres or a local cloud) for the database, with the app on the same provider.
3. Hybrid: the general store runs in an EU region, and pharmacy-vertical data (prescriptions, patient data) sits in an in-country store.

## Recommendation
**Choose the hosting region per client deployment** (made possible by ADR-0001 silo). Always run the app and the database in the same region: a cross-continent round trip inside the checkout transaction breaks it (PERF-04). **Pharmacy deployments use Ghana-hosted infrastructure**, with prescriptions and IDs in Ghana-hosted private object storage, never Cloudinary. Decide with legal counsel before launching the pharmacy vertical. For general retail at launch, option 1 with Act 843 safeguards (DPC registration, processor agreements, privacy notice) is pragmatic. Design the prescription and patient-data module (pharmacy pack) so its storage can be pointed at a separate in-country database (option 3) without changing the rest of the system.

## Reversibility
Expensive (database relocation), so the pharmacy-data boundary should be designed early.
