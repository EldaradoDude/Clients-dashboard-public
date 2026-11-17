# Deployment

The viewer runs as one uvicorn worker on `127.0.0.1:8050`, managed by systemd, behind Caddy
(automatic HTTPS via Let's Encrypt). One worker because the ClickHouse client is shared behind a
lock and the users database is SQLite.

| File | Installed as |
|---|---|
| `Caddyfile` | `/etc/caddy/Caddyfile` |
| `viewer.service` | `/etc/systemd/system/viewer.service` |
| `update.sh` | run in place: `deploy/update.sh` |

The files use placeholders (`dashboard.example.com`, `admin@example.com`, `/home/ubuntu/viewer`).
Edit the installed copies, not these, so real values stay out of the repo.

## First install (Ubuntu)

```bash
sudo apt install -y caddy python3.11 python3.11-venv git
git clone <repo url> ~/viewer && cd ~/viewer
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp credentials.example.json credentials.json && cp config.example.json config.json
chmod 600 credentials.json config.json            # then fill in the ClickHouse connection

.venv/bin/python -m alembic upgrade head
.venv/bin/python manage.py add-user admin         # prompts for the password; needs a terminal
.venv/bin/python manage.py grant-all admin

sudo cp deploy/viewer.service /etc/systemd/system/ # edit User= and paths first
sudo systemctl daemon-reload && sudo systemctl enable --now viewer

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile      # edit email and domain first
sudo systemctl reload caddy
```

Open ports 80 and 443 (ufw and the cloud firewall). The domain's A record must point at the
server before Caddy can get a certificate. The `Secure` session cookie needs HTTPS (or
localhost, e.g. an SSH tunnel).

## Updates

```bash
deploy/update.sh            # pull, pip install, alembic upgrade head, restart
```

Logs: `journalctl -u viewer -f`. Status: `systemctl status viewer`.

## Moving a server from the old flat layout

The app moved from `app.py` to the `viewer/` package, so a unit that runs `uvicorn app:app`
fails after the pull. Change its `ExecStart` to `-m uvicorn viewer.main:app ...` (as in
`viewer.service`), then `sudo systemctl daemon-reload` and restart. `config.json`,
`credentials.json` and `users.db` stay in the project root.
