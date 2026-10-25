#!/usr/bin/env python3
"""Send the morning Web Push (notification + app badge) to subscribed devices.

Needs two repository secrets:
  VAPID_PRIVATE_KEY  base64url private key matching the public key in web/index.html
  PUSH_SUBSCRIPTION  JSON from the app's "Copy connection code" button (one object, or a list)
Exits quietly when they are not set.
"""
import json, os, sys
from pathlib import Path

SITE = "https://vibhordube182-web.github.io/Iphone-apps-personal/"


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
    payload = json.dumps({
        "title": "Your morning edition is ready",
        "body": stories[0]["title"] if stories else "Open Lyceum to read today’s briefing.",
        "count": len(stories),
        "generated": edition["generated"],
    }, ensure_ascii=False)

    for i, sub in enumerate(subs):
        try:
            webpush(subscription_info=sub, data=payload, vapid_private_key=vapid,
                    vapid_claims={"sub": SITE}, ttl=6 * 3600)
            print(f"Pushed to device {i + 1}.")
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
