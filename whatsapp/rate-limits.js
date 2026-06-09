'use strict'

const COMMAND_COOLDOWNS_MS = {
    '/download': 30_000,
    '/mp3': 30_000,
    '/song': 30_000,
    '/summarize': 60_000,
    '/username': 60_000,
    '/email': 30_000,
    '/breach': 30_000,
    '/phone': 30_000
}

const OPERATION_LIMITS = {
    downloads: 1,
    sherlock: 1,
    imageAnalysis: 1,
    transcription: 1,
    pdfSummary: 1
}

class CooldownManager {
    constructor(cooldowns = COMMAND_COOLDOWNS_MS) {
        this.cooldowns = { ...cooldowns }
        this.lastUsed = new Map()
    }

    consume(actor, command, now = Date.now()) {
        const durationMs = this.cooldowns[command] || 0
        if (durationMs <= 0) return { allowed: true, retryAfterMs: 0 }

        const key = `${actor}:${command}`
        const previous = this.lastUsed.get(key)
        if (previous !== undefined) {
            const retryAfterMs = durationMs - (now - previous)
            if (retryAfterMs > 0) return { allowed: false, retryAfterMs }
        }

        this.lastUsed.set(key, now)
        return { allowed: true, retryAfterMs: 0 }
    }

    prune(now = Date.now()) {
        const maxCooldown = Math.max(0, ...Object.values(this.cooldowns))
        let removed = 0
        for (const [key, lastUsedAt] of this.lastUsed.entries()) {
            if (now - lastUsedAt <= maxCooldown) continue
            this.lastUsed.delete(key)
            removed += 1
        }
        return removed
    }
}

class ConcurrencyLimiter {
    constructor(limits = OPERATION_LIMITS) {
        this.limits = { ...limits }
        this.active = new Map()
    }

    tryAcquire(name) {
        const limit = this.limits[name]
        if (!Number.isInteger(limit) || limit < 1) {
            throw new Error(`Unknown concurrency limit: ${name}`)
        }

        const current = this.active.get(name) || 0
        if (current >= limit) return null

        this.active.set(name, current + 1)
        let released = false
        return () => {
            if (released) return
            released = true
            const remaining = Math.max(0, (this.active.get(name) || 1) - 1)
            if (remaining === 0) this.active.delete(name)
            else this.active.set(name, remaining)
        }
    }

    activeCount(name) {
        return this.active.get(name) || 0
    }
}

module.exports = {
    COMMAND_COOLDOWNS_MS,
    OPERATION_LIMITS,
    ConcurrencyLimiter,
    CooldownManager
}
