from apscheduler.schedulers.blocking import BlockingScheduler
from summary import run_summary

scheduler = BlockingScheduler()

# Runs every day at 8:00 AM
scheduler.add_job(run_summary, 'cron', hour=7, minute=0)

print('Scheduler started — summary will run daily at 7:00 AM')
scheduler.start()
