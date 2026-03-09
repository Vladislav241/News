from __future__ import annotations

import os
import asyncio
import logging
import hashlib
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import quote

from .db import db
from .emailer import send_email
from .unsubscribe_tokens import create_unsubscribe_token

log = logging.getLogger("news.notify")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _base_url() -> str:
    # Prefer explicit public URL
    env = (os.getenv("APP_BASE_URL") or os.getenv("PUBLIC_BASE_URL") or "").strip()
    if env:
        return env.rstrip("/")
    # Project default (your Render app). You can override with APP_BASE_URL.
    return "https://news-app-qxvw.onrender.com"


def _min_interval_seconds() -> int:
    try:
        return int((os.getenv("EMAIL_NOTIFY_MIN_SECONDS") or "600").strip())
    except Exception:
        return 600


def _email_logo_url() -> str:
    """Public logo URL for emails.

    NOTE: Many email clients (esp. Gmail) block `data:` images and may not
    reliably render SVG. A PNG served from your app is the most compatible.
    """
    return f"{_base_url()}/static/icons/LogoEmail.png"



def _build_email_html(
    *,
    user_id: int,
    to_email: str,
    cluster_id: int,
    title: str,
    primary_source: str,
    old_score: int,
    new_score: int,
    outlets: int,
) -> tuple[str, str]:
    """Return (subject, html)"""
    base = _base_url()

    if new_score > old_score:
        direction = "increased"
        expl = "strengthened confidence in this event."
    elif new_score < old_score:
        direction = "decreased"
        expl = "reduced confidence in this event."
    else:
        direction = "updated"
        expl = "recalculated confidence in this event."

    subject = f"CHECK news — Trust score {direction}: {old_score} → {new_score}"
    view_url = f"{base}/share/{cluster_id}"

    company_name = (os.getenv("COMPANY_NAME") or "CHECKNE").strip()
    company_addr = (os.getenv("COMPANY_POSTAL_ADDRESS") or "Berlin, Germany").strip()
    support_email = (os.getenv("SUPPORT_EMAIL") or "support@checkne.com").strip()
    # One-click unsubscribe token (alerts only)
    try:
        unsub_token = create_unsubscribe_token(int(user_id), to_email)
    except Exception:
        unsub_token = ""
    unsub_url = f"{base}/unsubscribe?token={quote(unsub_token)}" if unsub_token else f"{base}/#/tracking"

    # Styling notes:
    # - Table layout + inline styles for Gmail/Outlook reliability
    # - Inter font if available, with safe fallbacks
    # - Avoid `data:` images and avoid SVG in email (often blocked / unreliable)
    logo_url = _email_logo_url()

    # Only the word (increased/decreased/updated) is bold in the title line.
    title_line = f'Trust score <span style="font-weight:300;">{direction}</span> for a tracked event'

    # Simple arrow glyph is the most compatible across email clients.



    safe_title = (title or "").strip() or "Tracked event"
    safe_source = (primary_source or "").strip()

    html = f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>{subject}</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;600;800&display=swap" rel="stylesheet">
  </head>
  <body style="margin:0;padding:0;background:#ffffff;font-family:Inter,Arial,sans-serif;color:#0b0b0b;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff;">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table width="720" cellpadding="0" cellspacing="0" role="presentation" style="max-width:720px;width:100%;">
            <!-- Header -->
            <tr>
              <td align="center" style="padding:10px 0 66px;">
                <img src="{logo_url}" alt="CHECK news" style="height:55px;display:block;border:0;"/>
              </td>
            </tr>

            <!-- Title -->
            <tr>
              <td align="center" style="padding:0 0 10px;">
                <div style="font-size:34px;line-height:1.12;font-weight:200;letter-spacing:-0.6px;">
                  {title_line}
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 0 26px;">
                <div style="font-size:20px;line-height:1.4;color:#6b6b6b;">
                  New information has {expl}
                </div>
              </td>
            </tr>

            <!-- Card (outer + inner) -->
            <tr>
              <td style="padding:0 10px;">
                <!-- OUTER CARD -->
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                  style="border:1px solid #e5e5e5;border-radius:22px;background:#ffffff;">
                  <tr>
                    <td style="padding:22px;">
                     <div style="font-size:14px;letter-spacing:0.12em;color:#a1a1a1;font-weight:300;">
                              ARTICLE PREVIEW
                            </div>

                      <!-- INNER CARD (shadow) -->
                      <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                        style="margin-top:14px;background:#ffffff;border-radius:18px;box-shadow:0 10px 28px rgba(0,0,0,0.10);">
                        <tr>
                          <td style="padding:22px 22px 18px;">


                           <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:14px;">
                            <tr>
                              <!-- Title -->
                              <td align="left" style="
                                font-size:25px;
                                line-height:1.25;
                                font-weight:400;
                                letter-spacing:-0.3px;
                                padding-right:12px;
                              ">
                                {safe_title}
                              </td>
                            </tr>
                            <tr>
                              <!-- Source right -->
                              <td align="right" style="
                                padding-top:8px;
                                font-size:18px;
                                color:#7a7a7a;
                                white-space:nowrap;
                              ">
                                {safe_source}
                              </td>
                            </tr>
                          </table>


                            <!-- Divider line -->
                            <div style="margin:18px 0 18px;height:1px;background:#e8e8e8;"></div>

                            <div style="margin-top:0;text-align:center;font-size:18px;color:#7a7a7a;font-weight:300;">
                              Trust score
                            </div>

                           <table cellpadding="0" cellspacing="0" role="presentation" align="center" style="margin:10px auto 0;">
                          <tr>
                            <td align="right" valign="middle" style="font-size:42px;line-height:1;font-weight:800;padding-right:14px;">
                              {old_score}
                            </td>
                            <td align="center" valign="middle" style="padding:0 18px;">
                            <img src="{base}/static/icons/Arrow.png"
                            width="120"
                            alt="→"
                            style="display:block;border:0;outline:none;text-decoration:none;width:120px;height:auto;">
                          </td>
                            <td align="left" valign="middle" style="font-size:42px;line-height:1;font-weight:800;padding-left:14px;">
                              {new_score}
                            </td>
                          </tr>
                        </table>

                            <div style="margin-top:12px;text-align:center;font-size:18px;color:#7a7a7a;">
                              {outlets} outlets
                            </div>

                          </td>
                        </tr>
                      </table>

                      <div style="margin-top:18px;font-size:16px;line-height:1.5;color:#3f3f3f;">
                        The trust score {direction} as additional independent sources confirmed key details of this event.
                      </div>

                      <div style="margin-top:22px;text-align:center;">
                        <a href="{view_url}"
                          style="display:inline-block;background:#000;color:#fff;text-decoration:none;
                                  padding:13px 175px;border-radius:12px;font-weight:800;font-size:20px;">
                          View update
                        </a>
                      </div>

                    </td>
                  </tr>
                </table>
              </td>
            </tr>


            <!-- Footer -->
            <tr>
              <td align="center" style="padding:28px 14px 0;color:#8a8a8a;font-size:13px;line-height:1.5;">
                You’re receiving this email because you’re tracking this event.

                <!-- Divider -->
                <div style="margin:20px 0;height:1px;background:#e5e5e5; max-width:610px;"></div>

                <div>
                  CHECK news is an informational service and does not provide factual determinations.<br>
                  Trust scores are based on automated analysis of publicly available sources<br> and may change as new information becomes available.
                </div>
                <div style="margin-top:14px;">
                  <a href="{unsub_url}" style="color:#111;text-decoration:underline;">Unsubscribe from alerts</a>
                  &nbsp;•&nbsp;
                  <a href="{base}/#/tracking" style="color:#111;text-decoration:underline;">Manage email alerts</a>
                  &nbsp;•&nbsp;
                  <a href="mailto:{support_email}" style="color:#111;text-decoration:underline;">{support_email}</a>
                </div>
                <div style="margin-top:10px;color:#777;">
                  {company_name} • {company_addr}
                </div>
              </td>
            </tr>


          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""
    return subject, html


async def notify_loop() -> None:
    """Background loop: send emails when tracked events change score."""
    interval = int((os.getenv("EMAIL_NOTIFY_POLL_SECONDS") or "120").strip() or "120")
    log.info("notify loop started (poll=%ss)", interval)

    while True:
        try:
            await _notify_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("notify loop error: %s", e)
        await asyncio.sleep(interval)


async def _notify_once() -> None:
    db.ensure_schema()

    targets = db.get_email_alert_targets(limit=200)
    if not targets:
        return

    base = _base_url()
    min_int = _min_interval_seconds()
    now = _utc_now()

    # Fetch clusters in one query
    ids = [int(r["cluster_id"]) for r in targets]
    clusters = {int(c["id"]): c for c in db.get_clusters_by_ids(ids)}

    for t in targets:
        uid = int(t["user_id"])
        cid = int(t["cluster_id"])
        email = (t.get("user_email") or "").strip()

        # Require verified for local accounts if REQUIRE_EMAIL_VERIFIED is on
        enforce = (os.getenv("REQUIRE_EMAIL_VERIFIED") or "").strip().lower() not in ("0","false","no","off")  # default: True
        if enforce and not bool(int(t.get("user_email_verified") or 0)):
            continue

        c = clusters.get(cid)
        if not c:
            continue

        # Score can be stored under different keys depending on the join/state.
        # Prefer the computed credibility_score; fall back to other possible fields.
        score_raw = (
            c.get("credibility_score")
            if c.get("credibility_score") is not None
            else c.get("trust_score")
            if c.get("trust_score") is not None
            else c.get("score")
        )
        try:
            new_score = int(score_raw or 0)
        except Exception:
            new_score = 0

        brief = db.get_cluster_sources_brief(cid) or {}
        try:
            outlets = int(brief.get("sources_count") or 0)
        except Exception:
            outlets = 0
        primary_source = str(brief.get("primary_source") or "").strip()
        title = str(c.get("title") or "").strip()

        # Compute fingerprint (stable per update)
        fp_src = f"{cid}|{c.get('updated_at') or ''}|{new_score}|{outlets}"
        fingerprint = hashlib.sha1(fp_src.encode("utf-8")).hexdigest()[:24]

        prev_fp = (t.get("last_notified_fingerprint") or "").strip()
        prev_score = t.get("last_notified_score")
        prev_sources = t.get("last_notified_sources_count")
        last_at = _parse_dt(t.get("last_notified_at"))

        # First-time: snapshot only (no email)
        if prev_score is None:
            db.update_email_alert_notified_state(
                uid, cid,
                new_score=new_score,
                new_sources_count=outlets,
                fingerprint=fingerprint,
                notified_at_iso=now.isoformat(),
            )
            continue

        try:
            old_score = int(prev_score)
        except Exception:
            old_score = new_score

        # If score didn't change, don't email (users complain about "87 → 87").
        # Still update the stored state to avoid repeated notifications.
        if new_score == old_score:
            db.update_email_alert_notified_state(
                uid,
                cid,
                new_score=new_score,
                new_sources_count=outlets,
                fingerprint=fingerprint,
                notified_at_iso=now.isoformat(),
            )
            continue

        # Rate limit
        if last_at and last_at.tzinfo is None:
            last_at = last_at.replace(tzinfo=timezone.utc)
        if last_at and (now - last_at).total_seconds() < min_int:
            log.info(
                "skip notify (rate-limit) user=%s cluster=%s last=%s min=%ss",
                uid,
                cid,
                last_at.isoformat(),
                min_int,
            )
            continue

        # Build + send
        subject, html = _build_email_html(
            user_id=uid,
            to_email=email,
            cluster_id=cid,
            title=title,
            primary_source=primary_source,
            old_score=old_score,
            new_score=new_score,
            outlets=outlets,
        )
        ok = send_email(
            to_email=email,
            subject=subject,
            html=html,
            text=f"Trust score {old_score} -> {new_score}. View: {base}/share/{cid}",
        )
        if ok:
            log.info("email sent user=%s cluster=%s to=%s", uid, cid, email)
        else:
            log.warning("email NOT sent user=%s cluster=%s to=%s", uid, cid, email)
        log.info("notify send user=%s cluster=%s to=%s ok=%s", uid, cid, email, ok)
        if ok:
            db.update_email_alert_notified_state(
                uid, cid,
                new_score=new_score,
                new_sources_count=outlets,
                fingerprint=fingerprint,
                notified_at_iso=now.isoformat(),
            )
