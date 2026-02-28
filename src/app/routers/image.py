from __future__ import annotations

import hashlib
import os
import time
import urllib.parse
from typing import Optional, Tuple

import requests
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response


router = APIRouter()

# Very small disk cache to reduce repeated hotlink fetches.
# (Works on Render/containers too; /tmp is ephemeral but helps during runtime.)
_CACHE_DIR = os.path.join("/tmp", "checkne_img_cache")
os.makedirs(_CACHE_DIR, exist_ok=True)

# Cache TTL in seconds
_TTL = int(os.getenv("IMAGE_PROXY_TTL_SECONDS", "86400") or 86400)

# Hard safety limits
_MAX_BYTES = int(os.getenv("IMAGE_PROXY_MAX_BYTES", str(8 * 1024 * 1024)) or (8 * 1024 * 1024))
_TIMEOUT = float(os.getenv("IMAGE_PROXY_TIMEOUT_SECONDS", "12") or 12)


def _is_http_url(u: str) -> bool:
    try:
        p = urllib.parse.urlparse(u)
        return p.scheme in ("http", "https") and bool(p.netloc)
    except Exception:
        return False


def _cache_paths(url: str, width: Optional[int]) -> Tuple[str, str]:
    key = f"{url}|w={width or 0}".encode("utf-8", "ignore")
    h = hashlib.sha1(key).hexdigest()
    body_path = os.path.join(_CACHE_DIR, f"{h}.bin")
    meta_path = os.path.join(_CACHE_DIR, f"{h}.meta")
    return body_path, meta_path


def _read_cache(url: str, width: Optional[int]) -> Optional[Tuple[bytes, str, str]]:
    body_path, meta_path = _cache_paths(url, width)
    try:
        if not os.path.exists(body_path) or not os.path.exists(meta_path):
            return None
        # TTL based on mtime
        if time.time() - os.path.getmtime(body_path) > _TTL:
            return None
        with open(meta_path, "r", encoding="utf-8") as f:
            ct = (f.readline() or "").strip() or "application/octet-stream"
            etag = (f.readline() or "").strip()
        with open(body_path, "rb") as f:
            data = f.read()
        if not data:
            return None
        return data, ct, etag
    except Exception:
        return None


def _write_cache(url: str, width: Optional[int], data: bytes, content_type: str, etag: str) -> None:
    body_path, meta_path = _cache_paths(url, width)
    try:
        with open(body_path, "wb") as f:
            f.write(data)
        with open(meta_path, "w", encoding="utf-8") as f:
            f.write((content_type or "application/octet-stream") + "\n")
            f.write((etag or "") + "\n")
    except Exception:
        pass


def _upgrade_common_cdn(url: str, width: Optional[int]) -> str:
    """Best-effort URL upgrade for common news CDNs.

    Intentionally conservative: if we can't safely upgrade, return as-is.
    """
    # Remove common WordPress thumbnail suffix: -300x200.jpg -> .jpg
    try:
        base, ext = os.path.splitext(url)
        if ext.lower() in (".jpg", ".jpeg", ".png", ".webp"):
            import re

            m = re.search(r"-(\d{2,4})x(\d{2,4})$", base)
            if m:
                url = base[: m.start()] + ext
    except Exception:
        pass

    if not width or width <= 0:
        return url
    try:
        p = urllib.parse.urlparse(url)
        host = (p.netloc or "").lower()
        q = urllib.parse.parse_qs(p.query, keep_blank_values=True)

        # Guardian (i.guim.co.uk) often uses width= / quality= params
        if "i.guim.co.uk" in host:
            # Many Guardian image URLs already include a high-res "master" asset in the path
            # (e.g. .../master/3000.jpg?...). These are the best quality. Also, some variants
            # include signed params; changing width can lead to unexpected downgrades.
            # Prefer the master asset when present.
            if "/master/" in (p.path or ""):
                return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, p.params, "", p.fragment))

            q["width"] = [str(width)]
            q.setdefault("quality", ["85"])
            q.setdefault("fit", ["max"])
            # Higher DPR improves sharpness on Retina displays.
            q.setdefault("dpr", ["2"])
            new_q = urllib.parse.urlencode(q, doseq=True)
            return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, p.params, new_q, p.fragment))

        # BBC (ichef.bbci.co.uk) paths frequently include /news/1024/ or /news/480/
        if "ichef.bbci.co.uk" in host:
            parts = p.path.split("/")
            for i, seg in enumerate(parts):
                if seg.isdigit() and i >= 1 and parts[i - 1] in ("news", "images"):
                    parts[i] = str(width)
                    new_path = "/".join(parts)
                    return urllib.parse.urlunparse((p.scheme, p.netloc, new_path, p.params, p.query, p.fragment))
            # fallback: some variants use ?w=
            q["w"] = [str(width)]
            new_q = urllib.parse.urlencode(q, doseq=True)
            return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, p.params, new_q, p.fragment))

        # Generic query params
        for key in ("w", "width", "resize"):
            if key in q:
                if key == "resize":
                    # try "WIDTH,HEIGHT" pattern
                    q[key] = [f"{width}," + q[key][0].split(",")[-1]]
                else:
                    q[key] = [str(width)]
                new_q = urllib.parse.urlencode(q, doseq=True)
                return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, p.params, new_q, p.fragment))
    except Exception:
        pass
    return url


@router.get("/api/image")
def proxy_image(
    u: str = Query("", description="Remote image URL"),
    w: Optional[int] = Query(None, ge=64, le=3000, description="Optional target width"),
):
    """Fetch a remote image and serve it from the same origin.

    This fixes:
    - low-quality RSS thumbnails (we can request larger variants for common CDNs)
    - broken images due to publisher hotlink/header quirks
    - gives you stable caching on your own domain
    """
    url = (u or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Missing 'u' query parameter")

    # Support protocol-relative URLs like //ichef.bbci.co.uk/...
    if url.startswith("//"):
        url = "https:" + url

    if not _is_http_url(url):
        raise HTTPException(status_code=400, detail="Invalid image URL")

    url = _upgrade_common_cdn(url, w)

    cached = _read_cache(url, w)
    if cached:
        data, content_type, etag = cached
        headers = {
            "Cache-Control": f"public, max-age={_TTL}",
            "ETag": etag,
        }
        return Response(content=data, media_type=content_type, headers=headers)

    # Some publishers/CDNs block hotlinking or behave differently depending on headers.
    # Use a realistic UA and a referer matching the image host (not our own site).
    try:
        p0 = urllib.parse.urlparse(url)
        referer = f"{p0.scheme}://{p0.netloc}/" if p0.scheme and p0.netloc else "https://checkne.com/"
    except Exception:
        referer = "https://checkne.com/"

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        ),
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer,
        "Origin": referer.rstrip("/"),
    }

    def _placeholder_svg(reason: str = "No image") -> Response:
        svg = (
            "<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'>"
            "<rect width='100%' height='100%' fill='#e9e9ee'/>"
            "<text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' "
            "fill='#8a8a96' font-family='system-ui, -apple-system, Segoe UI, Roboto, Arial' font-size='28'>"
            + (reason or "No image")
            + "</text></svg>"
        )
        return Response(
            content=svg.encode("utf-8"),
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=300"},
        )

    try:
        r = requests.get(url, headers=headers, timeout=_TIMEOUT, stream=True, allow_redirects=True)
    except Exception:
        # Never return a broken-image icon to the UI.
        return _placeholder_svg("Image unavailable")

    if r.status_code >= 400:
        return _placeholder_svg("Image unavailable")

    content_type = (r.headers.get("Content-Type") or "").split(";")[0].strip() or "application/octet-stream"
    if content_type.startswith("text/html"):
        # Some CDNs return HTML blocks/challenges.
        try:
            r.close()
        except Exception:
            pass
        return _placeholder_svg("Image blocked")

    data = b""
    try:
        for chunk in r.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            data += chunk
            if len(data) > _MAX_BYTES:
                raise HTTPException(status_code=413, detail="Image too large")
    finally:
        try:
            r.close()
        except Exception:
            pass

    if not data:
        return _placeholder_svg("Image unavailable")

    etag = hashlib.sha1(data).hexdigest()
    _write_cache(url, w, data, content_type, etag)

    headers_out = {
        "Cache-Control": f"public, max-age={_TTL}",
        "ETag": etag,
    }
    return Response(content=data, media_type=content_type, headers=headers_out)
