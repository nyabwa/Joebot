import os
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_KEY")
)

def save_email_draft(to, subject, draft, urgency='Low', tone='Formal'):
    result = supabase.table('email_drafts').insert({
        'to': to,
        'subject': subject,
        'draft': draft,
        'status': 'pending_review',
        'urgency': urgency,
        'tone': tone
    }).execute()
    return result.data[0]['id']

def save_wa_draft(sender, original_message, detected_language, draft_reply):
    result = supabase.table('wa_drafts').insert({
        'from': sender,
        'original_message': original_message,
        'detected_language': detected_language,
        'draft_reply': draft_reply,
        'status': 'pending_review'
    }).execute()
    return result.data[0]['id']

def get_email_drafts(status=None):
    query = supabase.table('email_drafts').select('*').order('created_at', desc=True)
    if status:
        query = query.eq('status', status)
    return query.execute().data

def get_wa_drafts(status=None):
    query = supabase.table('wa_drafts').select('*').order('created_at', desc=True)
    if status:
        query = query.eq('status', status)
    return query.execute().data

def update_status(table, record_id, status):
    supabase.table(table).update({'status': status}).eq('id', record_id).execute()
def add_contact(name, phone=None, email=None, relationship=None, priority='normal', notes=None):
    result = supabase.table('contacts').insert({
        'name': name,
        'phone': phone,
        'email': email,
        'relationship': relationship,
        'priority': priority,
        'notes': notes
    }).execute()
    return result.data[0]['id']

def get_contacts():
    return supabase.table('contacts').select('*').order('priority').execute().data

def get_contact_by_phone(phone):
    result = supabase.table('contacts').select('*').ilike('phone', f'%{phone}%').execute()
    return result.data[0] if result.data else None

def get_contact_by_email(email):
    result = supabase.table('contacts').select('*').ilike('email', f'%{email}%').execute()
    return result.data[0] if result.data else None

def lock_contact(phone, reason=None):
    supabase.table('locked_contacts').upsert({
        'phone': phone,
        'reason': reason
    }).execute()

def unlock_contact(phone):
    supabase.table('locked_contacts').delete().eq('phone', phone).execute()

def is_locked(phone):
    result = supabase.table('locked_contacts').select('*').eq('phone', phone).execute()
    return len(result.data) > 0

def add_todo(task):
    result = supabase.table('todos').insert({'task': task, 'status': 'pending'}).execute()
    return result.data[0]['id']

def get_todos(status=None):
    query = supabase.table('todos').select('*').order('created_at', desc=False)
    if status:
        query = query.eq('status', status)
    return query.execute().data

def complete_todo(todo_number):
    todos = supabase.table('todos').select('*').eq('status', 'pending').order('created_at').execute().data
    if not todos or todo_number > len(todos):
        return False
    todo_id = todos[todo_number - 1]['id']
    from datetime import datetime
    supabase.table('todos').update({
        'status': 'done',
        'completed_at': datetime.utcnow().isoformat()
    }).eq('id', todo_id).execute()
    return todos[todo_number - 1]['task']
