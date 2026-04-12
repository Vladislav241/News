from __future__ import annotations

import html
import os
import smtplib
from email.message import EmailMessage


def public_base_url() -> str:
    return (os.getenv("PUBLIC_BASE_URL") or "http://127.0.0.1:8000").strip().rstrip("/")


def _brand_email_html(*, eyebrow: str, title: str, body: str, cta_label: str, cta_url: str, fallback_label: str, footer_note: str) -> str:
    eyebrow = html.escape(eyebrow)
    title = html.escape(title)
    body_html = "<br>".join(html.escape(line) for line in body.split("\n") if line.strip())
    cta_label = html.escape(cta_label)
    cta_url_escaped = html.escape(cta_url, quote=True)
    fallback_label = html.escape(fallback_label)
    footer_note = html.escape(footer_note)
    return f"""<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f8;font-family:Inter,Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f8;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;background:#ffffff;border:1px solid #e5e7eb;border-radius:28px;overflow:hidden;">
            <tr>
              <td style="padding:40px 38px 18px 38px;">
                <div style="font-size:36px;line-height:1;font-weight:800;letter-spacing:-0.04em;color:#0a1646;">CHECKNE.</div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 38px 12px 38px;">
                <div style="font-size:16px;line-height:1.4;letter-spacing:0.12em;font-weight:700;color:#8a90a3;text-transform:uppercase;">{eyebrow}</div>
                <div style="margin-top:14px;font-size:64px;line-height:0.98;font-weight:500;letter-spacing:-0.06em;color:#0a1646;">{title}</div>
                <div style="margin-top:26px;font-size:22px;line-height:1.6;color:#5d6475;max-width:620px;">{body_html}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 38px 0 38px;">
                <table role="presentation" cellspacing="0" cellpadding="0">
                  <tr>
                    <td bgcolor="#0b0b12" style="border-radius:20px;">
                      <a href="{cta_url_escaped}" target="_blank" style="display:inline-block;padding:20px 34px;font-size:26px;line-height:1;font-weight:700;color:#ffffff;text-decoration:none;border-radius:20px;background:#0b0b12;">{cta_label}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 38px 0 38px;">
                <div style="font-size:18px;line-height:1.5;font-weight:700;color:#141821;">Button not working? Use this link</div>
                <div style="margin-top:10px;word-break:break-all;">
                  <a href="{cta_url_escaped}" target="_blank" style="font-size:16px;line-height:1.6;color:#111827;text-decoration:underline;">{fallback_label}</a>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 38px 0 38px;">
                <div style="background:#f4f4f7;border:1px solid #e6e7ee;border-radius:24px;padding:24px 28px;font-size:16px;line-height:1.6;color:#666d80;">{footer_note}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 38px 40px 38px;">
                <div style="border-top:1px solid #e6e7ee;padding-top:26px;font-size:16px;line-height:1.6;color:#8a90a3;">Sent by CHECKNE. If you didn't request this email, you can safely ignore it.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


def build_verify_email(link: str) -> tuple[str, str]:
    text = (
        "Verify your email for CHECKNE.\n\n"
        f"Open this link to verify your email:\n{link}\n\n"
        "If the button is not working, copy the link into your browser.\n"
        "If you didn't sign up, ignore this email."
    )
    html_msg = _brand_email_html(
        eyebrow="Account security",
        title="Verify your email",
        body="Finish setting up your CHECKNE account to unlock tracking, saved events, and trust-change alerts.",
        cta_label="Verify email",
        cta_url=link,
        fallback_label=link,
        footer_note="This verification link expires automatically for security reasons.",
    )
    return text, html_msg


def build_reset_email(link: str) -> tuple[str, str]:
    text = (
        "Reset your CHECKNE password.\n\n"
        f"Open this link to set a new password:\n{link}\n\n"
        "If you didn't request a password reset, ignore this email."
    )
    html_msg = _brand_email_html(
        eyebrow="Account recovery",
        title="Reset your password",
        body="Use the secure button below to choose a new password for your CHECKNE account.",
        cta_label="Reset password",
        cta_url=link,
        fallback_label=link,
        footer_note="For security, this reset link expires automatically after a short time.",
    )
    return text, html_msg


def send_email(to_email: str, subject: str, text: str, html_body: str | None = None) -> None:
    host = (os.getenv("SMTP_HOST") or "").strip()
    user = (os.getenv("SMTP_USER") or "").strip()
    pwd = (os.getenv("SMTP_PASS") or "").strip()
    from_email = (os.getenv("SMTP_FROM") or user or "no-reply@example.com").strip()

    if not host:
        print("\n--- EMAIL (SMTP not configured) ---")
        print("To:", to_email)
        print("Subject:", subject)
        print(text)
        if html_body:
            print("HTML:", html_body)
        print("--- END EMAIL ---\n")
        return

    port = int(os.getenv("SMTP_PORT", "587"))
    use_tls = (os.getenv("SMTP_TLS") or "true").strip().lower() in ("1", "true", "yes")

    msg = EmailMessage()
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(text)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    with smtplib.SMTP(host, port, timeout=15) as s:
        if use_tls:
            s.starttls()
        if user and pwd:
            s.login(user, pwd)
        s.send_message(msg)
