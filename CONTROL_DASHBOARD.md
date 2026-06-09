# JoeBot Control Dashboard

The dashboard is part of JoeBot's existing Flask application and controls the existing Baileys process through a loopback-only API.

## Configuration

Add these values to the root `.env`:

```env
DASHBOARD_PASSWORD=use-a-long-unique-password
FLASK_SECRET_KEY=generate-a-long-random-secret
DASHBOARD_SECURE_COOKIES=false
JOEBOT_CONTROL_URL=http://127.0.0.1:5001/control
JOEBOT_CONTROL_TOKEN=generate-a-separate-random-token
JOEBOT_INTERNAL_TOKEN=generate-a-separate-random-token
```

On the first local visit, JoeBot asks you to create a password with at least 12 characters. The hash is stored in ignored `data/dashboard_auth.json`. `DASHBOARD_PASSWORD` can instead be set in `.env` for deployment-managed credentials.

Set `DASHBOARD_SECURE_COOKIES=true` when Flask is served through HTTPS.

The local services use separate directional tokens:

- `JOEBOT_CONTROL_TOKEN` authenticates Flask requests to the Node control API.
- `JOEBOT_INTERNAL_TOKEN` authenticates Node requests to Flask's `/internal/*` API.

Generate each token independently with `openssl rand -hex 32`, then set the same corresponding value in both `.env` and `whatsapp/.env`. The Node control server and Flask/Gunicorn both bind to `127.0.0.1`. Nginx returns `404` for `/internal/*`, and Flask additionally requires a loopback source plus `X-JoeBot-Internal`.

## Run

Start Flask:

```bash
cd /home/joe-joe/joebot
./venv/bin/python app.py
```

Start WhatsApp:

```bash
cd /home/joe-joe/joebot/whatsapp
npm start
```

Open:

```text
http://127.0.0.1:5000/control
```

## Production Deployment

The deployed dashboard is available at:

```text
https://joebot.16-61-51-131.sslip.io/control
```

Production uses:

- Elastic IP `16.61.51.131`
- Nginx for HTTPS termination and reverse proxying
- Gunicorn on `127.0.0.1:5000`
- PM2 for Flask and WhatsApp process recovery after reboot
- Certbot for automatic TLS certificate renewal

The Nginx and systemd source configurations are in `deploy/`.

## Current Capabilities

- Start and stop the WhatsApp socket without stopping Flask
- Enable or disable every slash command
- Enable or disable AI drafts, anti-delete, view-once capture, status saving, transcription, and media tools
- View recent in-memory chats and messages
- Send direct text messages to phone numbers or WhatsApp JIDs
- View structured connection, command, message, and settings activity
- Continue using the existing WhatsApp review and contacts pages

Chats are currently retained in memory for `WA_MESSAGE_TTL_MS`, which defaults to 24 hours. A durable encrypted message database is required before treating the dashboard as a complete WhatsApp archive.

## Retention Cleanup

JoeBot applies these retention limits:

- Saved statuses: 24 hours, with a 200 MB ceiling
- Anti-delete media: 24 hours, with a 100 MB ceiling
- View-once media: 24 hours
- Temporary downloads: 2 hours, with a 50 MB ceiling
- Activity log: 30 days, with a 20 MB ceiling
- PM2 logs: daily rotation, seven compressed rotations, and a 10 MB maximum before rotation

Media cleanup runs when the WhatsApp process starts and through the hourly `joebot-cleanup.timer`. Activity-log compaction runs inside the WhatsApp process to avoid racing with active writes.

Useful production checks:

```bash
systemctl list-timers joebot-cleanup.timer
journalctl -u joebot-cleanup.service --no-pager -n 100
sudo systemctl start joebot-cleanup.service
```

The dashboard does not expose Baileys session files. A logged-out session must be reset intentionally with:

```bash
cd /home/joe-joe/joebot/whatsapp
npm run relink
```
