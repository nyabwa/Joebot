'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { ConcurrencyLimiter, CooldownManager } = require('./rate-limits')

test('cooldowns are isolated by actor and command', () => {
    const cooldowns = new CooldownManager({ '/download': 30_000 })
    const now = 1_000_000

    assert.equal(cooldowns.consume('user-a', '/download', now).allowed, true)
    assert.deepEqual(cooldowns.consume('user-a', '/download', now + 10_000), {
        allowed: false,
        retryAfterMs: 20_000
    })
    assert.equal(cooldowns.consume('user-b', '/download', now + 10_000).allowed, true)
    assert.equal(cooldowns.consume('user-a', '/other', now + 10_000).allowed, true)
    assert.equal(cooldowns.consume('user-a', '/download', now + 30_000).allowed, true)
})

test('cooldown pruning removes stale actor-command entries', () => {
    const cooldowns = new CooldownManager({ '/download': 30_000 })
    cooldowns.consume('user-a', '/download', 1_000)

    assert.equal(cooldowns.prune(31_000), 0)
    assert.equal(cooldowns.prune(31_001), 1)
})

test('concurrency slots reject excess work and release exactly once', () => {
    const limiter = new ConcurrencyLimiter({ downloads: 1 })
    const release = limiter.tryAcquire('downloads')

    assert.equal(typeof release, 'function')
    assert.equal(limiter.activeCount('downloads'), 1)
    assert.equal(limiter.tryAcquire('downloads'), null)

    release()
    release()
    assert.equal(limiter.activeCount('downloads'), 0)
    assert.equal(typeof limiter.tryAcquire('downloads'), 'function')
})
