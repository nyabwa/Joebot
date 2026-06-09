'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const {
    cleanActivityLog,
    cleanByAge,
    cleanByCeiling,
    getFilesWithStats,
    removeEmptyDirectories,
    rotatePM2Logs
} = require('./cleanup')

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'joebot-cleanup-'))
}

function writeFile(filePath, size, mtimeMs = Date.now()) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.alloc(size, 'x'))
    const timestamp = new Date(mtimeMs)
    fs.utimesSync(filePath, timestamp, timestamp)
}

test('age cleanup traverses nested status directories and removes empty folders', () => {
    const dir = tempDir()
    const now = Date.now()
    const oldFile = path.join(dir, 'contact@lid', 'old.jpg')
    const newFile = path.join(dir, 'contact@lid', 'new.jpg')
    writeFile(oldFile, 10, now - 25 * 60 * 60 * 1000)
    writeFile(newFile, 10, now - 60 * 60 * 1000)

    const result = cleanByAge(dir, 24 * 60 * 60 * 1000, now)

    assert.equal(result.deleted, 1)
    assert.equal(fs.existsSync(oldFile), false)
    assert.equal(fs.existsSync(newFile), true)
    assert.equal(getFilesWithStats(dir).length, 1)

    fs.unlinkSync(newFile)
    assert.equal(removeEmptyDirectories(dir), 1)
})

test('ceiling cleanup removes oldest files first', () => {
    const dir = tempDir()
    const now = Date.now()
    const oldest = path.join(dir, 'oldest.bin')
    const middle = path.join(dir, 'middle.bin')
    const newest = path.join(dir, 'newest.bin')
    writeFile(oldest, 10, now - 3000)
    writeFile(middle, 10, now - 2000)
    writeFile(newest, 10, now - 1000)

    const result = cleanByCeiling(dir, 20)

    assert.equal(result.deleted, 1)
    assert.equal(fs.existsSync(oldest), false)
    assert.equal(fs.existsSync(middle), true)
    assert.equal(fs.existsSync(newest), true)
})

test('activity cleanup applies age and size retention on every run', () => {
    const dir = tempDir()
    const logPath = path.join(dir, 'activity.jsonl')
    const now = Date.now()
    const lines = [
        JSON.stringify({ timestamp: new Date(now - 31 * 86400000).toISOString(), type: 'old' }),
        JSON.stringify({ timestamp: new Date(now - 1000).toISOString(), type: 'new-one' }),
        JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'new-two' }),
        'invalid-json'
    ]
    fs.writeFileSync(logPath, `${lines.join('\n')}\n`)

    const result = cleanActivityLog(logPath, { maxAgeMs: 30 * 86400000, maxBytes: 100 }, now)
    const kept = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)

    assert.equal(result.before, 4)
    assert.equal(result.after, 1)
    assert.deepEqual(kept.map(entry => entry.type), ['new-two'])
})

test('PM2 log rotation keeps only the configured tail', () => {
    const dir = tempDir()
    const logPath = path.join(dir, 'app.log')
    fs.writeFileSync(logPath, '0123456789')

    const results = rotatePM2Logs(dir, { maxBytes: 8, keepBytes: 4 })

    assert.equal(results.length, 1)
    assert.equal(fs.readFileSync(logPath, 'utf8'), '6789')
})
