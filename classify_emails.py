import os
from dotenv import load_dotenv
from groq import Groq
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
import base64
import email

load_dotenv()

SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

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
                return base64.urlsafe_b64decode(data).decode('utf-8')[:500]
        # fallback for single part emails
        data = msg['payload']['body'].get('data', '')
        if data:
            return base64.urlsafe_b64decode(data).decode('utf-8')[:500]
    except:
        return "Could not extract body"
    return "No body found"

def classify_email(sender, subject, body):
    prompt = f"""
You are an email classifier for a personal assistant.

Classify this email and respond in this exact format:
NEEDS_REPLY: Yes or No
URGENCY: Low, Medium, or High
TONE: Formal, Casual, or Ignore
REASON: one sentence explanation

Email details:
From: {sender}
Subject: {subject}
Body preview: {body}
"""
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content

def main():
    service = get_gmail_service()
    results = service.users().messages().list(userId='me', maxResults=5, q='is:unread').execute()
    messages = results.get('messages', [])

    if not messages:
        print('No unread messages found.')
        return

    for msg in messages:
        msg_data = service.users().messages().get(userId='me', id=msg['id'], format='full').execute()
        headers = msg_data['payload']['headers']
        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
        sender = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown')
        body = get_email_body(msg_data)

        print(f"\nFrom: {sender}")
        print(f"Subject: {subject}")
        print("--- AI Classification ---")
        classification = classify_email(sender, subject, body)
        print(classification)
        print("=" * 50)

if __name__ == '__main__':
    main()
