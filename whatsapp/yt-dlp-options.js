'use strict'

const DEFAULT_PROXY_DOMAINS = ['youtube.com', 'youtu.be']

function parseProxyDomains(value = '') {
    const domains = String(value)
        .split(',')
        .map(domain => domain.trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
        .filter(Boolean)
    return domains.length > 0 ? [...new Set(domains)] : DEFAULT_PROXY_DOMAINS
}

function isProxiedYtDlpInput(input, proxyDomains = DEFAULT_PROXY_DOMAINS) {
    const value = String(input || '').trim()
    if (/^ytsearch\d*:/i.test(value)) return true

    let hostname
    try {
        hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '')
    } catch {
        return false
    }

    return proxyDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

function getYtDlpProxyArgs(input, proxyUrl, proxyDomains = DEFAULT_PROXY_DOMAINS) {
    if (!proxyUrl || !isProxiedYtDlpInput(input, proxyDomains)) return []
    return ['--proxy', proxyUrl]
}

function redactYtDlpSecrets(value) {
    return String(value || '')
        .replace(/(--proxy(?:=|\s+))\S+/gi, '$1[redacted]')
        .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1***:***@')
}

function safeYtDlpErrorDetails(error) {
    return redactYtDlpSecrets(error?.stderr || error?.stdout || error?.message || '')
}

module.exports = {
    DEFAULT_PROXY_DOMAINS,
    getYtDlpProxyArgs,
    isProxiedYtDlpInput,
    parseProxyDomains,
    redactYtDlpSecrets,
    safeYtDlpErrorDetails
}
