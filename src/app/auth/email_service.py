from __future__ import annotations

import os
import smtplib
from email.message import EmailMessage


def public_base_url() -> str:
    return (os.getenv("PUBLIC_BASE_URL") or "http://127.0.0.1:8000").strip().rstrip("/")


def send_email(to_email: str, subject: str, text: str) -> None:
    """Send email via SMTP if configured; otherwise prints to server logs."""
    host = (os.getenv("SMTP_HOST") or "").strip()
    user = (os.getenv("SMTP_USER") or "").strip()
    pwd = (os.getenv("SMTP_PASS") or "").strip()
    from_email = (os.getenv("SMTP_FROM") or user or "no-reply@example.com").strip()

    if not host:
        print("\n--- EMAIL (SMTP not configured) ---")
        print("To:", to_email)
        print("Subject:", subject)
        print(text)
        print("--- END EMAIL ---\n")
        return

    port = int(os.getenv("SMTP_PORT", "587"))
    use_tls = (os.getenv("SMTP_TLS") or "true").strip().lower() in ("1", "true", "yes")

    msg = EmailMessage()
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(text)

    with smtplib.SMTP(host, port, timeout=15) as s:
        if use_tls:
            s.starttls()
        if user and pwd:
            s.login(user, pwd)
        s.send_message(msg)
