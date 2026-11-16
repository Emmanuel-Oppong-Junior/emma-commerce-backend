# Ghana regulatory and market research for the e-commerce roadmap

Research date: 2026-11-16. Method: web search plus page/PDF fetches. Every claim carries a source URL and the date/version of the source where one was available. "Unverified" means I could not confirm it from a primary source. "Secondary" means law-firm, news or vendor commentary rather than the statute, regulator or provider itself.

This is research, not legal or tax advice. Sections 1, 4, 5 and 6 need review by a Ghanaian tax adviser / lawyer before they drive design.

Source-access limits worth knowing:
- paystack.com docs and pricing pages return HTTP 403 to automated fetches. Paystack facts below come from its support-centre pages and from search-engine excerpts of its docs, and are marked accordingly.
- The GRA VAT Administrative Guideline PDF (GRA/AG/25/002) is an image-only scan; I could download it but not read it (no OCR available). Nothing below is attributed to it.
- Hubtel's developer docs host did not resolve from my environment (one DNS failure; dev-docs.hubtel.com sits behind Cloudflare Access). Hubtel details are mostly from search excerpts.

---

## 1. Consumption taxes in Ghana (as of 2026-11-16)

### 1.1 What is in force

Legal basis: Value Added Tax Act, 2025 (Act 1151), effective 1 January 2026. It repeals and replaces the VAT Act, 2013 (Act 870). Companion amendments to the National Health Insurance Act 2005 (Act 852) and the GETFund Act 2000 (Act 581) were enacted at the same time.
- Source: EY Global Tax News 2026-0163, "Ghana's Parliament enacts several indirect tax-related laws effective 1 January 2026", published 12 January 2026. https://taxnews.ey.com/news/2026-0163-ghanas-parliament-enacts-several-indirect-tax-related-laws-effective-1-january-2026
- Source (GRA, undated notice, states "Effective Implementation of the VAT Act is January 1, 2026"): https://gra.gov.gh/news/?p=6191

| Component | Rate | Status in 2026 | Source |
|---|---|---|---|
| VAT standard rate | 15% on all taxable supplies | Unified. The 3% retail flat rate and 5% real-estate flat rate are removed. | EY 2026-0163 (12 Jan 2026); GRA notice above |
| NHIL (National Health Insurance Levy) | 2.5% | Retained | EY 2026-0163; GRA notice; GRA E-VAT page https://gra.gov.gh/e-vat/ |
| GETFund Levy | 2.5% | Retained | same |
| COVID-19 Health Recovery Levy (1%) | 0% | Abolished from 1 Jan 2026 | EY 2026-0163; GRA notice |
| Tourism Levy | n/a | Excluded from the VAT base for domestic supplies (rate not given in the source) | EY 2026-0163 |
| E-Levy (1% electronic transfers) | repealed | See section 2.6 | EY 2025-0844 |

Combined burden on a standard-rated sale: 15% + 2.5% + 2.5% = 20% of the net taxable value (down from about 21.9%). GRA E-VAT page states "effective VAT-able rate of 20%". https://gra.gov.gh/e-vat/

Was the COVID levy abolished or merged? Abolished, not merged, effective 1 Jan 2026 (EY and GRA above). The Act 1151 package was the vehicle; a separate presidential assent to the COVID-levy repeal on 10 December 2025 is reported by a news-search summary but I did not open a primary source for that date (Unverified).

### 1.2 Compounding and input deductibility

- Under Act 1151 the taxable value for VAT excludes VAT, GETFund Levy, NHIL and Tourism Levy, so for domestic supplies the three charges are each computed on the same net base. They do not compound. Source: EY 2026-0163 ("The taxable value excludes VAT, GETFund Levy, NHIL, and Tourism Levy. This removes the cascading effect for qualifying domestic supplies").
- GRA's Domestic Tax Commissioner said the same: VAT, GETFund and NHIL "share one base amount"; previously the levies were added to the base before 15% VAT was applied. MyJoyOnline, 31 December 2025. https://www.myjoyonline.com/taxpayers-to-pay-less-under-revised-vat-structure-from-2026-gra/
- NHIL and GETFund are now deductible as input tax (the provisions making them non-deductible were deleted). EY 2026-0163; GRA notice (https://gra.gov.gh/news/?p=6191: "recoupled so they can be claimed as input tax credits").
- Caveat on imports: EY notes cascading may still apply to imports of goods because the import valuation provision does not clearly exclude NHIL and GETFund. Communications Service Tax and excise duty still cascade. EY 2026-0163. Treat import tax as a separate case; the GRA guideline text was not readable to me.
- Pre-2026 regime (for historical orders / data migration only): NHIL 2.5% + GETFund 2.5% + COVID 1% were added to the base before 15% VAT, giving the reported 21.9% effective rate. Derivation: base 100, levies 6.00, VAT 15% x 106 = 15.90, total 121.90. The derivation is mine and matches the 21.9% figure in sources (e.g. https://www.graphic.com.gh/business/business-news/gra-announces-overhaul-vat-rate-cut-flat-rate-scheme-scrapped-covid-levy-abolished-from-jan-1.html, search excerpt). The COVID levy's presence in the old base is inferred from that arithmetic, not read from a source.

### 1.3 Flat rate scheme

Abolished. Flat-rate operators must now charge 15% (plus levies) and may apply to the Commissioner-General to deregister if below threshold. Sources: EY 2026-0163; GRA notice https://gra.gov.gh/news/?p=6191 ("VAT Flat Rate Scheme (VFRS) is abolished").

### 1.4 Registration thresholds

- Goods: threshold raised from GHS 200,000 to GHS 750,000 (GRA notice; EY).
- Services: EY says no turnover threshold; registration within 30 days of starting a taxable activity unless the Commissioner-General allows otherwise (EY 2026-0163). One secondary piece (Fiscal Solutions, 11 Sep 2026, https://www.fiscal-requirements.com/news/5951-ghana-enacts-2026-tax-vat-and-customs-reforms-what-retailers-should-bear-in-mind?country_id=29) says GHS 750,000 for services. These conflict. Confidence on "no threshold for services": Medium. Flag for the tax adviser.
- Practical read for a marketplace/platform: a platform that earns commission/fees is supplying services, so assume it must register regardless of turnover. A merchant selling only goods is registrable above GHS 750,000.

### 1.5 Changes after Act 1151 (important to track)

- A VAT (Amendment) Bill/Act, 2026 was assented to by the President on 26 August 2026 along with the Income Tax (Amendment), Customs, Excise and Energy Sector Levies bills. Source: Graphic, https://www.graphic.com.gh/news/general-news/president-mahama-assents-to-tribunals-bill-and-9-other-bills.html (describes it only as fine-tuning VAT to improve compliance and widen the base).
- Reported contents: zero-rating of domestic gold purchases under the national gold reserve programme, and removal of VAT on motor insurance (Fiscal Solutions 11 Sep 2026; TaxLawGH mid-year review page https://www.taxlawgh.com/ghana-2026-mid-year-budget-review). Act number, gazetted text and commencement dates are Unverified. No source I found says the 15%/2.5%/2.5% structure changed.
- 2026 mid-year review (July 2026): VAT regulations under Act 1151 planned for 2027; GRA to issue guidance meanwhile. A cross-border technology solution to collect VAT from non-resident digital platforms was piloted from April 2026 with nationwide rollout pending regulatory approval; a Fiscal Electronic Device (FED) pilot with a VAT reward scheme is at an advanced stage. Sources: KPMG, https://kpmg.com/us/en/taxnewsflash/news/2026/07/ghana-mid-year-budget-review-customs-excise-vat-measures.html (July 2026); TaxLawGH page above.
- Roadmap implication: tax rates and classification must be data (effective-dated), not code constants.

### 1.6 Exempt and zero-rated supplies relevant to e-commerce

Statutory structure: exempt = First Schedule; zero-rated = Second Schedule; relief = s.38 and Third Schedule. Exempt supplies carry no output VAT/NHIL/GETFund and the related input tax is generally not recoverable; zero-rated supplies carry 0% and keep input credit. Source for the detailed lists below: TaxLawGH, "Ghana VAT: exempt, zero-rated and relief supplies", reviewed 26 July 2026, applying from 1 Jan 2026 and citing Act 1151 as amended. https://www.taxlawgh.com/ghana-vat-exempt-zero-rated-relief . This is a secondary source; I could not read the Act's schedules directly. Confidence: Medium.

| Category | Treatment per that source |
|---|---|
| Unprocessed food | Exempt: raw agricultural and aquatic food produced in Ghana (cereals, tubers, non-ornamental fish, vegetables, fruit, cocoa beans, qualifying meat/offal). Ghanaian origin required. Simple preservation (drying, freezing, smoking) does not by itself remove raw treatment. Processed/packaged food is therefore standard-rated. |
| Medicines | Exempt: pharmaceuticals supplied in Ghana, limited to essential drugs in HS Chapter 30 (2022 HS); selected imported drugs and prescribed active ingredients. Not zero-rated. |
| Medical supplies/equipment | Exempt only if approved by the Finance Minister in consultation with the Health Minister; medical services by registered professionals exempt. |
| Books | Approved textbooks and supplementary readers, newspapers, atlases, charts, maps and music exempt; imported textbooks, exercise books and most other printed matter excluded (so many books are standard-rated). |
| Locally produced items | Exempt: livestock raised in Ghana, seeds, fertilisers, feed, veterinary drugs, fishing gear, mosquito nets, salt for human consumption, water (excluding bottled). Zero-rated: locally manufactured textiles from approved manufacturers to 31 Dec 2028 (EY 2026-0163 also confirms this extension), locally manufactured sanitary towels, exports and free-zone supplies. |

Modelling consequence: the same cart can mix STANDARD, EXEMPT and ZERO_RATED lines. Tax class must be per product/variant, ideally with an evidence field (approval reference, origin) because exemptions depend on origin, HS chapter or ministerial approval.

### 1.7 E-invoicing / E-VAT / fiscal devices

- GRA's E-VAT page describes E-VAT as "an electronic invoicing solution for VAT-registered businesses": a free all-round system, or a version integrated with a business's own invoicing system, requested via a Taxpayer Service Centre. The page does not state a mandate, deadline, API spec or e-commerce guidance. https://gra.gov.gh/e-vat/ (fetched 2026-11-16, undated).
- Act 1151 (EY 2026-0163): issuing a fiscal receipt under the Taxation (Use of Fiscal Electronic Device) Act, 2018 (Act 966) satisfies the tax invoice requirement; mandatory FED use "to be implemented in key sectors in 2026"; a VAT-registered buyer must give the vendor its TIN to claim input tax from FED vendors.
- Secondary reports: GRA moving retailers from manual VAT receipt books to digital fiscal receipts (VATupdate, 7 Apr 2026, https://www.vatupdate.com/2026/04/07/ghana-shifts-to-mandatory-electronic-vat-receipts-phasing-out-manual-booklets-for-retailers/); a report that E-VAT will extend to Tier-2 medium enterprises from 1 Nov 2026, explicitly "not yet confirmed by an official GRA announcement" (Fiscal Solutions, 29 Oct 2026, https://www.fiscal-requirements.com/news/6142-ghana-clarifies-digital-vat-collection-rules-as-further-e-vat-expansion-is-reported-for-november-2026). Unverified.
- Not found: any GRA technical API for e-commerce platforms to push invoices. Roadmap should keep an "invoice issuer" seam (TIN, invoice number, line-level tax breakdown, receipt/QR reference) without committing to a GRA API.

### 1.8 VAT on digital services supplied by non-residents

- Unregistered non-resident providers of telecommunications or e-commerce services must register, using a "tax registered agent" where applicable; "digital services" widened to include distance maintenance of programs/equipment, software supply and updates, virtual and digital asset management; online gaming excluded. EY 2026-0163; EY Reference Guide to Act 1151, January 2026 (https://ukgcc.com.gh/bfd_download/ey-reference-guide-to-the-new-vat-act-2025-act-1151).
- GRA said (about 14 Oct 2026, reported 29 Oct 2026) its digital VAT collection system adds no new tax; tax is identified at payment via Ghana-issued cards/mobile money; about 92 non-resident providers registered, about 100 more identified as non-compliant; imported physical goods from international e-commerce platforms are excluded. Secondary report: https://www.fiscal-requirements.com/news/6142-ghana-clarifies-digital-vat-collection-rules-as-further-e-vat-expansion-is-reported-for-november-2026 (cites GRA E-VAT page and ISD).
- Relevance: low for a Ghana-based seller of goods; relevant only if the platform sells digital goods/services to Ghanaians from abroad or resells foreign SaaS.

### 1.9 Worked example: GHS 100.00 taxable sale

Case A: GHS 100.00 is the net price (tax-exclusive), standard-rated, domestic supply, Act 1151 rules from 1 Jan 2026.

| Line | Base | Rate | Amount |
|---|---|---|---|
| VAT | 100.00 | 15% | 15.00 |
| NHIL | 100.00 | 2.5% | 2.50 |
| GETFund | 100.00 | 2.5% | 2.50 |
| Total tax | | 20% | 20.00 |
| Customer pays | | | 120.00 |

Case B: GHS 100.00 is the tax-inclusive shelf price (what Act 772 s.47(1)(h) requires you to show: "full price ... including ... taxes").
- Net base = 100 / 1.20 = 83.3333...
- VAT 15% = 12.50; NHIL 2.5% = 2.0833 -> 2.08; GETFund 2.5% = 2.0833 -> 2.08.
- Rounded sum of net + taxes = 83.33 + 12.50 + 2.08 + 2.08 = 99.99, one pesewa short. Resolve by deriving net as the remainder: net = 100.00 - 12.50 - 2.08 - 2.08 = 83.34 (or put the pesewa on VAT). The invoice must foot to the price the customer paid.

Case C (for comparison only, retired regime): base 100 -> levies 6.00 -> VAT 15.90 -> 121.90.

Exempt line (e.g. local raw tomatoes, essential drugs): 100.00 net, tax 0.00, gross 100.00, no input credit for the supplier. Zero-rated line: tax 0.00 at 0%, supplier keeps input credit.

Input side for a registered business: input VAT and now input NHIL/GETFund on purchases are all creditable against output tax (e.g. buying stock at net 50.00 carries 10.00 of recoverable tax; selling at net 100.00 with 20.00 output tax leaves 10.00 payable).

### 1.10 How the tax engine should model it

1. Tax components are separate lines, not one blended rate: VAT, NHIL, GETFund (and a pluggable slot for future levies, e.g. Tourism Levy, COVID for historical orders).
2. Each component has: code, rate, base rule, `compounds_on` (empty for all three today), `creditable` (true for all three from 2026-01-01; the NHIL/GETFund flag was false before), `effective_from`/`effective_to`. Historical regime: COVID 1% / NHIL / GETFund compound into VAT base until 2025-12-31.
3. Base: net taxable value of the line after discounts (what discount/coupon rules do to the base is a business decision; the sources do not address it, so flag to the adviser). All three components use the same base.
4. Tax class per product/variant: STANDARD, EXEMPT, ZERO_RATED (+ optional relief), with evidence fields. EXEMPT and ZERO_RATED both produce 0 tax but differ in input-credit treatment (matters only for the merchant's VAT return, not the customer total).
5. Prices: store a `prices_include_tax` flag. For inclusive prices compute net = gross / (1 + sum of rates), round each component, and derive the remainder so lines foot to the customer price.
6. Rounding: the GRA rounding rule is Unverified (not in readable sources). Recommended default: compute per line, round each component half-up to 2 decimals (pesewas), sum line components for the document total, and store the rounded components on the order so reprints and refunds never recompute. Re-confirm with GRA/the adviser.
7. Refunds/returns: reverse the stored per-line, per-component amounts proportionally; do not re-derive from current rates (rates are effective-dated).
8. Shipping: treatment of delivery charges (taxable with the supply vs separate) is not covered by what I read. Unverified; ask the adviser. Act 772 s.47(1)(h) requires the displayed full price to include "transport costs, taxes and any other fees".
9. Imports/cross-border: model separately (possible cascading on imports per EY). Do not reuse the domestic formula.
10. Merchant VAT status: the platform needs per-merchant `vat_registered`, TIN, and a flag for whether goods-only turnover is below GHS 750,000; unregistered merchants charge no VAT.

---

## 2. Payments

### 2.1 Comparison (facts as found; see per-row confidence)

| | Paystack Ghana | Hubtel | Flutterwave Ghana | ExpressPay | Stripe |
|---|---|---|---|---|---|
| Methods | Cards, mobile money (MTN, Telecel, "Airtel/Tigo"; provider codes mtn, vod, atl), bank transfer listed in fee article | Mobile money (MTN, Vodafone/Telecel, AirtelTigo), Visa/Mastercard (3DS), GHQR, Hubtel wallet | Local cards, bank transfer, wallets/mobile money (AirtelTigo, MTN, Telecel for GHS), international cards | Mobile money, Visa/Mastercard (per a WooCommerce plugin listing) | No direct Ghana account; "Extended network" via Paystack |
| Published fees | 1.95% local (cards, MoMo, bank transfer); no Ghana cap stated; fee is non-refundable on refunds | Not found on an official page. Third-party estimates 1.5%-2.5% (Unverified) | Local cards 2.6%; bank transfer 2%; wallets/MoMo 2%; international cards 4.8%; payouts GHS 10 to bank, 1.5% to MoMo; prices exclude VAT; customer bears fees by default | Third-party aggregator says "from 1.95%" (Unverified) | Via Paystack pricing |
| Settlement | T+1 working day, GHS; payouts under GHS 50 to bank carry GHS 5 fee, MoMo can be below | Next business day per one aggregator (Unverified) | Local payments: next business day | Unverified | Via Paystack |
| Webhook auth | `x-paystack-signature`: HMAC-SHA512 of the raw payload using the secret key; also three source IPs (52.31.139.75, 52.49.173.169, 52.214.14.220) for live and test | Callback to `callbackUrl`; no signature scheme found in docs I could reach. Docs say a Status Check API call is mandatory if no final status within 5 minutes (Redirect Checkout). Treat callback as untrusted and re-query. | `verif-hash` header equals the secret hash you configure (static shared secret, not an HMAC). Retries: 3 times, 30 min apart, only if enabled. No `flutterwave-signature` on the docs page I read | Unverified | n/a |
| Refund API | Yes: create/retrieve/retry via API; support page says bank-transfer refunds in NG/GH/ZA; 1-year window from 15 Oct 2026; 3-10 working days; funded from pending payout first. Mobile-money refund in Ghana specifically: Unverified | Dashboard refund feature (2020 product update); API refund endpoint Unverified | v4 refunds endpoint, full/partial, mobile-money wallets 3-5 days (bank 24h, cards 3-15 days) per docs excerpt | Unverified | n/a |
| Idempotency | Event retries every 3 min x4 then hourly for 72h (live), hourly 72h (test); docs page I read has no idempotency guidance. Idempotency-Key header: Unverified (use unique `reference` per attempt and dedupe events yourself) | Unverified | v4 refund example sends `X-Idempotency-Key`; docs tell you to make webhook handling idempotent and re-verify the transaction | Unverified | n/a |
| Test/sandbox | Test mode with test keys; test MTN number listed on docs; test cards; test webhooks use same IPs | Test host test.hubtel.com appears in search; sandbox terms Unverified | Test and live secret hashes are set per environment | PHP SDK supports sandbox vs production URL | n/a |

Sources:
- Paystack fees: https://support.paystack.com/hc/en-us/articles/360009881920-What-are-Paystack-s-transaction-charges (fetched 2026-11-16, article marked "Edited", undated). Paystack Ghana pricing page https://paystack.com/gh/pricing and docs https://paystack.com/docs/payments/webhooks/ return 403 to me; webhook facts above come from the docs-v2 mirror https://docs-v2.paystack.com/payments/webhooks/ (fetched 2026-11-16; one search excerpt noted this docs content is old, so re-check IP list against live docs).
- Paystack settlement: https://support.paystack.com/en/articles/2123586 (fetched 2026-11-16). Paystack MoMo networks: https://support.paystack.com/en/articles/2128386 (no recurring payments through MoMo; no limits stated).
- Paystack refunds: https://support.paystack.com/en/articles/2127106 (fetched 2026-11-16; refund-window rule effective 15 Oct 2026; Paystack's own fee is non-refundable).
- Paystack test payments: search excerpt of https://paystack.com/docs/payments/test-payments/ (test MTN number listed; pages inconsistent across versions).
- Stripe: https://stripe.com/global lists "Ghana Extended network", link goes to https://paystack.com/stripe/ghana (fetched 2026-11-16). The page does not define "extended network".
- Flutterwave pricing: https://flutterwave.com/gh/pricing (fetched 2026-11-16). Webhooks: https://developer.flutterwave.com/docs/webhooks (fetched 2026-11-16). Refunds/idempotency: search excerpt of https://developer.flutterwave.com/v4/docs/refunds; networks: https://developer.flutterwave.com/docs/mobile-money.
- Hubtel: https://businessdocs-developers.hubtel.com/docs/redirect-checkout and /docs/ussd-checkout (search excerpts only; host unreachable from my environment); Hubtel 2020 refund feature mention at https://news.hubtel.com/tag/innovation/page/2/; methods from search excerpt of /docs/getting-started-with-payments. Auth is HTTP Basic with API ID/Key.
- ExpressPay: no official docs found. WooCommerce plugin https://wordpress.org/plugins/woocommerce-expresspay-payment-gateway/ and community PHP SDK https://packagist.org/packages/swport/exp-php-sdk.
- MTN MoMo direct: official developer portal https://momodeveloper.mtn.com/Ghana_Collection_productDetails (Collections = request-to-pay, sandbox after sign-up, go-live after testing and KYC per an Ericsson case study). Telecel Cash and AT Money direct APIs: not researched/Unverified.

### 2.2 Recommendation

1. First: Paystack. Reasons grounded in the sources: single flat published fee (1.95%) across cards and all three MoMo networks, T+1 GHS settlement, an HMAC-SHA512 signed webhook with documented retry policy and event types for refunds (`refund.pending/processing/processed/failed`), a refund API with documented funding and timelines, test mode, and it is also the Ghana route to Stripe (Stripe's "Extended network"). Gap to close before launch: confirm with Paystack support (a) mobile-money refund behaviour in Ghana, (b) idempotency-key support on initialize/refund, (c) cut-off times.
2. Second: Flutterwave. It has a documented idempotency header on v4 refunds and explicit mobile-money refund timing; downsides are higher published fees (2.6% local cards, 2% MoMo) and a weaker webhook scheme (static `verif-hash`), so always re-verify the transaction by API before fulfilling.
3. Third / optional: Hubtel (GHQR and wallet reach, local-market integrations). Hold until Hubtel confirms in writing: refund API, callback authentication, and fee schedule. ExpressPay: skip until official docs/fees are obtained.
4. Design implications (engineering suggestions, not sourced): provider adapter with per-provider webhook verifiers; persist raw event and dedupe on (provider, event id/reference, status); never trust a callback without a server-side status check; store provider refund id and status separately from the order refund state because MoMo refunds are asynchronous.

### 2.3 Bank of Ghana and tax rules affecting merchants

- E-Levy repealed: Electronic Transfer Levy (Repeal) Act, 2025 (Act 1128), effective 2 April 2025, repealing Act 1075 and Act 1089. GRA directed charging entities to stop the levy and refund deductions made on or after that date; pre-repeal liabilities survive. Source: EY Global Tax News 2025-0844, 9 April 2025, https://taxnews.ey.com/news/2025-0844-ghanas-parliament-amends-tax-laws-following-the-2025-budget-statement-presentation . GRA/3news reporting corroborates the "midnight of April 2" cut-off (search result: https://3news.com/news/no-more-e-levy-from-midnight-of-april-2-gra, not opened). One vendor blog claimed a residual E-Levy in 2026; no primary source supports that, treat as wrong unless GRA says otherwise. Confidence the E-Levy is gone: High.
- Bank of Ghana Notice No. BG/GOV/SEC/2026/43, dated 6 November 2026, issued under s.101 of the Payment Systems and Services Act, 2019 (Act 987): PSPs are not deposit-taking, may not hold, use, pledge or set off merchant funds; collected funds must sit in designated settlement accounts at approved settlement banks, segregated from PSP operating accounts, and remain the merchants' property until settled per the SLA; PSPs settle strictly per SLA periods; only settlement and earned fees may leave the account; BoG may call for settlement-account statements; "immediate steps" to comply. I read the full notice text (PDF extracted locally). https://www.bog.gov.gh/wp-content/uploads/2026/11/Notice-No.43-MANAGEMENT-OF-MERCHANT-COLLECTION-FUNDS-BY-SETTLEMENT-BANKS-AND-PAYMENT-SERVICE-PROVIDERS.pdf . Press coverage: https://www.graphic.com.gh/business/business-news/new-bog-directive-payment-service-providers-cannot-hold-merchant-funds.html . Implication: SLA settlement timelines become enforceable; platform should not itself hold buyer funds for marketplace vendors without checking whether it needs a payments licence (not researched; flag for legal).
- PSP Corporate Governance Guidelines effective 31 December 2025 (search summary only, not opened): affects PSPs, not merchants.
- A BoG guideline on domestic processing of card transactions exists per a MyJoyOnline headline in search results (not opened): Unverified relevance.
- Claim that international card payments must settle in GHS: Unverified (only a third-party guide). Flutterwave's own page says international cards are charged and settled in local currency by default.

---

## 3. Pay on delivery (POD) in Ghana

Evidence quality is low here: I found no regulator or platform-published fraud statistics. Everything below is from vendor blogs and should be treated as directional.

- Practice: cash on delivery and mobile money coexist; Jumia's COD share was 59% of payments in 2018 (MyJoyOnline, older article, https://www.myjoyonline.com/cash-on-delivery-service-driving-growth-on-jumia/). A 2026 vendor guide says Ghanaian merchants use phone checks because customers place orders they do not intend to accept: https://easysellapp.com/blogs/wiki/ghana-ecommerce-mobile-money-cod-shopify-2026 (Secondary, vendor).
- Failure rates quoted: COD failure 15-25% in Accra (Kolonell blog, 2026, https://kolonell.com/en/blog/reduce-failed-cash-on-delivery-accra-2026); another Kolonell post puts failed orders 20-30%, returns about 22% versus about 4% for prepaid MoMo. These are vendor estimates, Unverified, Low confidence.
- Fake-order patterns (from the same vendor sources): serial no-shows, repeated orders from the same phone with different names/addresses, disposable emails, high-value baskets with throwaway numbers, address given as a vague landmark that cannot be located.
- Mitigations commonly recommended: OTP or call confirmation before dispatch (vendor claims 10-15% RTO reduction from OTP alone, unverified); partial MoMo deposit (about 30% quoted) with balance on delivery; cap on active unpaid COD orders per phone number and per address; flag duplicate phones/addresses; blacklist by phone/address/device after repeated refusals; restrict COD by basket value and area; send a MoMo request-to-pay at the door instead of cash (an engineering idea, not sourced).
- Legal link: Act 772 s.49 exempts foodstuffs, perishables and made-to-order goods from the 14-day change-of-mind cancellation right (see section 6.2), which affects how a refused COD order of those goods may be treated.
- Roadmap implication: model COD as a payment method with risk gates (phone-verified, order cap, deposit threshold, blacklist table), not as "no payment".

---

## 4. Online sale of medicines (Pharmacy Council / FDA)

Flag: this area is regulated and enforcement is active. Professional legal advice from a Ghanaian health-regulatory lawyer is required before listing any medicine.

### 4.1 Pharmacy Council Electronic Pharmacy Policy

- Document: "Electronic Pharmacy Policy, 2021" (the PDF itself says 2021), hosted on the Council's site in an August 2024 upload: https://pcghana.org/wp-content/uploads/2024/08/EPHARMACY-POLICY.pdf . I downloaded and read the 24-page text. Launched by the Vice President in December 2021 (https://www.citinewsroom.com/2021/12/bawumia-launches-policy-guidelines-for-national-e-pharmacy-platform/). Registration of ePharmacies opened June 2022 (Council announcement via search result). 
- No 2024-2026 replacement framework found. Searches for 2025/2026 FDA or Pharmacy Council e-pharmacy notices returned only enforcement items. Status of the policy in late 2026 (amended/replaced) is Unverified; check pcghana.org directly.

Key requirements (section numbers from the policy):
- Who may sell: only licensed retail pharmacies approved for internet/mail-order by the Pharmacy Council; "No person or entity is allowed to sell medicines online without obtaining registration for same" (s.2.1). Registration certificate valid 12 months. Each ePharmacy must have a designated pharmacist (s.3) and be in good standing; absence of a designated pharmacist is a ground for revocation (s.4.8.1).
- Platform: all orders go through the National Electronic Pharmacy Platform (NEPP); an ePharmacy may run its own platform only if it is "legally and technically linked" to the NEPP for synchronous recording and is assessed and authorised for a period by the Council (s.1). Common Council logo must be displayed (s.2.3).
- Application inputs (s.2.1): registered retail pharmacy; mandatory registration with the Data Protection Commission and compliance with Act 843; source of medicines; medicines registered in origin and destination countries; compliance with prescription rules; electronic records of all transactions kept and open to inspection; periodic transaction reports to the Council.
- Users: clients register with valid ID (e.g. Ghana Card) and get a unique ID; health professionals register with regulator numbers; history access only with client permission, expiring after a short period (s.2.2).
- POM vs OTC classes (s.4.1.1, per FDA classification): Class A: only by a medical practitioner or midwife; Class B: on prescription or by a pharmacist; Class C: client may request without prescription. Valid ePrescriptions flow only through the NEPP prescription service (s.4.1.2); a scanned prescription is valid. Every prescription received must be verified by a registered pharmacist (s.4.5).
- Sale/delivery (s.4.2.2): delivery by licensed couriers only; suitable packaging; delay detection and report-back; electronic delivery confirmation; patient information leaflet; medicines for acute conditions (immediate need, non-chronic) shall not be delivered by mail/courier; medicines requiring storage at or below 8 C not delivered unless cold chain is ensured; injectables not delivered by mail/courier.
- Records (s.4.2.3): each transaction record must hold pharmacy name/address and the pharmacist-in-charge signature; serial number and date; medicine name, quantity, batch number, expiry date, manufacturer.
- Refills (s.4.3): long prescriptions served in staggered quantities, not exceeding 3 months' quantity; patient notified at least one week before stock runs out.
- Counselling (s.4.4): mandatory phone counselling by the designated pharmacist on receipt, signed off and recorded; printed labels with pharmacy details; adverse-drug-reaction reporting to the FDA.
- Monitoring (s.4.5): premises inspected at least every six months; consumer rating/review of pharmacies and counselling required.
- Data (s.4.6): ePharmacies must be registered in Ghana; data "stored and processed locally" and subject to Act 843; disclosure of platform data is prohibited without Council permission; no sharing of critical information with foreign manufacturers without permission.
- Prohibited: sale/delivery of narcotics and psychotropic substances and precursors on the platform (revocation ground, s.4.8.1 v; the s.4.1.4 text itself was not legible in the extraction).
- Fees: processing, annual accreditation, and annual platform subscription fees, amounts set by the Governing Board (s.2.4). Amounts not found.

### 4.2 FDA Ghana

- All medicines need FDA registration; FDA warnings (Sep 2026) tell the public not to buy medicines, herbal remedies or supplements from unverified online networks and social media (e.g. "Dr Alfred Capsules" notice, 9 Sep 2026): https://www.graphic.com.gh/news/general-news/fda-arrests-two-over-fake-dr-alfred-capsules-containing-sildenafil.html (secondary news; not read in full).
- Consumer Protection Agency (June 2026) asked for prosecution of Temu and four other platforms over goods lacking FDA/GSA approval, including medicines and medical devices: https://www.myjoyonline.com/consumer-protection-agency-calls-for-prosecution-of-temu-four-other-e-commerce-firms/ (search excerpt; I did not open it, date approximate). Signals marketplace-operator exposure.
- FDA's G-FIRMS platform handles online product registration and facility licensing (GNA, June 2026 search result https://gna.org.gh/2026/06/fda-moves-herbal-registration-online-warns-against-adulteration/, not opened).
- I did not find an FDA-issued e-pharmacy-specific guideline. Not found is not the same as does not exist: Unverified.

### 4.3 Roadmap implications
- A generic multi-vertical marketplace should treat medicines as a separately gated vertical: vendor must be a Pharmacy Council-registered ePharmacy with a designated pharmacist, the storefront must integrate with the NEPP, and the operator needs its own legal read on whether it is an "independent platform" needing Council authorisation.
- Product model needs: FDA class (A/B/C), FDA registration number, batch and expiry per fulfilled line, prescription attachment and pharmacist verification state, courier eligibility rule (no acute/cold-chain/injectable by courier), counselling-call record. Do not launch POM sale without this.
- Cross-link to section 6: local data storage requirement applies to ePharmacy data.

---

## 5. Food (FDA Ghana)

Evidence here is mostly FDA pages seen only in search excerpts plus secondary commentary. Confidence Medium for registration/hygiene-permit points, Low for numbers.

- Registration: pre-packaged foods imported, distributed or sold locally must be registered with the FDA under the Public Health Act, 2012 (Act 851). Source: FDA guideline excerpts, https://fdaghana.gov.gh/wp-content/uploads/2024/09/IMPORT-PERMIT-AND-CLEARANCE-OF-PREPACKAGED-FOODS-GUIDELINES.pdf (search excerpt, not read in full). Official local application form FDA/FER/FOR-01 v02, effective 13 Sep 2024: https://fdaghana.gov.gh/locally-manufactured-food-product-application-form-2 (header only). Registration validity period ("3 years") appears only in a consultancy page: Unverified.
- Platforms: in February 2024 the FDA told e-commerce platforms and event organisers to allow only FDA-licensed food vendors to advertise and sell; food businesses need a valid Food Hygiene Permit; Section 130(1) of Act 851 prohibits selling regulated food without registration/permits; platforms should verify vendor licence status. Source: FoodBusiness MEA, 20 Feb 2024, https://www.foodbusinessmea.com/ghanas-fda-tightens-regulations-for-food-vendors-in-e-commerce-and-events/ (secondary report of an FDA statement); Citi Newsroom Feb 2024 https://citinewsroom.com/2024/02/permit-only-fda-licensed-food-vendors-to-advertise-sell-food-on-your-platforms-fda-to-e-commerce-businesses/ (search result only).
- Labelling: English, indelible; manufacturer details; batch; best-before/use-by where applicable; both primary and secondary packaging must carry compliant labels. FDA general labelling requirements page: https://fdaghana.gov.gh/general-labelling-requirements/ (search excerpt, effective 2020). Underlying standards cited by FDA: GS 46:2004 and the General Labelling Rules 1992 (L.I. 1541) (FAOLEX).
- Expiry: retailers must remove processed packaged food from sale after the expiry or sell-by date (FDA food-service code, search excerpt). Imports must arrive with at least two-thirds of shelf life remaining at port clearance (FDA import guideline, search excerpt; an older 2019 report quoted a different threshold, so confirm).
- Advertising: FDA has Guidelines for the Advertisement of Foods (2024 upload): https://fdaghana.gov.gh/wp-content/uploads/2024/03/GUIDELINES-FOR-THE-ADVERTISEMENT-OF-FOODS.pdf (not read). Online listings are adverts; get this read.
- Tax link: only raw, Ghana-produced food is VAT-exempt (section 1.6); packaged/processed food is standard-rated.
- Consumer-law link: Act 772 s.49 removes the 14-day cancellation right for foodstuffs, beverages and perishables (section 6.2).
- Roadmap implication: food vendor onboarding needs FDA product registration number(s) and Food Hygiene Permit reference with expiry; product needs manufacture/expiry/batch capture and a "do not ship if shelf life below X" rule; auto-delist at expiry.

---

## 6. Data protection and consumer law

### 6.1 Data Protection Act, 2012 (Act 843)

Primary regulator material I read: DPC "Guidelines to Demonstrate Data Protection Compliance" (July 2025 upload) https://dataprotection.org.gh/wp-content/uploads/2025/07/GUIDELINES-TO-DEMONSTRATE-DATA-PROTECTION-COMPLIANCE.pdf ; DPC controller portal manual (Jan 2026 upload) https://dataprotection.org.gh/wp-content/uploads/2026/01/1b-Data-Controller-Mauals.pdf . I could not open the Act text itself (GhaLII returned 403), so section numbers marked (G) are taken from the DPC guideline, others from secondary sources.

- Controller registration: s.27 requires a controller who intends to process personal data to register with the Commission (G). Registration asks for incorporation certificate, entity category, address, sector, services, annual turnover, number of data subjects and records, group structure, purpose, and "which countries outside of Ghana do you process data in" (G). Certificate issued on approval (s.49), fee prescribed on registration. Fee amounts: Unverified.
- Renewal: registration must be renewed every two years (s.50) (G). Portal shows Active/Expiring/Expired/Suspended states and a compliance score and risk level (portal manual, Jan 2026).
- Data Protection Supervisor: s.58; the DPC's administrative arrangements exempt small controllers from appointing one, medium/large must (G).
- Principles and lawful processing: ss.17-23; consent s.20(1) "a person shall not process personal data without the prior consent of the data subject" (Telerivet quoting the Act, 20 Jan 2026: https://www.telerivet.com/blog/ghana-sms-compliance-nca-sender-id-registration-and-act-843, secondary). Further processing must be compatible with purpose (s.25). Processors: ss.29-30.
- Security: s.28 (G). Retention: s.24 (G lists "Retention of records (s 24)"); I did not read the text. Commonly summarised as no longer than necessary for the purpose; Unverified here.
- Data subject rights: ss.32-35 and 39-44 (G): access, correction/deletion, withdraw consent, object to processing and direct marketing. DPC executive described rights including withdrawal of consent, correction, deletion and transfer between controllers (GNA, Oct 2026, https://gna.org.gh/2026/10/dpc-strengthens-enforcement-after-registering-2575-data-controllers/, search excerpt).
- Breach handling: s.31, notify the Commission and affected data subjects "as soon as reasonably practicable" after reasonable grounds to believe unauthorised access/acquisition; delay possible at the Commission's/security agencies' request. Source: Lex Mundi privacy guide (search excerpt, https://www.lexmundi.com/guides/data-privacy-guide/jurisdictions/africa/ghana). One comparison table says no fixed timeframe is specified. Confidence Medium. There is no fixed hour limit that I could find (unlike a 72-hour rule).
- Cross-border transfer: I could not find an express restriction or adequacy mechanism in the sources I read (the DPC registration form just asks where data is processed). Unverified. Separate hard rule for ePharmacy: data stored and processed locally (Pharmacy Council policy s.4.6, section 4). Recommend treating foreign hosting as a disclosure item for DPC registration and an explicit legal question.
- 2024-2026 updates: DPC declared 2026 "a year of enforcement" (GNA, 26 Jan 2026, https://gna.org.gh/2026/01/2026-will-be-a-year-of-enforcement-data-protection-commission-warns/); spot checks and referrals to police for non-registration (GNA Oct 2026 items above); 2,575 controllers registered in 2026. A replacement Data Protection Bill was announced by the Communications Minister in March 2026 (secondary; Telerivet also mentions a Data Protection Bill 2025 in development). Status: not passed as far as I could find. Act 843 remains operative.
- Roadmap implication: platform is a controller (customers, vendors, delivery addresses, phone numbers, prescriptions) and likely a processor for vendors' orders. Needs: DPC registration and renewal tracking, consent capture with purpose (separate marketing consent), opt-out, data export/deletion workflow, breach runbook, retention schedule, record of where data is hosted.

### 6.2 Electronic Transactions Act, 2008 (Act 772) consumer protection

Primary source read: Act 772 text, https://csa.gov.gh/resources/Electronic%20Transactions%20Act.pdf (OCR-quality text, section numbers legible). Enacted 2008; no amendment found.
- Scope: ss.47-54 apply only to electronic transactions (s.46).
- s.47(1) supplier must display on the platform: full name and legal status; physical address and telephone; website and email; self-regulatory body membership; code of conduct; registration number/office bearers/place of registration; sufficient description of goods/services; full price including transport costs, taxes and other fees; manner of payment; terms and guarantees (accessible, storable, reproducible); dispatch/delivery time; how to access a record of the transaction; return, exchange and refund policy; ADR code; security procedures and privacy policy; minimum duration for recurring agreements; and consumer rights.
- s.47(2): consumer must be able to read/store/reproduce terms, identify and correct errors, and withdraw before concluding the contract.
- s.47(3)-(4): if the supplier fails these disclosures, the consumer may cancel within 14 days of receipt; supplier refunds within 30 days.
- s.47(5)-(6): supplier must use a sufficiently secure payment system and is liable for damage from failing to.
- s.48: execute the order within 14 days unless agreed otherwise; otherwise voidable; if goods unavailable, notify immediately and refund within 7 days of notification.
- s.49: consumer may cancel without reason or penalty within 14 days of receipt of goods, or 7 days from conclusion of an agreement for services; only charge is the direct cost of returning goods. Exemptions (s.49(4)) include: financial services; auctions; foodstuffs, beverages or other goods for everyday consumption supplied to the home/workplace; services begun with consent in the grace period; made-to-specification goods; goods that by nature cannot be returned or are perishable; unsealed audio/video/software; newspapers, periodicals, magazines and books; gaming; accommodation/transport/catering/leisure on a specific date.
- s.50: no unsolicited commercial electronic communications without prior consent; must offer opt-out and identify the source of the consumer's data on request; offence with fine up to 5,000 penalty units or up to 10 years' imprisonment (the text as extracted).
- Status of reform: NITA ran a public consultation on an Electronic Transactions Bill, 2025 (https://nita.gov.gh/wp-content/uploads/2025/NITA-ETA-public-consultation-2025.pdf); whether it has passed: Unverified. A BFT Online piece (21 Apr 2026, https://thebftonline.com/2026/04/21/clicks-carts-and-consumer-rights-how-ghanas-2008-digital-law-shields-online-shoppers/) notes there is no dedicated digital consumer-protection unit.
- Roadmap implication: checkout/storefront must show seller identity, all-in price (taxes and delivery), delivery time, return/refund policy, privacy policy; support a 14-day goods cancel/return window with category exemptions flag (food, perishables, books, made-to-order); refund within the statutory periods (7 days for unavailable goods, 30 days after disclosure-failure cancellation); unavailable-item cancellation flow; marketing consent separate from order consent.

### 6.3 Consumer Protection Bill
Not enacted. CUTS International urged Parliament in December 2025 to pass the long-delayed Consumer Protection and Competition Bills (Citi Newsroom, https://citinewsroom.com/2025/12/pass-long-delayed-consumer-protection-and-competition-laws-cuts-intl-urges-parliament/, search result). Earlier reports say the bill never reached Parliament; one August 2026 item says it has been before Parliament in various forms since 2014; I could not reconcile this. I found no report of passage by 2026-11-16. Confidence it is not yet law: Medium. A Consumer Protection Agency is nonetheless acting against platforms (June 2026, section 4.2).

---

## 7. Addresses

### 7.1 Ghana Post GPS digital address
- Official description: a digital address is a postcode plus a unique address; the grid is 5 m x 5 m squares; first letter of the postcode is the region, second letter/digit the district, followed by a three-digit area code, then the unique number. Official examples: ER-200-1987, GA-543-0125 (3-digit area code, 4-digit unique number); another Ghana Post page example AK-039-5028. Source: https://www.ghanapostgps.com/get-help/ (fetched 2026-11-16, undated).
- Shape: two letters, hyphen, three digits, hyphen, four digits, i.e. `AA-999-9999`. The same site renders codes without hyphens in share links (e.g. GA1547475), and one share link shows a code with eight digits (NT08662280). The help page does not state when area codes or unique numbers have 3 or 4 digits. So a strict 2-3-4 regex would reject real addresses.
- Recommended validation (design suggestion): normalise by uppercasing and stripping spaces/hyphens, accept `^[A-Z]{2}\d{7,8}$`, store canonical display form with hyphens only when the 2-3-4 pattern fits, and treat the code as optional and unverified unless confirmed by a lookup. Confidence on the exact regex: Low; on the 2-3-4 majority shape: High.
- Accuracy: the app shows accuracy bands (green 3-9 m, yellow 10-20 m, red above 20 m); no offline version per the help page. Accuracy of customer-supplied codes is therefore variable; keep lat/lng if given.
- Public API: I found no official, documented public developer API from Ghana Post. api.ghanapostgps.com exists but the content I could reach was the public FAQ. Community/third-party options: Dojah address validation (GET `/api/v1/gh/kyc/address/gps`), GhanaAPI, open-source wrappers (search excerpts). Unofficial wrappers may break or violate terms. Treat as Unverified for production reliance; ask Ghana Post for B2B access if lookup matters.

### 7.2 What an address record should capture (practice and constraints)
No source documents "how Ghanaian e-commerce sites typically capture addresses"; the points below are my synthesis (Low confidence) from the format facts above.
- Ghana has 16 regions since 2019 (Greater Accra, Ashanti, Western, Western North, Central, Eastern, Volta, Oti, Northern, Savannah, North East, Upper East, Upper West, Bono, Bono East, Ahafo). Source: Wikipedia and Ghana news pages listed in search (e.g. https://www.graphic.com.gh/news/general-news/new-ghana-map-with-16-regional-capitals.html). Make region a controlled list.
- Fields: recipient name, phone (MoMo-reachable number, +233 normalisation), region, city/town, area/neighbourhood, street or house description (often absent), nearest landmark, Ghana Post GPS code (optional), optional map pin (lat/lng), delivery notes. Landmark and phone matter more than street because many locations lack street names; couriers phone customers.
- Link to shipping/pickup logic: shipping-zone matching should key off region + city/area, with GPS lat/lng only as an optional refinement.

---

## 8. SMS and WhatsApp

### 8.1 SMS gateways
- Arkesel, mNotify and Hubtel are the commonly cited Ghanaian providers (Arkesel and Hubtel names confirmed in search results; mNotify and Hubtel SMS API terms and pricing were not researched: Unverified).
- Sender ID: the sources conflict about the regulator's role.
  - Arkesel (2 May 2024): the NCA does not require businesses to register a sender ID or obtain "bulk SMS approval"; custom sender names are set up through the provider at operator/aggregator level; the NCA's UEC Code puts display obligations on licensed operators and providers. https://arkesel.com/legal-and-regulatory-policies-of-bulk-sms-in-ghana/
  - Telerivet (20 Jan 2026): provider submits sender IDs; approval is per network (MTN, Telecel, AirtelTigo); up to 11 characters; must match the brand, generic names rejected; about two weeks; MTN enforces strictly. https://www.telerivet.com/blog/ghana-sms-compliance-nca-sender-id-registration-and-act-843
  - Twilio guidelines (undated, copyright 2026): sender ID registration required for MTN; from 8 July 2026 messages with unregistered sender IDs to MTN are blocked; promotional content cannot be registered; dynamic alphanumeric not supported on MTN. https://www.twilio.com/en-us/guidelines/gh/sms
  - Net: register brand sender IDs per network through the chosen gateway; do not assume an NCA filing. Confidence: Medium.
- Message rules: promotional SMS only 8:00-19:00 Monday-Saturday, none on Sundays; transactional (OTP, order, payment) exempt from the window; consent and opt-out required (Telerivet, Arkesel citing NCA UEC Code s.11.2, s.15, s.19.2.3). Act 843 requires consent before processing phone numbers, and Act 772 s.50 requires prior consent and an opt-out for unsolicited commercial electronic messages.
- Roadmap implication: separate transactional and marketing templates and consent flags; schedule-guard promotional sends; store per-network delivery receipts; make the gateway a swappable adapter.

### 8.2 WhatsApp Business Platform
- Access is through Meta's WhatsApp Business Platform, directly or via a Business Solution Provider (BSP). Meta bills per delivered template message by category (Marketing, Utility, Authentication) since 1 July 2025; user-initiated service windows are free with a monthly free tier; from 1 October 2026 service messages beyond 1,000 per month per number are charged and utility messages inside open service windows become billable; payment method needed by 30 September 2026. Source: Meta pricing page, https://developers.facebook.com/docs/whatsapp/pricing (fetched 2026-11-16).
- Ghana (+233) is not named on the rate card; it falls under "Rest of Africa". The USD rates are in linked CSV/PDF files I did not retrieve. A Ghanaian news report (27 Aug 2026) quotes about USD 0.0101 per utility and USD 0.062 per marketing message to Ghanaian numbers: https://yen.com.gh/business-economy/310749-whatsapp-charge-ghanaian-businesses-message-october-1/ . Secondary, Unverified; BSP markups may apply.
- Template approval, opt-in rules and BSP names available in Ghana: not researched here; Unverified.
- Roadmap implication: treat WhatsApp as an optional notification channel behind the same adapter as SMS, billed per message, opt-in required; do not make it the only OTP path.

---

## Facts the roadmap depends on (with confidence)

Tax
- VAT standard rate is 15%, NHIL 2.5%, GETFund 2.5%, total 20% on a common base, effective 1 Jan 2026 under Act 1151. High (EY, GRA notice, GRA E-VAT page).
- COVID-19 Health Recovery Levy abolished from 1 Jan 2026. High.
- NHIL and GETFund do not compound with VAT on domestic supplies and are input-deductible from 2026. High (EY, GRA); imports may still cascade: Medium.
- VAT Flat Rate Scheme abolished. High.
- Goods registration threshold GHS 750,000. High. Services have no threshold: Medium (one secondary source says 750,000 for services).
- Raw local food, essential drugs (HS Ch.30), approved textbooks and several local inputs are exempt; processed food and imported printed matter are standard-rated. Medium (secondary summary of Act 1151 schedules).
- The tax rate/class regime can still change: VAT (Amendment) Act 2026 assented 26 Aug 2026 with unverified content; VAT regulations planned for 2027. Medium that rates are unchanged; Low on details.
- E-VAT/FED mandate for online sellers and any GRA API: not confirmed. Low. Fiscal receipt satisfies the invoice requirement: Medium-High (EY).
- Rounding rule for per-line vs per-document tax: Unverified.
- GHS 100 net standard-rated sale = VAT 15.00 + NHIL 2.50 + GETFund 2.50 = 120.00. High (arithmetic on High-confidence rates).

Payments
- E-Levy repealed effective 2 April 2025 (Act 1128). High.
- Paystack Ghana 1.95% on cards/MoMo/bank transfer, T+1 GHS settlement, HMAC-SHA512 `x-paystack-signature`, refund API, refund window 1 year from 15 Oct 2026. High for fee/settlement/refund-window (support pages); Medium for webhook details (docs-v2 mirror, possibly outdated); MoMo refund support in Ghana and idempotency header: Unverified.
- Flutterwave Ghana: 2.6% local cards, 2% MoMo/bank, next-business-day, static `verif-hash`, v4 `X-Idempotency-Key` on refunds. High (official pricing page and docs fetched), Medium on refund details (excerpt).
- Hubtel: methods MoMo/cards/GHQR/wallet, Basic auth, mandatory status check after 5 minutes. Medium; fees, callback auth, refund API Unverified.
- ExpressPay: no official fee/doc confirmation. Low.
- Stripe: Ghana is "Extended network", sign-up routes via Paystack. High.
- BoG Notice 43 (6 Nov 2026) segregates and protects merchant collection funds; PSPs must settle per SLA. High.

Pay on delivery
- Fake-order and failure rates, and mitigations, come from vendor blogs only. Low.

Medicines
- Online medicine sale in Ghana is limited to Pharmacy Council-registered retail pharmacies via/with the NEPP, with a designated pharmacist, pharmacist verification of prescriptions, FDA classes A/B/C, licensed courier only, and no courier delivery of acute-condition, cold-chain or injectable medicines. High (read the policy text).
- That policy is dated 2021 and no 2024-2026 replacement was found; whether it is still current: Medium. Legal advice required. Local storage of ePharmacy data is required in that policy: High (as written).

Food
- FDA registration of pre-packaged food and a Food Hygiene Permit are required; FDA told platforms (Feb 2024) to allow only licensed vendors. Medium. Registration validity (3 years), exact remaining-shelf-life thresholds: Low/Unverified.

Data and consumer law
- Controller registration with the DPC (s.27), renewal every 2 years (s.50), enforcement stepped up in 2026. High (DPC guideline); fees, retention text, cross-border rule: Unverified.
- Breach notification s.31 "as soon as reasonably practicable": Medium.
- Act 772 ss.47-50 disclosure, 14-day delivery/cancellation rules and exemptions (food, perishables, books, made-to-order): High (read the Act); whether an Electronic Transactions Bill 2025 has replaced it: Unverified.
- Consumer Protection Bill not enacted: Medium.

Addresses and messaging
- Ghana Post GPS code is `AA-NNN-NNNN` in the common case, with hyphenless and longer variants observed; no official public API found. Medium-High on shape, Low on regex strictness, Medium on "no official API".
- Sender IDs are registered per network through the SMS provider; MTN enforcement from 8 July 2026 (Twilio); NCA-filing claim disputed. Medium.
- Promotional SMS 8:00-19:00 Mon-Sat only, with consent/opt-out. Medium (provider commentary citing NCA code).
- WhatsApp per-message billing, with Ghana in "Rest of Africa" and the 1 Oct 2026 service-message billing change: High (Meta page); Ghana USD rates: Unverified.
