const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { ActivityLog, RuntimeSettings } = require('./control-state')

test('runtime settings persist command, feature, and bot changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joebot-control-'))
    const filePath = path.join(dir, 'settings.json')
    const settings = new RuntimeSettings(filePath)

    settings.setCommand('/song', false)
    settings.setFeature('antiDelete', false)
    settings.setBotEnabled(false)

    const restored = new RuntimeSettings(filePath)
    assert.equal(restored.isCommandEnabled('/song'), false)
    assert.equal(restored.isCommandEnabled('/help'), true)
    assert.equal(restored.isFeatureEnabled('antiDelete'), false)
    assert.equal(restored.snapshot().botEnabled, false)
})

test('activity log stays bounded and returns newest entries first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joebot-log-'))
    const log = new ActivityLog(path.join(dir, 'activity.jsonl'), 2)
    log.add('one')
    log.add('two')
    log.add('three')

    assert.deepEqual(log.recent().map(entry => entry.type), ['three', 'two'])
})

test('activity log compaction removes entries older than 30 days', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joebot-log-retention-'))
    const filePath = path.join(dir, 'activity.jsonl')
    fs.writeFileSync(filePath, [
        JSON.stringify({ timestamp: new Date(Date.now() - 31 * 86400000).toISOString(), type: 'old' }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'current' })
    ].join('\n') + '\n')

    const log = new ActivityLog(filePath)

    assert.deepEqual(log.recent().map(entry => entry.type), ['current'])
})
