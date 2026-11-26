# Production deploy (useloop.sh)

- Host config: export `LOOP_DEPLOY_HOST=root@<server-ip>` or create an ignored local file `deploy/.env.deploy` with `LOOP_DEPLOY_HOST=root@<server-ip>`.
- Data: persistent data directory configured via `LOOP_HUB_DATA` (for example `/var/lib/loop/data` or a mounted volume).
- TLS: Caddy (`deploy/Caddyfile` -> `/etc/caddy/Caddyfile`), auto Let's Encrypt with `CADDY_TLS_EMAIL`.
- Service: `deploy/loop.service` -> `/etc/systemd/system/loop.service`, env in `/etc/loop/loop.env` (see `loop.env.example`).
- Backups: server backups + `deploy/backup.sh` nightly copy of `LOOP_DATA_DIR` to `/var/backups/loop`.

Release (snapshot + full tests + deploy + publish archive): `sh deploy/release.sh`. Each release is tagged `release/<UTC time>`, written to `/opt/loop/app/RELEASE`, and packaged into `/opt/loop/releases/loop-<tag>.tar.gz` with `/opt/loop/releases/release.json` (served at `https://useloop.sh/release.json`, `/install.sh`, `/downloads/loop-latest.tar.gz`, and `/agent-files/*`).
Quick deploy of the working tree without tests (not for production changes): `sh deploy/deploy.sh`
Logs: `ssh "$LOOP_DEPLOY_HOST" journalctl -u loop -f`
Roll back to the previous release (and restore `release.json`): `sh deploy/rollback.sh`
Agent feedback of this server, to triage on this computer: `sh deploy/feedback.sh` (see `docs/agent-feedback.md`)

## Sharing (hosted)
- Share links and members live in `<LOOP_HUB_DATA>/shares.json` (lib/shares.mjs).
- `/j/<code>` serves `public/join.html`; signed-out `/` serves `public/landing.html`.
- Plain `https://useloop.sh/mcp` routes each agent key to the account that issued it.
