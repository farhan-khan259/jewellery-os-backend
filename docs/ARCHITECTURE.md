# Jeweller OS architecture

Source of truth: supplied 20-page PDF, with its first three access/admin override pages taking precedence.

React/Vite SPA -> same-origin Express /api/v1 -> Mongoose -> MongoDB replica set. Production Express serves the built SPA. No public signup or provisioning API. /access is outside the shop shell, /admin is a separately authenticated platform surface. First-use password change stays on /access. No in-app onboarding wizard.

Data: Tenant (profile, limits, subscription), Identity (separate platform/tenant types), Session (hashed opaque cookie and CSRF), Invitation (hashed single-use token), Record (tenant + branch + kind, validated per workflow), Sale (immutable branding/pricing snapshot), Counter, AuditLog, Attachment. Ledger and metal-movement records are append-only. MongoDB transactions protect stock, balances, numbering and idempotency.

Money is integer paisa, weight integer milligrams. Decimal.js handles multiplication and purity; round half-up centrally. Stored net weight = gross minus stone. Pure metal is tracked separately from physical weight. 1 tola = 11.6638038 g.

API groups: /access, /me, /platform-admin, /records/:kind, /rates, /sales, /payments, /old-gold, /karigar-movements, /amanat, /audits, /reconciliation, /reports, /settings, /users, /attachments. All business access derives tenant from server session, never request tenantId. Branch access is enforced on list, mutation, PDF and export routes.

Implementation order: (1) authentication/provisioning + roles, (2) inventory/rates/customer/POS/invoice, (3) old gold/karigar/orders/repairs, (4) audits/reconciliation/reports, (5) alerts/sharing/configuration. See COVERAGE.md for delivered scope and operational requirements.
