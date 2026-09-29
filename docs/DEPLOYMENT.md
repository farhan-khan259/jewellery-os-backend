# Deployment and operations

## Runtime

Use one Node.js 22+ service for Express and the compiled frontend, a MongoDB replica set, and private object storage or a durable upload volume. This application is not compatible with static-only website hosting. No live server, domain, MongoDB Atlas account or S3 bucket has been provisioned by this build.

From the project root, install with `npm run setup`, build with `npm run build`, and launch with `npm start`. Install Chromium from `backend/` (`npx playwright install --with-deps chromium`) or build with `docker build -f backend/Dockerfile -t jeweller-os .`, which pins the Playwright browser image to the application version. Expose the API through HTTPS with Caddy/Nginx or your hosting provider. `backend/ops/Caddyfile` is a starting point. Keep frontend and API on the same origin.

Store environment variables in your hosting provider's secret manager. Never commit `backend/.env`. MongoDB must use a dedicated least-privilege database user, TLS, and an IP/network allowlist. Restrict access to MongoDB itself; the browser must never connect to it.

`APP_ORIGIN` must exactly match the public browser origin, including scheme and any non-default port. Configure the deployment's proxy topology carefully: Express currently trusts one proxy hop. Change that setting if your infrastructure differs. Production sessions expire after `SESSION_HOURS`, default 8 hours; changing the Shop Profile does not currently override this environment setting.

## Accounts

Run the one-time `npm run bootstrap` command within the protected deployment environment, then sign in to `/admin`, change the temporary password and enable TOTP 2FA under Account security. Retain the authenticator secret in a secure recovery store. Recovery is an operator-controlled database procedure; there is deliberately no public reset endpoint.

Create each subscribing shop from the platform panel. Admin reset links expire after 30 minutes and are single-use. Never send credentials through application logs or bulk email. The app displays generated credentials once for private handoff; it does not send messages automatically.

Lowering user/branch limits retains historical data. Excess non-owner users are denied access based on creation order; excess branches remain readable to previously authorised users but cannot receive writes. Review assignments with the shop owner before lowering limits. A feature list of `*` enables all modules; otherwise provide module keys such as `inventory,customers,rates,sales,payments,old-gold,karigars,orders,repairs,expenses,audits,reconciliation,reports,users,audit-logs`.

## Storage

S3 storage activates when `S3_BUCKET` is configured. Set region, endpoint if using a compatible provider, and access credentials. Objects stay private; authenticated app endpoints enforce tenant access. PNG/JPEG uploads are limited to 5 MiB and validated by file signatures. SVG uploads are deliberately not accepted in this release.

Without S3, uploads are under `backend/var/uploads`, keyed by tenant and random identifier. Mount this directory to a durable volume and back it up separately. Invoice PDFs are generated from immutable invoice snapshots on demand; they are not cached in the bucket.

## Backups and restore

Atlas managed backups/PITR are preferred where available. Alternatively install MongoDB Database Tools and use `backend/ops/backup.sh`, which creates a gzip archive and checksum. `BACKUP_DIR` must be a protected durable directory; optional `BACKUP_S3_URI` copies backups offsite with server-side encryption.

A daily systemd timer is included. Install the service and timer on the server, create a dedicated `jeweller` service user, set `/etc/jeweller-os/backup.env` permissions to 600, then enable the timer. Backups are **not active merely because these files exist**. Verify a successful scheduled backup and monitoring alert on the deployed host.

Restore into a new empty database with `backend/ops/restore.sh`. Set `RESTORE_MONGODB_URI`, `RESTORE_DATABASE` (a new name), and `SOURCE_DATABASE`. The script verifies the checksum and remaps namespaces without dropping the source. Compare collection counts, sign in through a staging instance, and check a known invoice, stock balance and customer ledger. Never rehearse a restore over live data. The deployment-specific mongodump/mongorestore round trip has not been run in this workspace because MongoDB Database Tools and production infrastructure are not supplied.

Protect backup keys and apply your agreed retention policy. This release does not automatically purge financial history or archived tenants.

## Monitoring and scale

Monitor `/api/health`, process restarts, storage, database connection errors and backup failures. Server errors are structured JSON and omit request bodies and passwords. Add your organisation's error monitoring and alert destinations.

List screens paginate. Some dashboards and report exports aggregate records in application memory; large tenants need database aggregation/cursors and load testing before rollout at scale. Apply provider-level rate limits and resource limits for PDF generation. The current login limiter is process-local; use a shared limiter store or a single API replica until distributed rate limiting is configured.

Automated WhatsApp Business delivery, payment gateways, external pricing feeds, scheduled SMS, RFID and AI assistants are not configured. The base invoice share action opens WhatsApp with a prepared message; attach the downloaded PDF yourself.
