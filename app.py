from db import supabase
import os
import json
import urllib.request
import urllib.error
import urllib.parse
import functools
import hmac
import secrets
import time
from flask import Blueprint, Flask, render_template, request, jsonify, redirect, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
# pyrefly: ignore [missing-import]
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from email.mime.text import MIMEText
import base64
import ipaddress
import re
from db import get_email_drafts, get_wa_drafts, update_status, save_wa_draft, get_contacts, get_contact_by_phone, add_contact

load_dotenv()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.secret_key = os.getenv('FLASK_SECRET_KEY') or secrets.token_hex(32)
app.config.update(
    MAX_CONTENT_LENGTH=int(os.getenv('FLASK_MAX_CONTENT_MB', '70')) * 1024 * 1024,
    PREFERRED_URL_SCHEME='https',
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_NAME='joebot_session',
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=os.getenv('DASHBOARD_SECURE_COOKIES', '').lower() in ('1', 'true', 'yes')
)

DASHBOARD_PASSWORD = os.getenv('DASHBOARD_PASSWORD', '')
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
DASHBOARD_AUTH_FILE = os.path.join(DATA_DIR, 'dashboard_auth.json')
JOEBOT_CONTROL_TOKEN = os.getenv('JOEBOT_CONTROL_TOKEN', '')
JOEBOT_CONTROL_URL = os.getenv('JOEBOT_CONTROL_URL', 'http://127.0.0.1:5001/control')
JOEBOT_INTERNAL_TOKEN = os.getenv('JOEBOT_INTERNAL_TOKEN', '')
CONTROL_PROXY_ROUTES = {
    'state': ('GET',),
    'logs': ('GET',),
    'chats': ('GET',),
    'messages': ('GET',),
    'bot/start': ('POST',),
    'bot/stop': ('POST',),
    'send': ('POST',),
    'command': ('PUT',),
    'feature': ('PUT',)
}
dashboard_login_attempts = {}
internal = Blueprint('internal', __name__, url_prefix='/internal')

SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly']

def dashboard_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get('dashboard_authenticated'):
            if request.path.startswith('/control/api/'):
                return jsonify({'error': 'Authentication required.'}), 401
            return redirect(url_for('control_login'))
        return view(*args, **kwargs)
    return wrapped

def is_loopback_address(address):
    return address in ('127.0.0.1', '::1') or address.startswith('::ffff:127.0.0.1')

@internal.before_request
def require_internal_service_auth():
    if not is_loopback_address(request.remote_addr or ''):
        return jsonify({'error': 'Not found.'}), 404
    if len(JOEBOT_INTERNAL_TOKEN) < 32:
        return jsonify({'error': 'Internal service authentication is not configured.'}), 503
    supplied = request.headers.get('X-JoeBot-Internal', '')
    if not supplied or not hmac.compare_digest(supplied, JOEBOT_INTERNAL_TOKEN):
        return jsonify({'error': 'Unauthorized.'}), 401

@internal.route('/health')
def internal_health():
    return jsonify({'status': 'ok'})

def load_dashboard_auth():
    if not os.path.exists(DASHBOARD_AUTH_FILE):
        return None
    try:
        with open(DASHBOARD_AUTH_FILE, 'r', encoding='utf-8') as auth_file:
            return json.load(auth_file)
    except Exception:
        return None

def dashboard_is_configured():
    return len(DASHBOARD_PASSWORD) >= 12 or load_dashboard_auth() is not None

def verify_dashboard_password(password):
    if len(DASHBOARD_PASSWORD) >= 12:
        return hmac.compare_digest(password, DASHBOARD_PASSWORD)
    saved = load_dashboard_auth()
    return bool(saved and check_password_hash(saved.get('password_hash', ''), password))

def save_dashboard_password(password):
    if len(password) < 12:
        raise ValueError('Password must contain at least 12 characters.')
    os.makedirs(DATA_DIR, exist_ok=True)
    temp_path = f'{DASHBOARD_AUTH_FILE}.{os.getpid()}.tmp'
    with open(temp_path, 'w', encoding='utf-8') as auth_file:
        json.dump({
            'password_hash': generate_password_hash(password),
            'created_at': time.time()
        }, auth_file)
        auth_file.write('\n')
    os.chmod(temp_path, 0o600)
    os.replace(temp_path, DASHBOARD_AUTH_FILE)

def validate_dashboard_csrf():
    expected = session.get('dashboard_csrf', '')
    supplied = request.headers.get('X-CSRF-Token', '')
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))

def dashboard_csrf_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not validate_dashboard_csrf():
            return jsonify({'error': 'Request verification failed.'}), 403
        return view(*args, **kwargs)
    return wrapped

def proxy_joebot_control(route):
    allowed_methods = CONTROL_PROXY_ROUTES.get(route)
    if not allowed_methods or request.method not in allowed_methods:
        return jsonify({'error': 'Control route not allowed.'}), 404

    query = urllib.parse.urlencode(request.args)
    url = f'{JOEBOT_CONTROL_URL.rstrip("/")}/{route}'
    if query:
        url = f'{url}?{query}'

    body = request.get_data() if request.method != 'GET' else None
    headers = {'Accept': 'application/json'}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    if JOEBOT_CONTROL_TOKEN:
        headers['X-JoeBot-Control'] = JOEBOT_CONTROL_TOKEN

    proxied = urllib.request.Request(url, data=body, headers=headers, method=request.method)
    try:
        with urllib.request.urlopen(proxied, timeout=20) as response:
            payload = response.read()
            return app.response_class(payload, status=response.status, content_type='application/json')
    except urllib.error.HTTPError as error:
        return app.response_class(error.read(), status=error.code, content_type='application/json')
    except Exception as error:
        return jsonify({'error': f'WhatsApp control service unavailable: {error}'}), 503

@app.route('/control/login', methods=['GET', 'POST'])
def control_login():
    if session.get('dashboard_authenticated'):
        return redirect(url_for('control_dashboard'))

    error = None
    configured = dashboard_is_configured()
    setup_mode = not configured
    if request.method == 'POST':
        address = request.remote_addr or 'unknown'
        attempt = dashboard_login_attempts.get(address, {'count': 0, 'reset_at': 0})
        if attempt['reset_at'] <= time.time():
            attempt = {'count': 0, 'reset_at': time.time() + 300}

        submitted_password = request.form.get('password', '')
        if attempt['count'] >= 5:
            error = 'Too many attempts. Try again in five minutes.'
        elif setup_mode and not is_loopback_address(address):
            error = 'First-time setup is only allowed from this computer.'
        elif setup_mode:
            try:
                save_dashboard_password(submitted_password)
                dashboard_login_attempts.pop(address, None)
                session.clear()
                session['dashboard_authenticated'] = True
                session['dashboard_csrf'] = secrets.token_urlsafe(24)
                return redirect(url_for('control_dashboard'))
            except ValueError as setup_error:
                error = str(setup_error)
        elif verify_dashboard_password(submitted_password):
            dashboard_login_attempts.pop(address, None)
            session.clear()
            session['dashboard_authenticated'] = True
            session['dashboard_csrf'] = secrets.token_urlsafe(24)
            return redirect(url_for('control_dashboard'))
        else:
            attempt['count'] += 1
            dashboard_login_attempts[address] = attempt
            error = 'Invalid password.'

    return render_template('control_login.html', error=error, configured=configured, setup_mode=setup_mode)

@app.route('/control/logout', methods=['POST'])
@dashboard_required
def control_logout():
    if not validate_dashboard_csrf():
        return jsonify({'error': 'Request verification failed.'}), 403
    session.clear()
    return jsonify({'success': True})

@app.route('/control')
@dashboard_required
def control_dashboard():
    return render_template('control.html', csrf_token=session['dashboard_csrf'])

@app.route('/control/api/<path:route>', methods=['GET', 'POST', 'PUT'])
@dashboard_required
def control_api(route):
    if request.method != 'GET' and not validate_dashboard_csrf():
        return jsonify({'error': 'Request verification failed.'}), 403
    return proxy_joebot_control(route)

def get_gmail_service():
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open('token.json', 'w') as token:
            token.write(creds.to_json())
    return build('gmail', 'v1', credentials=creds)

def send_email(to, subject, body):
    service = get_gmail_service()
    message = MIMEText(body)
    message['to'] = to
    message['subject'] = subject
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    service.users().messages().send(userId='me', body={'raw': raw}).execute()

@app.route('/')
@dashboard_required
def index():
    pending = get_email_drafts('pending_review')
    sent = get_email_drafts('sent')
    skipped = get_email_drafts('skipped')
    return render_template('index.html', pending=pending, sent=sent, skipped=skipped)

@app.route('/approve', methods=['POST'])
@dashboard_required
@dashboard_csrf_required
def approve():
    data = request.json
    record_id = data['id']
    edited_draft = data['draft']
    to = data['to']
    subject = data['subject']
    try:
        send_email(to, subject, edited_draft)
        update_status('email_drafts', record_id, 'sent')
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@app.route('/skip', methods=['POST'])
@dashboard_required
@dashboard_csrf_required
def skip():
    data = request.json
    update_status('email_drafts', data['id'], 'skipped')
    return jsonify({'success': True})

@app.route('/wa-reviews')
@dashboard_required
def wa_reviews():
    pending = get_wa_drafts('pending_review')
    sent = get_wa_drafts('sent')
    skipped = get_wa_drafts('skipped')
    return render_template('wa_reviews.html', pending=pending, sent=sent, skipped=skipped)

@internal.route('/wa-draft', methods=['POST'])
def wa_draft():
    import time
    # pyrefly: ignore [missing-import]
    from groq import Groq
    data = request.json
    sender = data.get('sender', '')
    message = data.get('message', '')

    # Load conversation examples
    import json as _json
    try:
        with open('wa_examples.json') as f:
            examples = _json.load(f)
    except:
        examples = {"sheng": [], "kiswahili": [], "english": []}

    def build_examples(lang):
        ex_list = examples.get(lang, [])[:5]
        if not ex_list:
            return ""
        lines = [f'Received: "{e["received"]}"\nReply: "{e["reply"]}"' for e in ex_list]
        return "\n\n".join(lines)

    sheng_examples = build_examples("sheng")
    kiswahili_examples = build_examples("kiswahili")
    english_examples = build_examples("english")

    # Group whitelist check
    ALLOWED_GROUPS = os.getenv('ALLOWED_GROUPS', '').split(',')
    is_group = sender.endswith('@g.us')
    if is_group and sender not in ALLOWED_GROUPS:
        print(f'Ignored group message from: {sender}')
        return jsonify({'result': 'ignored'})

    # Check if sender is a known contact
    from db import get_contact_by_phone
    sender_number = sender.replace('@s.whatsapp.net', '').replace('@lid', '')
    contact = get_contact_by_phone(sender_number)
    contact_context = ''

    if contact:
        contact_context = f"\nSender info: {contact['name']} ({contact['relationship']}). Notes: {contact['notes'] or 'none'}. Priority: {contact['priority']}."
        print(f"Known contact: {contact['name']} [{contact['priority']}]")
    else:
        print(f"Unknown contact: {sender_number}")

    # Check for exact match in examples
    exact_match_reply = None
    exact_match_lang = None
    clean_msg = message.strip().lower()
    for lang, ex_list in examples.items():
        for ex in ex_list:
            if ex["received"].strip().lower() == clean_msg:
                exact_match_reply = ex["reply"]
                exact_match_lang = lang.capitalize()
                break
        if exact_match_reply:
            break

    if exact_match_reply:
        print(f"✓ Exact match found in examples ({exact_match_lang})")
        result = f"LANGUAGE: {exact_match_lang}\nREPLY: {exact_match_reply}\nCONFIDENCE: 100\nCOMPLEXITY: simple\nFLAG: no"
    else:
        client = Groq(api_key=os.getenv("GROQ_API_KEY"))

        def create_completion_with_retry(**kwargs):
            for attempt in range(3):
                try:
                    return client.chat.completions.create(**kwargs)
                except Exception as e:
                    if '429' in str(e) and attempt < 2:
                        time.sleep(3)
                        continue
                    raise

        # Question detector — check before normal flow
        question_indicators = [
            '?', 'what is', 'what are', 'who is', 'who are', 'how does', 'how do',
            'why is', 'why are', 'when did', 'when was', 'where is', 'where are',
            'explain', 'define', 'tell me about', 'what causes', 'how many',
            'difference between', 'what does', 'how is', 'nini maana', 'maana ya',
            'eleza', 'niambie kuhusu', 'ni nini', 'inafanyaje', 'kwa nini',
            'nini ni', 'sema kuhusu'
        ]
        message_lower = message.lower()
        is_question = any(ind in message_lower for ind in question_indicators)

        if is_question:
            lang_response = create_completion_with_retry(
                model='llama-3.3-70b-versatile',
                messages=[{
                    'role': 'user',
                    'content': f'What language is this message written in? Reply with only one word: English, Kiswahili, or Sheng.\n\nMessage: "{message}"'
                }]
            )
            detected_lang = lang_response.choices[0].message.content.strip()

            qa_response = create_completion_with_retry(
                model='llama-3.3-70b-versatile',
                messages=[
                    {
                        'role': 'system',
                        'content': f"""You are a knowledgeable assistant on Joseph Odhiambo's WhatsApp bot.
Answer in {detected_lang}. Be accurate, concise and natural. This is WhatsApp so keep it readable.
Never say you are an AI. End with a relevant emoji."""
                    },
                    {
                        'role': 'user',
                        'content': message
                    }
                ],
                max_tokens=500
            )
            answer = qa_response.choices[0].message.content.strip()

            # Save to Supabase for review
            save_wa_draft(sender, message, detected_lang, answer)
            print(f'\n→ Queued for review: {answer}')

            return jsonify({'result': f'LANGUAGE: {detected_lang}\nREPLY: {answer}\nCONFIDENCE: 95\nCOMPLEXITY: simple\nFLAG: no'})

        prompt = f"""You are a WhatsApp assistant for Joseph Odhiambo in Nairobi, Kenya.

Your job is to reply exactly like Joseph would — matching the language, tone and vibe of the sender.

Here are real examples of how Joseph replies in each language:

=== SHENG EXAMPLES ===
{sheng_examples}

=== KISWAHILI EXAMPLES ===
{kiswahili_examples}

=== ENGLISH EXAMPLES ===
{english_examples}

Rules:
- Detect language: English, Kiswahili, or Sheng
- Match EXACTLY the tone and style of the examples above
- Sheng: casual, short, Nairobi street tone — like the examples
- Kiswahili: warm, natural Kenyan Kiswahili — like the examples
- English: friendly and direct — like the examples
- NEVER be formal in Sheng. NEVER sound like a translation.
- Keep replies SHORT — 1 to 2 sentences max
- If unsure what to say, keep it very simple and natural

Incoming message from: {sender}
Message: "{message}"{contact_context}

Respond in this EXACT format:
LANGUAGE: [English, Kiswahili, or Sheng]
REPLY: [your reply]
CONFIDENCE: [0-100]
COMPLEXITY: [simple, moderate, or complex]
FLAG: [yes or no]"""

        response = create_completion_with_retry(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "user", "content": prompt}
            ]
        )

        result = response.choices[0].message.content
    lines = result.split('\n')

    def extract(key):
        line = next((l for l in lines if l.startswith(f'{key}:')), '')
        return line.replace(f'{key}:', '').strip()

    language = extract('LANGUAGE') or 'Unknown'
    reply = extract('REPLY') or ''

    save_wa_draft(sender, message, language, reply)

    print(f'\n→ Queued for review: {reply}')

    return jsonify({'result': result})

@app.route('/wa-approve', methods=['POST'])
@dashboard_required
@dashboard_csrf_required
def wa_approve():
    data = request.json
    record_id = data['id']
    reply = data['reply']
    to = data['to']

    try:
        body = json.dumps({'to': to, 'message': reply}).encode()
        req = urllib.request.Request(
            'http://localhost:5001/send',
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        urllib.request.urlopen(req)
        update_status('wa_drafts', record_id, 'sent')
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@app.route('/wa-skip', methods=['POST'])
@dashboard_required
@dashboard_csrf_required
def wa_skip():
    data = request.json
    update_status('wa_drafts', data['id'], 'skipped')
    return jsonify({'success': True})
@app.route('/contacts')
@dashboard_required
def contacts():
    all_contacts = get_contacts()
    return render_template('contacts.html', contacts=all_contacts)

@app.route('/contacts/add', methods=['POST'])
@dashboard_required
@dashboard_csrf_required
def add_contact_route():
    from db import add_contact
    data = request.json
    add_contact(
        name=data.get('name'),
        phone=data.get('phone'),
        email=data.get('email'),
        relationship=data.get('relationship'),
        priority=data.get('priority', 'normal'),
        notes=data.get('notes')
    )
    return jsonify({'success': True})

@app.route('/contacts/delete', methods=['POST'])
@dashboard_required
@dashboard_csrf_required
def delete_contact():
    data = request.json
    supabase.table('contacts').delete().eq('id', data['id']).execute()
    return jsonify({'success': True})

@internal.route('/contact-lock', methods=['POST'])
def contact_lock():
    from db import lock_contact, unlock_contact, is_locked, get_contact_by_phone
    data = request.json
    phone = data.get('phone', '')
    action = data.get('action', '')

    if action == 'lock':
        lock_contact(phone)
        return jsonify({'success': True})

    elif action == 'unlock':
        unlock_contact(phone)
        return jsonify({'success': True})

    elif action == 'check':
        locked = is_locked(phone)
        return jsonify({'locked': locked})

    elif action == 'check_contact':
        contact = get_contact_by_phone(phone)
        return jsonify({'known': contact is not None})

    return jsonify({'success': False})

@internal.route('/get-weather', methods=['POST'])
def get_weather():
    from groq import Groq
    data = request.json
    location = data.get('location', 'Nairobi')
    import urllib.request as ur
    try:
        url = f"https://wttr.in/{location.replace(' ', '+')}?format=j1"
        req = ur.Request(url, headers={'User-Agent': 'curl/7.68.0'})
        with ur.urlopen(req, timeout=10) as response:
            weather_data = json.loads(response.read().decode())
        current = weather_data['current_condition'][0]
        temp_c = current['temp_C']
        feels_like = current['FeelsLikeC']
        humidity = current['humidity']
        desc = current['weatherDesc'][0]['value']
        wind = current['windspeedKmph']
        result = (
            f"🌤️ *Weather in {location}*\n\n"
            f"🌡️ Temp: {temp_c}°C (feels like {feels_like}°C)\n"
            f"☁️ {desc}\n"
            f"💧 Humidity: {humidity}%\n"
            f"💨 Wind: {wind} km/h"
        )
    except Exception as e:
        result = f"❌ Could not fetch weather for {location}. Try again."
    return jsonify({'result': result})

@internal.route('/ip-info', methods=['POST'])
def ip_info():
    import urllib.request as ur
    data = request.json or {}
    ip = data.get('ip', '').strip()

    if not ip:
        return jsonify({'result': '❌ Usage: /ipinfo <ip address>\nExample: /ipinfo 8.8.8.8'})

    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return jsonify({'result': f'❌ Invalid IP address: {ip}'})

    try:
        req = ur.Request(
            f'http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,isp,org,as,query',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with ur.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())

        if result.get('status') == 'success':
            text = (
                f"🌐 *IP Info: {result.get('query')}*\n\n"
                f"📍 Location: {result.get('city')}, {result.get('regionName')}, {result.get('country')}\n"
                f"🏢 ISP: {result.get('isp')}\n"
                f"🔌 Org: {result.get('org')}\n"
                f"📡 AS: {result.get('as')}"
            )
        else:
            text = f"❌ Could not find info for {ip}: {result.get('message', 'Unknown error')}"
        return jsonify({'result': text})
    except Exception as e:
        return jsonify({'result': f'❌ Error: {str(e)}'})

@internal.route('/num-info', methods=['POST'])
def num_info():
    from groq import Groq
    data = request.json or {}
    number = re.sub(r'\D', '', data.get('number', ''))

    if not number:
        return jsonify({'result': '❌ Usage: /numinfo <number with country code>\nExample: /numinfo 254712345678'})

    try:
        client = Groq(api_key=os.getenv('GROQ_API_KEY'))
        response = client.chat.completions.create(
            model='llama-3.3-70b-versatile',
            messages=[{
                'role': 'user',
                'content': f'''Analyze this phone number: +{number}
Return the following in this exact format:
Country: [country name]
Country Code: [dial code]
Carrier/ISP: [likely carrier based on number prefix if known]
Line Type: [Mobile/Landline/VoIP]
Region: [region or state if determinable]
Valid: [Yes/No]

Only return what can be determined from the number format. Do not guess unknown fields — write Unknown instead.'''
            }],
            max_tokens=250
        )
        result = response.choices[0].message.content.strip()
        return jsonify({'result': f'📱 *Number Info: +{number}*\n\n{result}'})
    except Exception as e:
        return jsonify({'result': f'❌ Error: {str(e)}'})

@internal.route('/my-ip', methods=['GET'])
def my_ip():
    import urllib.request as ur
    try:
        req = ur.Request(
            'http://ip-api.com/json/?fields=status,message,country,regionName,city,isp,org,query',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with ur.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())

        if result.get('status') != 'success':
            return jsonify({'result': f"❌ Could not fetch server IP info: {result.get('message', 'Unknown error')}"})

        text = (
            f"🖥️ *Bot Server IP Info*\n\n"
            f"🌐 IP: {result.get('query')}\n"
            f"📍 Location: {result.get('city')}, {result.get('regionName')}, {result.get('country')}\n"
            f"🏢 ISP: {result.get('isp')}\n"
            f"🔌 Org: {result.get('org')}"
        )
        return jsonify({'result': text})
    except Exception as e:
        return jsonify({'result': f'❌ Error: {str(e)}'})

@internal.route('/save-note', methods=['POST'])
def save_note():
    data = request.json
    note = data.get('note', '')
    supabase.table('notes').insert({'note': note}).execute()
    return jsonify({'success': True})

@internal.route('/get-notes', methods=['GET'])
def get_notes():
    notes = supabase.table('notes').select('*').order('created_at', desc=True).limit(20).execute().data
    return jsonify({'notes': notes})

@internal.route('/clear-notes', methods=['POST'])
def clear_notes():
    supabase.table('notes').delete().neq('id', '00000000-0000-0000-0000-000000000000').execute()
    return jsonify({'success': True})

@internal.route('/calculate', methods=['POST'])
def calculate():
    from groq import Groq
    data = request.json
    expression = data.get('expression', '')
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{
            "role": "user",
            "content": f"Calculate this and return ONLY the numerical answer, nothing else: {expression}"
        }]
    )
    result = response.choices[0].message.content.strip()
    return jsonify({'result': result})

@internal.route('/translate', methods=['POST'])
def translate():
    from groq import Groq
    data = request.json
    text = data.get('text', '')
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{
            "role": "user",
            "content": f"Translate this to English. Return ONLY the translation, nothing else: {text}"
        }]
    )
    result = response.choices[0].message.content.strip()
    return jsonify({'result': result})

@internal.route('/get-wiki', methods=['POST'])
def get_wiki():
    from groq import Groq
    data = request.json
    topic = data.get('topic', '')
    client = Groq(api_key=os.getenv('GROQ_API_KEY'))
    response = client.chat.completions.create(
        model='llama-3.3-70b-versatile',
        messages=[{
            'role': 'user',
            'content': f'Give me a concise Wikipedia-style summary of "{topic}" in 3-4 sentences. Include key facts only.'
        }]
    )
    return jsonify({'result': response.choices[0].message.content.strip()})

@internal.route('/get-fact', methods=['POST'])
def get_fact():
    from groq import Groq
    data = request.json
    topic = data.get('topic', '')
    client = Groq(api_key=os.getenv('GROQ_API_KEY'))
    prompt = f'Give me one surprising, verified, interesting fact about "{topic}". One sentence only.' if topic else 'Give me one surprising, verified, interesting fact about anything. One sentence only.'
    response = client.chat.completions.create(
        model='llama-3.3-70b-versatile',
        messages=[{'role': 'user', 'content': prompt}]
    )
    return jsonify({'result': response.choices[0].message.content.strip()})

@internal.route('/get-quiz', methods=['POST'])
def get_quiz():
    from groq import Groq
    data = request.json
    topic = data.get('topic', '')
    client = Groq(api_key=os.getenv('GROQ_API_KEY'))
    response = client.chat.completions.create(
        model='llama-3.3-70b-versatile',
        messages=[{
            'role': 'user',
            'content': f'Generate a 5-question multiple choice quiz about "{topic}". Format each question as:\nQ1: [question]\nA) [option]\nB) [option]\nC) [option]\nD) [option]\nAnswer: [correct letter]\n\nKeep it educational and accurate.'
        }],
        max_tokens=600
    )
    return jsonify({'result': response.choices[0].message.content.strip()})

@internal.route('/get-diagnose', methods=['POST'])
def get_diagnose():
    from groq import Groq
    data = request.json
    symptoms = data.get('symptoms', '')
    client = Groq(api_key=os.getenv('GROQ_API_KEY'))
    response = client.chat.completions.create(
        model='llama-3.3-70b-versatile',
        messages=[
            {
                'role': 'system',
                'content': '''You are a clinical assistant with orthopaedic and general medicine knowledge.
Given symptoms, provide:
1. Possible conditions (most likely first)
2. Key differentiating features
3. Recommended next steps
Always add: "This is for educational purposes only. See a qualified clinician for diagnosis."
Be concise — this is WhatsApp.'''
            },
            {'role': 'user', 'content': f'Symptoms: {symptoms}'}
        ],
        max_tokens=500
    )
    return jsonify({'result': response.choices[0].message.content.strip()})

@internal.route('/get-news', methods=['POST'])
def get_news():
    import urllib.request as ur
    import xml.etree.ElementTree as ET
    try:
        req = ur.Request(
            'https://news.google.com/rss?hl=en-KE&gl=KE&ceid=KE:en',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with ur.urlopen(req, timeout=10) as resp:
            feed = resp.read()

        root = ET.fromstring(feed)
        items = root.findall('./channel/item')[:5]
        if not items:
            return jsonify({'result': '❌ Could not fetch live Kenya headlines right now.'})

        lines = []
        for index, item in enumerate(items, 1):
            title = item.findtext('title', default='Untitled').strip()
            link = item.findtext('link', default='').strip()
            lines.append(f'{index}. {title}\n{link}')

        return jsonify({'result': '📰 *Kenya News (Live Headlines)*\n\n' + '\n\n'.join(lines)})
    except Exception as e:
        return jsonify({'result': f'❌ Could not fetch live Kenya headlines: {str(e)}'})

@internal.route('/get-forex', methods=['POST'])
def get_forex():
    import urllib.request as ur
    try:
        req = ur.Request(
            'https://open.er-api.com/v6/latest/KES',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with ur.urlopen(req, timeout=10) as resp:
            data2 = json.loads(resp.read().decode())
        rates = data2.get('rates', {})
        usd = round(1 / rates.get('USD', 0.0077), 2) if rates.get('USD') else 'N/A'
        eur = round(1 / rates.get('EUR', 0.0071), 2) if rates.get('EUR') else 'N/A'
        gbp = round(1 / rates.get('GBP', 0.0061), 2) if rates.get('GBP') else 'N/A'
        result = f"💱 *Exchange Rates*\n\n1 USD = KES {usd}\n1 EUR = KES {eur}\n1 GBP = KES {gbp}\n\n_Updated: live_"
        return jsonify({'result': result})
    except Exception as e:
        return jsonify({'result': f'❌ Could not fetch rates: {str(e)}'})

@internal.route('/get-fuel', methods=['POST'])
def get_fuel():
    return jsonify({
        'result': (
            '⛽ *Kenya Fuel Prices*\n\n'
            'Live EPRA price extraction is not configured yet, so I will not guess current pump prices.\n\n'
            'Check the official EPRA pump price page:\n'
            'https://www.epra.go.ke/EPRA%20Pump%20Prices'
        )
    })

@internal.route('/get-verse', methods=['POST'])
def get_verse():
    from summary import get_daily_verse
    reference, text = get_daily_verse()
    result = f"📖 *{reference}*\n\n_{text}_\n\n🙏 God bless you, Joseph."
    return jsonify({'result': result})

@internal.route('/get-motivate', methods=['POST'])
def get_motivate():
    from groq import Groq
    client = Groq(api_key=os.getenv('GROQ_API_KEY'))
    response = client.chat.completions.create(
        model='llama-3.3-70b-versatile',
        messages=[{
            'role': 'user',
            'content': 'Give me one powerful motivational quote. Include the author. One quote only.'
        }]
    )
    return jsonify({'result': response.choices[0].message.content.strip()})

@internal.route('/get-contacts-list', methods=['GET'])
def get_contacts_list():
    contacts = get_contacts()
    return jsonify({'contacts': contacts})

@internal.route('/todo-add', methods=['POST'])
def todo_add():
    from db import add_todo
    data = request.json
    task = data.get('task', '')
    add_todo(task)
    return jsonify({'success': True})

@internal.route('/todo-list', methods=['GET'])
def todo_list():
    from db import get_todos
    pending = get_todos('pending')
    done = get_todos('done')
    return jsonify({'pending': pending, 'done': done})

@internal.route('/todo-done', methods=['POST'])
def todo_done():
    from db import complete_todo
    data = request.json
    number = data.get('number', 1)
    task = complete_todo(number)
    if task:
        return jsonify({'success': True, 'task': task})
    return jsonify({'success': False, 'message': 'Todo not found'})

@internal.route('/generate-qr', methods=['POST'])
def generate_qr():
    import qrcode
    import base64
    import tempfile
    data = request.json
    text = data.get('text', '')
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color='black', back_color='white')
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        img.save(f.name)
        tmp_path = f.name
    with open(tmp_path, 'rb') as f:
        img_b64 = base64.b64encode(f.read()).decode()
    os.unlink(tmp_path)
    return jsonify({'success': True, 'image': img_b64})

@internal.route('/generate-pdf', methods=['POST'])
def generate_pdf():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    import tempfile
    import base64
    data = request.json
    text = data.get('text', '')
    title = data.get('title', 'Document')
    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as f:
        tmp_path = f.name
    try:
        c = canvas.Canvas(tmp_path, pagesize=A4)
        width, height = A4
        c.setFont('Helvetica-Bold', 16)
        c.drawString(50, height - 50, title)
        c.setFont('Helvetica', 12)
        y = height - 90
        for line in text.split('\n'):
            words = line.split()
            current_line = ''
            for word in words:
                test_line = current_line + word + ' '
                if c.stringWidth(test_line, 'Helvetica', 12) < width - 100:
                    current_line = test_line
                else:
                    c.drawString(50, y, current_line.strip())
                    y -= 20
                    current_line = word + ' '
                    if y < 50:
                        c.showPage()
                        y = height - 50
                        c.setFont('Helvetica', 12)
            if current_line:
                c.drawString(50, y, current_line.strip())
                y -= 20
            if y < 50:
                c.showPage()
                y = height - 50
                c.setFont('Helvetica', 12)
        c.save()
        with open(tmp_path, 'rb') as f:
            pdf_b64 = base64.b64encode(f.read()).decode()
        os.unlink(tmp_path)
        return jsonify({'success': True, 'pdf': pdf_b64})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)})

@internal.route('/answer-question', methods=['POST'])
def answer_question():
    from groq import Groq
    data = request.json
    question = data.get('question', '')
    language = data.get('language', 'English')

    client = Groq(api_key=os.getenv('GROQ_API_KEY'))
    response = client.chat.completions.create(
        model='llama-3.3-70b-versatile',
        messages=[
            {
                'role': 'system',
                'content': f"""You are a knowledgeable assistant answering questions on behalf of Joseph Odhiambo's WhatsApp bot.

Answer in {language}. Rules:
- Give accurate, clear, educational answers
- Keep answers concise — this is WhatsApp, not an essay
- If the question is about medicine, science, history, math, geography, technology or any academic topic — answer it fully
- If Sheng: answer casually but still accurately
- If Kiswahili: answer warmly and clearly
- Always end with a relevant emoji
- Never say you are an AI — just answer naturally"""
            },
            {
                'role': 'user',
                'content': question
            }
        ],
        max_tokens=500
    )
    return jsonify({'success': True, 'result': response.choices[0].message.content.strip()})

@internal.route('/transcribe', methods=['POST'])
def transcribe():
    import whisper
    import tempfile
    import os
    data = request.json
    audio_b64 = data.get('audio')
    import base64
    audio_bytes = base64.b64decode(audio_b64)
    with tempfile.NamedTemporaryFile(suffix='.ogg', delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name
    try:
        model = whisper.load_model('base')
        result = model.transcribe(tmp_path)
        text = result['text'].strip()
        os.unlink(tmp_path)
        return jsonify({'success': True, 'text': text})
    except Exception as e:
        return jsonify({'success': False, 'text': str(e)})

@internal.route('/analyze-image', methods=['POST'])
def analyze_image():
    from groq import Groq
    import traceback
    try:
        data = request.json
        image_b64 = data.get('image')
        prompt = data.get('prompt', 'Describe what you see in this image in detail.')
        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        response = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}
                    },
                    {
                        "type": "text",
                        "text": prompt
                    }
                ]
            }],
            max_tokens=500
        )
        result = response.choices[0].message.content.strip()
        return jsonify({'success': True, 'result': result})
    except Exception as e:
        print(f"Error in /analyze-image: {e}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)})

@internal.route('/summarize-pdf', methods=['POST'])
def summarize_pdf():
    from groq import Groq
    import PyPDF2
    import tempfile
    try:
        data = request.json
        pdf_b64 = data.get('pdf')
        if not pdf_b64:
            return jsonify({'success': False, 'result': 'No PDF provided.'})

        pdf_bytes = base64.b64decode(pdf_b64)
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as f:
                f.write(pdf_bytes)
                tmp_path = f.name

            reader = PyPDF2.PdfReader(tmp_path)
            text = ''
            for page in reader.pages[:10]:
                text += page.extract_text() or ''
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)

        if not text.strip():
            return jsonify({'success': False, 'result': 'Could not extract text from PDF.'})

        client = Groq(api_key=os.getenv('GROQ_API_KEY'))
        response = client.chat.completions.create(
            model='llama-3.3-70b-versatile',
            messages=[{
                'role': 'user',
                'content': f'Summarize this document in clear bullet points. Be concise:\n\n{text[:8000]}'
            }],
            max_tokens=500
        )
        return jsonify({'success': True, 'result': response.choices[0].message.content.strip()})
    except Exception as e:
        return jsonify({'success': False, 'result': str(e)})

@internal.route('/summarize-youtube', methods=['POST'])
def summarize_youtube():
    from groq import Groq
    import glob
    import re
    import subprocess
    import tempfile
    data = request.json
    url = data.get('url', '')
    if not url:
        return jsonify({'success': False, 'result': 'No YouTube URL provided.'})

    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_tpl = os.path.join(tmp_dir, 'yt_sub')
            subprocess.run(
                ['/usr/local/bin/yt-dlp', '--write-auto-sub', '--skip-download',
                 '--sub-format', 'vtt', '--output', out_tpl, url],
                capture_output=True, text=True, timeout=60, check=False
            )
            sub_files = glob.glob(os.path.join(tmp_dir, 'yt_sub*.vtt'))
            if not sub_files:
                return jsonify({'success': False, 'result': 'No subtitles available for this video.'})

            with open(sub_files[0], 'r') as f:
                raw = f.read()

        lines = raw.split('\n')
        clean = []
        seen = set()
        for line in lines:
            stripped = line.strip()
            if '-->' in stripped or stripped == '' or stripped.isdigit():
                continue
            if re.match(r'^\d{2}:\d{2}', stripped):
                continue
            cleaned = re.sub(r'<[^>]+>', '', stripped).strip()
            if cleaned and cleaned not in seen:
                clean.append(cleaned)
                seen.add(cleaned)

        transcript = ' '.join(clean[:500])
        if not transcript.strip():
            return jsonify({'success': False, 'result': 'Could not extract transcript.'})

        client = Groq(api_key=os.getenv('GROQ_API_KEY'))
        response = client.chat.completions.create(
            model='llama-3.3-70b-versatile',
            messages=[{
                'role': 'user',
                'content': f'Summarize this YouTube video transcript in clear bullet points. Be concise:\n\n{transcript[:6000]}'
            }],
            max_tokens=400
        )
        return jsonify({'success': True, 'result': response.choices[0].message.content.strip()})
    except Exception as e:
        return jsonify({'success': False, 'result': str(e)})

@internal.route('/social-lookup', methods=['POST'])
def social_lookup():
    import urllib.request as ur
    data = request.json or {}
    platform = data.get('platform', '').lower()
    username = data.get('username', '').strip().lstrip('@')

    try:
        if platform in ['instagram', 'ig']:
            url = f'https://www.instagram.com/{username}/'
            req = ur.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.72 Mobile Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            })
            with ur.urlopen(req, timeout=10) as resp:
                html = resp.read().decode('utf-8', errors='ignore')

            followers = re.search(r'"edge_followed_by":\{"count":(\d+)\}', html)
            following = re.search(r'"edge_follow":\{"count":(\d+)\}', html)
            posts = re.search(r'"edge_owner_to_timeline_media":\{"count":(\d+)\}', html)
            bio = re.search(r'"biography":"([^"]*)"', html)
            full_name = re.search(r'"full_name":"([^"]*)"', html)
            is_private = re.search(r'"is_private":(\w+)', html)
            is_verified = re.search(r'"is_verified":(\w+)', html)

            result = f"📸 *Instagram: @{username}*\n\n"
            if full_name and full_name.group(1):
                result += f"👤 Name: {full_name.group(1)}\n"
            if followers:
                result += f"👥 Followers: {int(followers.group(1)):,}\n"
            if following:
                result += f"➡️ Following: {int(following.group(1)):,}\n"
            if posts:
                result += f"📷 Posts: {int(posts.group(1)):,}\n"
            if bio and bio.group(1):
                result += f"📝 Bio: {bio.group(1)}\n"
            if is_private:
                result += f"🔒 Private: {is_private.group(1).capitalize()}\n"
            if is_verified:
                result += f"✅ Verified: {is_verified.group(1).capitalize()}\n"
            result += f"\n🔗 https://instagram.com/{username}"

        elif platform in ['tiktok', 'tt']:
            url = f'https://www.tiktok.com/@{username}'
            req = ur.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            })
            with ur.urlopen(req, timeout=10) as resp:
                html = resp.read().decode('utf-8', errors='ignore')

            followers = re.search(r'"followerCount":(\d+)', html)
            following = re.search(r'"followingCount":(\d+)', html)
            likes = re.search(r'"heartCount":(\d+)', html)
            videos = re.search(r'"videoCount":(\d+)', html)
            nickname = re.search(r'"nickname":"([^"]*)"', html)
            bio = re.search(r'"signature":"([^"]*)"', html)
            verified = re.search(r'"verified":(\w+)', html)

            result = f"🎵 *TikTok: @{username}*\n\n"
            if nickname and nickname.group(1):
                result += f"👤 Name: {nickname.group(1)}\n"
            if followers:
                result += f"👥 Followers: {int(followers.group(1)):,}\n"
            if following:
                result += f"➡️ Following: {int(following.group(1)):,}\n"
            if likes:
                result += f"❤️ Total Likes: {int(likes.group(1)):,}\n"
            if videos:
                result += f"🎬 Videos: {int(videos.group(1)):,}\n"
            if bio and bio.group(1):
                result += f"📝 Bio: {bio.group(1)}\n"
            if verified:
                result += f"✅ Verified: {verified.group(1).capitalize()}\n"
            result += f"\n🔗 https://tiktok.com/@{username}"

        elif platform in ['twitter', 'x']:
            result = (
                f"🐦 *Twitter/X: @{username}*\n\n"
                f"⚠️ Twitter/X has restricted their API heavily.\n"
                f"🔗 View profile: https://x.com/{username}"
            )

        elif platform in ['github', 'gh']:
            req = ur.Request(
                f'https://api.github.com/users/{username}',
                headers={'User-Agent': 'JoeBot', 'Accept': 'application/vnd.github.v3+json'}
            )
            with ur.urlopen(req, timeout=10) as resp:
                data2 = json.loads(resp.read().decode())

            result = f"🐙 *GitHub: @{username}*\n\n"
            if data2.get('name'):
                result += f"👤 Name: {data2['name']}\n"
            result += f"👥 Followers: {data2.get('followers', 0):,}\n"
            result += f"➡️ Following: {data2.get('following', 0):,}\n"
            result += f"📦 Public Repos: {data2.get('public_repos', 0):,}\n"
            if data2.get('bio'):
                result += f"📝 Bio: {data2['bio']}\n"
            if data2.get('company'):
                result += f"🏢 Company: {data2['company']}\n"
            if data2.get('location'):
                result += f"📍 Location: {data2['location']}\n"
            if data2.get('blog'):
                result += f"🌐 Website: {data2['blog']}\n"
            result += f"\n🔗 https://github.com/{username}"

        else:
            result = f"❌ Unsupported platform: {platform}\nSupported: instagram, tiktok, twitter, github"

        return jsonify({'success': True, 'result': result})

    except Exception as e:
        return jsonify({'success': False, 'result': f'❌ Could not fetch info for @{username} on {platform}.\nError: {str(e)}'})

@internal.route('/check-email', methods=['POST'])
def check_email():
    import urllib.request as ur
    import re
    import hashlib
    import subprocess
    data = request.json
    email = data.get('email', '').strip()

    if not re.match(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$', email):
        return jsonify({'result': f'❌ Invalid email format: {email}'})

    results = [f'📧 *Email OSINT: {email}*\n']
    domain = email.split('@')[1]

    # Hunter.io email verification
    hunter_key = os.getenv('HUNTER_API_KEY', '')
    if hunter_key:
        try:
            req = ur.Request(
                f'https://api.hunter.io/v2/email-verifier?email={email}&api_key={hunter_key}',
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with ur.urlopen(req, timeout=10) as resp:
                hunter_data = json.loads(resp.read().decode())
            h = hunter_data.get('data', {})
            status = h.get('status', 'unknown')
            score = h.get('score', 0)
            disposable = h.get('disposable', False)
            webmail = h.get('webmail', False)
            mx_records = h.get('mx_records', False)
            smtp_check = h.get('smtp_server', False)

            status_emoji = '✅' if status == 'valid' else '⚠️' if status == 'risky' else '❌'
            results.append(f'{status_emoji} Status: {status.upper()}')
            results.append(f'🎯 Confidence score: {score}/100')
            results.append(f'📬 MX Records: {"Yes" if mx_records else "No"}')
            results.append(f'🔌 SMTP Server: {"Reachable" if smtp_check else "Unreachable"}')
            results.append(f'🗑️ Disposable email: {"Yes" if disposable else "No"}')
            results.append(f'📧 Webmail (Gmail/Yahoo etc): {"Yes" if webmail else "No"}')
        except Exception as e:
            results.append(f'⚠️ Hunter.io: {str(e)}')
    else:
        # MX record fallback
        try:
            mx = subprocess.run(['nslookup', '-type=MX', domain],
                              capture_output=True, text=True, timeout=10)
            if 'mail exchanger' in mx.stdout.lower():
                results.append(f'✅ Domain {domain} has valid MX records')
            else:
                results.append(f'⚠️ No MX records found for {domain}')
        except:
            results.append(f'📍 Domain: {domain}')

    # LeakCheck breach data
    leakcheck_key = os.getenv('LEAKCHECK_API_KEY', '')
    if leakcheck_key:
        try:
            req = ur.Request(
                f'https://leakcheck.io/api/v2/query/{email}',
                headers={
                    'User-Agent': 'Mozilla/5.0',
                    'X-API-Key': leakcheck_key
                }
            )
            with ur.urlopen(req, timeout=10) as resp:
                leak_data = json.loads(resp.read().decode())
            found = leak_data.get('found', 0)
            if found > 0:
                results.append(f'\n🚨 BREACHED: Found in {found} database(s)')
                sources = leak_data.get('sources', [])
                if sources:
                    for s in sources[:5]:
                        name = s.get('name', s) if isinstance(s, dict) else s
                        results.append(f'  • {name}')
            else:
                results.append(f'\n✅ No breaches found')
        except Exception as e:
            results.append(f'\n⚠️ Breach check: {str(e)}')

    # Gravatar
    try:
        email_hash = hashlib.md5(email.lower().strip().encode()).hexdigest()
        req = ur.Request(
            f'https://www.gravatar.com/{email_hash}.json',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with ur.urlopen(req, timeout=5) as resp:
            gravatar = json.loads(resp.read().decode())
        entry = gravatar.get('entry', [{}])[0]
        name = entry.get('displayName', '')
        if name:
            results.append(f'\n👤 Gravatar: {name}')
            results.append(f'🖼️ https://www.gravatar.com/avatar/{email_hash}?s=200')
    except:
        pass

    results.append(f'\n🔗 https://haveibeenpwned.com/account/{email.split("@")[0]}')
    return jsonify({'result': '\n'.join(results)})

@internal.route('/check-breach', methods=['POST'])
def check_breach():
    import urllib.request as ur
    import hashlib
    data = request.json
    email = data.get('email', '').strip()
    results = [f'🔓 *Breach Check: {email}*\n']

    leakcheck_key = os.getenv('LEAKCHECK_API_KEY', '')

    if leakcheck_key:
        try:
            req = ur.Request(
                f'https://leakcheck.io/api/v2/query/{email}',
                headers={
                    'User-Agent': 'Mozilla/5.0',
                    'X-API-Key': leakcheck_key
                }
            )
            with ur.urlopen(req, timeout=10) as resp:
                data2 = json.loads(resp.read().decode())
            found = data2.get('found', 0)
            if found > 0:
                results.append(f'🚨 ALERT: Found in {found} breach(es)!\n')
                sources = data2.get('sources', [])
                if sources:
                    results.append('📋 *Breached in:*')
                    for source in sources[:10]:
                        name = source.get('name', source) if isinstance(source, dict) else source
                        date = source.get('date', '') if isinstance(source, dict) else ''
                        results.append(f'  • {name} {date}'.strip())
            else:
                results.append('✅ Good news — not found in any known breaches')
        except Exception as e:
            results.append(f'⚠️ LeakCheck error: {str(e)}')
    else:
        # Public fallback
        try:
            req = ur.Request(
                f'https://leakcheck.io/api/public?check={email}',
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with ur.urlopen(req, timeout=10) as resp:
                data2 = json.loads(resp.read().decode())
            found = data2.get('found', 0)
            if found > 0:
                results.append(f'🚨 Found in {found} breach(es)')
                sources = data2.get('sources', [])
                if sources:
                    for s in sources[:5]:
                        results.append(f'  • {s}')
            else:
                results.append('✅ Not found in public breach database')
        except Exception as e:
            results.append(f'⚠️ Error: {str(e)}')

    # Gravatar check
    try:
        email_hash = hashlib.md5(email.lower().strip().encode()).hexdigest()
        req = ur.Request(
            f'https://www.gravatar.com/{email_hash}.json',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with ur.urlopen(req, timeout=5) as resp:
            gravatar = json.loads(resp.read().decode())
        entry = gravatar.get('entry', [{}])[0]
        name = entry.get('displayName', '')
        if name:
            results.append(f'\n👤 Gravatar profile found: {name}')
            results.append(f'🖼️ https://www.gravatar.com/avatar/{email_hash}?s=200')
    except:
        pass

    results.append(f'\n🔗 https://haveibeenpwned.com/account/{email}')
    return jsonify({'result': '\n'.join(results)})

@internal.route('/check-username', methods=['POST'])
def check_username():
    import subprocess
    data = request.json or {}
    username = data.get('username', '').strip().lstrip('@')

    results = [f'🔍 *Username OSINT: @{username}*\n']
    results.append('Running Sherlock scan across 200+ platforms...\n')

    try:
        # Run sherlock
        result = subprocess.run(
            ['sherlock', username, '--print-found', '--timeout', '10'],
            capture_output=True,
            text=True,
            timeout=120
        )
        output = result.stdout

        # Parse found accounts
        found = []
        for line in output.split('\n'):
            if '[+]' in line:
                found.append(line.replace('[+]', '').strip())

        if found:
            results.append(f'✅ Found on {len(found)} platform(s):\n')
            for account in found[:20]:
                results.append(f'  • {account}')
            if len(found) > 20:
                results.append(f'\n  ...and {len(found) - 20} more')
        else:
            results.append(f'❌ @{username} not found on major platforms')

    except FileNotFoundError:
        results.append('⚠️ Sherlock not installed. Install with:\npip install sherlock-project')
    except subprocess.TimeoutExpired:
        results.append('⏱️ Scan timed out — username may exist on some platforms')
    except Exception as e:
        results.append(f'❌ Error: {str(e)}')

    return jsonify({'result': '\n'.join(results)})

@internal.route('/check-phone', methods=['POST'])
def check_phone():
    import urllib.request as ur
    data = request.json
    number = data.get('number', '').strip().replace('+', '').replace(' ', '').replace('-', '')
    results = [f'📱 *Phone OSINT: +{number}*\n']

    numverify_key = os.getenv('NUMVERIFY_API_KEY', '')

    if numverify_key:
        try:
            req = ur.Request(
                f'http://apilayer.net/api/validate?access_key={numverify_key}&number={number}&format=1',
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with ur.urlopen(req, timeout=10) as resp:
                nv = json.loads(resp.read().decode())

            if nv.get('valid'):
                results.append(f'✅ Valid number')
                results.append(f'🌍 Country: {nv.get("country_name")} ({nv.get("country_code")})')
                results.append(f'📡 Carrier: {nv.get("carrier") or "Unknown"}')
                results.append(f'📞 Line Type: {nv.get("line_type") or "Unknown"}')
                results.append(f'🔢 Local Format: {nv.get("local_format")}')
                results.append(f'🌐 International: {nv.get("international_format")}')
                results.append(f'📍 Location: {nv.get("location") or "Unknown"}')
            else:
                results.append(f'❌ Invalid or unrecognized number')
        except Exception as e:
            results.append(f'⚠️ NumVerify error: {str(e)}')
    else:
        results.append('⚠️ Live phone validation is not configured. Set NUMVERIFY_API_KEY to enable verified carrier and line-type checks.')

    results.append(f'\n🔗 https://www.truecaller.com/search/ke/{number}')
    return jsonify({'result': '\n'.join(results)})

app.register_blueprint(internal)

if __name__ == '__main__':
    debug = os.getenv('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes')
    app.run(host='127.0.0.1', debug=debug, port=5000)
