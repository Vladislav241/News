from __future__ import annotations

import os
import smtplib
from email.message import EmailMessage


def _smtp_settings() -> tuple[str, int, bool, str, str, str]:
    host = (os.getenv("SMTP_HOST") or "").strip()
    port = int(os.getenv("SMTP_PORT", "587"))
    use_tls = (os.getenv("SMTP_TLS") or "true").strip().lower() in ("1", "true", "yes")
    user = (os.getenv("SMTP_USER") or "").strip()
    pwd = (os.getenv("SMTP_PASS") or "").strip()
    from_email = (os.getenv("SMTP_FROM") or user or "no-reply@example.com").strip()
    return host, port, use_tls, user, pwd, from_email


def send_email(to_email: str, subject: str, *, text: str = "", html: str = "") -> None:
    """Send an email (text + optional HTML). If SMTP isn't configured, prints to logs."""
    host, port, use_tls, user, pwd, from_email = _smtp_settings()

    if not host:
        print("\n--- EMAIL (SMTP not configured) ---")
        print("To:", to_email)
        print("Subject:", subject)
        if text:
            print(text)
        if html:
            print("\n[HTML]\n", html)
        print("--- END EMAIL ---\n")
        return

    msg = EmailMessage()
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = subject

    # Always include a plain-text part (better deliverability)
    msg.set_content(text or "")
    if html:
        msg.add_alternative(html, subtype="html")

    with smtplib.SMTP(host, port, timeout=20) as s:
        if use_tls:
            s.starttls()
        if user and pwd:
            s.login(user, pwd)
        s.send_message(msg)
