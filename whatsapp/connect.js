const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const path = require('path')

const AUTH_DIR = path.join(__dirname, 'auth_info')
const RESET_AUTH = process.argv.includes('--reset-auth')
let didResetAuth = false

function resetAuthSession(reason) {
    if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    }
    console.log(`Reset WhatsApp auth session (${reason}): ${AUTH_DIR}`)
}

async function connectToWhatsApp() {
    if (RESET_AUTH && !didResetAuth) {
        resetAuthSession('--reset-auth')
        didResetAuth = true
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('\nScan this QR code with your SECONDARY WhatsApp number:\n')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const errorMessage = lastDisconnect?.error?.message || 'Unknown disconnect'
            const wasLoggedOut = statusCode === DisconnectReason.loggedOut
            const shouldReconnect = !wasLoggedOut
            console.log(`Connection closed: ${errorMessage} (status: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`)
            if (wasLoggedOut) {
                resetAuthSession('WhatsApp rejected saved session')
                console.log('Starting fresh WhatsApp link. Scan the QR code when it appears.')
                setTimeout(connectToWhatsApp, 2000)
            } else if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 2000)
            }
        } else if (connection === 'open') {
            console.log('\n✓ WhatsApp connected successfully!')
            console.log('Secondary number is live and listening.')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe) return

        const sender = msg.key.remoteJid
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        if (!text) return

        console.log(`\nMessage from: ${sender}`)
        console.log(`Text: ${text}`)
        console.log('---')
    })
}

connectToWhatsApp()
