# Verification record

## Automated verification

- All 15 calculation, database integration and persistence tests passed after the frontend/backend split. See `backend/verification-tests.log`.
- Combined development startup and the frontend API proxy passed against a real MongoDB replica set. See `backend/verification-startup.log`.
- React production build passed.
- Chromium QA passed against the real Express application and an isolated MongoDB replica set, with no business API mocks.

Browser checks: shop sign-in, 14 operational screens, creation of a customer, Urdu RTL, Roman English switching, mobile layout overflow, A4 PDF, Urdu thermal PDF, platform sign-in, and shop provisioning. Generated screenshots and PDFs are in `backend/qa-preview/`.

API tests cover: cross-tenant/branch denial; absent public provisioning; CSRF; owner-only cost redaction; cashier restrictions; first-use password enforcement; active rates; stock issuance; immutable invoice branding; sale/payment idempotency; double-sale protection; old gold and karigar balance; reservation/release; append-only returns; physical audit; reconciliation; branch transfer; expiry; suspension; plan limits; and one-time reset links.

The sample A4 invoice was rendered and visually inspected; it fits one A4 page for the demonstrated single-item sale. The Urdu thermal receipt and responsive desktop/mobile screens were also inspected.

## Boundaries

This is targeted functional verification, not an exhaustive penetration test, load test, financial audit or a production hosting acceptance test. Full workflows involving your actual shop rates, cost conventions, accounting policies, printer drivers, S3 provider, backup destination and production domain still need acceptance in your deployment. See COVERAGE.md for explicit implementation gaps.

## Commands

Run these convenience commands from the project root. Backend-only commands also work inside `backend/`; React builds run inside `frontend/`.

- `npm test` — all calculation, integration and persistence tests.
- `npm run build` — production React build.
- `npm run qa` — real-database browser and PDF checks after building.

The tests use disposable isolated databases. Do not set TEST_MONGODB_URI to a live shop database.
