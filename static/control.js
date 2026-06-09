const csrfToken = window.JOEBOT_CSRF
let selectedChat = null
let pollTimer = null
let toastTimer = null

const $ = selector => document.querySelector(selector)
const elements = {
  connectionState: $('#connectionState'),
  accountId: $('#accountId'),
  messageCount: $('#messageCount'),
  lastConnected: $('#lastConnected'),
  connectionError: $('#connectionError'),
  sideDot: $('#sideDot'),
  sideStatus: $('#sideStatus'),
  startButton: $('#startButton'),
  stopButton: $('#stopButton'),
  scanNotice: $('#scanNotice'),
  commandGrid: $('#commandGrid'),
  featureGrid: $('#featureGrid'),
  chatList: $('#chatList'),
  conversationHeader: $('#conversationHeader'),
  messageList: $('#messageList'),
  chatReplyForm: $('#chatReplyForm'),
  chatReply: $('#chatReply'),
  sendForm: $('#sendForm'),
  sendTo: $('#sendTo'),
  sendMessage: $('#sendMessage'),
  sendResult: $('#sendResult'),
  logList: $('#logList'),
  toast: $('#toast')
}

async function api(route, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.body) headers['Content-Type'] = 'application/json'
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrfToken
  const response = await fetch(`/control/api/${route}`, { credentials: 'same-origin', ...options, headers })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || `Request failed with HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return data
}

function toast(message, error = false) {
  clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.className = `toast show${error ? ' error' : ''}`
  toastTimer = setTimeout(() => { elements.toast.className = 'toast' }, 3000)
}

function handleError(error) {
  if (error.status === 401) {
    location.href = '/control/login'
    return
  }
  toast(error.message, true)
}

function renderState(state) {
  const status = String(state.connection || 'unknown').replaceAll('_', ' ')
  elements.connectionState.textContent = status
  elements.accountId.textContent = state.account || 'No account identifier'
  elements.messageCount.textContent = state.messagesInMemory || 0
  elements.lastConnected.textContent = state.lastConnectedAt ? new Date(state.lastConnectedAt).toLocaleString() : 'Never'
  elements.connectionError.textContent = state.lastError || 'No connection error'
  elements.sideDot.className = `dot ${state.connection || ''}`
  elements.sideStatus.textContent = `WhatsApp ${status}`
  elements.startButton.disabled = state.desiredRunning
  elements.stopButton.disabled = !state.desiredRunning
  const needsScan = state.connection === 'awaiting_scan' || state.connection === 'logged_out'
  elements.scanNotice.classList.toggle('hidden', !needsScan)
  elements.scanNotice.textContent = state.connection === 'logged_out'
    ? 'The session is logged out. Run npm run relink intentionally and scan the terminal QR code.'
    : 'Scan the QR code printed by the WhatsApp process.'
  renderToggles(elements.commandGrid, state.settings.commandDefinitions, state.settings.commands, 'command')
  renderToggles(elements.featureGrid, state.settings.featureDefinitions, state.settings.features, 'feature')
}

function renderToggles(container, definitions, values, type) {
  container.replaceChildren()
  for (const definition of definitions) {
    const card = document.createElement('article')
    card.className = 'toggle-card'
    const copy = document.createElement('div')
    const title = document.createElement('h3')
    title.textContent = definition.label
    const description = document.createElement('p')
    description.textContent = definition.description
    copy.append(title, description)

    const label = document.createElement('label')
    label.className = 'switch'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = values[definition.key] !== false
    input.setAttribute('aria-label', `Toggle ${definition.label}`)
    input.addEventListener('change', async () => {
      input.disabled = true
      try {
        await api(type, {
          method: 'PUT',
          body: JSON.stringify({ [type]: definition.key, enabled: input.checked })
        })
        toast(`${definition.label} ${input.checked ? 'enabled' : 'disabled'}`)
        await loadLogs()
      } catch (error) {
        input.checked = !input.checked
        handleError(error)
      } finally {
        input.disabled = false
      }
    })
    const track = document.createElement('span')
    label.append(input, track)
    card.append(copy, label)
    container.append(card)
  }
}

function chatDisplayName(chat) {
  if (chat.name && chat.name !== 'Unknown') return chat.name
  return chat.jid.split('@')[0]
}

function renderChats(chats) {
  elements.chatList.replaceChildren()
  if (!chats.length) {
    elements.chatList.innerHTML = '<div class="empty" style="padding:50px 20px">No recent chats in memory.</div>'
    return
  }
  for (const chat of chats) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `chat-item${selectedChat === chat.jid ? ' active' : ''}`
    const header = document.createElement('div')
    header.className = 'chat-name'
    const name = document.createElement('span')
    name.textContent = chatDisplayName(chat)
    const time = document.createElement('span')
    time.className = 'chat-time'
    time.textContent = new Date(chat.timestamp * 1000).toLocaleString()
    header.append(name, time)
    const preview = document.createElement('div')
    preview.className = 'chat-preview'
    preview.textContent = chat.preview || `[${chat.type}]`
    button.append(header, preview)
    button.addEventListener('click', async () => {
      selectedChat = chat.jid
      elements.conversationHeader.textContent = `${chatDisplayName(chat)} · ${chat.jid}`
      elements.chatReplyForm.classList.remove('hidden')
      renderChats(chats)
      try { await loadMessages(chat.jid) } catch (error) { handleError(error) }
    })
    elements.chatList.append(button)
  }
}

function renderMessages(messages) {
  elements.messageList.replaceChildren()
  if (!messages.length) {
    elements.messageList.innerHTML = '<div class="empty">No messages cached for this chat.</div>'
    return
  }
  for (const message of messages) {
    const bubble = document.createElement('div')
    bubble.className = `bubble${message.fromMe ? ' mine' : ''}`
    bubble.textContent = message.text || `[${message.type}${message.hasMedia ? ' media' : ''}]`
    const meta = document.createElement('span')
    meta.className = 'bubble-meta'
    meta.textContent = new Date(message.timestamp * 1000).toLocaleString()
    bubble.append(meta)
    elements.messageList.append(bubble)
  }
  elements.messageList.scrollTop = elements.messageList.scrollHeight
}

function renderLogs(entries) {
  elements.logList.replaceChildren()
  if (!entries.length) {
    elements.logList.innerHTML = '<div class="empty" style="padding:55px">No activity recorded.</div>'
    return
  }
  for (const entry of entries) {
    const row = document.createElement('div')
    row.className = 'log-row'
    const time = document.createElement('span')
    time.className = 'log-time'
    time.textContent = new Date(entry.timestamp).toLocaleString()
    const type = document.createElement('span')
    type.className = 'log-type'
    type.textContent = entry.type
    const details = document.createElement('span')
    details.className = 'log-detail'
    const detail = { ...entry }
    delete detail.timestamp
    delete detail.type
    details.textContent = Object.entries(detail).map(([key, value]) => `${key}=${value}`).join(' · ') || 'No details'
    row.append(time, type, details)
    elements.logList.append(row)
  }
}

async function loadState() {
  const state = await api('state')
  renderState(state)
}

async function loadChats() {
  const data = await api('chats?limit=100')
  renderChats(data.chats)
}

async function loadMessages(jid) {
  const data = await api(`messages?jid=${encodeURIComponent(jid)}&limit=150`)
  renderMessages(data.messages)
}

async function loadLogs() {
  const data = await api('logs?limit=150')
  renderLogs(data.entries)
}

async function refreshAll(quiet = false) {
  try {
    await Promise.all([loadState(), loadChats(), loadLogs()])
    if (selectedChat) await loadMessages(selectedChat)
  } catch (error) {
    if (!quiet) handleError(error)
  }
}

elements.startButton.addEventListener('click', async () => {
  try {
    await api('bot/start', { method: 'POST' })
    await refreshAll()
    toast('WhatsApp bot started')
  } catch (error) { handleError(error) }
})

elements.stopButton.addEventListener('click', async () => {
  try {
    await api('bot/stop', { method: 'POST' })
    await refreshAll()
    toast('WhatsApp bot stopped')
  } catch (error) { handleError(error) }
})

elements.sendForm.addEventListener('submit', async event => {
  event.preventDefault()
  elements.sendResult.textContent = ''
  try {
    const result = await api('send', {
      method: 'POST',
      body: JSON.stringify({ to: elements.sendTo.value, message: elements.sendMessage.value })
    })
    elements.sendResult.textContent = result.skipped ? 'Recipient is blocked by JoeBot.' : `Sent to ${result.to}`
    elements.sendMessage.value = ''
    await Promise.all([loadLogs(), loadChats()])
  } catch (error) {
    elements.sendResult.textContent = error.message
    handleError(error)
  }
})

elements.chatReplyForm.addEventListener('submit', async event => {
  event.preventDefault()
  if (!selectedChat || !elements.chatReply.value.trim()) return
  try {
    await api('send', {
      method: 'POST',
      body: JSON.stringify({ to: selectedChat, message: elements.chatReply.value })
    })
    elements.chatReply.value = ''
    toast('Message sent')
    await Promise.all([loadMessages(selectedChat), loadLogs()])
  } catch (error) { handleError(error) }
})

$('#refreshButton').addEventListener('click', async () => {
  await refreshAll()
  toast('Dashboard refreshed')
})

$('#logoutButton').addEventListener('click', async () => {
  try {
    const response = await fetch('/control/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      credentials: 'same-origin'
    })
    if (!response.ok) throw new Error('Sign out failed')
    location.href = '/control/login'
  } catch (error) { handleError(error) }
})

for (const link of document.querySelectorAll('.nav-link')) {
  link.addEventListener('click', () => {
    for (const item of document.querySelectorAll('.nav-link')) item.classList.toggle('active', item === link)
  })
}

refreshAll()
pollTimer = setInterval(() => refreshAll(true), 5000)
