from __future__ import annotations

import os
import time
import threading
import logging
import smtplib
from email.message import EmailMessage
from typing import Optional

import requests

log = logging.getLogger("news.email")

# -----------------
# Simple global throttling
# -----------------

_send_lock = threading.Lock()
_last_send_ts = 0.0


def _throttle() -> None:
    """Best-effort rate limiting (prevents provider 429s).

    Configure with EMAIL_RATE_LIMIT_PER_SEC (default: 1 email/sec).
    """
    global _last_send_ts
    try:
        rate = float(os.getenv("EMAIL_RATE_LIMIT_PER_SEC", "1").strip())
    except Exception:
        rate = 1.0
    if rate <= 0:
        return
    min_interval = 1.0 / rate
    with _send_lock:
        now = time.monotonic()
        sleep_for = (_last_send_ts + min_interval) - now
        if sleep_for > 0:
            time.sleep(sleep_for)
        _last_send_ts = time.monotonic()

def _env_bool(name: str, default: bool = False) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _from_email() -> str:
    """Pick From address.

    Prefer EMAIL_FROM (used elsewhere in this app), then SMTP_FROM, then legacy FROM_EMAIL.
    """
    return (
        (os.getenv("EMAIL_FROM") or "").strip()
        or (os.getenv("SMTP_FROM") or "").strip()
        or (os.getenv("FROM_EMAIL") or "").strip()
        or "CHECK news <no-reply@checkne.com>"
    )


def _provider() -> str:
    """Choose provider.

    EMAIL_PROVIDER can be: resend | smtp | auto
    """
    p = (os.getenv("EMAIL_PROVIDER") or "auto").strip().lower()
    if p in {"resend", "smtp"}:
        return p
    # auto
    if (os.getenv("RESEND_API_KEY") or "").strip():
        return "resend"
    if (os.getenv("SMTP_HOST") or "").strip():
        return "smtp"
    return "none"


def send_email(
    *,
    to_email: str,
    subject: str,
    html: str,
    text: Optional[str] = None,
) -> bool:
    """Send transactional email.

    Provider selection:
      - EMAIL_PROVIDER=resend|smtp|auto (default auto)
      - auto prefers Resend if RESEND_API_KEY is set, else SMTP if SMTP_HOST is set.

    Note: We also throttle sends (EMAIL_RATE_LIMIT_PER_SEC) to avoid 429 rate limits.
    """
    to_email = (to_email or "").strip()
    if not to_email:
        return False

    provider = _provider()
    if provider == "none":
        log.warning("Email not sent: no provider configured (set RESEND_API_KEY or SMTP_HOST).")
        return False

    _throttle()

    if provider == "resend":
        resend_key = (os.getenv("RESEND_API_KEY") or "").strip()
        if not resend_key:
            log.warning("Email not sent: EMAIL_PROVIDER=resend but RESEND_API_KEY is missing.")
            return False

        from_email = _from_email()  # IMPORTANT: must be a verified sender in Resend
        try:
            # 2 attempts: immediate + short backoff for transient 429
            for attempt in range(2):
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
                if r.status_code == 429 and attempt == 0:
                    time.sleep(0.6)
                    continue
                log.warning("Resend send failed status=%s body=%s", r.status_code, (r.text or "")[:500])
                return False
            return False
        except Exception as e:
            log.exception("Resend send error: %s", e)
            return False

    # SMTP (AWS SES SMTP uses this)
    smtp_host = (os.getenv("SMTP_HOST") or "").strip()
    if not smtp_host:
        log.warning("Email not sent: EMAIL_PROVIDER=smtp but SMTP_HOST is missing.")
        return False

    smtp_port = int((os.getenv("SMTP_PORT") or "587").strip())
    smtp_user = (os.getenv("SMTP_USER") or "").strip()
    smtp_pass = (os.getenv("SMTP_PASS") or "").strip()
    from_email = _from_email() or smtp_user or "no-reply@example.com"

    msg = EmailMessage()
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(text or "Open this email in an HTML-capable client.")
    msg.add_alternative(html, subtype="html")

    try:
        # Support both env names. Your .env uses SMTP_TLS.
        use_tls = _env_bool("SMTP_TLS", _env_bool("SMTP_STARTTLS", True))
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as s:
            s.ehlo()
            if use_tls:
                s.starttls()
                s.ehlo()
            if smtp_user:
                s.login(smtp_user, smtp_pass)
            s.send_message(msg)
        return True
    except Exception as e:
        log.exception("SMTP send error: %s", e)
        return False
