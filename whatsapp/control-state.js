const fs = require('fs')
const path = require('path')
const { cleanActivityLog, DEFAULT_POLICY } = require('./cleanup')

const COMMANDS = [
    '/help', '/date', '/getdp', '/savestatus', '/download', '/mp3', '/song',
    '/lookup', '/lock', '/unlock', '/weather', '/ipinfo', '/numinfo', '/myip',
    '/remind', '/note', '/notes', '/clearnotes', '/calc', '/translate', '/reply',
    '/broadcast', '/lastmsg', '/online', '/wiki', '/fact', '/quiz', '/diagnose',
    '/news', '/forex', '/fuel', '/todo', '/todos', '/done', '/qr', '/pdf',
    '/block', '/prayer', '/motivate', '/schedule', '/summarize', '/sticker',
    '/email', '/breach', '/username', '/phone', '/exif'
]

const FEATURES = [
    { key: 'aiReplies', label: 'AI reply drafting', description: 'Create review drafts for normal incoming messages.' },
    { key: 'antiDelete', label: 'Anti-delete', description: 'Cache messages and notify the owner when they are deleted.' },
    { key: 'viewOnce', label: 'View-once capture', description: 'Save and forward view-once images and videos.' },
    { key: 'statusSaver', label: 'Status saver', description: 'Automatically save received WhatsApp statuses.' },
    { key: 'voiceTranscription', label: 'Voice transcription', description: 'Transcribe incoming voice notes through Flask.' },
    { key: 'mediaTools', label: 'Media tools', description: 'Allow compression, resize, sticker, PDF, and image analysis flows.' }
]

const DEFAULT_SETTINGS = {
    botEnabled: true,
    commands: Object.fromEntries(COMMANDS.map(command => [command, true])),
    features: Object.fromEntries(FEATURES.map(feature => [feature.key, true]))
}

function atomicWriteJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tempPath, filePath)
}

class RuntimeSettings {
    constructor(filePath) {
        this.filePath = filePath
        this.state = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
        this.load()
    }

    load() {
        if (!fs.existsSync(this.filePath)) return
        try {
            const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
            this.state = {
                botEnabled: saved.botEnabled !== false,
                commands: { ...DEFAULT_SETTINGS.commands, ...(saved.commands || {}) },
                features: { ...DEFAULT_SETTINGS.features, ...(saved.features || {}) }
            }
        } catch (err) {
            console.error('Control settings load error:', err.message)
        }
    }

    save() {
        atomicWriteJson(this.filePath, this.state)
    }

    snapshot() {
        return {
            botEnabled: this.state.botEnabled,
            commands: { ...this.state.commands },
            features: { ...this.state.features },
            commandDefinitions: COMMANDS.map(command => ({
                key: command,
                label: command.slice(1),
                description: `Allow the ${command} WhatsApp command.`
            })),
            featureDefinitions: FEATURES.map(feature => ({ ...feature }))
        }
    }

    isCommandEnabled(command) {
        return this.state.commands[String(command || '').toLowerCase()] !== false
    }

    isFeatureEnabled(feature) {
        return this.state.features[feature] !== false
    }

    setBotEnabled(enabled) {
        this.state.botEnabled = Boolean(enabled)
        this.save()
    }

    setCommand(command, enabled) {
        const key = String(command || '').toLowerCase()
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS.commands, key)) {
            throw new Error(`Unknown command: ${command}`)
        }
        this.state.commands[key] = Boolean(enabled)
        this.save()
    }

    setFeature(feature, enabled) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS.features, feature)) {
            throw new Error(`Unknown feature: ${feature}`)
        }
        this.state.features[feature] = Boolean(enabled)
        this.save()
    }
}

class ActivityLog {
    constructor(filePath, maxEntries = 500) {
        this.filePath = filePath
        this.maxEntries = maxEntries
        this.entries = []
        this.compact()
        this.load()
        this.compactionTimer = setInterval(() => this.compact(), 60 * 60 * 1000)
        if (typeof this.compactionTimer.unref === 'function') this.compactionTimer.unref()
    }

    load() {
        if (!fs.existsSync(this.filePath)) return
        try {
            const lines = fs.readFileSync(this.filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
            this.entries = lines.slice(-this.maxEntries).flatMap(line => {
                try {
                    return [JSON.parse(line)]
                } catch {
                    return []
                }
            })
        } catch (err) {
            console.error('Activity log load error:', err.message)
        }
    }

    add(type, details = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            type,
            ...details
        }
        this.entries.push(entry)
        if (this.entries.length > this.maxEntries) this.entries.shift()
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
        return entry
    }

    compact() {
        return cleanActivityLog(this.filePath, DEFAULT_POLICY.activity)
    }

    recent(limit = 100) {
        const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 300)
        return this.entries.slice(-safeLimit).reverse()
    }
}

module.exports = {
    ActivityLog,
    COMMANDS,
    DEFAULT_SETTINGS,
    FEATURES,
    RuntimeSettings,
    atomicWriteJson
}
