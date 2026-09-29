# Requirements coverage and release limits

The supplied PDF is the source specification. Its first three v2 access/admin pages override the original onboarding/login requirements. This package delivers a working initial release across all main business modules; it does not claim that every advanced requirement or production service in the PDF is complete.

## Delivered

| PDF area | Implemented |
| --- | --- |
| Platform access | Separate Ahmed Solutions portal; bootstrap administrator; no public signup; create tenant/owner; issued temporary credentials; mandatory first-use password change on external access page |
| Account management | Shop profile, plan/features, billing state/dates, grace/expiry, suspension/reactivation/archive, user limits, branch limits, one-time resets, revocation, support notes and audit history |
| Authentication | bcrypt hashes; hashed opaque sessions; HttpOnly/Secure production cookies; CSRF/origin checks; login throttling; TOTP for admin/owner; distinct platform/tenant roles |
| Isolation and permissions | Session-derived tenant/branch scope on APIs, records, documents and images; owner/manager/cashier/accountant/inventory/coordinator/auditor roles; owner-only cost/profit restrictions |
| Languages | English, Urdu RTL, Roman English navigation and main forms; persisted user preference; bundled Urdu font; English/Urdu/bilingual invoice PDFs |
| Rates | Manual 24K/22K/21K/18K and silver entries, automatic purity conversion, gram/tola input, immutable history and invoice-time snapshot |
| Inventory | Weight, purity, category, making, wastage, stones, owner-only cost, location, photo uploads, search, status, table/gallery, reserve/release, QR tags, branch transfer, audited weight corrections |
| Sales | Search/select items, customer creation, server quote, mixed payment methods, discount/tax, customer credit, old-gold exchange, save/reopen drafts, atomic numbering/idempotency, double-sale prevention, invoice history |
| Invoices | Shop branding snapshot, customer and rate snapshots, weight/making/stone/wastage detail, totals, exchange/credit, prior/current balance, payment breakdown, signatures, protected QR, A4/80mm PDF |
| Returns | Append-only line returns, customer credit/refund, stock restoration, audit reason; reviewed full void on unlinked invoices |
| Customers | Profile, opening balance, credit limit, payments and ledger, printable statement, separate amanat gold deposit/return ledger |
| Old gold | Purity, deductions, testing loss, pure equivalent, valuation, cash/exchange, separate remaining stock, purchase PDF |
| Karigars | Profile, opening metal, issue from available source stock, pure-equivalent balance, finished/scrap/remainder/wastage receipt, automatic returned inventory, tolerance alerts |
| Custom orders | Multiple items/specifications, measurements, budget/advance, due date, karigar, booking/delivery/locked rate policy, sequential status workflow, gold-issue prerequisite, settlement into sale, order PDF |
| Repairs | Condition/photo/weight, added/removed metal fields, service charge, assignee/due date, status progression, delivery confirmation, cash payment/ledger posting and repair PDF |
| Control | Physical audit snapshots and scanning, missing/unexpected/mismatch history, owner/manager resolution, reconciliation from recorded movements, recorded reasons and activity history |
| Finance/reports | Expenses, cash/bank payments and opening adjustments, sales/stock/metal/karigar/wastage/receivable/expense/order/repair/audit/activity reports, CSV, browser print-to-PDF, owner data export |
| Alerts/sharing | Due orders/repairs, stock discrepancies, excessive wastage and large-discount alerts; invoice WhatsApp message preparation |
| Operations | Environment example, locked dependency versions, Dockerfile, local replica-set Compose, private S3/local upload abstraction, daily backup timer and non-destructive restore scripts |

## Not yet equivalent to the full PDF

These are explicit limits, not hidden placeholders:

- Fixed role permissions are implemented; a custom permission-matrix editor, multi-tenant user switching and fully configurable order/repair pipelines are not.
- The core inventory/POS supports gold and silver. Platinum/custom-metal pricing, manual retail-price overrides, advanced multi-field inventory filters, scheduled future rates, RFID and hardware-specific label layouts remain extensions.
- Customer financial entries and amanat are separate ledger views. A single merged timeline of every job/purchase event, ageing buckets and date-ranged customer statement UI still need development.
- Karigar accountability is pooled by karigar/purity with job references. Automatic per-job allocation of partial returns and a dedicated karigar PDF statement are not yet provided.
- Repair metal-added/removed values are recorded on the job but do not automatically consume owned stock; record the corresponding reviewed stock adjustment. Repair delivery currently posts cash payment.
- The custom-order pipeline is a list/detail workflow rather than a drag-and-drop Kanban board. Payment schedules are recorded as text; automated instalment collection/reminders are not implemented.
- Linked old-gold/order invoices cannot be directly voided. Returns provide a reviewed customer credit/refund path; undoing the original exchange/purchase or order advance needs an explicit accounting adjustment process.
- Report exports contain detailed records; several advanced analytics (receivables ageing, grouped wastage comparisons, branch-consolidated reporting and sophisticated design ranking) need further aggregation. Cross-period returns need review in sales/profit reports because sales are grouped by invoice date.
- Most visible shop labels and common errors are translated; detailed audit action names, some low-level record labels, and custom business text remain English/user-entered. Platform Admin starts in English as permitted by v2.
- Logo/image uploads support PNG/JPEG; SVG is not accepted. A5 invoices and custom drag-and-drop invoice theme editing are not implemented.
- WhatsApp opens a prepared message; PDFs are downloaded for manual attachment. Automated WhatsApp/SMS, public customer invoice access, payment gateways, email delivery and market-rate feeds are not connected.
- Shop settings cover the principal fields, tax, invoice language and wastage. Global session duration uses the server environment; per-shop session duration and a complete settings editor for all PDF-listed preferences remain extensions.
- Daily backup and restore tooling is supplied; real backup scheduling, retention/PITR, restoration rehearsal, uptime monitoring, load tests and production security review must be completed in the actual hosting environment.

## Verification

Automated tests use real isolated MongoDB replica sets, not an in-memory database imitation. Browser QA uses the actual Express APIs and MongoDB with a dedicated development seed. The included `verification-tests.log` and `verification-browser.log` report the final run. The `qa-preview` folder contains generated screenshots and sample invoices.

Development data is created only by the separate seed command. Production startup never inserts example shop records or default credentials.
