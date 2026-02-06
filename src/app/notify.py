from __future__ import annotations

import asyncio
import hashlib
import os
from datetime import datetime, timezone
from typing import Any

from .db import db
from .emailer import send_email


def _public_base_url() -> str:
    return (os.getenv("PUBLIC_BASE_URL") or "http://127.0.0.1:8000").strip().rstrip("/")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except Exception:
        return default


def _email_html(payload: dict[str, Any]) -> str:
    """Simple, email-client friendly HTML that matches your screenshot vibe."""

    brand = "CHECK news."
    title = payload.get("title") or "Tracked event"
    source = payload.get("source") or ""
    score_from = payload.get("score_from")
    score_to = payload.get("score_to")
    outlets = payload.get("outlets")
    note = payload.get("note")
    action_url = payload.get("action_url") or _public_base_url()

    # Minimal inline CSS for broad email support
    return f"""<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="max-width:700px;margin:0 auto;padding:40px 18px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;font-weight:800;letter-spacing:0.5px;font-size:22px;">{brand}</div>
      </div>

      <div style="background:#ffffff;border-radius:18px;padding:34px 26px;box-shadow:0 10px 30px rgba(0,0,0,0.08);">
        <div style="text-align:center;font-size:34px;font-weight:700;line-height:1.2;">
          Trust score <span style="font-weight:900;">{payload.get('headline_emphasis','changed')}</span>
        </div>
        <div style="text-align:center;margin-top:10px;color:#475569;font-size:15px;">{payload.get('subheadline','New information has changed confidence in this event.')}</div>

        <div style="margin-top:28px;background:#f8fafc;border-radius:18px;padding:22px;">
          <div style="color:#94a3b8;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Article preview</div>

          <div style="margin-top:14px;background:#ffffff;border-radius:18px;padding:22px;box-shadow:0 10px 24px rgba(0,0,0,0.08);">
            <div style="font-size:18px;font-weight:800;line-height:1.25;">{title}</div>
            <div style="margin-top:8px;color:#94a3b8;font-size:12px;">{source}</div>
            <div style="height:1px;background:#e2e8f0;margin:16px 0;"></div>

            <div style="text-align:center;color:#64748b;font-size:13px;">Trust score</div>
            <div style="text-align:center;margin-top:6px;font-size:56px;font-weight:900;letter-spacing:-1px;">
              {score_from} <span style="color:#94a3b8;font-weight:700;font-size:44px;vertical-align:6px;">→</span> {score_to}
            </div>
            <div style="text-align:center;margin-top:6px;color:#94a3b8;font-size:13px;">{outlets} outlets</div>
          </div>

          <div style="margin-top:16px;color:#475569;font-size:13px;line-height:1.35;">{note}</div>

          <div style="text-align:center;margin-top:22px;">
            <a href="{action_url}" style="display:inline-block;background:#0b0b0c;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:14px;font-weight:800;">View update</a>
          </div>
        </div>

        <div style="margin-top:22px;text-align:center;color:#94a3b8;font-size:12px;">You’re receiving this email because you’re tracking this event.</div>
        <div style="margin-top:16px;text-align:center;color:#94a3b8;font-size:11px;line-height:1.4;">
          CHECK news is an informational service and does not provide factual determinations.<br/>
          Trust scores are based on automated analysis of publicly available sources and may change.
        </div>
      </div>
    </div>
  </body>
</html>"""


def _make_fingerprint(cluster_id: int, score: int, sources_count: int, updated_at: str | None) -> str:
    raw = f"{cluster_id}|{score}|{sources_count}|{updated_at or ''}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:20]


def _build_payload(user_email: str, cluster: dict[str, Any], score_from: int, score_to: int, outlets: int) -> dict[str, Any]:
    title = (cluster.get("title") or "Tracked event").strip()
    topic = (cluster.get("topic") or "general").strip()
    updated_at = cluster.get("updated_at")

    note = "The trust score changed as new sources introduced conflicting or incomplete information related to this event."
    if score_to > score_from:
        note = "The trust score increased as new sources strengthened confidence in this event."
    elif score_to < score_from:
        note = "The trust score decreased as new sources introduced conflicting or incomplete information related to this event."

    return {
        "headline_emphasis": "increased" if score_to > score_from else ("decreased" if score_to < score_from else "changed"),
        "subheadline": "New information has changed confidence in this event.",
        "title": title,
        "source": f"Topic: {topic} · Updated {updated_at or ''}",
        "score_from": score_from,
        "score_to": score_to,
        "outlets": outlets,
        "note": note,
        "action_url": f"{_public_base_url()}/?tracking=1&cluster={int(cluster.get('id') or 0)}",
    }


async def _notify_once() -> None:
    db.connect()
    db.ensure_schema()

    targets = db.get_email_alert_targets(limit=200)
    if not targets:
        return

    for t in targets:
        user_id = int(t["user_id"])
        user_email = (t.get("user_email") or "").strip()
        if not user_email:
            continue

        cluster_id = int(t["cluster_id"])

        cluster = db.get_cluster_meta(cluster_id)
        if not cluster:
            continue

        score_row = db.get_score(cluster_id) or {}
        score_now = _safe_int(score_row.get("credibility_score"), 0)

        sources = db.get_cluster_sources(cluster_id)
        outlets_now = len(sources)

        fingerprint = _make_fingerprint(cluster_id, score_now, outlets_now, cluster.get("updated_at"))
        last_fp = (t.get("last_notified_fingerprint") or "").strip()

        # First run: set baseline without sending anything
        if not last_fp:
            db.mark_email_alert_notified(user_id, cluster_id, score_now, outlets_now, fingerprint, _utc_now_iso())
            continue

        if last_fp == fingerprint:
            continue

        last_score = t.get("last_notified_score")
        score_from = _safe_int(last_score, score_now)

        payload = _build_payload(user_email, cluster, score_from, score_now, outlets_now)
        html = _email_html(payload)

        subject = f"CHECK news: Trust score {payload['headline_emphasis']} ({score_from} → {score_now})"
        text = f"{payload['title']}\nTrust score: {score_from} -> {score_now}\nOutlets: {outlets_now}\n{payload['action_url']}"

        try:
            send_email(user_email, subject, text=text, html=html)
            db.mark_email_alert_notified(user_id, cluster_id, score_now, outlets_now, fingerprint, _utc_now_iso())
        except Exception as e:
            print("notify email error:", e)


async def notify_loop(stop_event: asyncio.Event) -> None:
    poll = int(os.getenv("EMAIL_ALERT_POLL_SECONDS", "120"))
    poll = max(30, min(3600, poll))

    print(f"INFO:news.notify:notify loop started (poll={poll}s)")

    while not stop_event.is_set():
        try:
            await _notify_once()
        except Exception as e:
            print("ERROR:news.notify:notify loop error:", e)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=poll)
        except asyncio.TimeoutError:
            pass

    print("INFO:news.notify:notify loop stopped")
