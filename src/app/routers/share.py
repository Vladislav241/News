
# src/app/routers/share.py
from __future__ import annotations

import os
import io
import time
import hashlib
import json
from datetime import datetime, timezone
from typing import Optional

import requests
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import HTMLResponse, Response
from PIL import Image, ImageDraw, ImageFont

from ..db import db

router = APIRouter()

# Cache directory (best-effort). On Render it may be ephemeral, but still reduces repeat work.
CACHE_DIR = os.getenv("SHARE_CACHE_DIR") or os.path.join("src", "web", "share_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# OG recommended size for social cards
OG_W, OG_H = 1200, 630

def _base_url(request: Request) -> str:
    # Prefer explicit public URL for Render/custom domains
    env = (os.getenv("APP_BASE_URL") or "").strip()
    if env:
        return env.rstrip("/")
    # fallback: infer from request (works but may be http behind proxies)
    return str(request.base_url).rstrip("/")

def _safe_text(s: str, limit: int) -> str:
    s = (s or "").strip()
    if len(s) <= limit:
        return s
    return s[: max(0, limit - 1)].rstrip() + "…"

def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        # stored as ISO-like strings
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None

def _human_age(dt: Optional[datetime]) -> str:
    if not dt:
        return ""
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = now - dt
    mins = int(delta.total_seconds() // 60)
    # Match the UI copy used in the share card mock.
    if mins < 1:
        return "Update just now"
    if mins < 60:
        return f"Update {mins}m ago"
    hours = mins // 60
    if hours < 24:
        return f"Update {hours}h ago"
    days = hours // 24
    return f"Update {days}d ago"

def _fonts_dir() -> str:
    """Project fonts directory (bundled, works on local + Render)."""
    here = os.path.dirname(__file__)
    # share.py is: src/app/routers/share.py
    # fonts are in: src/web/static/fonts
    # Primary: relative to this file.
    p1 = os.path.abspath(os.path.join(here, "..", "..", "..", "web", "static", "fonts"))
    if os.path.isdir(p1):
        return p1
    # Fallback: relative to current working directory (useful if the app is launched from repo root).
    p2 = os.path.abspath(os.path.join(os.getcwd(), "src", "web", "static", "fonts"))
    if os.path.isdir(p2):
        return p2
    # Last resort: return primary path anyway.
    return p1


def _font(size: int, *, family: str = "inter", weight: str = "regular") -> ImageFont.FreeTypeFont:
    """Load bundled fonts.

    Expected files in src/web/static/fonts:
      - Inter-Regular.ttf / Inter-Medium.ttf / Inter-SemiBold.ttf / Inter-Bold.ttf
      - Jersey25-Regular.ttf
    """
    fonts_dir = _fonts_dir()

    inter = {
    "light": os.path.join(fonts_dir, "Inter-Light.ttf"),
    "regular": os.path.join(fonts_dir, "Inter-Regular.ttf"),
    "medium": os.path.join(fonts_dir, "Inter-Medium.ttf"),
    "semibold": os.path.join(fonts_dir, "Inter-SemiBold.ttf"),
    "bold": os.path.join(fonts_dir, "Inter-Bold.ttf"),
}

    jersey = {
        "regular": os.path.join(fonts_dir, "Jersey25-Regular.ttf"),
    }

    candidates: list[str] = []
    if family == "jersey":
        candidates += [jersey.get(weight) or jersey.get("regular")]
    else:
        # default to Inter
           candidates += [inter.get(weight) or inter.get("regular"), inter.get("regular")]

    # Extra fallbacks if someone didn't add Inter/Jersey yet
    candidates += [
        os.path.join(fonts_dir, "DejaVuSans.ttf"),
        os.path.join(fonts_dir, "DejaVuSans-Bold.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]

    for p in candidates:
        try:
            if p and os.path.exists(p):
                return ImageFont.truetype(p, size=size)
        except Exception:
            continue
    return ImageFont.load_default()

def _download_image(url: str) -> Optional[Image.Image]:
    if not url:
        return None
    try:
        r = requests.get(url, timeout=6, headers={"User-Agent": "CheckNE-news-share/1.0"})
        if r.status_code != 200:
            return None
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
        return img
    except Exception:
        return None

def _cover_resize(img: Image.Image, w: int, h: int) -> Image.Image:
    # Resize to cover (like CSS object-fit: cover)
    iw, ih = img.size
    if iw == 0 or ih == 0:
        return img.resize((w, h))
    scale = max(w / iw, h / ih)
    nw, nh = int(iw * scale), int(ih * scale)
    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - w) // 2
    top = (nh - h) // 2
    return img.crop((left, top, left + w, top + h))

def _draw_trust_pie(draw: ImageDraw.ImageDraw, center: tuple[int,int], radius: int, score: int):
    # Black circle with a white "missing wedge" = (100-score)%
    cx, cy = center
    bbox = (cx - radius, cy - radius, cx + radius, cy + radius)
    draw.ellipse(bbox, fill=(15,15,15))
    missing = max(0, min(100, 100 - int(score)))
    if missing > 0:
        # Start at top (-90deg). Remove clockwise.
        start = -90
        end = start + int(360 * (missing / 100))
        draw.pieslice(bbox, start=start, end=end, fill=(255,255,255))

def _wrap_by_pixels(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    """Word-wrap text so each line fits within max_width (in pixels)."""
    text = (text or "").strip()
    if not text:
        return []
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        candidate = (cur + " " + w).strip()
        if draw.textlength(candidate, font=font) <= max_width:
            cur = candidate
        else:
            if cur:
                lines.append(cur)
                cur = w
            else:
                # single very long word; hard cut
                cut = w
                while cut and draw.textlength(cut + "…", font=font) > max_width:
                    cut = cut[:-1]
                lines.append((cut + "…") if cut else "…")
                cur = ""
    if cur:
        lines.append(cur)
    return lines


def _ellipsize(draw: ImageDraw.ImageDraw, line: str, font: ImageFont.FreeTypeFont, max_width: int) -> str:
    if draw.textlength(line, font=font) <= max_width:
        return line
    s = line
    while s and draw.textlength(s + "…", font=font) > max_width:
        s = s[:-1]
    return (s + "…") if s else "…"


def _clamp_lines(draw: ImageDraw.ImageDraw, lines: list[str], font: ImageFont.FreeTypeFont, max_width: int, max_lines: int) -> list[str]:
    if not lines:
        return []
    if len(lines) <= max_lines:
        return lines
    out = lines[:max_lines]
    out[-1] = _ellipsize(draw, out[-1], font, max_width)
    return out


def _cache_path(cluster_id: int, version: str) -> str:
    # version should change when cluster content changes
    h = hashlib.sha1(version.encode("utf-8")).hexdigest()[:10]
    return os.path.join(CACHE_DIR, f"share_{cluster_id}_{h}.png")


# -----------------------------
# Tracking update email card
# -----------------------------
EMAIL_W, EMAIL_H = 1200, 1500  # high-res for email (will be scaled down by clients)

def _load_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    fp = os.path.join(_fonts_dir(), name)
    try:
        return ImageFont.truetype(fp, size=size)
    except Exception:
        return ImageFont.load_default()

def _rounded_rect(draw: ImageDraw.ImageDraw, xy, r: int, fill, outline=None, width: int = 1):
    # PIL>=8 supports rounded_rectangle
    try:
        draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)
    except Exception:
        # fallback: plain rect
        draw.rectangle(xy, fill=fill, outline=outline, width=width)

def _render_tracking_update_image(
    *,
    title: str,
    primary_source: str,
    old_score: int,
    new_score: int,
    outlets: int,
    direction: str,
    base_url: str,
) -> bytes:
    """Return PNG bytes for the 'trust score changed' email card."""
    W, H = EMAIL_W, EMAIL_H
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)

    # Fonts
    f_logo = _load_font("Inter-Bold.ttf", 52)
    f_h1 = _load_font("Inter-Regular.ttf", 56)
    f_h1b = _load_font("Inter-Bold.ttf", 56)
    f_sub = _load_font("Inter-Regular.ttf", 28)
    f_card_title = _load_font("Inter-Bold.ttf", 34)
    f_small = _load_font("Inter-Regular.ttf", 22)
    f_score_label = _load_font("Inter-Regular.ttf", 26)
    f_score = _load_font("Inter-Bold.ttf", 70)
    f_btn = _load_font("Inter-Bold.ttf", 34)
    f_muted = _load_font("Inter-Regular.ttf", 20)

    # Header logo (simple text logo)
    # Draw a small black block + text to mimic branding
    d.rectangle([W//2 - 260, 110, W//2 - 210, 160], fill=(0,0,0))
    d.text((W//2 - 190, 102), "CHECKNE.", font=f_logo, fill=(0,0,0))

    # Headline
    y = 260
    # "Trust score " + bold word + " for a tracked event"
    x0 = 120
    d.text((x0, y), "Trust score ", font=f_h1, fill=(0,0,0))
    w1 = d.textlength("Trust score ", font=f_h1)
    word = "increased" if direction == "up" else "decreased"
    d.text((x0 + w1, y), word, font=f_h1b, fill=(0,0,0))
    w2 = d.textlength(word, font=f_h1b)
    d.text((x0 + w1 + w2, y), " for a tracked event", font=f_h1, fill=(0,0,0))

    d.text((x0, y+80), "New information has strengthened confidence in this event.", font=f_sub, fill=(40,40,40))

    # Outer card
    card_x1, card_y1 = 90, 430
    card_x2, card_y2 = W-90, H-220
    _rounded_rect(d, [card_x1, card_y1, card_x2, card_y2], r=32, fill=(255,255,255), outline=(220,220,220), width=2)

    # Inner preview block (light gray)
    inner_x1, inner_y1 = card_x1+70, card_y1+170
    inner_x2, inner_y2 = card_x2-70, card_y1+650
    _rounded_rect(d, [inner_x1, inner_y1, inner_x2, inner_y2], r=28, fill=(250,250,250), outline=(235,235,235), width=2)

    d.text((card_x1+70, card_y1+70), "ARTICLE PREVIEW", font=f_small, fill=(170,170,170))

    # Title + source inside preview
    t = _safe_text(title, 90)
    d.text((inner_x1+50, inner_y1+50), t, font=f_card_title, fill=(0,0,0))
    d.text((inner_x2-260, inner_y1+130), _safe_text(primary_source, 22), font=f_small, fill=(130,130,130))

    # Divider line
    d.line([inner_x1+40, inner_y1+170, inner_x2-40, inner_y1+170], fill=(220,220,220), width=2)

    # Trust score block
    cx = (inner_x1+inner_x2)//2
    d.text((cx-70, inner_y1+210), "Trust score", font=f_score_label, fill=(0,0,0))
    # Scores
    d.text((cx-210, inner_y1+270), str(int(old_score)), font=f_score, fill=(0,0,0))
    d.text((cx-30, inner_y1+300), "→", font=_load_font("Inter-Regular.ttf", 70), fill=(120,160,150))
    d.text((cx+60, inner_y1+270), str(int(new_score)), font=f_score, fill=(0,0,0))
    d.text((cx-40, inner_y1+370+20), f"{int(outlets)} outlets", font=f_small, fill=(120,120,120))

    # Explanation
    expl = "The trust score decreased as new sources introduced conflicting or incomplete information related to this event."
    if direction == "up":
        expl = "The trust score increased as new sources strengthened confidence in this event."
    d.text((card_x1+70, inner_y2+70), expl, font=f_small, fill=(40,40,40))

    # Button
    btn_w, btn_h = 760, 96
    btn_x1 = (W - btn_w)//2
    btn_y1 = inner_y2 + 180
    _rounded_rect(d, [btn_x1, btn_y1, btn_x1+btn_w, btn_y1+btn_h], r=28, fill=(0,0,0))
    label = "View update"
    tw = d.textlength(label, font=f_btn)
    d.text((btn_x1 + (btn_w-tw)//2, btn_y1+26), label, font=f_btn, fill=(255,255,255))

    # Footer
    foot_y = H-150
    d.text((W//2 - 250, foot_y), "You’re receiving this email because you’re tracking this event.", font=f_muted, fill=(150,150,150))
    d.line([220, foot_y+50, W-220, foot_y+50], fill=(220,220,220), width=1)
    d.text((W//2 - 420, foot_y+80), "CHECKNE. is an informational service and does not provide factual determinations.", font=f_muted, fill=(170,170,170))

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()

@router.get("/api/share-image/{cluster_id}.png")
def share_image(cluster_id: int, request: Request):
    meta = db.get_cluster_meta(int(cluster_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Cluster not found")

    score_row = db.get_score(int(cluster_id)) or {}
    score = int(score_row.get("credibility_score") or 0)
    score = max(0, min(100, score))

    summary_row = db.get_summary(int(cluster_id)) or {}
    summary = (summary_row.get("summary_text") or "").strip()

    sources = db.get_cluster_sources(int(cluster_id)) or []
    top_source = (sources[0].get("source_name") if sources else "") or ""
    outlets_count = len({(s.get("source_name") or "").strip() for s in sources if (s.get("source_name") or "").strip()}) or len(sources)

    img_url = ""
    for s in sources:
        if s.get("image_url"):
            img_url = s["image_url"]
            break

    updated_at = score_row.get("computed_at") or meta.get("updated_at") or meta.get("created_at") or ""
    dt = _parse_dt(updated_at)
    v = str(int(dt.timestamp())) if dt else str(int(time.time()))
    # Bump the version suffix when the render/layout changes so cached images refresh everywhere.
    # IMPORTANT: bump the suffix whenever layout math changes, otherwise you'll keep seeing cached images.
    version = f"{meta.get('title','')}|{summary}|{score}|{top_source}|{outlets_count}|{img_url}|{updated_at}|v8"
    out_path = _cache_path(int(cluster_id), version)

    # Serve cached file if present
    if os.path.exists(out_path):
        with open(out_path, "rb") as f:
            data = f.read()
        return Response(content=data, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})

    # Compose image (match the mock: full-height photo + clean white card on the right)
    canvas = Image.new("RGB", (OG_W, OG_H), (255, 255, 255))
    cd = ImageDraw.Draw(canvas)

    # Layout: make the photo feel "taller" by removing outer padding and going full-bleed.
    left_w = 530
    right_x0 = left_w
    right_w = OG_W - left_w


    # Left image (full-bleed)
    art = _download_image(img_url)
    if art is None:
        art = Image.new("RGB", (left_w, OG_H), (235, 235, 240))
        ad = ImageDraw.Draw(art)
        ad.text((34, 34), "No related image", font=_font(28, weight="bold"), fill=(110, 110, 120))
    art = _cover_resize(art, left_w, OG_H)
    canvas.paste(art, (0, 0))

    # Right panel background: pure white + subtle divider
    cd.rectangle((right_x0, 0, OG_W, OG_H), fill=(255, 255, 255))
    cd.line((right_x0, 0, right_x0, OG_H), fill=(235, 235, 235), width=2)

    # Brand (logo + wordmark)
    logo_path = os.path.join("src", "web", "icons", "Logo.png")
    brand_x = right_x0 + 52
    brand_y = 34
    if os.path.exists(logo_path):
        try:
            logo = Image.open(logo_path).convert("RGBA")
            max_w, max_h = 128, 56
            lw, lh = logo.size
            scale = min(max_w / lw, max_h / lh)
            logo = logo.resize((int(lw * scale), int(lh * scale)), Image.Resampling.LANCZOS)
            canvas.paste(logo, (brand_x, brand_y), logo)
            wx = brand_x + logo.size[0] + 12
        except Exception:
            wx = brand_x
    else:
        wx = brand_x

    # Use Jersey for the brand wordmark (matches your web UI).
    cd.text((wx, brand_y - 2), "CHECKNE.", font=_font(34, family="jersey", weight="regular"), fill=(15, 15, 15))

    # Trust pie (black circle with a white missing wedge)
    pie_cx = right_x0 + right_w // 2
    # Keep the score block high enough to leave room for headline + full AI summary.
    pie_cy = 180
    pie_r = 74
    _draw_trust_pie(cd, (pie_cx, pie_cy), pie_r, score)

    # Score labels (order & spacing like the mock)
    # Slightly smaller typography so it never collides with the headline block.
    label_font = _font(40, weight="light")
    score_font = _font(38, weight="regular")
    cd.text((pie_cx, pie_cy + pie_r + 45), "Trust score", font=label_font, fill=(35, 35, 35), anchor="mm")
    cd.text((pie_cx, pie_cy + pie_r + 92), f"{score}/100", font=score_font, fill=(15, 15, 15), anchor="mm")

    updated_label = _human_age(_parse_dt(updated_at))
    updated_y = pie_cy + pie_r + 138
    if updated_label:
        cd.text((pie_cx, updated_y), updated_label, font=_font(23, weight="regular"), fill=(180, 180, 180), anchor="mm")
    # Headline should always start AFTER the score block.
    headline_start_y = updated_y + 36

    # Copy (topic + full description)
    title = (meta.get("title") or "").strip()
    # Prefer AI summary, but if empty fall back to the first source description.
    desc_text = (summary or "").strip()
    if not desc_text:
        sources_for_desc = db.get_cluster_sources(int(cluster_id)) or []
        desc_text = (sources_for_desc[0].get("description") if sources_for_desc else "") or ""

    text_x = right_x0 + 34
    max_text_w = right_w - 68


    # Bottom reserved space (source line + disclaimer)
    # Keep disclaimer compact... extra vertical room helps long headlines + summaries.
    disclaimer_lines = [
        "CHECKNE. is an informational service and does not provide factual determinations.",
        "Trust scores reflect automated analysis and may change as new information becomes available.",
    ]
    disclaimer_font = _font(10)
    disclaimer_line_h = int(disclaimer_font.size * 1.20)
    disclaimer_h = disclaimer_line_h * len(disclaimer_lines) + 8
    footer_font = _font(16)
    footer_h = int(footer_font.size * 1.25) + 10

    footer_y = OG_H - disclaimer_h - footer_h - 18
    y_max = footer_y - 18

    # Start copy below the score block (dynamic, avoids overlaps)
    y = headline_start_y

        # ---------- TEXT BLOCK (title + description) ----------

    # Base fonts
    body_font = _font(18, weight="regular")
    line_h_body = int(body_font.size * 1.35)

    # --- TITLE: always 2 lines if possible, NEVER add "..." ---
    TARGET_TITLE_LINES = 2

    title_lines = []
    title_font = None

    for size in (26, 24, 22, 20, 18, 16):
        tf = _font(size, weight="semibold")
        lines = _wrap_by_pixels(cd, title, tf, max_text_w)

        # If it fits into 2 lines -> accept
        if len(lines) <= TARGET_TITLE_LINES:
            title_font = tf
            title_lines = lines
            break

    # If still too long -> force 2 lines by shrinking more AND hard-cut words (without "…")
    if not title_font:
        title_font = _font(16, weight="semibold")
        title_lines = _wrap_by_pixels(cd, title, title_font, max_text_w)
        title_lines = title_lines[:TARGET_TITLE_LINES]  # no ellipsis for title

    line_h_title = int(title_font.size * 1.18)

    # --- Compute space: title is PRIORITY, description gets the leftovers ---
    title_block_h = len(title_lines) * line_h_title + 10
    available_for_desc_px = (y_max - (y + title_block_h))

    # Draw title (no ellipsis)
    for ln in title_lines:
        if y + line_h_title > y_max:
            break
        cd.text((text_x, y), ln, font=title_font, fill=(20, 20, 20))
        y += line_h_title
    y += 10

    # --- DESCRIPTION: can be truncated with "..." ---
    desc_raw = (desc_text or "").strip()
    desc_lines_all = _wrap_by_pixels(cd, desc_raw, body_font, max_text_w)

    MAX_DESC_LINES = 2
    lines_fit = int(available_for_desc_px // line_h_body) if available_for_desc_px > 0 else 0
    lines_to_draw = max(0, min(MAX_DESC_LINES, lines_fit))

    if desc_lines_all and lines_to_draw > 0:
        drawn = desc_lines_all[:lines_to_draw]

        # add ellipsis only if truncated
        if len(desc_lines_all) > len(drawn):
            drawn[-1] = _ellipsize(cd, drawn[-1] + " …", body_font, max_text_w)

        for ln in drawn:
            cd.text((text_x, y), ln, font=body_font, fill=(65, 65, 65))
            y += line_h_body





    # Footer: source + outlets (above disclaimer)
    footer = ""
    if top_source and outlets_count:
        footer = f"{top_source}      {outlets_count} outlets"
    elif outlets_count:
        footer = f"{outlets_count} outlets"
    elif top_source:
        footer = top_source
    if footer:
        cd.text((text_x, footer_y), footer, font=footer_font, fill=(170, 170, 170))

    # Disclaimer (always bottom)
    dy = OG_H - disclaimer_h - 10
    for ln in disclaimer_lines:
        cd.text((text_x, dy), ln, font=disclaimer_font, fill=(210, 210, 210))
        dy += disclaimer_line_h

    # encode
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    data = buf.getvalue()

    # write cache best-effort
    try:
        with open(out_path, "wb") as f:
            f.write(data)
    except Exception:
        pass

    return Response(content=data, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})

@router.get("/share/{cluster_id}", response_class=HTMLResponse)
def share_page(cluster_id: int, request: Request):
    meta = db.get_cluster_meta(int(cluster_id))
    if not meta:
        raise HTTPException(status_code=404, detail="Not found")

    score_row = db.get_score(int(cluster_id)) or {}
    score = int(score_row.get("credibility_score") or 0)
    score = max(0, min(100, score))

    summary_row = db.get_summary(int(cluster_id)) or {}
    summary = (summary_row.get("summary_text") or "").strip()
    if not summary:
        # fallback: use description from latest source
        sources = db.get_cluster_sources(int(cluster_id)) or []
        summary = (sources[0].get("description") if sources else "") or ""

    title = meta.get("title") or "CHECKNE."
    desc = _safe_text(summary or "Track credibility across sources.", 180)

    # ----- Versioning (чтобы ссылка менялась после обновления новости) -----
    updated_at = score_row.get("computed_at") or meta.get("updated_at") or meta.get("created_at") or ""

    dt = _parse_dt(updated_at)
    v = str(int(dt.timestamp())) if dt else str(int(time.time()))

    # ----- URLs (все теперь с ?v=...) -----
    base = _base_url(request)

    page_url = f"{base}/share/{int(cluster_id)}?v={v}"
    app_url  = f"{base}/?open={int(cluster_id)}&shared=1"
    img_url  = f"{base}/api/share-image/{int(cluster_id)}.png?v={v}"


    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>{title} — CHECKNE.</title>

  <!-- Open Graph -->
  <meta property="og:type" content="article" />
  <meta property="og:title" content="{title}" />
  <meta property="og:description" content="{desc}" />
  <meta property="og:image" content="{img_url}" />
  <meta property="og:url" content="{page_url}" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{title}" />
  <meta name="twitter:description" content="{desc}" />
  <meta name="twitter:image" content="{img_url}" />

  <meta name="theme-color" content="#ffffff" />

  <style>
    body{{ margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#f2f2f2; }}
    .wrap{{ max-width: 980px; margin: 40px auto; padding: 0 16px; }}
    .frame{{ border: 2px solid #d8d8d8; border-radius: 26px; padding: 36px; background:#fff; }}
    h1{{ margin: 0 0 20px; font-size: 28px; letter-spacing: 0.08em; color:#9a9a9a; font-weight: 500; }}
    .card{{ display:flex; justify-content:center; }}
    .cta{{ margin-top: 18px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }}
    .btn{{ border:1px solid #111; background:#111; color:#fff; padding:12px 16px; border-radius:12px; cursor:pointer; font-weight:600; }}
    .btn.secondary{{ background:#fff; color:#111; }}
    .hint{{ margin-top: 14px; text-align:center; color:#777; font-size: 13px; }}
    img{{ max-width:100%; height:auto; border-radius: 16px; box-shadow: 0 16px 30px rgba(0,0,0,.12); }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="frame">
      <h1>ARTICLE SHARE</h1>
      <div class="card">
        <img src="/api/share-image/{int(cluster_id)}.png" alt="Share card" />
      </div>
      <div class="cta">
        <a class="btn" href="{app_url}" id="openBtn" style="text-decoration:none; display:inline-flex; align-items:center; justify-content:center;">Open article</a>
        <button class="btn" id="shareBtn">Share</button>
        <button class="btn secondary" id="copyBtn">Copy link</button>
      </div>
      <div class="hint">If your app doesn't open a share dialog, copy the link and paste it into Twitter/X, Threads, or any messenger.</div>
    </div>
  </div>

<script>
(function(){{
  const url = {json.dumps(page_url)};
  const appUrl = {json.dumps(app_url)};
  const title = {json.dumps(title)};
  const text = {json.dumps(desc)};
  const shareBtn = document.getElementById('shareBtn');
  const copyBtn = document.getElementById('copyBtn');

  // Auto-open the article inside the app for real users.
  // Avoid redirecting social preview bots (they need to read OG tags).
  const ua = (navigator.userAgent || '').toLowerCase();
  const isBot = /bot|crawl|spider|slurp|facebookexternalhit|twitterbot|slackbot|discordbot|whatsapp/i.test(ua);
  if (!isBot) {{
    setTimeout(()=>{{
      try {{ window.location.replace(appUrl); }} catch(e) {{ window.location.href = appUrl; }}
    }}, 350);
  }}

  async function copyLink(){{
    try {{
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = "Copied ✓";
      setTimeout(()=>copyBtn.textContent="Copy link", 1400);
    }} catch(e) {{
      prompt("Copy link:", url);
    }}
  }}

  if (shareBtn) {{
    shareBtn.addEventListener('click', async ()=>{{
      if (navigator.share) {{
        try {{
          await navigator.share({{ title, text, url }});
          return;
        }} catch(e) {{}}
      }}
      await copyLink();
    }});
  }}
  if (copyBtn) {{
    copyBtn.addEventListener('click', copyLink);
  }}
}})();
</script>
</body>
</html>
"""
    return HTMLResponse(content=html)
