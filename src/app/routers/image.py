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

_CACHE_DIR = os.path.join("/tmp", "checkne_img_cache")
os.makedirs(_CACHE_DIR, exist_ok=True)

_TTL = int(os.getenv("IMAGE_PROXY_TTL_SECONDS", "86400") or 86400)
_MAX_BYTES = int(os.getenv("IMAGE_PROXY_MAX_BYTES", str(8 * 1024 * 1024)) or (8 * 1024 * 1024))
_CONNECT_TIMEOUT = float(os.getenv("IMAGE_PROXY_CONNECT_TIMEOUT_SECONDS", "3") or 3)
_READ_TIMEOUT = float(os.getenv("IMAGE_PROXY_READ_TIMEOUT_SECONDS", "6") or 6)
_FAILURE_TTL = int(os.getenv("IMAGE_PROXY_FAILURE_TTL_SECONDS", "300") or 300)
_FAIL_CACHE: dict[str, tuple[float, str]] = {}


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


def _is_http_url(u: str) -> bool:
    try:
        p = urllib.parse.urlparse(u)
        return p.scheme in ("http", "https") and bool(p.netloc)
    except Exception:
        return False


def _failure_key(url: str, width: Optional[int]) -> str:
    return f"{url}|w={width or 0}"


def _get_recent_failure(url: str, width: Optional[int]) -> Optional[str]:
    hit = _FAIL_CACHE.get(_failure_key(url, width))
    if not hit:
        return None
    ts, reason = hit
    if (time.time() - float(ts)) > _FAILURE_TTL:
        _FAIL_CACHE.pop(_failure_key(url, width), None)
        return None
    return reason or "Image unavailable"


def _remember_failure(url: str, width: Optional[int], reason: str) -> None:
    _FAIL_CACHE[_failure_key(url, width)] = (time.time(), reason or "Image unavailable")


def _clear_failure(url: str, width: Optional[int]) -> None:
    _FAIL_CACHE.pop(_failure_key(url, width), None)


def _cache_paths(url: str, width: Optional[int]) -> Tuple[str, str]:
    key = _failure_key(url, width).encode("utf-8", "ignore")
    h = hashlib.sha1(key).hexdigest()
    body_path = os.path.join(_CACHE_DIR, f"{h}.bin")
    meta_path = os.path.join(_CACHE_DIR, f"{h}.meta")
    return body_path, meta_path


def _read_cache(url: str, width: Optional[int]) -> Optional[Tuple[bytes, str, str]]:
    body_path, meta_path = _cache_paths(url, width)
    try:
        if not os.path.exists(body_path) or not os.path.exists(meta_path):
            return None
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

        if "i.guim.co.uk" in host:
            if "s" in q and q.get("s"):
                return url
            q.setdefault("width", [str(width)])
            q.setdefault("quality", ["85"])
            q.setdefault("fit", ["max"])
            q.setdefault("dpr", ["2"])
            new_q = urllib.parse.urlencode(q, doseq=True)
            return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, p.params, new_q, p.fragment))

        if "ichef.bbci.co.uk" in host:
            parts = p.path.split("/")
            for i, seg in enumerate(parts):
                if seg.isdigit() and i >= 1 and parts[i - 1] in ("news", "images"):
                    parts[i] = str(width)
                    new_path = "/".join(parts)
                    return urllib.parse.urlunparse((p.scheme, p.netloc, new_path, p.params, p.query, p.fragment))
            q["w"] = [str(width)]
            new_q = urllib.parse.urlencode(q, doseq=True)
            return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, p.params, new_q, p.fragment))

        for key in ("w", "width", "resize"):
            if key in q:
                if key == "resize":
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
    url = (u or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Missing 'u' query parameter")
    if url.startswith("//"):
        url = "https:" + url
    if not _is_http_url(url):
        raise HTTPException(status_code=400, detail="Invalid image URL")

    url = _upgrade_common_cdn(url, w)

    recent_failure = _get_recent_failure(url, w)
    if recent_failure:
        return _placeholder_svg(recent_failure)

    cached = _read_cache(url, w)
    if cached:
        data, content_type, etag = cached
        return Response(content=data, media_type=content_type, headers={"Cache-Control": f"public, max-age={_TTL}", "ETag": etag})

    try:
        p0 = urllib.parse.urlparse(url)
        host0 = (p0.netloc or "").lower()
        if host0.endswith("guim.co.uk") or host0.endswith("theguardian.com"):
            referer = "https://www.theguardian.com/"
        else:
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
    }

    def _fetch_once(fetch_url: str):
        return requests.get(fetch_url, headers=headers, timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT), stream=True, allow_redirects=True)

    try:
        r = _fetch_once(url)
    except Exception:
        _remember_failure(url, w, "Image unavailable")
        return _placeholder_svg("Image unavailable")

    if r.status_code >= 400:
        try:
            raw_url = (u or "").strip()
            if raw_url.startswith("//"):
                raw_url = "https:" + raw_url
            if raw_url and raw_url != url and _is_http_url(raw_url):
                try:
                    r.close()
                except Exception:
                    pass
                r = _fetch_once(raw_url)
                url = raw_url
        except Exception:
            pass

    if r.status_code >= 400:
        try:
            r.close()
        except Exception:
            pass
        _remember_failure(url, w, "Image unavailable")
        return _placeholder_svg("Image unavailable")

    content_type = (r.headers.get("Content-Type") or "").split(";")[0].strip() or "application/octet-stream"
    if content_type.startswith("text/html"):
        try:
            r.close()
        except Exception:
            pass
        _remember_failure(url, w, "Image blocked")
        return _placeholder_svg("Image blocked")

    chunks = bytearray()
    try:
        for chunk in r.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            chunks.extend(chunk)
            if len(chunks) > _MAX_BYTES:
                _remember_failure(url, w, "Image too large")
                raise HTTPException(status_code=413, detail="Image too large")
    except requests.exceptions.RequestException:
        _remember_failure(url, w, "Image unavailable")
        return _placeholder_svg("Image unavailable")
    except Exception:
        _remember_failure(url, w, "Image unavailable")
        return _placeholder_svg("Image unavailable")
    finally:
        try:
            r.close()
        except Exception:
            pass

    data = bytes(chunks)
    if not data:
        _remember_failure(url, w, "Image unavailable")
        return _placeholder_svg("Image unavailable")

    _clear_failure(url, w)
    etag = hashlib.sha1(data).hexdigest()
    _write_cache(url, w, data, content_type, etag)
    return Response(content=data, media_type=content_type, headers={"Cache-Control": f"public, max-age={_TTL}", "ETag": etag})
