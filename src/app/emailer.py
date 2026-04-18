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


def _get_from_email(fallback: str = "no-reply@example.com", provider: Optional[str] = None) -> str:
    """Resolve the From header.

    For Resend, prefer RESEND_FROM first so tracking mail can use a verified
    Resend sender without depending on legacy SMTP vars.

    General priority:
      - Resend: RESEND_FROM -> EMAIL_FROM -> FROM_EMAIL -> SMTP_FROM
      - SMTP:   EMAIL_FROM -> FROM_EMAIL -> SMTP_FROM
    """
    provider = (provider or "").strip().lower()
    candidates = []
    if provider in ("resend", "resend.com"):
        candidates.append((os.getenv("RESEND_FROM") or "").strip())
    candidates.extend([
        (os.getenv("EMAIL_FROM") or "").strip(),
        (os.getenv("FROM_EMAIL") or "").strip(),
        (os.getenv("SMTP_FROM") or "").strip(),
    ])
    for value in candidates:
        if value:
            return value
    return fallback


def _provider(provider: Optional[str] = None) -> str:
    """Decide which email provider to use.

    Explicit provider wins. Otherwise EMAIL_PROVIDER is used. When neither is
    set, Resend is preferred for notification-style mail and SMTP is used as a
    fallback when Resend is unavailable.
    """
    p = (provider or os.getenv("EMAIL_PROVIDER") or "").strip().lower()
    if p:
        return p
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
    provider: Optional[str] = None,
) -> bool:
    """Send email using the selected provider."""

    to_email = (to_email or "").strip()
    if not to_email:
        return False

    provider = _provider(provider)

    # 1) Resend
    if provider in ("resend", "resend.com"):
        resend_key = (os.getenv("RESEND_API_KEY") or "").strip()
        if not resend_key:
            log.warning("Resend selected but RESEND_API_KEY is not set")
            return False

        from_email = _get_from_email("CHECK news <no-reply@checkne.com>", provider="resend")
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

    # 2) SMTP (AWS SES SMTP / Gmail SMTP / etc.)
    if provider == "smtp":
        smtp_host = (os.getenv("SMTP_HOST") or "").strip()
        if not smtp_host:
            log.warning("SMTP selected but SMTP_HOST is not set")
            return False

        smtp_port = int((os.getenv("SMTP_PORT") or "587").strip())
        smtp_user = (os.getenv("SMTP_USER") or "").strip()
        smtp_pass = (os.getenv("SMTP_PASS") or "").strip()

        # STARTTLS toggle (prefer SMTP_STARTTLS; also accept SMTP_TLS for convenience)
        use_tls = _env_bool("SMTP_STARTTLS", _env_bool("SMTP_TLS", True))

        from_email = _get_from_email(smtp_user or "no-reply@example.com", provider="smtp")

        msg = EmailMessage()
        msg["From"] = from_email
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.set_content(text or "Open this email in an HTML-capable client.")
        msg.add_alternative(html, subtype="html")

        try:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as s:
                # Be explicit (some servers are picky)
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

    log.warning("Email not sent: no provider configured (set EMAIL_PROVIDER + creds)")
    return False



def send_tracking_email(
    *,
    to_email: str,
    subject: str,
    html: str,
    text: Optional[str] = None,
) -> bool:
    """Send tracking/notification email. Prefer Resend, fall back to SMTP."""
    preferred = "resend" if (os.getenv("RESEND_API_KEY") or "").strip() else "smtp"
    ok = send_email(
        to_email=to_email,
        subject=subject,
        html=html,
        text=text,
        provider=preferred,
    )
    if ok or preferred == "smtp":
        return ok
    return send_email(
        to_email=to_email,
        subject=subject,
        html=html,
        text=text,
        provider="smtp",
    )
