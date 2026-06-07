# JoeBot Work Log

Date: 2026-06-07

This file summarizes the work completed so far, the cause of each issue, how it was fixed, and the current deployment state.

## 1. Sensitive Files Excluded Before Git

### Problem

The project contained sensitive local files and runtime artifacts that must not be pushed to GitHub:

- `.env`
- `credentials.json`
- `token.json`
- WhatsApp auth sessions
- Python virtual environment files
- Node modules
- Downloads, statuses, drafts, and zip files

### Cause

The repo had not been safely prepared for Git. Without a `.gitignore`, `git add .` could stage secrets, WhatsApp session credentials, downloaded media, or large generated files.

### Fix

Created `.gitignore` with exclusions for:

- Sensitive credential files
- WhatsApp auth/session folders
- Python cache and virtualenv files
- Node dependencies
- Downloaded media and status folders
- Zip files and drafts
- Temporary save files

### Result

Ran `git add .` and verified the staged files. Sensitive files were not staged.

Staged source files included only application code, templates, package files, and `.gitignore`.

## 2. Git Repository Initialized

### Problem

The local project needed to be initialized and prepared for GitHub.

### Cause

`~/joebot` was not a valid initialized Git repository at first.

### Fix

Ran:

```bash
git init
git add .
git branch -m main
git commit -m "Initial commit: JoeBot - AI WhatsApp assistant"
```

### Result

Created local commit:

```text
b0e331f Initial commit: JoeBot - AI WhatsApp assistant
```

## 3. GitHub Push Attempt

### Problem

The repository needed to be pushed to GitHub.

### Cause

The GitHub repo existed at:

```text
https://github.com/nyabwa/Joebot
```

But local `git push` could not authenticate from this environment:

- HTTPS push could not prompt for username/PAT.
- SSH push failed because no GitHub SSH key was configured.
- The GitHub connector could read repo metadata, but write operations returned `403 Resource not accessible by integration`.

### Fix Attempted

Set remote:

```bash
git remote add origin https://github.com/nyabwa/Joebot.git
```

Tried pushing with network access:

```bash
git push -u origin main
```

### Result

Push was blocked by authentication, not by code or repo state.

Current local branch tracks `origin/main`, but the local changes still need a valid GitHub auth method if pushing from this machine.

## 4. AWS Deployment Access

### Problem

The bot was already running in the cloud on AWS, so local fixes needed to be deployed to the EC2 server.

### Cause

The live bot was not using the local files directly. It was running from:

```text
/home/ubuntu/joebot
```

on AWS public IP:

```text
18.171.222.73
```

### Fix

Found the EC2 key locally:

```text
/home/joe-joe/Downloads/joebot-key.pem
```

Used SSH/SCP to access and deploy files to AWS.

Identified PM2 processes:

```text
joebot-flask
joebot-whatsapp
```

The WhatsApp bot process runs as:

```text
node /home/ubuntu/joebot/whatsapp/bot.js
```

### Result

AWS access works. Deployments were done by:

1. Backing up the remote `bot.js`.
2. Copying the fixed local `whatsapp/bot.js`.
3. Running `npm test` on AWS.
4. Restarting `joebot-whatsapp` with PM2.

## 5. Plain Links Were Auto-Downloading

### Problem

When anyone sent any link, JoeBot attempted to download it using `yt-dlp`.

Example bad behavior:

```text
https://chat.whatsapp.com/...
```

returned:

```text
Download failed: Command failed: yt-dlp ...
```

### Cause

The message handler had an `AUTO URL DOWNLOAD` block that detected any `http://` or `https://` URL and immediately passed it into `yt-dlp`.

This meant normal links, WhatsApp group invite links, and supported media platform links all triggered download attempts even when the user did not ask for `/download`.

### First Fix

Added a domain allowlist so only media platforms would auto-download.

### Why That Was Not Enough

You clarified that even approved platforms should not download automatically. Downloads should only happen when explicitly requested with `/download`.

### Final Fix

Removed the entire passive auto-download block from `whatsapp/bot.js`.

### Result

Now:

- Plain links do not auto-download.
- YouTube, Instagram, TikTok, Facebook, and X/Twitter links do not auto-download just because they appear in chat.
- `/download <url>` still works.
- `/mp3 <url>` and `/song <url>` still work as explicit commands.

## 6. `/getdp` Returned `ECONNREFUSED 127.0.0.1:443`

### Problem

The `/getdp` command returned:

```text
Network error: connect ECONNREFUSED 127.0.0.1:443
```

### Cause

The old `/getdp` logic directly used `https.get(ppUrl)` and streamed the result to a file.

That approach was fragile because:

- It did not handle redirects cleanly.
- It wrote temporary files unnecessarily.
- It exposed raw network errors to the chat.
- It assumed the returned URL could always be fetched through the simple `https.get` path.

### Fix

Added a safer `fetchBuffer()` helper that:

- Parses the URL safely.
- Supports both HTTP and HTTPS.
- Follows redirects.
- Uses timeouts.
- Returns the image as an in-memory buffer.

Updated `/getdp` to:

- Clean the target phone number with `arg.replace(/\D/g, '')`.
- Call `sock.profilePictureUrl(...)`.
- Fetch the image into memory.
- Send the image buffer directly.
- Avoid writing temporary files.

### Result

The `127.0.0.1:443` network error was removed.

## 7. `/getdp` Timed Out for Some Numbers

### Problem

After the network fix, `/getdp` worked for some numbers but failed for others with:

```text
WhatsApp did not respond while fetching that DP.
```

### Cause

Baileys was timing out while asking WhatsApp for the profile picture. Logs showed failures such as:

```text
254743879765@s.whatsapp.net/image: Timed Out
254743879765@s.whatsapp.net/preview: Timed Out
```

Saving the number locally was not enough. WhatsApp Web/Baileys often needs the correct LID identity for modern WhatsApp accounts, not only the phone-number JID.

### Fix 1: Resolve Candidate JIDs

Added `resolveWhatsAppJids()` to build multiple candidates:

- Normal phone JID:

```text
2547...@s.whatsapp.net
```

- Baileys-resolved JID from `sock.onWhatsApp(...)`
- LID JID from Baileys auth mapping files:

```text
auth_info/lid-mapping-<phone>.json
```

Example discovered mapping:

```text
254743879765 -> 45381228437556@lid
```

### Fix 2: Try Image and Preview

Added fallback attempts for both:

- `image` for high-resolution DP
- `preview` for low-resolution DP

### Fix 3: Raw Profile Picture Query

Some contacts still timed out through `sock.profilePictureUrl(...)`, even with LID mappings.

Added a lower-level raw WhatsApp profile-picture IQ request using:

- `sock.query(...)`
- `getBinaryNodeChild(...)`
- `jidNormalizedUser(...)`
- `S_WHATSAPP_NET`

This bypasses the Baileys helper path that was hanging for some contacts.

### Result

`/getdp` started working for the previously failing numbers after adding the raw IQ fallback.

## 8. AWS Deployment Validation

Every AWS deployment followed this pattern:

```bash
cp /home/ubuntu/joebot/whatsapp/bot.js /home/ubuntu/joebot/whatsapp/bot.js.backup-<timestamp>
scp whatsapp/bot.js ubuntu@18.171.222.73:/home/ubuntu/joebot/whatsapp/bot.js
cd /home/ubuntu/joebot/whatsapp
npm test
pm2 restart joebot-whatsapp
pm2 list
```

### Current AWS Status

PM2 processes:

```text
joebot-flask      online
joebot-whatsapp   online
```

The WhatsApp bot reconnects successfully after restart and logs:

```text
WhatsApp bot is live and listening...
```

## 9. Files Changed

Main file changed:

```text
whatsapp/bot.js
```

Main changes in that file:

- Removed passive auto-download behavior.
- Added safer profile-picture fetching.
- Added timeout wrapper.
- Added WhatsApp JID/LID resolution.
- Added raw profile-picture IQ fallback.
- Improved `/getdp` logging and user-facing error messages.

Created:

```text
.gitignore
WORK_LOG.md
```

## 10. Current Behavior

### Links

Plain links are ignored by the downloader.

Downloads only happen through explicit commands:

```text
/download <url>
/mp3 <url>
/song <name or url>
```

### `/getdp`

The command now:

1. Cleans the phone number.
2. Checks Baileys LID mappings.
3. Tries phone JID and LID JID candidates.
4. Tries raw profile-picture query first.
5. Falls back to Baileys `profilePictureUrl`.
6. Tries both high-resolution and preview profile pictures.
7. Sends the image directly as a buffer.

## 11. Remaining Operational Notes

### GitHub

The repo exists:

```text
https://github.com/nyabwa/Joebot
```

But pushing from this local machine still requires a working GitHub auth method:

- Personal Access Token for HTTPS, or
- SSH key added to GitHub, or
- GitHub CLI login.

### AWS

The live bot is on AWS and must be updated there after local code changes.

The current reliable deployment path is SSH/SCP with:

```text
/home/joe-joe/Downloads/joebot-key.pem
```

Do not commit or upload that `.pem` file.

