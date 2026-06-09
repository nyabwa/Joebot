# JoeBot Control Dashboard

The dashboard is part of JoeBot's existing Flask application and controls the existing Baileys process through a loopback-only API.

## Configuration

Add these values to the root `.env`:

```env
DASHBOARD_PASSWORD=use-a-long-unique-password
FLASK_SECRET_KEY=generate-a-long-random-secret
DASHBOARD_SECURE_COOKIES=false
JOEBOT_CONTROL_URL=http://127.0.0.1:5001/control
JOEBOT_CONTROL_TOKEN=
```

On the first local visit, JoeBot asks you to create a password with at least 12 characters. The hash is stored in ignored `data/dashboard_auth.json`. `DASHBOARD_PASSWORD` can instead be set in `.env` for deployment-managed credentials.

Set `DASHBOARD_SECURE_COOKIES=true` when Flask is served through HTTPS.

The control API binds to `127.0.0.1` by default. To authenticate Flask-to-Node calls as well, set the same random `JOEBOT_CONTROL_TOKEN` in both `.env` and `whatsapp/.env`.

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

The dashboard does not expose Baileys session files. A logged-out session must be reset intentionally with:

```bash
cd /home/joe-joe/joebot/whatsapp
npm run relink
```
