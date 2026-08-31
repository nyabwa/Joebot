module.exports = {
  apps: [
    {
      name: 'joebot-flask',
      cwd: '/home/joe-joe/joebot',
      script: 'venv/bin/python',
      args: 'app.py',
      interpreter: 'none',
      env: {
        PYTHONUNBUFFERED: '1'
      },
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'joebot-whatsapp',
      cwd: '/home/joe-joe/joebot/whatsapp',
      script: 'bot.js',
      interpreter: 'node',
      restart_delay: 5000,
      max_restarts: 10
    }
  ]
}
