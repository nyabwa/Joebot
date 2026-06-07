const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info")

    const sock = makeWASocket({
        auth: state
    })

    sock.ev.on("connection.update", (update) => {
        const { qr, connection } = update

        if (qr) {
            console.log("Scan this QR code:")
            qrcode.generate(qr, { small: true })
        }

        if (connection === "open") {
            console.log("WhatsApp connected!")
        }
    })

    sock.ev.on("creds.update", saveCreds)
}

startBot()
