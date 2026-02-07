from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from ..notify import _build_email_html

router = APIRouter()

@router.get("/api/debug/email-preview", response_class=HTMLResponse)
async def email_preview():
    subject, html = _build_email_html(
        cluster_id=123,
        title="Fisherman fleeing elephants killed by crocodile in Zambia",
        primary_source="BBC Top",
        old_score=0,
        new_score=50,
        outlets=5,
    )
    return HTMLResponse(content=html)
