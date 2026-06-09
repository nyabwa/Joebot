(() => {
  'use strict'

  const storageKey = 'joebot-control-theme'
  const defaultTheme = 'truecaller-blue'
  const supportedThemes = new Set(['light', 'truecaller-blue'])

  function readTheme() {
    try {
      const storedTheme = window.localStorage.getItem(storageKey)
      return supportedThemes.has(storedTheme) ? storedTheme : defaultTheme
    } catch {
      return defaultTheme
    }
  }

  function updateControls(theme) {
    for (const button of document.querySelectorAll('[data-theme-value]')) {
      const selected = button.dataset.themeValue === theme
      button.classList.toggle('active', selected)
      button.setAttribute('aria-pressed', String(selected))
    }
  }

  function applyTheme(theme, persist = true) {
    const nextTheme = supportedThemes.has(theme) ? theme : defaultTheme
    const isLight = nextTheme === 'light'

    document.documentElement.dataset.theme = nextTheme
    document.documentElement.style.colorScheme = isLight ? 'light' : 'dark'

    const themeColor = document.querySelector('meta[name="theme-color"]')
    if (themeColor) themeColor.content = isLight ? '#f4f7fb' : '#06182e'

    if (persist) {
      try {
        window.localStorage.setItem(storageKey, nextTheme)
      } catch {
        // Theme still applies when browser storage is unavailable.
      }
    }

    updateControls(nextTheme)
  }

  function bindThemeControls() {
    updateControls(document.documentElement.dataset.theme || defaultTheme)
    for (const button of document.querySelectorAll('[data-theme-value]')) {
      button.addEventListener('click', () => applyTheme(button.dataset.themeValue))
    }
  }

  applyTheme(readTheme(), false)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindThemeControls, { once: true })
  } else {
    bindThemeControls()
  }
})()
