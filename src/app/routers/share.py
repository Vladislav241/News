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



def _resolve_score(meta: dict, score_row: dict) -> int:
    candidates = [
        score_row.get("credibility_score"),
        score_row.get("score"),
        meta.get("credibility_score"),
        meta.get("score"),
        meta.get("trust_score"),
        meta.get("rating"),
    ]
    for value in candidates:
        try:
            if value is None or value == "":
                continue
            return max(0, min(100, int(round(float(value)))))
        except Exception:
            continue
    return 0

def _query_float(request: Request, name: str, default: float) -> float:
    raw = (request.query_params.get(name) or '').strip()
    if not raw:
        return default
    try:
        val = float(raw)
    except Exception:
        return default
    return max(0.0, min(1.0, val))

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

def _cover_resize(img: Image.Image, w: int, h: int, *, focus_x: float = 0.5, focus_y: float = 0.5) -> Image.Image:
    iw, ih = img.size
    if iw == 0 or ih == 0:
        return img.resize((w, h))
    scale = max(w / iw, h / ih)
    nw, nh = int(iw * scale), int(ih * scale)
    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
    extra_x = max(0, nw - w)
    extra_y = max(0, nh - h)
    fx = max(0.0, min(1.0, float(focus_x)))
    fy = max(0.0, min(1.0, float(focus_y)))
    left = int(round(extra_x * fx))
    top = int(round(extra_y * fy))
    left = max(0, min(left, extra_x))
    top = max(0, min(top, extra_y))
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
    d.rectangle([W//2 - 260, 110, W//2 - 210, 160], fill=(0,0,0))
    d.text((W//2 - 190, 102), "CHECKNE.", font=f_logo, fill=(0,0,0))

    # Headline
    y = 260
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
    score = _resolve_score(meta, score_row)

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

    focus_x = _query_float(request, "fx", 0.5)
    focus_y = _query_float(request, "fy", 0.5)

    updated_at = score_row.get("computed_at") or meta.get("updated_at") or meta.get("created_at") or ""
    dt = _parse_dt(updated_at)
    v = str(int(dt.timestamp())) if dt else str(int(time.time()))
    version = f"{meta.get('title','')}|{summary}|{score}|{top_source}|{outlets_count}|{img_url}|{updated_at}|{focus_x:.4f}|{focus_y:.4f}|v10"
    out_path = _cache_path(int(cluster_id), version)

    if os.path.exists(out_path):
        with open(out_path, "rb") as f:
            data = f.read()
        return Response(content=data, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})

    canvas = Image.new("RGB", (OG_W, OG_H), (244, 244, 246))
    cd = ImageDraw.Draw(canvas)

    art = _download_image(img_url)
    if art is None:
        art = Image.new("RGB", (OG_W, OG_H), (228, 230, 234))
        ad = ImageDraw.Draw(art)
        ad.text((44, 40), "No related image", font=_font(28, weight="bold"), fill=(105, 110, 118))

    art = _cover_resize(art, OG_W, OG_H, focus_x=focus_x, focus_y=focus_y)
    canvas.paste(art, (0, 0))

    # Atmospheric overlays for better text legibility.
    top_fade = Image.new("RGBA", (OG_W, OG_H), (0, 0, 0, 0))
    td = ImageDraw.Draw(top_fade)
    td.rectangle((0, 0, OG_W, 150), fill=(8, 12, 18, 34))
    td.rectangle((0, OG_H - 260, OG_W, OG_H), fill=(5, 8, 12, 34))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), top_fade)

    # Stronger bottom gradient.
    gradient = Image.new("L", (1, OG_H), 0)
    for y_px in range(OG_H):
        if y_px < OG_H * 0.46:
            alpha = 0
        else:
            t = (y_px - OG_H * 0.46) / max(1, (OG_H * 0.54))
            alpha = int(max(0, min(220, 220 * (t ** 1.65))))
        gradient.putpixel((0, y_px), alpha)
    gradient = gradient.resize((OG_W, OG_H))
    shadow = Image.new("RGBA", (OG_W, OG_H), (0, 0, 0, 0))
    shadow.putalpha(gradient)
    canvas = Image.alpha_composite(canvas, shadow)

    cd = ImageDraw.Draw(canvas)

    def draw_glass_pill(x1: int, y1: int, x2: int, y2: int, *, alpha: int = 122, outline_alpha: int = 92):
        pill = Image.new("RGBA", (OG_W, OG_H), (0, 0, 0, 0))
        pd = ImageDraw.Draw(pill)
        pd.rounded_rectangle((x1, y1, x2, y2), radius=26, fill=(22, 28, 36, alpha), outline=(255, 255, 255, outline_alpha), width=2)
        canvas.alpha_composite(pill)

    # Top pills
    trust_label = f"Trust {int(max(0, min(100, score)))}/100"
    trust_font = _font(30, weight="bold")
    pill_pad_x = 28
    pill_h = 86
    trust_w = int(cd.textlength(trust_label, font=trust_font)) + pill_pad_x * 2
    trust_x1 = 52
    trust_y1 = 46
    draw_glass_pill(trust_x1, trust_y1, trust_x1 + trust_w, trust_y1 + pill_h)
    cd.text((trust_x1 + trust_w // 2, trust_y1 + pill_h // 2 - 2), trust_label, font=trust_font, fill=(255, 255, 255), anchor="mm")

    brand_label = "CHECKNE."
    brand_font = _font(28, family="jersey", weight="regular")
    brand_w = max(250, int(cd.textlength(brand_label, font=brand_font)) + 78)
    brand_x2 = OG_W - 52
    brand_x1 = brand_x2 - brand_w
    brand_y1 = 46
    draw_glass_pill(brand_x1, brand_y1, brand_x2, brand_y1 + pill_h)
    cd.text(((brand_x1 + brand_x2) // 2, brand_y1 + pill_h // 2 - 2), brand_label, font=brand_font, fill=(255, 255, 255), anchor="mm")

    # Main bottom story block — smaller and cleaner.
    panel_margin_x = 56
    panel_h = 244
    panel_x1 = panel_margin_x
    panel_x2 = OG_W - panel_margin_x
    panel_y2 = OG_H - 28
    panel_y1 = panel_y2 - panel_h
    panel = Image.new("RGBA", (OG_W, OG_H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle((panel_x1, panel_y1, panel_x2, panel_y2), radius=34, fill=(10, 16, 24, 158), outline=(255, 255, 255, 92), width=2)
    canvas.alpha_composite(panel)
    cd = ImageDraw.Draw(canvas)

    title = (meta.get("title") or "").strip()
    desc_text = (summary or "").strip()
    if not desc_text:
        desc_text = (sources[0].get("description") if sources else "") or ""

    text_x = panel_x1 + 46
    text_y = panel_y1 + 42
    text_w = panel_x2 - panel_x1 - 92

    title_font = None
    title_lines = []
    for size in (64, 60, 56, 52, 48, 44):
        tf = _font(size, weight="bold")
        lines = _wrap_by_pixels(cd, title, tf, text_w)
        if len(lines) <= 3:
            title_font = tf
            title_lines = lines[:3]
            break
    if not title_font:
        title_font = _font(42, weight="bold")
        title_lines = _wrap_by_pixels(cd, title, title_font, text_w)[:3]
        if len(title_lines) == 3:
            title_lines[-1] = _ellipsize(cd, title_lines[-1], title_font, text_w)

    title_line_h = int(title_font.size * 1.08)
    for i, ln in enumerate(title_lines):
        cd.text((text_x, text_y + i * title_line_h), ln, font=title_font, fill=(255, 255, 255))

    meta_font = _font(24, weight="semibold")
    meta_parts = []
    if top_source:
        meta_parts.append(str(top_source).strip())
    if outlets_count:
        meta_parts.append(f"{int(outlets_count)} outlets")
    meta_line = " • ".join(meta_parts)
    if meta_line:
        meta_y = panel_y2 - 50
        cd.text((text_x, meta_y), _ellipsize(cd, meta_line, meta_font, text_w), font=meta_font, fill=(235, 235, 235))

    # Subtle source credit on the frame itself.
    if top_source:
        source_credit = f"Source: {top_source}"
        cd.text((OG_W - 54, OG_H - 12), source_credit, font=_font(14, weight="regular"), fill=(230, 230, 230), anchor="rd")

    buf = io.BytesIO()
    canvas.convert("RGB").save(buf, format="PNG", optimize=True)
    data = buf.getvalue()

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
    score = _resolve_score(meta, score_row)

    summary_row = db.get_summary(int(cluster_id)) or {}
    summary = (summary_row.get("summary_text") or "").strip()
    if not summary:
        sources = db.get_cluster_sources(int(cluster_id)) or []
        summary = (sources[0].get("description") if sources else "") or ""

    title = meta.get("title") or "CHECKNE."
    desc = _safe_text(summary or "Track credibility across sources.", 180)

    updated_at = score_row.get("computed_at") or meta.get("updated_at") or meta.get("created_at") or ""
    dt = _parse_dt(updated_at)
    v = str(int(dt.timestamp())) if dt else str(int(time.time()))

    base = _base_url(request)

    sref = (request.query_params.get("sref") or "").strip()
    focus_x = _query_float(request, "fx", 0.5)
    focus_y = _query_float(request, "fy", 0.5)
    focus_qs = f"&fx={focus_x:.4f}&fy={focus_y:.4f}"
    page_url = f"{base}/share/{int(cluster_id)}?v={v}{focus_qs}" + (f"&sref={sref}" if sref else "")
    app_url  = f"{base}/?open={int(cluster_id)}&shared=1" + (f"&sref={sref}" if sref else "")
    img_url  = f"{base}/api/share-image/{int(cluster_id)}.png?v={v}{focus_qs}"

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

    /* Fallback input for manual copy (shown only if copy failed) */
    #copyFallback{{ display:none; margin-top: 14px; text-align:center; }}
    #copyFallback input{{
      width: min(720px, 92%);
      padding: 12px 14px;
      border: 1px solid #d8d8d8;
      border-radius: 12px;
      font-size: 14px;
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="frame">
      <h1>ARTICLE SHARE</h1>
      <div class="card">
        <img src="/api/share-image/{int(cluster_id)}.png?fx={focus_x:.4f}&fy={focus_y:.4f}" alt="Share card" />
      </div>
      <div class="cta">
        <a class="btn" href="{app_url}" id="openBtn" style="text-decoration:none; display:inline-flex; align-items:center; justify-content:center;">Open article</a>
        <button class="btn" id="shareBtn">Share</button>
        <button class="btn secondary" id="copyBtn">Copy link</button>
      </div>

      <div id="copyFallback">
        <div style="color:#777; font-size:13px; margin-bottom:8px;">Copy manually:</div>
        <input type="text" readonly value="{page_url}" />
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
      try {{ window.location.replace(appUrl); }}
      catch(e) {{ window.location.href = appUrl; }}
    }}, 350);
  }}

  async function copyLink() {{
    // 1) Modern clipboard
    try {{
      await navigator.clipboard.writeText(url);
      if (copyBtn) {{
        copyBtn.textContent = "Copied ✓";
        setTimeout(()=>copyBtn.textContent="Copy link", 1400);
      }}
      return true;
    }} catch(e) {{}}

    // 2) Fallback for older browsers/Safari
    try {{
      const tmp = document.createElement('textarea');
      tmp.value = url;
      tmp.setAttribute('readonly', '');
      tmp.style.position = 'fixed';
      tmp.style.left = '-9999px';
      tmp.style.top = '0';
      document.body.appendChild(tmp);
      tmp.select();
      tmp.setSelectionRange(0, tmp.value.length);
      document.execCommand('copy');
      document.body.removeChild(tmp);

      if (copyBtn) {{
        copyBtn.textContent = "Copied ✓";
        setTimeout(()=>copyBtn.textContent="Copy link", 1400);
      }}
      return true;
    }} catch(e2) {{}}

    // 3) Last resort: show input so user can copy manually
    const fallback = document.getElementById('copyFallback');
    if (fallback) {{
      fallback.style.display = 'block';
      const inp = fallback.querySelector('input');
      if (inp) {{
        inp.value = url;
        inp.focus();
        inp.select();
      }}
    }}
    return false;
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