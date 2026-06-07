import os
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
# pyrefly: ignore [missing-import]
from groq import Groq
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
# pyrefly: ignore [missing-import]
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
import base64

load_dotenv()

SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

SYSTEM_PROMPT = """
You are a personal email assistant for Joseph Odhiambo.
Your job is to draft email replies on his behalf.
Joseph's tone: Professional but friendly, straight to the point.
Never use flowery language or filler phrases like I hope this email finds you well.
Be warm but concise. Always sign off as: Joseph.
If you do not have enough context to reply, say CANNOT_DRAFT instead.
"""

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

def get_email_body(msg):
    try:
        parts = msg['payload'].get('parts', [])
        for part in parts:
            if part['mimeType'] == 'text/plain':
                data = part['body']['data']
                return base64.urlsafe_b64decode(data).decode('utf-8')[:800]
        data = msg['payload']['body'].get('data', '')
        if data:
            return base64.urlsafe_b64decode(data).decode('utf-8')[:800]
    except:
        return "Could not extract body"
    return "No body found"

def classify_email(sender, subject, body):
    prompt = f"Classify this email and respond in this exact format:\nNEEDS_REPLY: Yes or No\nURGENCY: Low, Medium, or High\nTONE: Formal, Casual, or Ignore\nREASON: one sentence explanation\n\nFrom: {sender}\nSubject: {subject}\nBody preview: {body}"
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content

def draft_reply(sender, subject, body):
    prompt = f"Draft a reply to this email on behalf of Joseph.\n\nFrom: {sender}\nSubject: {subject}\nEmail body: {body}\n\nWrite only the reply body. No subject line. No metadata."
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt}
        ]
    )
    return response.choices[0].message.content

def save_draft(sender, subject, draft):
    from db import save_email_draft
    record_id = save_email_draft(
        to=sender,
        subject=f"Re: {subject}",
        draft=draft
    )
    print(f"Draft saved to Supabase -> {record_id}")
    return record_id

def main():
    service = get_gmail_service()
    results = service.users().messages().list(userId='me', maxResults=10, q='is:unread').execute()
    messages = results.get('messages', [])

    if not messages:
        print('No unread messages found.')
        return

    drafts_created = 0

    for msg in messages:
        msg_data = service.users().messages().get(userId='me', id=msg['id'], format='full').execute()
        headers = msg_data['payload']['headers']
        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
        sender = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown')
        body = get_email_body(msg_data)

        print(f"\nProcessing: {subject}")
        classification = classify_email(sender, subject, body)
        print(classification)

        forward_urgent_to_whatsapp(sender, subject, classification)
        if 'NEEDS_REPLY: Yes' in classification:
            print("-> Drafting reply...")
            draft = draft_reply(sender, subject, body)
            if 'CANNOT_DRAFT' in draft:
                print("-> Not enough context to draft. Skipping.")
            else:
                save_draft(sender, subject, draft)
                drafts_created += 1
        else:
            print("-> No reply needed. Skipping.")

    print(f"\nDone. {drafts_created} draft(s) saved to /drafts folder.")

def forward_urgent_to_whatsapp(sender, subject, classification):
    if 'URGENCY: High' not in classification:
        return
    import urllib.request as ur
    import json as _json
    YOUR_NUMBER = '254743376683@s.whatsapp.net'
    message = f"📧 *Urgent Email Alert*\n\n*From:* {sender}\n*Subject:* {subject}\n\n⚠️ This email needs your attention. Check your email review dashboard."
    body = _json.dumps({'to': YOUR_NUMBER, 'message': message}).encode()
    try:
        req = ur.Request(
            'http://localhost:5001/send',
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        ur.urlopen(req)
        print(f'✓ Urgent email forwarded to WhatsApp')
    except Exception as e:
        print(f'WhatsApp forward failed: {e}')

if __name__ == '__main__':
    main()
