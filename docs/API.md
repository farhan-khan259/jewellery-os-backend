# API guide

Base path: `/api/v1`. JSON request bodies, same-origin cookies. Responses return JSON; errors use `{ "error": { "code": "...", "message": "..." } }`. Login returns an opaque session cookie and a CSRF token. Send that token as `x-csrf-token` on subsequent mutations. Send `x-branch` for an authorised branch, defaulting to the user's first branch.

Tenant identity always comes from the session. A caller-supplied tenant ID cannot change shop scope. Platform APIs use distinct platformAdmin identities and cannot be used by tenant owners.

## Access and administration

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/access/sign-in` | username, password, portal (`shop`/`admin`), optional TOTP code |
| POST | `/access/change-password` | currentPassword, password; revokes prior sessions |
| POST | `/access/accept-invitation` | Single-use token + new password |
| POST | `/access/logout` | End session |
| POST | `/access/2fa/setup`, `/access/2fa/enable` | TOTP setup and code verification |
| GET/PATCH | `/me` | Current user/tenant; persist preferred language |
| GET | `/platform-admin/overview` | Shops and provisioning/account events |
| GET/POST | `/platform-admin/tenants` | Search or provision a shop and primary owner |
| GET/PATCH | `/platform-admin/tenants/:id` | Detail or update profile/subscription/status |
| POST | `/platform-admin/tenants/:id/logo` | Upload initial shop logo, then save returned ID in profile |
| POST | `/platform-admin/users/:id/reset` | Revoke sessions; issue 30-minute reset invitation |
| POST | `/platform-admin/users/:id/status` | Revoke or unlock account access |
| GET | `/platform-admin/audit` | Platform/security audit events |
| POST | `/platform-admin/support` | Add a support note with a tenant reference |

Create-tenant example (only with a platform admin session):

```json
{
  "name": "Your Jewellery Shop",
  "ownerName": "Shop Owner",
  "username": "yourshop.owner",
  "subscription": {
    "plan": "business",
    "status": "active",
    "expiresAt": "2030-01-01",
    "billingCycle": "monthly",
    "paymentStatus": "paid",
    "limits": { "users": 5, "branches": 1, "features": ["*"] }
  },
  "profile": { "name": "Your Jewellery Shop", "address": "Peshawar", "phone": "Your number" }
}
```

The response includes the generated temporary password once. It is not stored in plaintext. A first-use password change is required before business API access.

## Shop data and transactions

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/dashboard` | Actual stock, money, ledger, rates and due-job figures |
| GET/POST | `/records/:kind` | Validated module lists/creation |
| GET/PATCH | `/records/:kind/:id` | Scoped detail/edit; immutable financial kinds reject editing |
| POST | `/rates` | Append current gold/silver rate snapshot and audit reason |
| GET/POST | `/sales` | List or transactionally issue an invoice |
| POST | `/sales/quote` | Calculate authoritative server totals before issue |
| GET | `/sales/:id` | Immutable invoice snapshot |
| POST | `/sales/:id/void` | Reviewed reversal; linked orders/exchanges require adjustment workflow |
| POST | `/sales/:id/returns` | Line-item return, customer credit, optional refund, stock movement |
| POST | `/payments` | Idempotent customer receipt |
| POST | `/old-gold` | Cash purchase or exchange stock |
| POST | `/karigar-movements` | Issue/receive, source stock, purity and gold accountability |
| POST | `/amanat` | Customer metal deposit/return |
| POST | `/cash-adjustments` | Owner capital/opening/cash-bank adjustment with reason |
| POST | `/inventory/:id/reserve` | Reserve/release stock |
| POST | `/inventory/:id/transfer` | Transfer to an authorised tenant branch |
| GET | `/inventory/:id/tag` | Printable SKU tag PDF |
| POST | `/audits` | Create a snapshot of expected branch inventory |
| POST | `/audits/:id/scan` | Scan SKU and measured grams |
| POST | `/audits/:id/close` | Preserve missing/unexpected/mismatch results and resolution |
| POST | `/reconciliation` | Record physical closing against ledger movements |
| GET | `/reports/:type` | Dated branch-scoped report; `format=csv` for export |
| GET/PUT | `/settings` | Profile, branding, tax and invoice defaults |
| GET/POST/PATCH | `/users`, `/users/:id` | Owner staff management with plan limits |
| GET | `/audit-logs`, `/notifications`, `/export` | Activity, alerts, owner export |
| POST/GET | `/attachments`, `/attachments/:id` | Private tenant-scoped PNG/JPEG images |

Record kinds include `inventory`, `customers`, `karigars`, `orders`, `repairs`, `expenses`, `branches`, `drafts`; append-only kinds include `customerLedger`, `karigarLedger`, `metalMovements`, `payments`, `old-gold`, `rates`, `audits`, `reconciliation`, `amanat`, `returns`. Generic GET lists accept `page`, `limit` (max 200), `q`, `status`, and relevant customer/karigar identifiers. Transaction kinds must be created through their dedicated endpoints.

Example sale request:

```json
{
  "customerId": "MongoDB customer object ID",
  "items": ["MongoDB inventory object ID"],
  "discount": 0,
  "credit": 0,
  "oldGoldId": "",
  "orderId": "",
  "payments": [{ "method": "cash", "amount": 100000 }],
  "idempotencyKey": "a-new-unique-request-identifier"
}
```

Input amounts are PKR and weights are grams. Persisted calculation snapshots use integer paisa and milligrams. The browser never supplies authoritative price totals. Sale issuance checks and changes stock within the same MongoDB transaction as invoice/ledger/payment creation.

## Documents

- `/sales/:id/document?paper=a4&lang=en|ur|bilingual`
- `/sales/:id/document?paper=thermal&lang=ur`
- `/customers/:id/statement`
- `/documents/orders/:id`, `/documents/repairs/:id`, `/documents/old-gold/:id`

PDF is the default. `format=html` provides the underlying printable HTML where supported. Every document endpoint requires an authorised session and matching tenant/branch. QR invoice links require shop access; they do not publicly expose customer invoices.
