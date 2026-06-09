const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    normalizeMessageContent,
    getBinaryNodeChild,
    jidNormalizedUser,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true })
const http = require('http')
const https = require('https')
const { exec, execFile } = require('child_process')
const { promisify } = require('util')
const { ActivityLog, RuntimeSettings } = require('./control-state')
const { runCleanup } = require('./cleanup')
const { ConcurrencyLimiter, CooldownManager } = require('./rate-limits')
const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const AUTH_DIR = path.join(__dirname, 'auth_info')
const DATA_DIR = path.join(__dirname, 'data')
const RESET_AUTH = process.argv.includes('--reset-auth')
const YTDLP_PATH = process.env.YTDLP_PATH || '/usr/local/bin/yt-dlp'
const YTDLP_COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || path.join(__dirname, 'cookies.txt')
const YTDLP_PROXY_URL = process.env.YTDLP_PROXY_URL || ''
const MAX_DOWNLOAD_SIZE_MB = Number(process.env.WA_MAX_DOWNLOAD_MB || 50)
const MAX_DOWNLOAD_SIZE_BYTES = MAX_DOWNLOAD_SIZE_MB * 1024 * 1024
const FLASK_HOST = process.env.FLASK_HOST || '127.0.0.1'
const FLASK_PORT = Number(process.env.FLASK_PORT || 5000)
const JOEBOT_INTERNAL_TOKEN = process.env.JOEBOT_INTERNAL_TOKEN || ''
const JOEBOT_CONTROL_TOKEN = process.env.JOEBOT_CONTROL_TOKEN || ''
for (const [name, value] of [
    ['JOEBOT_INTERNAL_TOKEN', JOEBOT_INTERNAL_TOKEN],
    ['JOEBOT_CONTROL_TOKEN', JOEBOT_CONTROL_TOKEN]
]) {
    if (value.length < 32) throw new Error(`${name} must be configured with at least 32 characters.`)
}
const VIDEO_FORMATS = [
    'bv*[height<=720][vcodec!*=h265]+ba/b[height<=720][vcodec!*=h265]/b[height<=720]',
    'bv*[vcodec!*=h265]+ba/b[vcodec!*=h265]/b',
    'bv*+ba/best'
]
try {
    runCleanup()
} catch (err) {
    console.error('Startup cleanup error:', err.message)
}
let didResetAuth = false
const runtimeSettings = new RuntimeSettings(path.join(DATA_DIR, 'runtime-settings.json'))
const activityLog = new ActivityLog(path.join(DATA_DIR, 'activity.jsonl'))
const commandCooldowns = new CooldownManager()
const operationLimiter = new ConcurrencyLimiter()
const cooldownCleanupTimer = setInterval(() => commandCooldowns.prune(), 5 * 60 * 1000)
if (typeof cooldownCleanupTimer.unref === 'function') cooldownCleanupTimer.unref()

function resetAuthSession(reason) {
    if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    }
    console.log(`Reset WhatsApp auth session (${reason}): ${AUTH_DIR}`)
}

const OWNER_NUMBER = '254785998674'
const OWNER_LID = '259957761028204@lid'
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`
const OWNER_NUMBER_DIGITS = OWNER_NUMBER.replace(/\D/g, '')
const IGNORED_GROUPS = new Set([
    '120363334397550146@g.us'
])

function internalFlaskPath(route) {
    return `/internal${route.startsWith('/') ? route : `/${route}`}`
}

function internalFlaskHeaders(body) {
    const headers = { 'X-JoeBot-Internal': JOEBOT_INTERNAL_TOKEN }
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(body)
    }
    return headers
}

function callFlask(sender, message) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ sender, message })
        const req = http.request({
            hostname: FLASK_HOST,
            port: FLASK_PORT,
            path: internalFlaskPath('/wa-draft'),
            method: 'POST',
            headers: internalFlaskHeaders(body)
        }, (res) => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`Flask returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
                    return
                }
                try { resolve(JSON.parse(data)) }
                catch (err) { reject(new Error(`JSON parse failed: ${data.slice(0, 100)}`)) }
            })
        })
        req.on('error', reject)
        req.write(body)
        req.end()
    })
}

function callFlaskPost(path2, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload)
        const req = http.request({
            hostname: FLASK_HOST,
            port: FLASK_PORT,
            path: internalFlaskPath(path2),
            method: 'POST',
            headers: internalFlaskHeaders(body),
            timeout: 60000
        }, (res) => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`Flask returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
                    return
                }
                try { resolve(JSON.parse(data)) }
                catch(e) { reject(new Error(`JSON parse failed: ${data.slice(0,100)}`)) }
            })
        })
        req.on('error', (err) => {
            console.error(`Flask POST error on ${path2}:`, err.message)
            reject(err)
        })
        req.on('timeout', () => {
            req.destroy()
            reject(new Error(`Request timeout on ${path2}`))
        })
        req.write(body)
        req.end()
    })
}

function callFlaskGet(path2) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: FLASK_HOST,
            port: FLASK_PORT,
            path: internalFlaskPath(path2),
            method: 'GET',
            headers: internalFlaskHeaders(),
            timeout: 60000
        }, (res) => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`Flask returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
                    return
                }
                try { resolve(JSON.parse(data)) }
                catch(e) { reject(new Error(`JSON parse failed: ${data.slice(0,100)}`)) }
            })
        })
        req.on('error', (err) => {
            console.error(`Flask GET error on ${path2}:`, err.message)
            reject(err)
        })
        req.on('timeout', () => {
            req.destroy()
            reject(new Error(`Request timeout on ${path2}`))
        })
        req.end()
    })
}

function saveDraft(sender, message, result) {
    const lines = result.split('\n')
    const language = lines.find(l => l.startsWith('LANGUAGE:'))?.replace('LANGUAGE:', '').trim() || 'Unknown'
    const reply = lines.find(l => l.startsWith('REPLY:'))?.replace('REPLY:', '').trim() || ''
    console.log(`Language: ${language}`)
    console.log(`Draft reply: ${reply}`)
    console.log('Saved to Supabase via Flask')
}

function formatFileSize(bytes) {
    return (bytes / 1024 / 1024).toFixed(1)
}

function extractDownloadedPath(stdout) {
    return stdout.trim().split('\n').map(line => line.trim()).filter(Boolean).pop()
}

function getYtDlpCookieArgs() {
    return fs.existsSync(YTDLP_COOKIES_PATH) ? ['--cookies', YTDLP_COOKIES_PATH] : []
}

function getYtDlpProxyArgs() {
    return YTDLP_PROXY_URL ? ['--proxy', YTDLP_PROXY_URL] : []
}

function getYtDlpRuntimeArgs() {
    return ['--js-runtimes', 'node']
}

function buildDownloadErrorMessage(err, url) {
    const details = `${err.stderr || err.stdout || err.message || ''}`
    if (/proxy|407 Proxy Authentication Required|tunnel connection failed|connection.*proxy/i.test(details)) {
        return 'Proxy connection failed. Check YTDLP_PROXY_URL credentials, host, and port.'
    }
    if (/Sign in to confirm.*not a bot|not a bot|Use --cookies|cookies-from-browser/i.test(details)) {
        return 'YouTube is blocking downloads from the AWS server as automated traffic. Add a YouTube cookies.txt file on the server and set YTDLP_COOKIES_PATH, then try again.'
    }
    if (url.includes('instagram.com') && /login|private|cookies|not available|Requested format/i.test(details)) {
        return 'Instagram could not provide a downloadable public video for this link. The reel may need login/cookies, be private, or be restricted.'
    }
    if (/File is larger than max-filesize|larger than/i.test(details)) {
        return `Download is larger than ${MAX_DOWNLOAD_SIZE_MB}MB.`
    }
    if (/Requested format is not available/i.test(details)) {
        return 'No compatible video format was available for this link.'
    }
    return err.message.split('\n')[0]
}

function buildSongDownloadErrorMessage(err) {
    const details = `${err.stderr || err.stdout || err.message || ''}`
    if (/proxy|407 Proxy Authentication Required|tunnel connection failed|connection.*proxy/i.test(details)) {
        return 'Proxy connection failed. Check the Decodo proxy credentials, host, and port.'
    }
    if (/Sign in to confirm.*not a bot|not a bot|Use --cookies|cookies-from-browser/i.test(details)) {
        return 'YouTube is still blocking the server. The proxy may be missing, blocked, or not being used.'
    }
    if (/No video results|did not match any documents|Unable to extract/i.test(details)) {
        return 'I could not find a downloadable YouTube result for that song.'
    }
    if (/ffmpeg|ffprobe/i.test(details)) {
        return 'Audio conversion failed because ffmpeg is missing or failed on the server.'
    }
    return err.message.split('\n')[0]
}

function fetchBuffer(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('Too many redirects'))
            return
        }

        let parsed
        try {
            parsed = new URL(url)
        } catch {
            reject(new Error('Invalid URL returned by WhatsApp'))
            return
        }

        const client = parsed.protocol === 'http:' ? http : https
        const req = client.get(parsed, { timeout: 30000 }, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                response.resume()
                const redirectUrl = new URL(response.headers.location, parsed).toString()
                fetchBuffer(redirectUrl, redirectCount + 1).then(resolve).catch(reject)
                return
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.resume()
                reject(new Error(`HTTP ${response.statusCode}`))
                return
            }

            const chunks = []
            response.on('data', chunk => chunks.push(chunk))
            response.on('end', () => resolve(Buffer.concat(chunks)))
        })

        req.on('timeout', () => {
            req.destroy(new Error('Request timed out'))
        })
        req.on('error', reject)
    })
}

function withTimeout(promise, timeoutMs, label) {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function resolveWhatsAppJids(sock, phoneNumber) {
    const candidates = [`${phoneNumber}@s.whatsapp.net`]

    try {
        const mappingPath = path.join(AUTH_DIR, `lid-mapping-${phoneNumber}.json`)
        if (fs.existsSync(mappingPath)) {
            const lid = JSON.parse(fs.readFileSync(mappingPath, 'utf8'))
            if (lid) {
                candidates.unshift(`${lid}@lid`)
            }
        }
    } catch (err) {
        console.error(`getdp LID mapping read failed for ${phoneNumber}:`, err.message)
    }

    try {
        const results = await withTimeout(sock.onWhatsApp(phoneNumber), 15000, 'WhatsApp number lookup')
        for (const result of results || []) {
            if (result?.exists && result?.jid) {
                candidates.unshift(result.jid)
            }
        }
    } catch (err) {
        console.error(`getdp number lookup failed for ${phoneNumber}:`, err.message)
    }

    return [...new Set(candidates)]
}

async function rawProfilePictureUrl(sock, jid, type) {
    const normalizedJid = jidNormalizedUser(jid)
    const result = await sock.query({
        tag: 'iq',
        attrs: {
            target: normalizedJid,
            to: S_WHATSAPP_NET,
            type: 'get',
            xmlns: 'w:profile:picture'
        },
        content: [{ tag: 'picture', attrs: { type, query: 'url' } }]
    }, 10000)

    const picture = getBinaryNodeChild(result, 'picture')
    return picture?.attrs?.url
}

async function findProfilePictureUrl(sock, jids) {
    const attempts = []

    for (const jid of jids) {
        for (const type of ['image', 'preview']) {
            try {
                const url = await withTimeout(
                    rawProfilePictureUrl(sock, jid, type),
                    12000,
                    `Raw profile picture lookup for ${jid}`
                )
                if (url) return { url, jid, type, method: 'raw' }
                attempts.push(`${jid}/${type}/raw: no URL returned`)
            } catch (err) {
                attempts.push(`${jid}/${type}/raw: ${err.message}`)
            }

            try {
                const url = await withTimeout(
                    sock.profilePictureUrl(jid, type, 15000),
                    20000,
                    `Profile picture lookup for ${jid}`
                )
                if (url) return { url, jid, type, method: 'baileys' }
                attempts.push(`${jid}/${type}/baileys: no URL returned`)
            } catch (err) {
                attempts.push(`${jid}/${type}/baileys: ${err.message}`)
            }
        }
    }

    throw new Error(attempts.join(' | '))
}

async function downloadVideoWithYtDlp(url, outputTemplate) {
    let lastError = null

    for (const format of VIDEO_FORMATS) {
        try {
            const { stdout, stderr } = await execFileAsync(YTDLP_PATH, [
                '--no-playlist',
                '--max-filesize', `${MAX_DOWNLOAD_SIZE_MB}M`,
                '--format-sort', 'res:720,ext:mp4:m4a,vcodec:h264,acodec:aac',
                '-f', format,
                '--merge-output-format', 'mp4',
                '--recode-video', 'mp4',
                '--output', outputTemplate,
                '--print', 'after_move:filepath',
                ...getYtDlpRuntimeArgs(),
                ...getYtDlpProxyArgs(),
                ...getYtDlpCookieArgs(),
                url
            ], { timeout: 120000, maxBuffer: 1024 * 1024 })

            if (stderr) console.log('yt-dlp stderr:', stderr.slice(0, 500))

            const filePath = extractDownloadedPath(stdout)
            if (!filePath || !fs.existsSync(filePath)) {
                throw new Error('yt-dlp did not produce a file')
            }

            const fileSize = fs.statSync(filePath).size
            if (fileSize > MAX_DOWNLOAD_SIZE_BYTES) {
                fs.unlinkSync(filePath)
                throw new Error(`Downloaded file is ${formatFileSize(fileSize)}MB; limit is ${MAX_DOWNLOAD_SIZE_MB}MB`)
            }

            return filePath
        } catch (err) {
            lastError = err
            if (!/Requested format is not available|No video formats found|No compatible formats/i.test(`${err.stderr || err.message || ''}`)) {
                break
            }
        }
    }

    throw lastError || new Error('Download failed')
}

let activeSock = null
let desiredRunning = RESET_AUTH || runtimeSettings.snapshot().botEnabled
let connectionState = 'stopped'
let lastConnectedAt = null
let lastConnectionError = null
let qrPending = false
let connectionGeneration = 0
let reconnectTimer = null
const messageStore = new Map()
const MESSAGE_TTL = Number(process.env.WA_MESSAGE_TTL_MS || 24 * 60 * 60 * 1000)
const ANTI_DELETE_CACHE_DIR = path.join(__dirname, 'anti_delete_cache')
const ANTI_DELETE_MEDIA_MAX_MB = Number(process.env.WA_ANTI_DELETE_MEDIA_MAX_MB || 50)
const ANTI_DELETE_MEDIA_MAX_BYTES = ANTI_DELETE_MEDIA_MAX_MB * 1024 * 1024

function getMessageStoreKey(key = {}) {
    return `${key.remoteJid || ''}:${key.participant || ''}:${key.fromMe ? '1' : '0'}:${key.id || ''}`
}

function getMessageStoreCandidateKeys(key = {}) {
    const remoteJid = key.remoteJid || ''
    const participant = key.participant || ''
    const fromMe = key.fromMe ? '1' : '0'
    const id = key.id || ''
    return [
        `${remoteJid}:${participant}:${fromMe}:${id}`,
        `${remoteJid}:${participant}:0:${id}`,
        `${remoteJid}:${participant}:1:${id}`,
        `${remoteJid}::${fromMe}:${id}`,
        `${remoteJid}::0:${id}`,
        `${remoteJid}::1:${id}`
    ]
}

function deleteCachedMedia(entry) {
    const filePath = entry?.media?.filePath
    if (!filePath) return
    const resolved = path.resolve(filePath)
    const cacheRoot = path.resolve(ANTI_DELETE_CACHE_DIR)
    if (!resolved.startsWith(cacheRoot)) return
    try {
        if (fs.existsSync(resolved)) fs.unlinkSync(resolved)
    } catch (err) {
        console.error('Cached media cleanup error:', err.message)
    }
}

function cleanupMessageStore() {
    const now = Date.now()
    for (const [key, entry] of messageStore.entries()) {
        if (now - entry.storedAt > MESSAGE_TTL) {
            deleteCachedMedia(entry)
            messageStore.delete(key)
        }
    }
    console.log(`MessageStore cleanup: ${messageStore.size} messages in cache`)
}

const cleanupTimer = setInterval(cleanupMessageStore, 60 * 60 * 1000)
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()

function storeMessage(msg) {
    const key = getMessageStoreKey(msg.key)
    const entry = {
        key,
        msg,
        sender: msg.key.remoteJid,
        participant: msg.key.participant,
        message: msg.message,
        timestamp: Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)),
        storedAt: Date.now(),
        pushName: msg.pushName || 'Unknown',
        media: null,
        mediaError: null,
        deletedNotified: false
    }
    const oldEntry = messageStore.get(key)
    if (oldEntry?.media?.filePath && oldEntry.media.filePath !== entry.media?.filePath) {
        deleteCachedMedia(oldEntry)
    }
    messageStore.set(key, entry)
    return entry
}

function getStoredEntryByKey(key = {}) {
    for (const candidate of getMessageStoreCandidateKeys(key)) {
        const entry = messageStore.get(candidate)
        if (!entry) continue
        if (Date.now() - entry.storedAt > MESSAGE_TTL) {
            deleteCachedMedia(entry)
            messageStore.delete(candidate)
            return null
        }
        return entry
    }

    const remoteJid = key.remoteJid || ''
    const participant = key.participant || ''
    const id = key.id || ''
    if (!remoteJid || !id) return null

    let matched = null
    for (const entry of messageStore.values()) {
        // Match by ID only as last resort; delete events can arrive with LID JIDs
        // while the original message was stored under a phone-number JID.
        if (entry.msg.key.id !== id) continue
        if (!matched || entry.timestamp > matched.timestamp) matched = entry
    }
    if (matched && Date.now() - matched.storedAt > MESSAGE_TTL) {
        deleteCachedMedia(matched)
        messageStore.delete(matched.key)
        return null
    }
    return matched
}

function getStoredMessageContent(key = {}) {
    return getStoredEntryByKey(key)?.message
}

function getLatestStoredEntryBySender(sender) {
    let latest = null
    for (const entry of messageStore.values()) {
        if (entry.sender !== sender) continue
        if (!latest || entry.timestamp > latest.timestamp) latest = entry
    }
    return latest
}

function getRecentChats(limit = 80) {
    const chats = new Map()
    for (const entry of messageStore.values()) {
        const jid = entry.sender
        if (!jid || jid === 'status@broadcast') continue
        const current = chats.get(jid)
        if (current && current.timestamp >= entry.timestamp) continue
        chats.set(jid, {
            jid,
            name: entry.pushName || jid,
            participant: entry.participant || null,
            timestamp: entry.timestamp,
            preview: extractTextFromMessage(entry.message).slice(0, 180),
            type: Object.keys(unwrapMessageContent(entry.message) || {})[0] || 'unknown',
            fromMe: Boolean(entry.msg.key.fromMe)
        })
    }
    return Array.from(chats.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, Math.min(Math.max(Number(limit) || 80, 1), 200))
}

function getRecentMessages(jid, limit = 100) {
    return Array.from(messageStore.values())
        .filter(entry => entry.sender === jid)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-Math.min(Math.max(Number(limit) || 100, 1), 200))
        .map(entry => ({
            id: entry.msg.key.id,
            jid: entry.sender,
            participant: entry.participant || null,
            name: entry.pushName || entry.sender,
            timestamp: entry.timestamp,
            text: extractTextFromMessage(entry.message).slice(0, 4000),
            type: Object.keys(unwrapMessageContent(entry.message) || {})[0] || 'unknown',
            fromMe: Boolean(entry.msg.key.fromMe),
            hasMedia: Boolean(getMediaInfo(entry.message))
        }))
}

function unwrapMessageContent(message) {
    return normalizeMessageContent(message) ||
           message?.ephemeralMessage?.message ||
           message?.viewOnceMessage?.message ||
           message?.viewOnceMessageV2?.message ||
           message?.viewOnceMessageV2Extension?.message ||
           message?.documentWithCaptionMessage?.message ||
           message?.buttonsMessage ||
           message
}

function getExtensionFromMedia(fileName, mimetype, fallback) {
    const ext = path.extname(fileName || '').replace('.', '').replace(/[^a-zA-Z0-9]/g, '')
    if (ext) return ext
    if (mimetype?.includes('pdf')) return 'pdf'
    if (mimetype?.includes('wordprocessingml')) return 'docx'
    if (mimetype?.includes('spreadsheetml')) return 'xlsx'
    if (mimetype?.includes('presentationml')) return 'pptx'
    if (mimetype?.includes('zip')) return 'zip'
    return fallback
}

function getViewOnceMessageContent(message) {
    const actual = message?.ephemeralMessage?.message ||
                   message?.documentWithCaptionMessage?.message ||
                   message
    return actual?.viewOnceMessage?.message ||
           actual?.viewOnceMessageV2?.message ||
           actual?.viewOnceMessageV2Extension?.message ||
           actual?.ephemeralMessage?.message?.viewOnceMessage?.message ||
           actual?.ephemeralMessage?.message?.viewOnceMessageV2?.message ||
           actual?.ephemeralMessage?.message?.viewOnceMessageV2Extension?.message ||
           null
}

function getMediaInfo(message) {
    const actual = unwrapMessageContent(message)
    if (actual?.imageMessage) {
        const mimetype = actual.imageMessage.mimetype || 'image/jpeg'
        return { kind: 'image', mimetype, extension: mimetype.includes('png') ? 'png' : 'jpg' }
    }
    if (actual?.videoMessage) {
        return { kind: 'video', mimetype: actual.videoMessage.mimetype || 'video/mp4', extension: 'mp4' }
    }
    if (actual?.audioMessage) {
        const mimetype = actual.audioMessage.mimetype || 'audio/ogg; codecs=opus'
        return { kind: 'audio', mimetype, extension: mimetype.includes('mpeg') ? 'mp3' : 'ogg' }
    }
    if (actual?.documentMessage) {
        const mimetype = actual.documentMessage.mimetype || 'application/octet-stream'
        const fileName = actual.documentMessage.fileName || ''
        return {
            kind: 'document',
            mimetype,
            fileName,
            extension: getExtensionFromMedia(fileName, mimetype, 'bin')
        }
    }
    return null
}

async function downloadMessageBuffer(sock, msg) {
    return downloadMediaMessage(msg, 'buffer', {}, {
        logger: console,
        reuploadRequest: async (...args) => sock.updateMediaMessage(...args)
    })
}

async function cacheMessageMedia(sock, entry) {
    const mediaInfo = getMediaInfo(entry.message)
    if (!mediaInfo) return

    try {
        const buffer = await downloadMessageBuffer(sock, entry.msg)
        if (buffer.length > ANTI_DELETE_MEDIA_MAX_BYTES) {
            entry.mediaError = `media is larger than ${ANTI_DELETE_MEDIA_MAX_MB}MB`
            return
        }

        fs.mkdirSync(ANTI_DELETE_CACHE_DIR, { recursive: true })
        const safeId = (entry.msg.key.id || `${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '')
        const filePath = path.join(ANTI_DELETE_CACHE_DIR, `${Date.now()}_${safeId}.${mediaInfo.extension}`)
        fs.writeFileSync(filePath, buffer)
        entry.media = { ...mediaInfo, filePath }
        entry.mediaError = null
    } catch (err) {
        entry.mediaError = err.message
        console.error('Anti-delete media cache error:', err.message)
    }
}

async function sendDeletedMessageAlert(sock, entry, fallbackName = 'Unknown') {
    if (!entry) {
        console.log('ANTI-DELETE alert skipped: no stored entry')
        return
    }
    if (entry.deletedNotified) {
        console.log('ANTI-DELETE alert skipped: already notified', entry.key)
        return
    }
    entry.deletedNotified = true

    const senderName = entry.pushName || fallbackName
    const alertText = `🗑️ *Deleted Message Alert*\n*From:* ${senderName}\n*Time:* ${new Date(entry.timestamp * 1000).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}\n\n`
    const actualMsg = unwrapMessageContent(entry.message)
    const text = extractTextFromMessage(entry.message)
    console.log('ANTI-DELETE alert sending:', entry.key, '| text:', text.slice(0, 80) || '(no text)', '| types:', Object.keys(actualMsg || {}).join(',') || 'unknown')

    if (text) {
        await sock.sendMessage(OWNER_JID, { text: alertText + `*Message:* ${text}` })
        console.log('ANTI-DELETE alert sent: text')
        return
    }

    const mediaInfo = getMediaInfo(entry.message)
    if (mediaInfo && entry.media?.filePath && fs.existsSync(entry.media.filePath)) {
        const buffer = fs.readFileSync(entry.media.filePath)
        if (mediaInfo.kind === 'image') {
            await sock.sendMessage(OWNER_JID, { text: alertText + '*Type:* Image' })
            await sock.sendMessage(OWNER_JID, { image: buffer, caption: '(deleted image)' })
        } else if (mediaInfo.kind === 'video') {
            await sock.sendMessage(OWNER_JID, { text: alertText + '*Type:* Video' })
            await sock.sendMessage(OWNER_JID, { video: buffer, caption: '(deleted video)' })
        } else if (mediaInfo.kind === 'audio') {
            await sock.sendMessage(OWNER_JID, { text: alertText + '*Type:* Voice note' })
            await sock.sendMessage(OWNER_JID, { audio: buffer, mimetype: mediaInfo.mimetype, ptt: true })
        } else if (mediaInfo.kind === 'document') {
            await sock.sendMessage(OWNER_JID, { text: alertText + '*Type:* Document' })
            await sock.sendMessage(OWNER_JID, {
                document: buffer,
                mimetype: mediaInfo.mimetype,
                fileName: mediaInfo.fileName || `deleted_document.${mediaInfo.extension}`
            })
        }
        console.log('ANTI-DELETE alert sent:', mediaInfo.kind)
        return
    }

    if (mediaInfo) {
        await sock.sendMessage(OWNER_JID, {
            text: alertText + `*Type:* ${mediaInfo.kind} (not cached${entry.mediaError ? `: ${entry.mediaError}` : ''})`
        })
        console.log('ANTI-DELETE alert sent: media not cached', mediaInfo.kind)
        return
    }

    await sock.sendMessage(OWNER_JID, { text: alertText + `*Type:* ${Object.keys(actualMsg || {}).join(', ') || 'unknown'}` })
    console.log('ANTI-DELETE alert sent: unknown type')
}

function extractTextFromMessage(message) {
    const actual = unwrapMessageContent(message)
    if (!actual) return ''
    return actual.conversation ||
           actual.extendedTextMessage?.text ||
           actual.imageMessage?.caption ||
           actual.videoMessage?.caption ||
           actual.documentMessage?.caption ||
           actual.templateButtonReplyMessage?.selectedId ||
           actual.buttonsResponseMessage?.selectedButtonId ||
           actual.listResponseMessage?.singleSelectReply?.selectedRowId ||
           ''
}

function normalizeNumberFromJid(jid = '') {
    return jid.split('@')[0].split(':')[0].replace(/\D/g, '')
}

function isOwnerActor(actorJid = '') {
    const bare = actorJid.split('@')[0].split(':')[0]
    if (bare === OWNER_LID.split('@')[0] || bare === OWNER_JID.split('@')[0]) return true
    const actorNumber = normalizeNumberFromJid(actorJid)
    return !!actorNumber && actorNumber === OWNER_NUMBER_DIGITS
}

async function runLimitedOperation(name, sock, sender, busyMessage, task) {
    const release = operationLimiter.tryAcquire(name)
    if (!release) {
        activityLog.add('operation_rate_limited', { operation: name, sender })
        await sock.sendMessage(sender, { text: busyMessage })
        return false
    }

    try {
        await task()
        return true
    } finally {
        release()
    }
}

async function handleCommand(sock, sender, text, actorJid = sender) {
    const parts = text.trim().split(' ')
    const command = parts[0].toLowerCase()
    const arg = parts.slice(1).join(' ').trim()
    console.log(`Command: ${command} | Arg: ${arg}`)

    if (!runtimeSettings.isCommandEnabled(command)) {
        activityLog.add('command_disabled', { command, sender })
        await sock.sendMessage(sender, { text: `⛔ ${command} is disabled in the JoeBot control dashboard.` })
        return
    }

    const cooldown = arg
        ? commandCooldowns.consume(actorJid, command)
        : { allowed: true, retryAfterMs: 0 }
    if (!cooldown.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(cooldown.retryAfterMs / 1000))
        activityLog.add('command_rate_limited', {
            command,
            actor: actorJid,
            retryAfterSeconds
        })
        await sock.sendMessage(sender, {
            text: `⏳ ${command} is cooling down. Try again in ${retryAfterSeconds} seconds.`
        })
        return
    }

    activityLog.add('command', { command, sender })

    switch (command) {

        case '/help': {
            const helpText = `*JoeBot Commands* 🤖\n\n` +
                `*📡 Info*\n` +
                `/date — Nairobi time\n` +
                `/weather [city] — Current weather\n` +
                `/ipinfo <ip> — IP address lookup\n` +
                `/numinfo <number> — Phone number info\n` +
                `/myip — Bot server IP info\n` +
                `/song <name or url> — Download song as MP3\n` +
                `/lookup <platform> <username> — Social media profile info\n` +
                `/news — Kenya headlines\n` +
                `/forex — KES exchange rates\n` +
                `/fuel — Kenya fuel prices\n\n` +
                `*📝 Productivity*\n` +
                `/remind <time> <msg> — Reminder\n` +
                `/schedule <num> <time> <msg> — Schedule message\n` +
                `/note <text> — Save note\n` +
                `/notes — View notes\n` +
                `/clearnotes — Clear notes\n` +
                `/calc <expression> — Calculator\n` +
                `/translate <text> — Translate to English\n\n` +
                `*🧠 Intelligence*\n` +
                `/wiki <topic> — Wikipedia summary\n` +
                `/fact [topic] — Interesting fact\n` +
                `/quiz <topic> — Generate quiz\n` +
                `/diagnose <symptoms> — Clinical assessment\n` +
                `/summarize <url> — Summarize YouTube video\n\n` +
                `*🕵️ OSINT*\n` +
                `/email <address> — Email investigation\n` +
                `/breach <email> — Data breach check\n` +
                `/username <handle> — Username across 200+ platforms\n` +
                `/phone <number> — Phone number intelligence\n\n` +
                `*💬 Messaging*\n` +
                `/reply <num> <msg> — Send message\n` +
                `/broadcast <msg> — Message all contacts\n` +
                `/lastmsg <num> — Last message from number\n` +
                `/online <num> — Check online status\n` +
                `/schedule <num> <time> <msg> — Schedule send\n\n` +
                `*📱 WhatsApp*\n` +
                `/getdp <number> — Profile picture\n` +
                `/savestatus <number> — Saved statuses\n` +
                `/download <url> — Download video\n` +
                `/mp3 <url> — Extract audio\n` +
                `/sticker — Send image as sticker\n` +
                `/lock <number> — Ignore number\n` +
                `/unlock <number> — Unblock number\n\n` +
                `*🙏 Personal*\n` +
                `/prayer — Daily Bible verse\n` +
                `/motivate — Motivational quote\n\n` +
                `/help — Show this menu`
            await sock.sendMessage(sender, { text: helpText })
            break
        }

        case '/date': {
            const now = new Date().toLocaleString('en-KE', {
                timeZone: 'Africa/Nairobi', weekday: 'long', year: 'numeric',
                month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
            })
            await sock.sendMessage(sender, { text: `🕐 *Nairobi Time*\n${now}` })
            break
        }

        case '/getdp': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /getdp 254712345678' }); break }
            try {
                const targetNumber = arg.replace(/\D/g, '')
                if (!targetNumber) {
                    await sock.sendMessage(sender, { text: '❌ Usage: /getdp 254712345678' })
                    break
                }

                const targetJids = await resolveWhatsAppJids(sock, targetNumber)
                console.log(`getdp candidates for ${targetNumber}: ${targetJids.join(', ')}`)

                const profilePicture = await findProfilePictureUrl(sock, targetJids)
                console.log(`getdp resolved ${targetNumber} via ${profilePicture.jid}/${profilePicture.type}/${profilePicture.method}`)

                const imageBuffer = await fetchBuffer(profilePicture.url)
                await sock.sendMessage(sender, {
                    image: imageBuffer,
                    caption: `📸 Profile picture for ${targetNumber}`
                })
            } catch (err) {
                console.error('getdp error:', err.message)
                const timedOut = /timed out|timeout/i.test(err.message)
                await sock.sendMessage(sender, {
                    text: timedOut
                        ? '❌ WhatsApp did not respond while fetching that DP. Try again, or ask the contact to message the bot first.'
                        : '❌ Could not fetch DP. The number may not be reachable from this WhatsApp session, or profile photo privacy may block it.'
                })
            }
            break
        }

        case '/savestatus': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /savestatus 254712345678' }); break }
            const statusDir = path.join(__dirname, 'saved_statuses', arg.replace(/\+/g, ''))
            if (!fs.existsSync(statusDir)) {
                await sock.sendMessage(sender, { text: `📁 No statuses saved yet for ${arg}.` }); break
            }
            const files = fs.readdirSync(statusDir)
            await sock.sendMessage(sender, { text: files.length === 0 ? `📁 Empty for ${arg}.` : `✓ ${files.length} item(s) for ${arg}:\n${files.join('\n')}` })
            break
        }

        case '/download': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /download <url>' }); break }
            await runLimitedOperation(
                'downloads',
                sock,
                sender,
                '⏳ Another download is already running. Try again when it finishes.',
                async () => {
                    await sock.sendMessage(sender, { text: `⏳ Downloading...\n${arg}` })
                    const dlDir = path.join(__dirname, 'downloads')
                    fs.mkdirSync(dlDir, { recursive: true })
                    const outTpl = path.join(dlDir, `%(title)s.%(ext)s`)
                    try {
                        const filePath = await downloadVideoWithYtDlp(arg, outTpl)
                        if (!filePath || !fs.existsSync(filePath)) {
                            await sock.sendMessage(sender, { text: '❌ Download failed.' })
                            return
                        }
                        const sizeMB = formatFileSize(fs.statSync(filePath).size)
                        const ext = path.extname(filePath).toLowerCase()
                        if (['.mp4', '.mov', '.mkv', '.webm'].includes(ext)) {
                            await sock.sendMessage(sender, { video: fs.readFileSync(filePath), caption: `✓ ${sizeMB}MB` })
                        } else if (['.mp3', '.m4a', '.ogg', '.wav'].includes(ext)) {
                            await sock.sendMessage(sender, { audio: fs.readFileSync(filePath), mimetype: 'audio/mp4', ptt: false })
                        } else {
                            await sock.sendMessage(sender, { document: fs.readFileSync(filePath), mimetype: 'application/octet-stream', fileName: path.basename(filePath) })
                        }
                        fs.unlinkSync(filePath)
                    } catch (err) {
                        if (err.stderr) console.log('yt-dlp stderr:', err.stderr.slice(0, 500))
                        const isFB266 = arg.includes('facebook.com') || arg.includes('fb.watch')
                        const errorMessage = buildDownloadErrorMessage(err, arg)
                        await sock.sendMessage(sender, { text: isFB266 ? `❌ Facebook downloads are temporarily broken.\n\nyt-dlp releases a fix within days. Try again soon or update with:\nsudo yt-dlp -U` : `❌ Download failed: ${errorMessage}` })
                    }
                }
            )
            break
        }

        case '/mp3': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /mp3 <url>' }); break }
            await runLimitedOperation(
                'downloads',
                sock,
                sender,
                '⏳ Another download is already running. Try again when it finishes.',
                async () => {
                    await sock.sendMessage(sender, { text: `⏳ Extracting audio...` })
                    const dlDir2 = path.join(__dirname, 'downloads')
                    fs.mkdirSync(dlDir2, { recursive: true })
                    try {
                        const { stdout } = await execFileAsync(YTDLP_PATH, [
                            '-x',
                            '--audio-format', 'mp3',
                            '--output', path.join(dlDir2, '%(title)s.%(ext)s'),
                            '--print', 'after_move:filepath',
                            ...getYtDlpRuntimeArgs(),
                            ...getYtDlpProxyArgs(),
                            ...getYtDlpCookieArgs(),
                            arg
                        ], { timeout: 120000, maxBuffer: 1024 * 1024 })
                        const filePath = stdout.trim().split('\n').pop()
                        if (!filePath || !fs.existsSync(filePath)) {
                            await sock.sendMessage(sender, { text: '❌ Failed.' })
                            return
                        }
                        await sock.sendMessage(sender, { audio: fs.readFileSync(filePath), mimetype: 'audio/mp4', ptt: false })
                        fs.unlinkSync(filePath)
                    } catch (err) {
                        if (err.stderr) console.log('yt-dlp mp3 stderr:', err.stderr.slice(0, 800))
                        await sock.sendMessage(sender, { text: `❌ Audio failed: ${buildSongDownloadErrorMessage(err)}` })
                    }
                }
            )
            break
        }

        case '/song': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /song <song name or url>\nExample: /song Kendrick Lamar Not Like Us\nExample: /song https://youtube.com/...' })
                break
            }
            await runLimitedOperation(
                'downloads',
                sock,
                sender,
                '⏳ Another download is already running. Try again when it finishes.',
                async () => {
                    await sock.sendMessage(sender, { text: `🎵 Searching and downloading "${arg}"...` })
                    const dlDir = path.join(__dirname, 'downloads')
                    fs.mkdirSync(dlDir, { recursive: true })
                    const outTpl = path.join(dlDir, '%(title)s.%(ext)s')
                    try {
                        const isUrl = arg.startsWith('http')
                        const searchArg = isUrl ? arg : `ytsearch1:${arg}`
                        const { stdout } = await execFileAsync(YTDLP_PATH, [
                            '-x',
                            '--audio-format', 'mp3',
                            '--audio-quality', '0',
                            '--output', outTpl,
                            '--print', 'after_move:filepath',
                            ...getYtDlpRuntimeArgs(),
                            ...getYtDlpProxyArgs(),
                            ...getYtDlpCookieArgs(),
                            searchArg
                        ], { timeout: 120000, maxBuffer: 1024 * 1024 })
                        const filePath = stdout.trim().split('\n').pop()
                        if (!filePath || !fs.existsSync(filePath)) {
                            await sock.sendMessage(sender, { text: '❌ Could not find or download the song.' })
                            return
                        }
                        const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1)
                        const songTitle = path.basename(filePath, '.mp3')
                        await sock.sendMessage(sender, {
                            audio: fs.readFileSync(filePath),
                            mimetype: 'audio/mpeg',
                            ptt: false,
                            fileName: `${songTitle}.mp3`
                        })
                        await sock.sendMessage(sender, { text: `✓ *${songTitle}*\n📦 Size: ${sizeMB}MB` })
                        fs.unlinkSync(filePath)
                        console.log(`✓ Song sent: ${songTitle}`)
                    } catch (err) {
                        console.error('Song download error:', err.message)
                        if (err.stderr) console.log('yt-dlp song stderr:', err.stderr.slice(0, 800))
                        await sock.sendMessage(sender, { text: `❌ Download failed: ${buildSongDownloadErrorMessage(err)}` })
                    }
                }
            )
            break
        }

        case '/lookup': {
            if (!arg) {
                await sock.sendMessage(sender, {
                    text: '❌ Usage: /lookup <platform> <username>\n\nSupported platforms:\n• instagram (or ig)\n• tiktok (or tt)\n• twitter (or x)\n• github (or gh)\n\nExample: /lookup instagram cristiano\nExample: /lookup github torvalds'
                })
                break
            }
            const lookupParts = arg.split(' ')
            const platform = lookupParts[0].toLowerCase()
            const username = lookupParts[1]
            if (!username) {
                await sock.sendMessage(sender, { text: '❌ Include a username.\nExample: /lookup instagram cristiano' })
                break
            }
            await sock.sendMessage(sender, { text: `🔍 Looking up @${username} on ${platform}...` })
            try {
                const result = await callFlaskPost('/social-lookup', { platform, username })
                await sock.sendMessage(sender, { text: result.result })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Lookup failed: ${err.message}` })
            }
            break
        }

        case '/lock': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /lock 254712345678' }); break }
            const num = arg.replace(/\+/g, '').trim()
            await callFlaskPost('/contact-lock', { phone: num, action: 'lock' })
            await sock.sendMessage(sender, { text: `🔒 ${num} is now locked.` })
            break
        }

        case '/unlock': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /unlock 254712345678' }); break }
            const num2 = arg.replace(/\+/g, '').trim()
            await callFlaskPost('/contact-lock', { phone: num2, action: 'unlock' })
            await sock.sendMessage(sender, { text: `🔓 ${num2} is now unlocked.` })
            break
        }

        case '/weather': {
            const location = arg || 'Nairobi'
            const data = await callFlaskPost('/get-weather', { location })
            await sock.sendMessage(sender, { text: data.result })
            break
        }

        case '/ipinfo': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /ipinfo <ip address>\nExample: /ipinfo 8.8.8.8' })
                break
            }
            const ipData = await callFlaskPost('/ip-info', { ip: arg })
            await sock.sendMessage(sender, { text: ipData.result })
            break
        }

        case '/numinfo': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /numinfo <number with country code>\nExample: /numinfo 254712345678' })
                break
            }
            const number = arg.replace(/\D/g, '')
            if (!number) {
                await sock.sendMessage(sender, { text: '❌ Usage: /numinfo <number with country code>\nExample: /numinfo 254712345678' })
                break
            }
            await sock.sendMessage(sender, { text: `🔍 Looking up +${number}...` })
            const numData = await callFlaskPost('/num-info', { number })
            await sock.sendMessage(sender, { text: numData.result })
            break
        }

        case '/myip': {
            const myIpData = await callFlaskGet('/my-ip')
            await sock.sendMessage(sender, { text: myIpData.result })
            break
        }

        case '/remind': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /remind 30m Buy milk' }); break }
            const p = arg.split(' ')
            const timeStr = p[0]
            const reminderMsg = p.slice(1).join(' ')
            if (!reminderMsg) { await sock.sendMessage(sender, { text: '❌ Include a message.' }); break }
            let ms = 0
            if (timeStr.endsWith('m')) ms = parseInt(timeStr) * 60000
            else if (timeStr.endsWith('h')) ms = parseInt(timeStr) * 3600000
            else if (timeStr.endsWith('s')) ms = parseInt(timeStr) * 1000
            else { await sock.sendMessage(sender, { text: '❌ Format: 30m, 2h, 90s' }); break }
            const fireTime = new Date(Date.now() + ms).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
            await sock.sendMessage(sender, { text: `⏰ Reminder set!\n*Message:* ${reminderMsg}\n*Fires at:* ${fireTime}` })
            setTimeout(async () => {
                await sock.sendMessage(sender, { text: `⏰ *REMINDER*\n\n${reminderMsg}\n\n_Set ${timeStr} ago_` })
            }, ms)
            break
        }

        case '/note': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /note <text>' }); break }
            await callFlaskPost('/save-note', { note: arg })
            await sock.sendMessage(sender, { text: `📝 Note saved!` })
            break
        }

        case '/notes': {
            const result = await callFlaskGet('/get-notes')
            if (!result.notes || result.notes.length === 0) {
                await sock.sendMessage(sender, { text: '📝 No notes yet.' }); break
            }
            const list = result.notes.map((n, i) => `*${i+1}.* ${n.note}`).join('\n')
            await sock.sendMessage(sender, { text: `📝 *Notes*\n\n${list}` })
            break
        }

        case '/clearnotes': {
            await callFlaskPost('/clear-notes', {})
            await sock.sendMessage(sender, { text: '🗑️ All notes cleared.' })
            break
        }

        case '/calc': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /calc 15% of 8500' }); break }
            const calc = await callFlaskPost('/calculate', { expression: arg })
            await sock.sendMessage(sender, { text: `🔢 *${arg}*\n= ${calc.result}` })
            break
        }

        case '/translate': {
            if (!arg) { await sock.sendMessage(sender, { text: '❌ Usage: /translate <text>' }); break }
            const trans = await callFlaskPost('/translate', { text: arg })
            await sock.sendMessage(sender, { text: `🌍 *Translation*\n\n*Original:* ${arg}\n*English:* ${trans.result}` })
            break
        }

        case '/reply': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /reply 254712345678 Your message here' })
                break
            }
            const replyParts = arg.split(' ')
            const replyNumber = replyParts[0].replace(/\+/g, '')
            const replyMsg = replyParts.slice(1).join(' ')
            if (!replyMsg) {
                await sock.sendMessage(sender, { text: '❌ Include a message after the number.' })
                break
            }
            try {
                await sock.sendMessage(`${replyNumber}@s.whatsapp.net`, { text: replyMsg })
                await sock.sendMessage(sender, { text: `✓ Message sent to ${replyNumber}` })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Failed: ${err.message}` })
            }
            break
        }

        case '/broadcast': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /broadcast Your message here' })
                break
            }
            try {
                const contactsResult = await callFlaskGet('/get-contacts-list')
                const contacts = contactsResult.contacts || []
                if (contacts.length === 0) {
                    await sock.sendMessage(sender, { text: '❌ No contacts saved. Add contacts first at /contacts.' })
                    break
                }
                let sent = 0
                for (const contact of contacts) {
                    if (contact.phone) {
                        try {
                            await sock.sendMessage(`${contact.phone}@s.whatsapp.net`, { text: arg })
                            sent++
                            await new Promise(r => setTimeout(r, 1000))
                        } catch {}
                    }
                }
                await sock.sendMessage(sender, { text: `✓ Broadcast sent to ${sent} contacts.` })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Broadcast failed: ${err.message}` })
            }
            break
        }

        case '/lastmsg': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /lastmsg 254712345678' })
                break
            }
            const targetNum = arg.replace(/\+/g, '')
            const targetJid = `${targetNum}@s.whatsapp.net`
            const stored = getLatestStoredEntryBySender(targetJid)
            if (!stored) {
                await sock.sendMessage(sender, { text: `❌ No stored messages from ${targetNum}. Messages are stored as they arrive.` })
            } else {
                const msgText = stored.message?.conversation || stored.message?.extendedTextMessage?.text || '(media message)'
                const time = new Date(stored.timestamp * 1000).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
                await sock.sendMessage(sender, { text: `💬 *Last message from ${stored.pushName}*\n\n"${msgText}"\n\n_${time}_` })
            }
            break
        }

        case '/online': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /online 254712345678' })
                break
            }
            try {
                const targetJid = `${arg.replace(/\+/g, '')}@s.whatsapp.net`
                const status = await sock.fetchStatus(targetJid)
                await sock.sendMessage(sender, { text: `👤 *${arg}*\nStatus: ${status?.status || 'No status set'}` })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Could not fetch status for ${arg}.` })
            }
            break
        }

        case '/wiki': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /wiki <topic>' })
                break
            }
            const wikiData = await callFlaskPost('/get-wiki', { topic: arg })
            await sock.sendMessage(sender, { text: `📖 *${arg}*\n\n${wikiData.result}` })
            break
        }

        case '/fact': {
            const factData = await callFlaskPost('/get-fact', { topic: arg || '' })
            await sock.sendMessage(sender, { text: `💡 *Fact${arg ? ' about ' + arg : ''}*\n\n${factData.result}` })
            break
        }

        case '/quiz': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /quiz <topic>\nExample: /quiz anatomy' })
                break
            }
            await sock.sendMessage(sender, { text: `📝 Generating quiz on "${arg}"...` })
            const quizData = await callFlaskPost('/get-quiz', { topic: arg })
            await sock.sendMessage(sender, { text: `📝 *Quiz: ${arg}*\n\n${quizData.result}` })
            break
        }

        case '/diagnose': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /diagnose <symptoms>\nExample: /diagnose knee pain swelling morning stiffness' })
                break
            }
            await sock.sendMessage(sender, { text: `🏥 Analyzing symptoms...` })
            const diagnoseData = await callFlaskPost('/get-diagnose', { symptoms: arg })
            await sock.sendMessage(sender, { text: `🏥 *Clinical Assessment*\n\n${diagnoseData.result}` })
            break
        }

        case '/news': {
            await sock.sendMessage(sender, { text: `📰 Fetching news...` })
            const newsData = await callFlaskPost('/get-news', {})
            await sock.sendMessage(sender, { text: newsData.result })
            break
        }

        case '/forex': {
            const forexData = await callFlaskPost('/get-forex', {})
            await sock.sendMessage(sender, { text: forexData.result })
            break
        }

        case '/fuel': {
            const fuelData = await callFlaskPost('/get-fuel', {})
            await sock.sendMessage(sender, { text: fuelData.result })
            break
        }

        case '/todo': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /todo <task>\nExample: /todo Buy milk' })
                break
            }
            await callFlaskPost('/todo-add', { task: arg })
            await sock.sendMessage(sender, { text: `✅ Todo added: ${arg}` })
            break
        }

        case '/todos': {
            try {
                const result = await callFlaskGet('/todo-list')
                const pending = result.pending || []
                const done = result.done || []
                if (pending.length === 0 && done.length === 0) {
                    await sock.sendMessage(sender, { text: '📋 No todos yet. Add one with /todo <task>' })
                    break
                }
                let msg = '📋 *Your Todos*\n\n'
                if (pending.length > 0) {
                    msg += '*Pending:*\n'
                    pending.forEach((t, i) => { msg += `${i + 1}. ☐ ${t.task}\n` })
                }
                if (done.length > 0) {
                    msg += '\n*Completed:*\n'
                    done.slice(-5).forEach(t => { msg += `✓ ~~${t.task}~~\n` })
                }
                msg += `\nUse /done <number> to mark complete`
                await sock.sendMessage(sender, { text: msg })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` })
            }
            break
        }

        case '/done': {
            if (!arg || isNaN(parseInt(arg))) {
                await sock.sendMessage(sender, { text: '❌ Usage: /done <number>\nExample: /done 1' })
                break
            }
            const doneResult = await callFlaskPost('/todo-done', { number: parseInt(arg) })
            if (doneResult.success) {
                await sock.sendMessage(sender, { text: `✅ Completed: ${doneResult.task}` })
            } else {
                await sock.sendMessage(sender, { text: `❌ Todo #${arg} not found.` })
            }
            break
        }

        case '/qr': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /qr <text or url>\nExample: /qr https://example.com' })
                break
            }
            await sock.sendMessage(sender, { text: `⏳ Generating QR code...` })
            try {
                const result = await callFlaskPost('/generate-qr', { text: arg })
                if (result.success) {
                    const imgBuffer = Buffer.from(result.image, 'base64')
                    await sock.sendMessage(sender, {
                        image: imgBuffer,
                        caption: `🔳 QR Code for: ${arg}`
                    })
                }
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ QR generation failed: ${err.message}` })
            }
            break
        }

        case '/pdf': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /pdf <your text>\nExample: /pdf Meeting notes from today...' })
                break
            }
            await sock.sendMessage(sender, { text: `⏳ Generating PDF...` })
            try {
                const titleMatch = arg.match(/^"([^"]+)"\s+(.+)/s)
                const title = titleMatch ? titleMatch[1] : 'JoeBot Document'
                const content = titleMatch ? titleMatch[2] : arg
                const result = await callFlaskPost('/generate-pdf', { text: content, title })
                if (result.success) {
                    const pdfBuffer = Buffer.from(result.pdf, 'base64')
                    await sock.sendMessage(sender, {
                        document: pdfBuffer,
                        mimetype: 'application/pdf',
                        fileName: `${title}.pdf`,
                        caption: `📄 ${title}`
                    })
                } else {
                    await sock.sendMessage(sender, { text: `❌ PDF failed: ${result.message}` })
                }
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ PDF error: ${err.message}` })
            }
            break
        }

        case '/block': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /block 254712345678' })
                break
            }
            try {
                const blockJid = `${arg.replace(/\+/g, '')}@s.whatsapp.net`
                await sock.updateBlockStatus(blockJid, 'block')
                await sock.sendMessage(sender, { text: `🚫 ${arg} has been blocked on WhatsApp.` })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Block failed: ${err.message}` })
            }
            break
        }

        case '/prayer': {
            const verseData = await callFlaskPost('/get-verse', { action: 'verse' })
            await sock.sendMessage(sender, { text: verseData.result })
            break
        }

        case '/motivate': {
            const motivateData = await callFlaskPost('/get-motivate', {})
            await sock.sendMessage(sender, { text: `💪 ${motivateData.result}` })
            break
        }

        case '/schedule': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /schedule 254712345678 14:30 Your message' })
                break
            }
            const scheduleParts = arg.split(' ')
            const scheduleNumber = scheduleParts[0].replace(/\+/g, '')
            const scheduleTime = scheduleParts[1]
            const scheduleMsg = scheduleParts.slice(2).join(' ')

            if (!scheduleTime || !scheduleMsg || !scheduleTime.includes(':')) {
                await sock.sendMessage(sender, { text: '❌ Format: /schedule 254712345678 14:30 Your message' })
                break
            }

            const [hours, minutes] = scheduleTime.split(':').map(Number)
            const now = new Date()
            const nairobiOffset = 3 * 60
            const nairobiNow = new Date(now.getTime() + nairobiOffset * 60000)
            let fireTime = new Date(nairobiNow)
            fireTime.setHours(hours, minutes, 0, 0)

            if (fireTime <= nairobiNow) {
                fireTime.setDate(fireTime.getDate() + 1)
            }

            const msUntilFire = fireTime - nairobiNow
            const fireTimeStr = fireTime.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })

            await sock.sendMessage(sender, {
                text: `⏰ Message scheduled!\n*To:* ${scheduleNumber}\n*Message:* ${scheduleMsg}\n*Sends at:* ${fireTimeStr}`
            })

            setTimeout(async () => {
                try {
                    await sock.sendMessage(`${scheduleNumber}@s.whatsapp.net`, { text: scheduleMsg })
                    await sock.sendMessage(sender, { text: `✓ Scheduled message sent to ${scheduleNumber}` })
                } catch (err) {
                    await sock.sendMessage(sender, { text: `❌ Scheduled send failed: ${err.message}` })
                }
            }, msUntilFire)
            break
        }

        case '/summarize': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /summarize <youtube_url>' })
                break
            }
            await runLimitedOperation(
                'downloads',
                sock,
                sender,
                '⏳ Another download or YouTube summary is already running. Try again when it finishes.',
                async () => {
                    await sock.sendMessage(sender, { text: `⏳ Fetching transcript and summarizing...\n${arg}` })
                    try {
                        const result = await callFlaskPost('/summarize-youtube', { url: arg })
                        if (result.success) {
                            await sock.sendMessage(sender, { text: `📺 *YouTube Summary*\n\n${result.result}` })
                        } else {
                            await sock.sendMessage(sender, { text: `❌ ${result.result}` })
                        }
                    } catch (err) {
                        await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` })
                    }
                }
            )
            break
        }

        case '/sticker': {
            await sock.sendMessage(sender, { text: '📌 Send me any image with caption /sticker and I will convert it to a sticker.' })
            break
        }

        case '/email': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /email <address>\nExample: /email john@gmail.com' })
                break
            }
            await sock.sendMessage(sender, { text: `🔍 Running email OSINT on ${arg}...` })
            try {
                const result = await callFlaskPost('/check-email', { email: arg })
                await sock.sendMessage(sender, { text: result.result })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` })
            }
            break
        }

        case '/breach': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /breach <email>\nExample: /breach john@gmail.com' })
                break
            }
            await sock.sendMessage(sender, { text: `🔓 Checking breach databases for ${arg}...` })
            try {
                const result = await callFlaskPost('/check-breach', { email: arg })
                await sock.sendMessage(sender, { text: result.result })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` })
            }
            break
        }

        case '/username': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /username <handle>\nExample: /username johndoe' })
                break
            }
            await runLimitedOperation(
                'sherlock',
                sock,
                sender,
                '⏳ A username scan is already running. Try again when it finishes.',
                async () => {
                    await sock.sendMessage(sender, { text: `🔍 Scanning @${arg} across 200+ platforms...\n\n⏳ This takes 30-60 seconds` })
                    try {
                        const result = await callFlaskPost('/check-username', { username: arg })
                        await sock.sendMessage(sender, { text: result.result })
                    } catch (err) {
                        await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` })
                    }
                }
            )
            break
        }

        case '/phone': {
            if (!arg) {
                await sock.sendMessage(sender, { text: '❌ Usage: /phone <number>\nExample: /phone 254712345678' })
                break
            }
            await sock.sendMessage(sender, { text: `📱 Running phone OSINT on +${arg.replace(/\+/g, '')}...` })
            try {
                const result = await callFlaskPost('/check-phone', { number: arg })
                await sock.sendMessage(sender, { text: result.result })
            } catch (err) {
                await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` })
            }
            break
        }

        case '/exif': {
            await sock.sendMessage(sender, { text: '📎 Send an image as a *document* with caption /exif to extract metadata.\n\nTip: Attach → Document → pick image from gallery for full EXIF including GPS.' })
            break
        }

        default: {
            await sock.sendMessage(sender, { text: `❓ Unknown command: ${command}\nSend /help to see available commands.` })
        }
    }
}

function scheduleReconnect() {
    if (!desiredRunning || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connectToWhatsApp().catch(err => {
            connectionState = 'error'
            lastConnectionError = err.message
            activityLog.add('connection', { status: 'error', error: err.message })
            console.error('Reconnect error:', err.message)
            scheduleReconnect()
        })
    }, 3000)
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
}

async function startWhatsApp() {
    desiredRunning = true
    runtimeSettings.setBotEnabled(true)
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }
    try {
        await connectToWhatsApp()
    } catch (err) {
        connectionState = 'error'
        lastConnectionError = err.message
        activityLog.add('connection', { status: 'error', error: err.message })
        scheduleReconnect()
        throw err
    }
}

async function stopWhatsApp() {
    desiredRunning = false
    runtimeSettings.setBotEnabled(false)
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }
    const sock = activeSock
    activeSock = null
    connectionState = 'stopped'
    qrPending = false
    connectionGeneration += 1
    activityLog.add('connection', { status: 'stopped' })
    if (sock) {
        try {
            sock.end(new Error('Stopped from JoeBot dashboard'))
        } catch (err) {
            console.error('Socket stop error:', err.message)
        }
    }
}

function getRuntimeState() {
    return {
        desiredRunning,
        connection: connectionState,
        connected: connectionState === 'connected',
        account: activeSock?.user?.id || null,
        lastConnectedAt,
        lastError: lastConnectionError,
        qrPending,
        messagesInMemory: messageStore.size,
        settings: runtimeSettings.snapshot()
    }
}

async function connectToWhatsApp() {
    if (!desiredRunning || connectionState === 'connecting' || connectionState === 'connected') return

    if (RESET_AUTH && !didResetAuth) {
        resetAuthSession('--reset-auth')
        didResetAuth = true
    }

    connectionState = 'connecting'
    lastConnectionError = null
    const generation = ++connectionGeneration
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        shouldIgnoreJid: jid => false,
        getMessage: async (key) => getStoredMessageContent(key)
    })

    activeSock = sock

    sock.ev.on('connection.update', (update) => {
        if (generation !== connectionGeneration) return
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            qrPending = true
            connectionState = 'awaiting_scan'
            activityLog.add('connection', { status: 'awaiting_scan' })
            console.log('\nScan QR code:\n')
            qrcode.generate(qr, { small: true })
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const errorMessage = lastDisconnect?.error?.message || 'Unknown disconnect'
            const wasLoggedOut = statusCode === DisconnectReason.loggedOut
            const shouldReconnect = !wasLoggedOut
            activeSock = null
            qrPending = false
            lastConnectionError = errorMessage
            connectionState = wasLoggedOut ? 'logged_out' : (desiredRunning ? 'reconnecting' : 'stopped')
            activityLog.add('connection', {
                status: connectionState,
                statusCode: statusCode || null,
                error: errorMessage
            })
            console.log(`Connection closed: ${errorMessage} (status: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`)
            if (wasLoggedOut) {
                console.log('WhatsApp logged out. Run npm run relink when you intentionally want to reset and scan again.')
            } else if (desiredRunning && shouldReconnect) {
                scheduleReconnect()
            }
        } else if (connection === 'open') {
            connectionState = 'connected'
            lastConnectedAt = new Date().toISOString()
            lastConnectionError = null
            qrPending = false
            activityLog.add('connection', { status: 'connected', account: sock.user?.id || null })
            console.log('✓ WhatsApp bot is live and listening...')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.process(async (events) => {
        if (events['contacts.update']) {
            for (const contact of events['contacts.update']) {
                if (contact.imgUrl !== undefined) console.log(`Contact updated: ${contact.id}`)
            }
        }
    })

    // Keep the original delete event as backup
    sock.ev.on('messages.delete', async (item) => {
        if (!runtimeSettings.isFeatureEnabled('antiDelete')) return
        console.log('DELETE EVENT:', JSON.stringify(item).slice(0, 200))
        if (!('keys' in item)) return
        for (const key of item.keys) {
            const stored = getStoredEntryByKey(key)
            if (!stored) continue
            await sendDeletedMessageAlert(sock, stored)
        }
    })

    // SINGLE UNIFIED messages.upsert listener
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log('UPSERT type:', type, '| count:', messages.length)
        for (const m of messages) {
            console.log('RAW MSG TYPES:', Object.keys(m.message || {}).join(','), '| fromMe:', m.key.fromMe, '| full:', JSON.stringify(m).slice(0, 300))
        }
        for (const msg of messages) {
            if (!msg.message) continue

            // Skip messages older than 5 minutes to avoid backlog flood
            const msgAge = Date.now() / 1000 - (msg.messageTimestamp || 0)
            if (msgAge > 300) {
                // Still store for anti-delete but skip processing
                storeMessage(msg)
                continue
            }

            const sender = msg.key.remoteJid
            const actorJid = msg.key.participant || sender
            const commandActorJid = msg.key.fromMe ? OWNER_JID : actorJid
            const senderNumber = normalizeNumberFromJid(actorJid)
            const text = extractTextFromMessage(msg.message)
            const msgType = Object.keys(msg.message || {})[0] || ''
            console.log('MSG TYPES:', Object.keys(msg.message || {}).join(','), '| from:', msg.key.remoteJid)
            const isCommand = text.startsWith('/')
            const isOwner = isOwnerActor(actorJid)
            const isGroup = sender.endsWith('@g.us')
            const isStatus = sender === 'status@broadcast'

            if (isGroup && IGNORED_GROUPS.has(sender)) {
                console.log(`Ignored forbidden group: ${sender}`)
                continue
            }

            if (isCommand && isOwner) {
                const requestedCommand = text.trim().split(/\s+/)[0].toLowerCase()
                if (!runtimeSettings.isCommandEnabled(requestedCommand)) {
                    activityLog.add('command_disabled', { command: requestedCommand, sender })
                    await sock.sendMessage(sender, { text: `⛔ ${requestedCommand} is disabled in the JoeBot control dashboard.` })
                    continue
                }
            }

            // --- STORE ALL MESSAGES FOR ANTI-DELETE ---
            const storedEntry = storeMessage(msg)
            activityLog.add('message_received', {
                jid: sender,
                name: msg.pushName || null,
                type: msgType,
                fromMe: Boolean(msg.key.fromMe)
            })
            if (runtimeSettings.isFeatureEnabled('antiDelete') || runtimeSettings.isFeatureEnabled('viewOnce')) {
                await cacheMessageMedia(sock, storedEntry)
            }

            // --- STATUS AUTO-SAVE ---
            if (isStatus) {
                if (!runtimeSettings.isFeatureEnabled('statusSaver')) continue
                const posterJid = msg.key.participant || sender
                const posterNumber = posterJid.replace('@s.whatsapp.net', '')
                const statusDir = path.join(__dirname, 'saved_statuses', posterNumber)
                fs.mkdirSync(statusDir, { recursive: true })
                try {
                    if (msg.message?.imageMessage) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {})
                        fs.writeFileSync(path.join(statusDir, `status_${msg.messageTimestamp}.jpg`), buffer)
                        console.log(`✓ Auto-saved image status from ${posterNumber}`)
                    } else if (msg.message?.videoMessage) {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {})
                        fs.writeFileSync(path.join(statusDir, `status_${msg.messageTimestamp}.mp4`), buffer)
                        console.log(`✓ Auto-saved video status from ${posterNumber}`)
                    } else if (msg.message?.conversation || msg.message?.extendedTextMessage) {
                        const statusText = msg.message.conversation || msg.message.extendedTextMessage?.text
                        fs.writeFileSync(path.join(statusDir, `status_${msg.messageTimestamp}.txt`), statusText)
                        console.log(`✓ Auto-saved text status from ${posterNumber}`)
                    }
                } catch (err) {
                    console.error(`Status save error:`, err.message)
                }
                continue
            }

            // --- ANTI-DELETE: catch protocol delete messages ---
            const proto = msg.message?.protocolMessage
            if (proto) console.log('PROTOCOL MSG type:', proto.type, '| key:', JSON.stringify(proto.key).slice(0, 100))
            if (runtimeSettings.isFeatureEnabled('antiDelete') && proto && proto.type === 0) {
                const deletedKey = proto.key
                const stored = getStoredEntryByKey(deletedKey)
                console.log('ANTI-DELETE lookup:', stored ? `found ${stored.key}` : 'missing', '| deleted id:', deletedKey?.id)
                if (!stored) {
                    await sock.sendMessage(OWNER_JID, {
                        text: `🗑️ *Deleted Message Alert*\n*From:* ${msg.pushName || 'Unknown'}\n*Time:* ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}\n\n⚠️ Deleted before it was stored.`
                    })
                    console.log('ANTI-DELETE alert sent: missing stored entry')
                    continue
                }
                try {
                    await sendDeletedMessageAlert(sock, stored, msg.pushName || 'Unknown')
                } catch (err) { console.error('Anti-delete error:', err.message) }
                continue
            }

            // --- VIEW-ONCE INTERCEPTOR ---
            const viewOnceMsg = getViewOnceMessageContent(msg.message)
            if (runtimeSettings.isFeatureEnabled('viewOnce') && viewOnceMsg) {
                console.log(`👁️ View-once from ${msg.pushName || sender}`)
                try {
                    if (viewOnceMsg.imageMessage) {
                        const buffer = storedEntry.media?.filePath && fs.existsSync(storedEntry.media.filePath)
                            ? fs.readFileSync(storedEntry.media.filePath)
                            : await downloadMessageBuffer(sock, msg)
                        const savePath = path.join(__dirname, 'view_once', `${Date.now()}.jpg`)
                        fs.mkdirSync(path.join(__dirname, 'view_once'), { recursive: true })
                        fs.writeFileSync(savePath, buffer)
                        await sock.sendMessage(OWNER_JID, { text: `👁️ *View-Once Image*\n*From:* ${msg.pushName || sender}` })
                        await sock.sendMessage(OWNER_JID, { image: buffer, caption: '(view-once intercepted)' })
                    } else if (viewOnceMsg.videoMessage) {
                        const buffer = storedEntry.media?.filePath && fs.existsSync(storedEntry.media.filePath)
                            ? fs.readFileSync(storedEntry.media.filePath)
                            : await downloadMessageBuffer(sock, msg)
                        const savePath = path.join(__dirname, 'view_once', `${Date.now()}.mp4`)
                        fs.mkdirSync(path.join(__dirname, 'view_once'), { recursive: true })
                        fs.writeFileSync(savePath, buffer)
                        await sock.sendMessage(OWNER_JID, { text: `👁️ *View-Once Video*\n*From:* ${msg.pushName || sender}` })
                        await sock.sendMessage(OWNER_JID, { video: buffer, caption: '(view-once intercepted)' })
                    }
                } catch (err) { console.error('View-once error:', err.message) }
                continue
            }

            // --- EXIF EXTRACTION ---
            if (runtimeSettings.isFeatureEnabled('mediaTools') && text?.trim().toLowerCase() === '/exif' && (msgType === 'imageMessage' || msgType === 'documentMessage')) {
                await sock.sendMessage(sender, { text: '🔍 Extracting EXIF data...' })
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {})
                    const tmpPath = path.join(__dirname, 'downloads', `exif_${Date.now()}.jpg`)
                    fs.mkdirSync(path.dirname(tmpPath), { recursive: true })
                    fs.writeFileSync(tmpPath, buffer)
                    const { stdout } = await execAsync(`exiftool -json "${tmpPath}"`)
                    fs.unlinkSync(tmpPath)
                    const data = JSON.parse(stdout)[0]

                    const fields = [
                        ['📷 Camera', data.Make && data.Model ? `${data.Make} ${data.Model}` : null],
                        ['📱 Device', data.DeviceManufacturer || data.Software || null],
                        ['📅 Date Taken', data.DateTimeOriginal || data.CreateDate || null],
                        ['📍 GPS Lat', data.GPSLatitude || null],
                        ['📍 GPS Long', data.GPSLongitude || null],
                        ['🗺️ GPS Ref', data.GPSLatitudeRef && data.GPSLongitudeRef ? `${data.GPSLatitudeRef}, ${data.GPSLongitudeRef}` : null],
                        ['📐 Resolution', data.ImageWidth && data.ImageHeight ? `${data.ImageWidth} x ${data.ImageHeight}` : null],
                        ['🎨 Color Space', data.ColorSpace || null],
                        ['📁 File Type', data.FileType || null],
                        ['💾 File Size', data.FileSize || null],
                        ['🔧 Software', data.Software || null],
                        ['⚡ Flash', data.Flash || null],
                        ['🔍 Focal Length', data.FocalLength || null],
                        ['📊 ISO', data.ISO || null],
                        ['⏱️ Exposure', data.ExposureTime || null],
                        ['🌐 F-Number', data.FNumber || null],
                    ]

                    const lines = fields
                        .filter(([_, val]) => val !== null && val !== undefined)
                        .map(([label, val]) => `${label}: ${val}`)

                    if (lines.length === 0) {
                        await sock.sendMessage(sender, { text: '⚠️ No EXIF data found in this image.\n\nMost social media platforms strip EXIF data before sending.' })
                    } else {
                        let result = `🔍 *EXIF Data*\n\n${lines.join('\n')}`
                        if (data.GPSLatitude && data.GPSLongitude) {
                            result += `\n\n🗺️ *Maps:* https://maps.google.com/?q=${data.GPSLatitude},${data.GPSLongitude}`
                        }
                        result += '\n\n⚠️ Note: WhatsApp strips GPS data from images sent through the app.'
                        await sock.sendMessage(sender, { text: result })
                    }
                } catch (err) {
                    console.error('EXIF error:', err.message)
                    await sock.sendMessage(sender, { text: `❌ EXIF extraction failed: ${err.message.split('\n')[0]}` })
                }
                continue
            }

            // Handle owner/self commands sent from linked devices ("fromMe" messages)
            if (msg.key.fromMe) {
                if (isCommand) {
                    await handleCommand(sock, sender, text, commandActorJid)
                }
                continue
            }

            // --- VOICE NOTE TRANSCRIPTION ---
            if (runtimeSettings.isFeatureEnabled('voiceTranscription') && msg.message?.audioMessage?.ptt === true) {
                console.log(`🎤 Voice note from ${sender}`)
                await runLimitedOperation(
                    'transcription',
                    sock,
                    sender,
                    '⏳ Another voice note is being transcribed. Try again when it finishes.',
                    async () => {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {})
                            const base64Audio = buffer.toString('base64')
                            const result = await callFlaskPost('/transcribe', { audio: base64Audio })
                            if (result.success && result.text) {
                                await sock.sendMessage(OWNER_JID, {
                                    text: `🎤 *Voice Note Transcript*\n*From:* ${msg.pushName || sender}\n\n"${result.text}"`
                                })
                                await callFlask(sender, result.text)
                            }
                        } catch (err) {
                            console.error('Transcription error:', err.message)
                        }
                    }
                )
                continue
            }

            // --- VIDEO COMPRESSION ---
            if (runtimeSettings.isFeatureEnabled('mediaTools') && msg.message?.videoMessage) {
                const videoCaption = msg.message.videoMessage.caption || ''
                if (videoCaption.trim().toLowerCase() === '/compress') {
                    console.log(`🎥 Video compression requested from ${sender}`)
                    await sock.sendMessage(sender, { text: `⏳ Compressing video...` })
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {})
                        const inputPath = path.join(__dirname, 'downloads', `input_${Date.now()}.mp4`)
                        const outputPath = path.join(__dirname, 'downloads', `compressed_${Date.now()}.mp4`)
                        fs.mkdirSync(path.join(__dirname, 'downloads'), { recursive: true })
                        fs.writeFileSync(inputPath, buffer)
                        await execAsync(
                            `ffmpeg -i "${inputPath}" -vcodec libx264 -crf 28 -preset fast -acodec aac "${outputPath}"`,
                            { timeout: 120000 }
                        )
                        const originalMB = (buffer.length / 1024 / 1024).toFixed(1)
                        const compressedMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)
                        await sock.sendMessage(sender, {
                            video: fs.readFileSync(outputPath),
                            caption: `✅ Compressed: ${originalMB}MB → ${compressedMB}MB`
                        })
                        fs.unlinkSync(inputPath)
                        fs.unlinkSync(outputPath)
                    } catch (err) {
                        await sock.sendMessage(sender, { text: `❌ Compression failed: ${err.message}` })
                    }
                    continue
                }
            }

            // --- IMAGE RESIZE ---
            if (runtimeSettings.isFeatureEnabled('mediaTools') && msg.message?.imageMessage) {
                const resizeCaption = msg.message.imageMessage.caption || ''
                if (resizeCaption.trim().toLowerCase() === '/resize') {
                    console.log(`🖼️ Image resize requested from ${sender}`)
                    await sock.sendMessage(sender, { text: `⏳ Resizing image...` })
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {})
                        const inputPath = path.join(__dirname, 'downloads', `resize_input_${Date.now()}.jpg`)
                        const outputPath = path.join(__dirname, 'downloads', `resized_${Date.now()}.jpg`)
                        fs.mkdirSync(path.join(__dirname, 'downloads'), { recursive: true })
                        fs.writeFileSync(inputPath, buffer)
                        await execAsync(
                            `ffmpeg -i "${inputPath}" -vf "scale=800:-1" "${outputPath}"`,
                            { timeout: 30000 }
                        )
                        fs.unlinkSync(inputPath)
                        const originalMB = (buffer.length / 1024 / 1024).toFixed(2)
                        const resizedMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)
                        await sock.sendMessage(sender, {
                            image: fs.readFileSync(outputPath),
                            caption: `✅ Resized: ${originalMB}MB → ${resizedMB}MB (max width: 800px)`
                        })
                        fs.unlinkSync(outputPath)
                    } catch (err) {
                        await sock.sendMessage(sender, { text: `❌ Resize failed: ${err.message}` })
                    }
                    continue
                }
            }

            // --- PDF SUMMARIZER ---
            if (runtimeSettings.isFeatureEnabled('mediaTools') && msg.message?.documentMessage) {
                const doc = msg.message.documentMessage
                const isPDF = doc.mimetype === 'application/pdf' || doc.fileName?.endsWith('.pdf')
                if (isPDF) {
                    console.log(`📄 PDF received from ${sender}`)
                    await runLimitedOperation(
                        'pdfSummary',
                        sock,
                        sender,
                        '⏳ Another PDF is being summarized. Try again when it finishes.',
                        async () => {
                            await sock.sendMessage(sender, { text: `📄 PDF received. Summarizing...` })
                            try {
                                const buffer = await downloadMediaMessage(msg, 'buffer', {})
                                const base64PDF = buffer.toString('base64')
                                const result = await callFlaskPost('/summarize-pdf', { pdf: base64PDF })
                                if (result.success) {
                                    const preview = result.result.length > 1000
                                        ? result.result.slice(0, 1000) + '...'
                                        : result.result
                                    await sock.sendMessage(sender, { text: `📄 *PDF Summary*\n\n${preview}` })
                                    sock.sendMessage(OWNER_JID, {
                                        text: `📄 *PDF Summary*\n*From:* ${msg.pushName || sender}\n*File:* ${doc.fileName || 'document.pdf'}\n\n${preview}`
                                    }).catch(() => {})
                                } else {
                                    await sock.sendMessage(sender, { text: `❌ ${result.result}` })
                                }
                            } catch (err) {
                                console.error('PDF error:', err.message)
                                await sock.sendMessage(sender, { text: `❌ PDF processing failed: ${err.message}` })
                            }
                        }
                    )
                    continue
                }
            }

            // --- IMAGE ANALYSIS / STICKER ---
            if (runtimeSettings.isFeatureEnabled('mediaTools') && msgType === 'imageMessage' && (text?.startsWith('/analyze') || text?.startsWith('/describe') || text?.trim().toLowerCase() === '/sticker')) {
                console.log(`🖼️ Image from ${sender}`)
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {})
                    const imgCaption = msg.message.imageMessage.caption || ''
                    if (imgCaption.trim().toLowerCase() === '/sticker') {
                        const downloadsDir = path.join(__dirname, 'downloads')
                        fs.mkdirSync(downloadsDir, { recursive: true })
                        const inputPath = path.join(downloadsDir, `sticker_${Date.now()}.jpg`)
                        const stickerPath = path.join(downloadsDir, `sticker_${Date.now()}.webp`)
                        fs.writeFileSync(inputPath, buffer)
                        try {
                            await execAsync(`ffmpeg -y -i "${inputPath}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0" "${stickerPath}"`, {
                                timeout: 30000
                            })
                            if (fs.existsSync(stickerPath)) {
                                await sock.sendMessage(sender, {
                                    sticker: fs.readFileSync(stickerPath)
                                })
                                console.log('✓ Sticker sent')
                            } else {
                                await sock.sendMessage(sender, { text: '❌ Sticker conversion failed.' })
                            }
                        } catch (err) {
                            console.error('Sticker error:', err.message)
                            await sock.sendMessage(sender, { text: '❌ Sticker conversion failed.' })
                        } finally {
                            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath)
                            if (fs.existsSync(stickerPath)) fs.unlinkSync(stickerPath)
                        }
                        continue
                    }
                    await runLimitedOperation(
                        'imageAnalysis',
                        sock,
                        sender,
                        '⏳ Another image is being analyzed. Try again when it finishes.',
                        async () => {
                            const base64Image = buffer.toString('base64')
                            const caption = msg.message.imageMessage.caption || ''
                            const result = await callFlaskPost('/analyze-image', {
                                image: base64Image,
                                prompt: caption || 'Describe what you see in this image. Extract any text visible.'
                            })
                            console.log('Image analysis result:', JSON.stringify(result))
                            if (result.success) {
                                const preview = result.result.length > 1000
                                    ? result.result.slice(0, 1000) + '...'
                                    : result.result
                                sock.sendMessage(sender, {
                                    text: `🖼️ *Image Analysis*\n\n${preview}`
                                }).catch(err => console.error('Send to sender error:', err.message))
                                sock.sendMessage(OWNER_JID, {
                                    text: `🖼️ *Image Analysis*\n*From:* ${msg.pushName || sender}\n\n${preview}`
                                }).catch(err => console.error('Send to owner error:', err.message))
                            } else {
                                console.error('Image analysis returned false success:', result)
                            }
                        }
                    )
                } catch (err) {
                    console.error('Image analysis error:', err.message)
                }
                continue
            }

            if (!text) continue

            console.log(`\nFrom: ${sender}`)
            console.log(`Message: ${text}`)

            // --- COMMAND HANDLER ---
            if (isCommand) {
                if (isOwner) {
                    await handleCommand(sock, sender, text, commandActorJid)
                } else {
                    await sock.sendMessage(OWNER_JID, {
                        text: `⚠️ *Intruder Alert*\n*Number:* ${senderNumber}\n*Command:* ${text}\n*Time:* ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}`
                    })
                    await sock.sendMessage(sender, { text: `❌ You are not authorized to use commands.` })
                }
                continue
            }

            // --- LOCK CHECK ---
            try {
                const lockCheck = await callFlaskPost('/contact-lock', { phone: senderNumber, action: 'check' })
                if (lockCheck.locked) { console.log(`Ignored locked: ${senderNumber}`); continue }
            } catch (err) { console.error('Lock check error:', err.message) }

            // --- UNKNOWN NUMBER ALERT ---
            // Disabled: this was too noisy for normal bot usage.
            // try {
            //     const contactCheck = await callFlaskPost('/contact-lock', { phone: senderNumber, action: 'check_contact' })
            //     if (!contactCheck.known) {
            //         await sock.sendMessage(OWNER_JID, {
            //             text: `👤 *Unknown Number*\n*Number:* ${senderNumber}\n*Message:* ${text}\n*Time:* ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}\n\n/lock ${senderNumber} to ignore.`
            //         })
            //     }
            // } catch (err) { console.error('Contact check error:', err.message) }

            // --- NORMAL AI FLOW ---
            if (!runtimeSettings.isFeatureEnabled('aiReplies')) {
                activityLog.add('ai_reply_skipped', { jid: sender, reason: 'disabled' })
                continue
            }
            console.log('Calling Flask...')
            try {
                const response = await callFlask(sender, text)
                saveDraft(sender, text, response.result)
            } catch (err) { console.error('Flask error:', err.message) }
        }
    })
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(payload))
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => {
            body += chunk
            if (Buffer.byteLength(body) > 32 * 1024) {
                reject(new Error('Request body is too large.'))
                req.destroy()
            }
        })
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {})
            } catch {
                reject(new Error('Request body must be valid JSON.'))
            }
        })
        req.on('error', reject)
    })
}

function isAuthorizedControlRequest(req) {
    const supplied = req.headers['x-joebot-control']
    if (typeof supplied !== 'string') return false
    const suppliedBuffer = Buffer.from(supplied)
    const expectedBuffer = Buffer.from(JOEBOT_CONTROL_TOKEN)
    if (suppliedBuffer.length !== expectedBuffer.length) return false
    return crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
}

function normalizeSendTarget(rawTarget) {
    const value = String(rawTarget || '').trim()
    if (value === 'status@broadcast' || value.endsWith('@g.us') || value.endsWith('@s.whatsapp.net') || value.endsWith('@lid')) {
        return value
    }
    const number = value.replace(/\D/g, '')
    if (!/^\d{8,15}$/.test(number)) throw new Error('Enter one phone number with country code or a valid WhatsApp JID.')
    return `${number}@s.whatsapp.net`
}

async function sendTextMessage(to, message) {
    if (!activeSock || connectionState !== 'connected') throw new Error('WhatsApp is not connected.')
    const text = String(message || '').trim()
    if (!text) throw new Error('Message is required.')
    if (text.length > 4000) throw new Error('Message must be 4000 characters or fewer.')
    const target = normalizeSendTarget(to)
    if (IGNORED_GROUPS.has(target)) return { success: true, skipped: true, to: target }
    if (target === 'status@broadcast') {
        await activeSock.sendMessage(target, { text }, { statusJidList: [activeSock.user.id] })
    } else {
        await activeSock.sendMessage(target, { text })
    }
    activityLog.add('message_sent', { jid: target, source: 'dashboard' })
    console.log(`✓ Sent dashboard message to ${target}`)
    return { success: true, to: target }
}

// Loopback control and send server used by Flask.
const sendServer = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1')

        if (req.method === 'POST' && url.pathname === '/send') {
            const body = await readJsonBody(req)
            sendJson(res, 200, await sendTextMessage(body.to, body.message))
            return
        }

        if (!url.pathname.startsWith('/control/')) {
            sendJson(res, 404, { success: false, error: 'Not found.' })
            return
        }
        if (!isAuthorizedControlRequest(req)) {
            sendJson(res, 401, { success: false, error: 'Unauthorized.' })
            return
        }

        if (req.method === 'GET' && url.pathname === '/control/state') {
            sendJson(res, 200, getRuntimeState())
            return
        }
        if (req.method === 'GET' && url.pathname === '/control/logs') {
            sendJson(res, 200, { entries: activityLog.recent(url.searchParams.get('limit')) })
            return
        }
        if (req.method === 'GET' && url.pathname === '/control/chats') {
            sendJson(res, 200, { chats: getRecentChats(url.searchParams.get('limit')) })
            return
        }
        if (req.method === 'GET' && url.pathname === '/control/messages') {
            const jid = url.searchParams.get('jid')
            if (!jid) {
                sendJson(res, 400, { success: false, error: 'jid is required.' })
                return
            }
            sendJson(res, 200, { jid, messages: getRecentMessages(jid, url.searchParams.get('limit')) })
            return
        }
        if (req.method === 'POST' && url.pathname === '/control/bot/start') {
            await startWhatsApp()
            sendJson(res, 200, getRuntimeState())
            return
        }
        if (req.method === 'POST' && url.pathname === '/control/bot/stop') {
            await stopWhatsApp()
            sendJson(res, 200, getRuntimeState())
            return
        }
        if (req.method === 'POST' && url.pathname === '/control/send') {
            const body = await readJsonBody(req)
            sendJson(res, 200, await sendTextMessage(body.to, body.message))
            return
        }
        if (req.method === 'PUT' && url.pathname === '/control/command') {
            const body = await readJsonBody(req)
            runtimeSettings.setCommand(body.command, body.enabled === true)
            activityLog.add('setting_changed', { setting: body.command, enabled: body.enabled === true })
            sendJson(res, 200, { settings: runtimeSettings.snapshot() })
            return
        }
        if (req.method === 'PUT' && url.pathname === '/control/feature') {
            const body = await readJsonBody(req)
            runtimeSettings.setFeature(body.feature, body.enabled === true)
            activityLog.add('setting_changed', { setting: body.feature, enabled: body.enabled === true })
            sendJson(res, 200, { settings: runtimeSettings.snapshot() })
            return
        }

        sendJson(res, 404, { success: false, error: 'Control route not found.' })
    } catch (err) {
        console.error('Control server error:', err.message)
        sendJson(res, /required|valid|Unknown|4000|phone number/i.test(err.message) ? 400 : 500, {
            success: false,
            error: err.message
        })
    }
})

const SEND_SERVER_HOST = process.env.SEND_SERVER_HOST || '127.0.0.1'
const SEND_SERVER_PORT = Number(process.env.SEND_SERVER_PORT || 5001)
sendServer.listen(SEND_SERVER_PORT, SEND_SERVER_HOST, () => console.log(`Control server listening on ${SEND_SERVER_HOST}:${SEND_SERVER_PORT}`))
if (desiredRunning) startWhatsApp().catch(err => console.error('Initial WhatsApp connection error:', err.message))
