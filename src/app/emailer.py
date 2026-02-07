from __future__ import annotations

import os
import logging
import smtplib
from email.message import EmailMessage
from typing import Optional

import requests

log = logging.getLogger("news.email")

def _env_bool(name: str, default: bool = False) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def send_email(
    *,
    to_email: str,
    subject: str,
    html: str,
    text: Optional[str] = None,
) -> bool:
    """Send transactional email.

    Provider priority:
      1) Resend (if RESEND_API_KEY is set)  ✅ recommended
      2) SMTP (if SMTP_HOST is set)
      3) no-op (logs warning)
    """
    to_email = (to_email or "").strip()
    if not to_email:
        return False

    # 1) Resend
    resend_key = (os.getenv("RESEND_API_KEY") or "").strip()
    if resend_key:
        from_email = (os.getenv("FROM_EMAIL") or "").strip() or "CHECK news <onboarding@resend.dev>"
        try:
            r = requests.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {resend_key}", "Content-Type": "application/json"},
                json={
                    "from": from_email,
                    "to": [to_email],
                    "subject": subject,
                    "html": html,
                    **({"text": text} if text else {}),
                },
                timeout=20,
            )
            if 200 <= r.status_code < 300:
                return True
            log.warning("Resend send failed status=%s body=%s", r.status_code, (r.text or "")[:500])
            return False
        except Exception as e:
            log.exception("Resend send error: %s", e)
            return False

    # 2) SMTP
    smtp_host = (os.getenv("SMTP_HOST") or "").strip()
    if smtp_host:
        smtp_port = int((os.getenv("SMTP_PORT") or "587").strip())
        smtp_user = (os.getenv("SMTP_USER") or "").strip()
        smtp_pass = (os.getenv("SMTP_PASS") or "").strip()
        from_email = (os.getenv("FROM_EMAIL") or "").strip() or smtp_user or "no-reply@example.com"

        msg = EmailMessage()
        msg["From"] = from_email
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.set_content(text or "Open this email in an HTML-capable client.")
        msg.add_alternative(html, subtype="html")

        try:
            use_tls = _env_bool("SMTP_STARTTLS", True)
            with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as s:
                if use_tls:
                    s.starttls()
                if smtp_user:
                    s.login(smtp_user, smtp_pass)
                s.send_message(msg)
            return True
        except Exception as e:
            log.exception("SMTP send error: %s", e)
            return False

    log.warning("Email not sent: no provider configured (set RESEND_API_KEY or SMTP_HOST).")
    return False
