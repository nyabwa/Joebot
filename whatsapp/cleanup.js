#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const BASE = path.resolve(__dirname)
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const DEFAULT_POLICY = {
    directories: {
        saved_statuses: { maxAgeMs: DAY_MS, maxBytes: 200 * 1024 * 1024 },
        anti_delete_cache: { maxAgeMs: DAY_MS, maxBytes: 100 * 1024 * 1024 },
        view_once: { maxAgeMs: DAY_MS },
        downloads: { maxAgeMs: 2 * HOUR_MS, maxBytes: 50 * 1024 * 1024 }
    },
    activity: {
        maxAgeMs: 30 * DAY_MS,
        maxBytes: 20 * 1024 * 1024
    },
    pm2Logs: {
        maxBytes: 10 * 1024 * 1024,
        keepBytes: 5 * 1024 * 1024
    }
}

function formatMegabytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(1)
}

function getFilesWithStats(rootDir) {
    if (!fs.existsSync(rootDir)) return []

    const files = []
    const pending = [rootDir]
    while (pending.length > 0) {
        const currentDir = pending.pop()
        let entries
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true })
        } catch (err) {
            console.error(`[cleanup] Could not read ${currentDir}: ${err.message}`)
            continue
        }

        for (const entry of entries) {
            const filePath = path.join(currentDir, entry.name)
            try {
                if (entry.isDirectory()) {
                    pending.push(filePath)
                    continue
                }
                if (!entry.isFile()) continue
                const stat = fs.statSync(filePath)
                files.push({
                    name: entry.name,
                    filePath,
                    mtime: stat.mtimeMs,
                    size: stat.size
                })
            } catch (err) {
                console.error(`[cleanup] Could not inspect ${filePath}: ${err.message}`)
            }
        }
    }
    return files
}

function deleteFiles(files, shouldDelete) {
    let deleted = 0
    let freedBytes = 0

    for (const file of files) {
        if (!shouldDelete(file)) continue
        try {
            fs.unlinkSync(file.filePath)
            deleted += 1
            freedBytes += file.size
        } catch (err) {
            console.error(`[cleanup] Could not delete ${file.filePath}: ${err.message}`)
        }
    }
    return { deleted, freedBytes }
}

function cleanByAge(dir, maxAgeMs, now = Date.now()) {
    return deleteFiles(getFilesWithStats(dir), file => now - file.mtime > maxAgeMs)
}

function cleanByCeiling(dir, maxBytes) {
    const files = getFilesWithStats(dir).sort((a, b) => a.mtime - b.mtime)
    let currentSize = files.reduce((sum, file) => sum + file.size, 0)
    if (currentSize <= maxBytes) return { deleted: 0, freedBytes: 0 }

    let deleted = 0
    let freedBytes = 0
    for (const file of files) {
        if (currentSize <= maxBytes) break
        try {
            fs.unlinkSync(file.filePath)
            currentSize -= file.size
            freedBytes += file.size
            deleted += 1
        } catch (err) {
            console.error(`[cleanup] Could not delete ${file.filePath}: ${err.message}`)
        }
    }
    return { deleted, freedBytes }
}

function removeEmptyDirectories(rootDir) {
    if (!fs.existsSync(rootDir)) return 0
    let removed = 0

    function walk(dir) {
        let entries
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.isDirectory()) walk(path.join(dir, entry.name))
        }
        if (dir === rootDir) return
        try {
            if (fs.readdirSync(dir).length === 0) {
                fs.rmdirSync(dir)
                removed += 1
            }
        } catch {
            // A concurrent writer may have added a file; leave the directory in place.
        }
    }

    walk(rootDir)
    return removed
}

function rotatePM2Logs(logDir, policy = DEFAULT_POLICY.pm2Logs) {
    const results = []
    for (const file of getFilesWithStats(logDir)) {
        if (!file.name.endsWith('.log') || file.size <= policy.maxBytes) continue
        try {
            const keepBytes = Math.min(policy.keepBytes, file.size)
            const buffer = Buffer.alloc(keepBytes)
            const fd = fs.openSync(file.filePath, 'r')
            try {
                fs.readSync(fd, buffer, 0, keepBytes, file.size - keepBytes)
            } finally {
                fs.closeSync(fd)
            }
            fs.writeFileSync(file.filePath, buffer)
            results.push({
                file: file.name,
                beforeBytes: file.size,
                afterBytes: keepBytes
            })
        } catch (err) {
            console.error(`[cleanup] Could not rotate ${file.filePath}: ${err.message}`)
        }
    }
    return results
}

function cleanActivityLog(logPath, policy = DEFAULT_POLICY.activity, now = Date.now()) {
    if (!fs.existsSync(logPath)) return { before: 0, after: 0, removed: 0 }

    try {
        const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
        const cutoff = now - policy.maxAgeMs
        const keptByAge = lines.filter(line => {
            try {
                const entry = JSON.parse(line)
                const timestamp = Date.parse(entry.timestamp || entry.time || '')
                return Number.isFinite(timestamp) && timestamp > cutoff
            } catch {
                return false
            }
        })

        const newestFirst = [...keptByAge].reverse()
        const boundedNewestFirst = []
        let bytes = 0
        for (const line of newestFirst) {
            const lineBytes = Buffer.byteLength(line) + 1
            if (bytes + lineBytes > policy.maxBytes) break
            boundedNewestFirst.push(line)
            bytes += lineBytes
        }
        const kept = boundedNewestFirst.reverse()
        if (kept.length !== lines.length) {
            const tempPath = `${logPath}.${process.pid}.tmp`
            fs.writeFileSync(tempPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', { mode: 0o600 })
            fs.renameSync(tempPath, logPath)
        }
        return {
            before: lines.length,
            after: kept.length,
            removed: lines.length - kept.length
        }
    } catch (err) {
        console.error(`[cleanup] Activity log cleanup error: ${err.message}`)
        return { before: 0, after: 0, removed: 0, error: err.message }
    }
}

function logDirectoryResult(label, ageResult, ceilingResult, emptyDirectories) {
    const deleted = ageResult.deleted + ceilingResult.deleted
    const freedBytes = ageResult.freedBytes + ceilingResult.freedBytes
    console.log(
        `[cleanup] ${label}: deleted ${deleted} files, freed ${formatMegabytes(freedBytes)}MB` +
        (emptyDirectories > 0 ? `, removed ${emptyDirectories} empty directories` : '')
    )
}

function runCleanup(options = {}) {
    const baseDir = options.baseDir || BASE
    const homeDir = options.homeDir || process.env.HOME || '/home/ubuntu'
    const policy = options.policy || DEFAULT_POLICY
    const now = options.now ?? Date.now()
    const includeActiveLogs = options.includeActiveLogs === true
    const pm2LogDir = options.pm2LogDir || path.join(homeDir, '.pm2', 'logs')
    const activityLogPath = options.activityLogPath || path.join(baseDir, 'data', 'activity.jsonl')

    console.log(`[cleanup] Starting at ${new Date(now).toISOString()}`)
    for (const [dirName, retention] of Object.entries(policy.directories)) {
        const dir = path.join(baseDir, dirName)
        const ageResult = retention.maxAgeMs
            ? cleanByAge(dir, retention.maxAgeMs, now)
            : { deleted: 0, freedBytes: 0 }
        const ceilingResult = retention.maxBytes
            ? cleanByCeiling(dir, retention.maxBytes)
            : { deleted: 0, freedBytes: 0 }
        const emptyDirectories = removeEmptyDirectories(dir)
        logDirectoryResult(dirName, ageResult, ceilingResult, emptyDirectories)
    }

    if (includeActiveLogs) {
        for (const result of rotatePM2Logs(pm2LogDir, policy.pm2Logs)) {
            console.log(
                `[cleanup] Rotated PM2 log ${result.file}: ` +
                `${formatMegabytes(result.beforeBytes)}MB -> ${formatMegabytes(result.afterBytes)}MB`
            )
        }
        const activityResult = cleanActivityLog(activityLogPath, policy.activity, now)
        console.log(
            `[cleanup] Activity log: ${activityResult.before} -> ${activityResult.after} entries`
        )
    }
    console.log(`[cleanup] Done at ${new Date().toISOString()}`)
}

if (require.main === module) runCleanup()

module.exports = {
    DEFAULT_POLICY,
    cleanActivityLog,
    cleanByAge,
    cleanByCeiling,
    getFilesWithStats,
    removeEmptyDirectories,
    rotatePM2Logs,
    runCleanup
}
