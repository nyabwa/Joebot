'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
    getYtDlpProxyArgs,
    isProxiedYtDlpInput,
    parseProxyDomains,
    redactYtDlpSecrets,
    safeYtDlpErrorDetails
} = require('./yt-dlp-options')

test('proxy routing defaults to YouTube URLs and searches', () => {
    assert.equal(isProxiedYtDlpInput('https://www.youtube.com/watch?v=abc'), true)
    assert.equal(isProxiedYtDlpInput('https://music.youtube.com/watch?v=abc'), true)
    assert.equal(isProxiedYtDlpInput('https://youtu.be/abc'), true)
    assert.equal(isProxiedYtDlpInput('ytsearch1:artist song'), true)
    assert.equal(isProxiedYtDlpInput('https://vt.tiktok.com/example/'), false)
    assert.equal(isProxiedYtDlpInput('https://www.instagram.com/reel/example/'), false)
})

test('proxy arguments are added only for configured domains', () => {
    const proxyUrl = 'http://user:password@proxy.example:10001'
    const domains = parseProxyDomains('youtube.com, youtu.be, example.org')

    assert.deepEqual(
        getYtDlpProxyArgs('https://video.example.org/watch/1', proxyUrl, domains),
        ['--proxy', proxyUrl]
    )
    assert.deepEqual(
        getYtDlpProxyArgs('https://vt.tiktok.com/example/', proxyUrl, domains),
        []
    )
})

test('yt-dlp errors redact proxy credentials and command arguments', () => {
    const command = 'Command failed: yt-dlp --proxy http://user:password@proxy.example:10001 https://example.com'
    const redacted = redactYtDlpSecrets(command)

    assert.equal(redacted.includes('user'), false)
    assert.equal(redacted.includes('password'), false)
    assert.match(redacted, /--proxy \[redacted\]/)
    assert.equal(safeYtDlpErrorDetails({ message: command }), redacted)
})
