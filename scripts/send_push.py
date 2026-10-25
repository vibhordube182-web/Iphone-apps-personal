#!/usr/bin/env python3
"""Send the morning Web Push (notification + app badge) to subscribed devices.

Needs two repository secrets:
  VAPID_PRIVATE_KEY  base64url private key matching the public key in web/index.html
  PUSH_SUBSCRIPTION  JSON from the app's "Copy connection code" button (one object, or a list)
Exits quietly when they are not set.
"""
import json, os, sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

SITE = "https://vibhordube182-web.github.io/Iphone-apps-personal/"
NAME = "Vibhor"

# Four daily nudges, Melbourne time. No headlines: just a reason to open the app.
SLOTS = {
    "morning": ("Good morning, " + NAME, [
        "Your edition is ready. Know the world before it knows you.",
        "A sharp mind starts with a sharp morning. Your briefing is waiting.",
        "Five minutes of reading now beats an hour of scrolling later.",
        "The world moved overnight. Catch up before the day catches you.",
        "Discipline is a morning decision. Open your edition.",
        "Today’s Logos and your reading are waiting for you.",
    ]),
    "midday": ("Midday reset", [
        "Two minutes, a clearer head. See what changed this morning.",
        "Step away from the noise and read what actually matters.",
        "Keep the streak alive. Your edition has been refreshed.",
        "Small habits, big results. Take your midday read.",
        "Curiosity is a muscle. Give it a quick workout.",
        "Pause. Breathe. Catch up on the world.",
    ]),
    "evening": ("Evening edition", [
        "Close the day informed, not overwhelmed. Your edition is updated.",
        "Finish what you started this morning. Your stories are waiting.",
        "A few minutes now, and tomorrow starts ahead of the crowd.",
        "End the day with a clear picture of the world.",
        "Ambition is built in the hours after work. Read, then reflect.",
        "Your unread stories are still here. Make the time.",
    ]),
    "night": ("Before you switch off", [
        "One last look at the world, then rest. Tomorrow needs you sharp.",
        "Read something worth thinking about before sleep.",
        "Finish your reading and close the day well.",
        "Rest is part of discipline. One last read, then lights out.",
        "Today’s reading is waiting. Mark it done and sleep easy.",
        "Know thyself: did you read today? There is still time.",
    ]),
}


SLOT_HOURS = (6, 12, 17, 21)   # local hours at which a scheduled run sends
DEFAULT_TZ = "Australia/Melbourne"


def slot_for(now):
    h = now.hour
    return "morning" if h < 10 else "midday" if h < 15 else "evening" if h < 19 else "night"


def local_now(tz_name):
    try:
        return datetime.now(ZoneInfo(tz_name or DEFAULT_TZ))
    except Exception:
        return datetime.now(ZoneInfo(DEFAULT_TZ))


def main():
    key = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    raw = os.environ.get("PUSH_SUBSCRIPTION", "").strip()
    if not key or not raw:
        print("Push not configured; skipping.")
        return
    from pywebpush import webpush, WebPushException
    from py_vapid import Vapid

    vapid = Vapid.from_string(key)
    vapid.conf = {"no-strict": True}  # contact is the site URL (allowed by RFC 8292), not an email address

    subs = json.loads(raw)
    if isinstance(subs, dict):
        subs = [subs]
    edition = json.loads(Path("web/news.json").read_text())
    stories = edition["stories"]
    scheduled = os.environ.get("EVENT") == "schedule"

    for i, sub in enumerate(subs):
        # "tz" is added by the app's connection code; the push service must not see it.
        now = local_now(sub.pop("tz", None))
        if scheduled and now.hour not in SLOT_HOURS:
            print(f"Device {i + 1}: {now:%H:%M} local, not an alert hour; skipping.")
            continue
        slot = slot_for(now)
        title, messages = SLOTS[slot]
        payload = json.dumps({
            "title": title,
            "body": messages[(now.timetuple().tm_yday + now.hour) % len(messages)],
            "count": len(stories),
            "tag": "lyceum-" + slot,
            "generated": edition["generated"],
        }, ensure_ascii=False)
        try:
            webpush(subscription_info=sub, data=payload, vapid_private_key=vapid,
                    vapid_claims={"sub": SITE}, ttl=6 * 3600)
            print(f"Pushed to device {i + 1} ({slot}, {now:%H:%M} local).")
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            print(f"::warning::Push to device {i + 1} failed ({status}): {e}")
            if status in (404, 410):
                print("::warning::That subscription has expired. Open Lyceum, tap Morning alert, and copy a fresh connection code.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never fail the deploy because of push
        print(f"::warning::Push step errored: {e}")
