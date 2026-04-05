from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..auth.deps import require_user
from ..db import db


router = APIRouter()


def _stripe() :
    """Lazy import so the app can boot even if stripe isn't installed yet."""
    try:
        import stripe  # type: ignore
    except Exception:
        raise HTTPException(status_code=500, detail="Stripe library not installed. Add 'stripe' to requirements.")

    key = (os.getenv("STRIPE_SECRET_KEY") or "").strip()
    if not key:
        raise HTTPException(status_code=500, detail="Missing STRIPE_SECRET_KEY in environment")
    stripe.api_key = key
    return stripe


def _public_base_url() -> str:
    base = (os.getenv("PUBLIC_BASE_URL") or "").strip().rstrip("/")
    if base:
        return base
    # fallback for local dev
    return "http://127.0.0.1:8000"


Plan = Literal["free", "pro", "analyst"]
Interval = Literal["monthly", "yearly"]


def _stripe_id(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return value.get("id")
    except Exception:
        return None


def _plan_interval_from_subscription_object(obj: dict) -> tuple[str, str]:
    plan = "pro"
    interval = "monthly"
    try:
        items = (obj.get("items") or {}).get("data") or []
        if items:
            price = (items[0].get("price") or {})
            recurring_interval = (price.get("recurring") or {}).get("interval") or "month"
            interval = "yearly" if recurring_interval == "year" else "monthly"
            price_id = price.get("id")
            if price_id:
                if price_id in {
                    (os.getenv("STRIPE_PRICE_ANALYST_MONTHLY") or "").strip(),
                    (os.getenv("STRIPE_PRICE_ANALYST_YEARLY") or "").strip(),
                }:
                    plan = "analyst"
                elif price_id in {
                    (os.getenv("STRIPE_PRICE_PRO_MONTHLY") or "").strip(),
                    (os.getenv("STRIPE_PRICE_PRO_YEARLY") or "").strip(),
                }:
                    plan = "pro"
    except Exception:
        pass
    return plan, interval


def _apply_subscription_state(user_id: int, *, customer_id: Optional[str], subscription_obj: dict, fallback_plan: Optional[str] = None, fallback_interval: Optional[str] = None) -> dict:
    status = str(subscription_obj.get("status") or "active")
    plan, interval = _plan_interval_from_subscription_object(subscription_obj)
    if fallback_plan:
        plan = str(fallback_plan)
    if fallback_interval:
        interval = str(fallback_interval)

    cpe_iso = None
    cpe = subscription_obj.get("current_period_end")
    if isinstance(cpe, int):
        cpe_iso = datetime.fromtimestamp(cpe, tz=timezone.utc).replace(microsecond=0).isoformat()

    db.set_user_subscription(
        int(user_id),
        plan=plan,
        status=status,
        billing_interval=interval,
        stripe_customer_id=customer_id,
        stripe_subscription_id=_stripe_id(subscription_obj.get("id") or subscription_obj),
        current_period_end=cpe_iso,
        cancel_at_period_end=bool(subscription_obj.get("cancel_at_period_end")),
    )
    return {"plan": plan, "interval": interval, "status": status, "current_period_end": cpe_iso}


def _paid_access_active(plan: Optional[str], status: Optional[str]) -> bool:
    plan_v = str(plan or "free").strip().lower()
    status_v = str(status or "").strip().lower()
    return plan_v in ("pro", "analyst") and status_v in ("active", "trialing")


def _normalize_billing_payload(sub: Optional[dict], *, preserve_recent_cancel: bool = True) -> dict:
    if not sub:
        return {
            "plan": "free",
            "status": "active",
            "interval": "monthly",
            "current_period_end": None,
            "cancel_at_period_end": False,
            "previous_plan": None,
            "ended_at": None,
            "recently_expired": False,
        }

    plan = str(sub.get("plan") or "free").strip().lower()
    status = str(sub.get("status") or "active").strip().lower()
    interval = str(sub.get("billing_interval") or "monthly").strip().lower()
    current_period_end = sub.get("current_period_end")
    cancel_at_period_end = bool(sub.get("cancel_at_period_end"))

    if _paid_access_active(plan, status):
        return {
            "plan": plan,
            "status": status,
            "interval": interval,
            "current_period_end": current_period_end,
            "cancel_at_period_end": cancel_at_period_end,
            "previous_plan": None,
            "ended_at": None,
            "recently_expired": False,
        }

    previous_plan = plan if plan in ("pro", "analyst") else None
    ended_at = current_period_end
    return {
        "plan": "free",
        "status": "active",
        "interval": "monthly",
        "current_period_end": None,
        "cancel_at_period_end": False,
        "previous_plan": previous_plan,
        "ended_at": ended_at,
        "recently_expired": bool(preserve_recent_cancel and previous_plan),
    }


def _sync_user_subscription_from_stripe(user_id: int) -> Optional[dict]:
    current = db.get_user_subscription(int(user_id))
    if not current:
        return None

    stripe_subscription_id = str(current.get("stripe_subscription_id") or "").strip()
    stripe_customer_id = str(current.get("stripe_customer_id") or "").strip() or None
    if not stripe_subscription_id:
        return current

    try:
        stripe = _stripe()
        stripe_sub = stripe.Subscription.retrieve(stripe_subscription_id)
    except Exception:
        return current

    current_plan = str(current.get("plan") or "").strip().lower()
    current_interval = str(current.get("billing_interval") or "").strip().lower()
    updated = _apply_subscription_state(
        int(user_id),
        customer_id=stripe_customer_id,
        subscription_obj=stripe_sub,
        fallback_plan=(current_plan if current_plan in ("pro", "analyst") else None),
        fallback_interval=(current_interval if current_interval in ("monthly", "yearly") else None),
    )
    return {
        **current,
        "plan": updated.get("plan") or current.get("plan"),
        "status": updated.get("status") or current.get("status"),
        "billing_interval": updated.get("interval") or current.get("billing_interval"),
        "current_period_end": updated.get("current_period_end"),
        "cancel_at_period_end": bool(getattr(stripe_sub, "cancel_at_period_end", False)),
    }


class CheckoutIn(BaseModel):
    plan: Plan
    interval: Interval = "monthly"


@router.get("/api/billing/me")
def billing_me(user=Depends(require_user)):
    """Returns the effective subscription info for the logged-in user.

    In production the Stripe webhook should keep local state fresh, but this endpoint
    also performs a defensive sync so the UI reflects cancellations immediately even
    if a webhook has not arrived yet.
    """
    sub = _sync_user_subscription_from_stripe(int(user["id"]))
    return _normalize_billing_payload(sub)


@router.post("/api/billing/cancel")
def cancel_at_period_end(user=Depends(require_user)):
    """Cancel at period end (Stripe cancel_at_period_end=true)."""
    current = db.get_user_subscription(int(user["id"]))
    if not current or not current.get("stripe_subscription_id"):
        raise HTTPException(status_code=400, detail="No active subscription")

    stripe = _stripe()
    try:
        stripe_sub = stripe.Subscription.modify(
            current["stripe_subscription_id"],
            cancel_at_period_end=True,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Stripe error: {e}")

    period_end_iso = None
    if getattr(stripe_sub, "current_period_end", None):
        period_end_iso = datetime.fromtimestamp(int(stripe_sub.current_period_end), tz=timezone.utc).isoformat()

    db.set_user_subscription(
        int(user["id"]),
        plan=(current.get("plan") or "free"),
        status=stripe_sub.status,
        billing_interval=(current.get("billing_interval") or "monthly"),
        stripe_customer_id=current.get("stripe_customer_id"),
        stripe_subscription_id=current.get("stripe_subscription_id"),
        current_period_end=period_end_iso,
        cancel_at_period_end=bool(getattr(stripe_sub, "cancel_at_period_end", False)),
    )

    return {
        "ok": True,
        "status": stripe_sub.status,
        "current_period_end": period_end_iso,
        "cancel_at_period_end": bool(getattr(stripe_sub, "cancel_at_period_end", False)),
    }


@router.post("/api/billing/resume")
def resume_subscription(user=Depends(require_user)):
    """Undo cancel at period end (Stripe cancel_at_period_end=false)."""
    current = db.get_user_subscription(int(user["id"]))
    if not current or not current.get("stripe_subscription_id"):
        raise HTTPException(status_code=400, detail="No active subscription")

    stripe = _stripe()
    try:
        stripe_sub = stripe.Subscription.modify(
            current["stripe_subscription_id"],
            cancel_at_period_end=False,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Stripe error: {e}")

    period_end_iso = None
    if getattr(stripe_sub, "current_period_end", None):
        period_end_iso = datetime.fromtimestamp(int(stripe_sub.current_period_end), tz=timezone.utc).isoformat()

    db.set_user_subscription(
        int(user["id"]),
        plan=(current.get("plan") or "free"),
        status=stripe_sub.status,
        billing_interval=(current.get("billing_interval") or "monthly"),
        stripe_customer_id=current.get("stripe_customer_id"),
        stripe_subscription_id=current.get("stripe_subscription_id"),
        current_period_end=period_end_iso,
        cancel_at_period_end=bool(getattr(stripe_sub, "cancel_at_period_end", False)),
    )

    return {
        "ok": True,
        "status": stripe_sub.status,
        "current_period_end": period_end_iso,
        "cancel_at_period_end": bool(getattr(stripe_sub, "cancel_at_period_end", False)),
    }


@router.post("/api/billing/set-free")
def set_free(user=Depends(require_user)):
    """MVP downgrade to Free without Stripe."""
    db.set_user_subscription(int(user["id"]), plan="free", status="active", billing_interval="monthly")
    return {"status": "ok", "plan": "free"}


@router.post("/api/billing/checkout")
def create_checkout(payload: CheckoutIn, user=Depends(require_user)):
    """Creates a Stripe Checkout Session for Pro/Analyst.

    You must set price IDs in env:
      STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_YEARLY,
      STRIPE_PRICE_ANALYST_MONTHLY, STRIPE_PRICE_ANALYST_YEARLY
    """
    # Prevent re-purchasing the exact same active subscription (UI should block too, but enforce server-side).
    current = db.get_user_subscription(int(user["id"]))
    if current:
        cur_plan = (current.get("plan") or "free").lower()
        cur_status = (current.get("status") or "active").lower()
        cur_interval = (current.get("billing_interval") or "monthly").lower()
        if cur_status in ("active", "trialing") and cur_plan == payload.plan and cur_interval == payload.interval:
            raise HTTPException(status_code=400, detail="Already subscribed to this plan.")
    if payload.plan == "free":
        # Free doesn't need Stripe.
        db.set_user_subscription(int(user["id"]), plan="free", status="active", billing_interval="monthly")
        return {"url": f"{_public_base_url()}/?pricing=1"}

    stripe = _stripe()

    price_key = f"STRIPE_PRICE_{payload.plan.upper()}_{payload.interval.upper()}"
    price_id = (os.getenv(price_key) or "").strip()
    if not price_id:
        raise HTTPException(status_code=500, detail=f"Missing {price_key} in environment")

    # Ensure Stripe customer
    stripe_customer_id: Optional[str] = user.get("stripe_customer_id")
    if not stripe_customer_id:
        cust = stripe.Customer.create(email=user.get("email"), metadata={"user_id": str(user["id"])})
        stripe_customer_id = cust["id"]
        db.set_user_stripe_customer_id(int(user["id"]), stripe_customer_id)

    base = _public_base_url()
    success_url = f"{base}/?checkout=success&session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{base}/?pricing=1"

    session = stripe.checkout.Session.create(
        mode="subscription",
        customer=stripe_customer_id,
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        allow_promotion_codes=True,
        metadata={
            "user_id": str(user["id"]),
            "plan": payload.plan,
            "interval": payload.interval,
        },
    )

    return {"url": session.get("url")}


@router.post("/api/billing/checkout/complete")
def complete_checkout(session_id: str, user=Depends(require_user)):
    """Finalize subscription after returning from Stripe (fallback for when webhooks aren't configured)."""
    session_id = (session_id or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="Missing session_id")

    stripe = _stripe()

    sess = stripe.checkout.Session.retrieve(session_id, expand=["subscription", "customer"])
    session_customer_id = _stripe_id(sess.get("customer"))
    user_customer_id = user.get("stripe_customer_id")

    if session_customer_id and user_customer_id and session_customer_id != user_customer_id:
        raise HTTPException(status_code=403, detail="Session does not belong to the current user")

    if session_customer_id and session_customer_id != user_customer_id:
        db.set_user_stripe_customer_id(int(user["id"]), session_customer_id)

    sub = sess.get("subscription")
    if not sub:
        raise HTTPException(status_code=400, detail="No subscription on checkout session")
    if isinstance(sub, str):
        sub = stripe.Subscription.retrieve(sub)

    result = _apply_subscription_state(
        int(user["id"]),
        customer_id=session_customer_id or user_customer_id,
        subscription_obj=sub,
        fallback_plan=(sess.get("metadata") or {}).get("plan"),
        fallback_interval=(sess.get("metadata") or {}).get("interval"),
    )

    return {"status": "ok", "plan": result["plan"], "interval": result["interval"], "sub_status": result["status"]}


@router.post("/api/billing/webhook")
async def stripe_webhook(request: Request):
    """Stripe webhook handler (recommended for production).

    Configure STRIPE_WEBHOOK_SECRET and point Stripe webhooks to:
      {PUBLIC_BASE_URL}/api/billing/webhook
    """
    stripe = _stripe()

    secret = (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=500, detail="Missing STRIPE_WEBHOOK_SECRET in environment")

    payload = await request.body()
    sig = request.headers.get("stripe-signature")
    try:
        event = stripe.Webhook.construct_event(payload, sig_header=sig, secret=secret)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    etype = event.get("type")
    obj = (event.get("data") or {}).get("object") or {}

    if etype == "checkout.session.completed":
        customer = _stripe_id(obj.get("customer"))
        user_id = None
        try:
            user_id = int(((obj.get("metadata") or {}).get("user_id") or 0))
        except Exception:
            user_id = None
        user = None
        if user_id:
            user = {"id": user_id}
            if customer:
                db.set_user_stripe_customer_id(user_id, customer)
        elif customer:
            user = db._fetchone("SELECT id FROM users WHERE stripe_customer_id = ?", (customer,))

        if user:
            sub = obj.get("subscription")
            if sub:
                if isinstance(sub, str):
                    sub = stripe.Subscription.retrieve(sub)
                _apply_subscription_state(
                    int(user["id"]),
                    customer_id=customer,
                    subscription_obj=sub,
                    fallback_plan=(obj.get("metadata") or {}).get("plan"),
                    fallback_interval=(obj.get("metadata") or {}).get("interval"),
                )

    elif etype in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        customer = _stripe_id(obj.get("customer"))
        user = db._fetchone("SELECT id FROM users WHERE stripe_customer_id = ?", (customer,)) if customer else None
        if user:
            _apply_subscription_state(int(user["id"]), customer_id=customer, subscription_obj=obj)

    return {"received": True}
