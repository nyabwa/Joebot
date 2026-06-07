import os
from datetime import datetime, timedelta
from dotenv import load_dotenv
from groq import Groq
from db import supabase
import urllib.request
import json

load_dotenv()

YOUR_WHATSAPP_NUMBER = '254785998674@s.whatsapp.net'  # e.g. 254712345678@s.whatsapp.net

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

def get_yesterdays_stats():
    now = datetime.utcnow()
    since = (now - timedelta(hours=24)).isoformat()

    email_drafts = supabase.table('email_drafts').select('*').gte('created_at', since).execute().data
    wa_drafts = supabase.table('wa_drafts').select('*').gte('created_at', since).execute().data

    email_sent = [d for d in email_drafts if d['status'] == 'sent']
    email_pending = [d for d in email_drafts if d['status'] == 'pending_review']
    email_skipped = [d for d in email_drafts if d['status'] == 'skipped']

    wa_sent = [d for d in wa_drafts if d['status'] == 'sent']
    wa_pending = [d for d in wa_drafts if d['status'] == 'pending_review']

    return {
        'email': {
            'total': len(email_drafts),
            'sent': len(email_sent),
            'pending': len(email_pending),
            'skipped': len(email_skipped),
            'samples': [d['subject'] for d in email_sent[:3]]
        },
        'whatsapp': {
            'total': len(wa_drafts),
            'sent': len(wa_sent),
            'pending': len(wa_pending),
            'samples': [d['original_message'][:40] for d in wa_sent[:3]]
        }
    }

def generate_summary(stats):
    prompt = f"""Generate a short friendly morning WhatsApp summary message for Joseph.
Keep it under 10 lines. Use simple formatting with emojis.

Last 24 hours stats:
- Emails processed: {stats['email']['total']}
- Emails sent: {stats['email']['sent']}
- Emails pending review: {stats['email']['pending']}
- WhatsApp messages handled: {stats['whatsapp']['total']}
- WhatsApp auto-replied: {stats['whatsapp']['sent']}
- WhatsApp pending review: {stats['whatsapp']['pending']}
- Sample emails handled: {stats['email']['samples']}
- Sample WA messages: {stats['whatsapp']['samples']}

Start with "Good morning Joseph 👋" and end with a motivational one-liner."""

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content

def send_whatsapp_summary(message):
    body = json.dumps({'to': YOUR_WHATSAPP_NUMBER, 'message': message}).encode()
    req = urllib.request.Request(
        'http://localhost:5001/send',
        data=body,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    urllib.request.urlopen(req)
    print(f'✓ Summary sent at {datetime.now().strftime("%H:%M")}')

BIBLE_VERSES = [
    ("Jeremiah 29:11", "For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future."),
    ("Philippians 4:13", "I can do all things through Christ who strengthens me."),
    ("Proverbs 3:5-6", "Trust in the Lord with all your heart and lean not on your own understanding; in all your ways submit to him, and he will make your paths straight."),
    ("Isaiah 41:10", "So do not fear, for I am with you; do not be dismayed, for I am your God. I will strengthen you and help you."),
    ("Psalm 23:1", "The Lord is my shepherd, I lack nothing."),
    ("Romans 8:28", "And we know that in all things God works for the good of those who love him."),
    ("Matthew 6:33", "But seek first his kingdom and his righteousness, and all these things will be given to you as well."),
    ("Psalm 46:1", "God is our refuge and strength, an ever-present help in trouble."),
    ("Joshua 1:9", "Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go."),
    ("2 Timothy 1:7", "For God has not given us a spirit of fear, but of power, love and a sound mind."),
    ("Psalm 118:24", "This is the day the Lord has made; let us rejoice and be glad in it."),
    ("Lamentations 3:22-23", "The steadfast love of the Lord never ceases; his mercies never come to an end; they are new every morning."),
    ("Proverbs 16:3", "Commit to the Lord whatever you do, and he will establish your plans."),
    ("Psalm 28:7", "The Lord is my strength and my shield; my heart trusts in him, and he helps me."),
    ("Ephesians 3:20", "Now to him who is able to do immeasurably more than all we ask or imagine, according to his power that is at work within us."),
]

def get_daily_verse():
    day_of_year = datetime.utcnow().timetuple().tm_yday
    verse = BIBLE_VERSES[day_of_year % len(BIBLE_VERSES)]
    return verse[0], verse[1]

def post_whatsapp_status():
    reference, text = get_daily_verse()
    verse_message = f"📖 *Daily Verse — {reference}*\n\n_{text}_\n\n🙏 Have a blessed day, Joseph."

    body = json.dumps({
        'to': YOUR_WHATSAPP_NUMBER,
        'message': verse_message
    }).encode()

    try:
        req = urllib.request.Request(
            'http://localhost:5001/send',
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        urllib.request.urlopen(req)
        print(f'✓ Bible verse sent to your number: {reference}')
    except Exception as e:
        print(f'Verse send failed: {e}')

def run_summary():
    print('Generating daily summary...')
    stats = get_yesterdays_stats()
    summary = generate_summary(stats)
    print(summary)
    send_whatsapp_summary(summary)
    post_whatsapp_status()

if __name__ == '__main__':
    run_summary()

