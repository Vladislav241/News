from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..auth.deps import require_user
from ..db import db


router = APIRouter()
logger = logging.getLogger(__name__)


def _stripe():
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


def _secret_key_mode() -> str:
    key = (os.getenv("STRIPE_SECRET_KEY") or "").strip()
    if key.startswith("sk_live_"):
        return "live"
    if key.startswith("sk_test_"):
        return "test"
    return "unknown"


def _publishable_key() -> str:
    return (os.getenv("STRIPE_PUBLISHABLE_KEY") or "").strip()


def _publishable_key_mode() -> str:
    key = _publishable_key()
    if key.startswith("pk_live_"):
        return "live"
    if key.startswith("pk_test_"):
        return "test"
    return "missing" if not key else "unknown"


def _public_base_url() -> str:
    base = (os.getenv("PUBLIC_BASE_URL") or "").strip().rstrip("/")
    if base:
        return base
    return "http://127.0.0.1:8000"


Plan = Literal["free", "pro", "analyst"]
Interval = Literal["monthly", "yearly"]


class CheckoutIn(BaseModel):
    plan: Plan
    interval: Interval = "monthly"


def _stripe_id(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return value.get("id")
    except Exception:
        return None


def _normalized_interval(value: Optional[str]) -> str:
    v = str(value or "month").strip().lower()
    return "yearly" if v in ("year", "annual", "yearly") else "monthly"


def _product_matches_plan(product_obj, plan: str) -> bool:
    if not product_obj:
        return False
    names = []
    metadata = {}
    try:
        if isinstance(product_obj, dict):
            names.extend([
                str(product_obj.get("name") or ""),
                str(product_obj.get("description") or ""),
                str(product_obj.get("statement_descriptor") or ""),
            ])
            metadata = product_obj.get("metadata") or {}
        else:
            names.extend([
                str(getattr(product_obj, "name", "") or ""),
                str(getattr(product_obj, "description", "") or ""),
                str(getattr(product_obj, "statement_descriptor", "") or ""),
            ])
            metadata = getattr(product_obj, "metadata", {}) or {}
    except Exception:
        metadata = {}

    plan_l = str(plan or "").strip().lower()
    haystack = " ".join(n.strip().lower() for n in names if n).strip()
    if plan_l and haystack and plan_l in haystack:
        return True

    try:
        meta_values = " ".join(str(v or "").strip().lower() for v in metadata.values())
        meta_keys = " ".join(str(k or "").strip().lower() for k in metadata.keys())
        if plan_l and (plan_l in meta_values or plan_l in meta_keys):
            return True
    except Exception:
        pass
    return False


def _price_matches_plan_interval(price_obj, plan: str, interval: str) -> bool:
    if not price_obj:
        return False
    try:
        active = bool(price_obj.get("active", True)) if isinstance(price_obj, dict) else bool(getattr(price_obj, "active", True))
        if not active:
            return False
        recurring = price_obj.get("recurring") if isinstance(price_obj, dict) else getattr(price_obj, "recurring", None)
        if not recurring:
            return False
        recurring_interval = recurring.get("interval") if isinstance(recurring, dict) else getattr(recurring, "interval", None)
        if _normalized_interval(recurring_interval) != str(interval or "monthly").strip().lower():
            return False

        lookup_key = str(price_obj.get("lookup_key") or "") if isinstance(price_obj, dict) else str(getattr(price_obj, "lookup_key", "") or "")
        metadata = (price_obj.get("metadata") or {}) if isinstance(price_obj, dict) else (getattr(price_obj, "metadata", {}) or {})
        combined = f"{lookup_key} {' '.join(str(v or '') for v in metadata.values())}".lower()
        if plan and plan.lower() in combined and str(interval).lower() in combined:
            return True
        if plan and plan.lower() in combined and _normalized_interval(interval) in combined:
            return True

        product_obj = price_obj.get("product") if isinstance(price_obj, dict) else getattr(price_obj, "product", None)
        return _product_matches_plan(product_obj, plan)
    except Exception:
        return False


def _infer_plan_from_price_obj(price_obj) -> Optional[str]:
    if not price_obj:
        return None
    if _price_matches_plan_interval(price_obj, "analyst", _normalized_interval(((price_obj.get("recurring") or {}).get("interval") if isinstance(price_obj, dict) else getattr(getattr(price_obj, "recurring", None), "interval", None)))):
        return "analyst"
    if _price_matches_plan_interval(price_obj, "pro", _normalized_interval(((price_obj.get("recurring") or {}).get("interval") if isinstance(price_obj, dict) else getattr(getattr(price_obj, "recurring", None), "interval", None)))):
        return "pro"
    return None


def _resolve_price_id_from_product_id(stripe, product_id: str, interval: str) -> Optional[str]:
    try:
        prices = stripe.Price.list(product=product_id, active=True, limit=100, expand=["data.product"])
    except Exception as exc:
        logger.warning("Failed to list Stripe prices for product %s: %s", product_id, exc)
        return None

    for price in (prices.get("data") or []):
        if _price_matches_plan_interval(price, "analyst", interval) or _price_matches_plan_interval(price, "pro", interval):
            pid = _stripe_id(price)
            if pid:
                return pid
    for price in (prices.get("data") or []):
        recurring = price.get("recurring") or {}
        if _normalized_interval(recurring.get("interval")) == str(interval).lower():
            pid = _stripe_id(price)
            if pid:
                return pid
    return None


def _resolve_price_id_from_catalog(stripe, plan: str, interval: str) -> Optional[str]:
    try:
        prices = stripe.Price.list(active=True, limit=100, expand=["data.product"])
    except Exception as exc:
        logger.warning("Failed to scan Stripe catalog for %s/%s: %s", plan, interval, exc)
        return None

    preferred = []
    fallback = []
    wanted_interval = str(interval or "monthly").strip().lower()
    for price in (prices.get("data") or []):
        recurring = price.get("recurring") or {}
        if not recurring:
            continue
        if _normalized_interval(recurring.get("interval")) != wanted_interval:
            continue
        pid = _stripe_id(price)
        if not pid:
            continue
        if _price_matches_plan_interval(price, plan, wanted_interval):
            preferred.append(price)
        else:
            product_obj = price.get("product") or {}
            product_name = str((product_obj.get("name") if isinstance(product_obj, dict) else getattr(product_obj, "name", "")) or "").strip().lower()
            if plan in product_name:
                fallback.append(price)

    candidates = preferred or fallback
    if not candidates:
        return None
    candidates.sort(key=lambda p: int((p.get("created") or 0)), reverse=True)
    return _stripe_id(candidates[0])


def _resolve_checkout_price_id(stripe, plan: str, interval: str) -> str:
    env_key = f"STRIPE_PRICE_{str(plan).upper()}_{str(interval).upper()}"
    configured = (os.getenv(env_key) or "").strip()

    if configured:
        if configured.startswith("price_"):
            try:
                price = stripe.Price.retrieve(configured, expand=["product"])
                if _price_matches_plan_interval(price, plan, interval):
                    return configured
                logger.warning("Configured %s=%s exists but does not match %s/%s; falling back to catalog lookup", env_key, configured, plan, interval)
            except Exception as exc:
                logger.warning("Configured %s=%s is not usable with current Stripe mode: %s", env_key, configured, exc)
        elif configured.startswith("prod_"):
            resolved = _resolve_price_id_from_product_id(stripe, configured, interval)
            if resolved:
                return resolved
            logger.warning("Configured %s=%s points to product but no matching recurring price was found", env_key, configured)
        else:
            logger.warning("Configured %s has unsupported value %s; expected price_... or prod_...", env_key, configured)

    fallback = _resolve_price_id_from_catalog(stripe, plan, interval)
    if fallback:
        return fallback

    raise HTTPException(
        status_code=500,
        detail=(
            f"No active Stripe price found for {plan}/{interval}. "
            f"Set {env_key}=price_... (or prod_...) or create an active recurring Stripe price for this plan."
        ),
    )




def _get_or_create_checkout_customer(stripe, user: dict) -> str:
    user_id = int(user["id"])
    email = (user.get("email") or "").strip() or None
    existing = str(user.get("stripe_customer_id") or "").strip()

    if existing:
        try:
            cust = stripe.Customer.retrieve(existing)
            deleted = bool(cust.get("deleted")) if isinstance(cust, dict) else bool(getattr(cust, "deleted", False))
            if not deleted:
                return existing
        except Exception as exc:
            logger.warning("Stored Stripe customer %s is not usable for user %s; recreating. Error: %s", existing, user_id, exc)
        try:
            db.set_user_stripe_customer_id(user_id, "")
        except Exception:
            logger.exception("Failed to clear stale Stripe customer id for user %s", user_id)

    metadata = {"user_id": str(user_id)}
    try:
        if email:
            matches = stripe.Customer.list(email=email, limit=10)
            for cust in (matches.get("data") or []):
                deleted = bool(cust.get("deleted")) if isinstance(cust, dict) else bool(getattr(cust, "deleted", False))
                if deleted:
                    continue
                cid = _stripe_id(cust)
                if cid:
                    db.set_user_stripe_customer_id(user_id, cid)
                    return cid
    except Exception as exc:
        logger.warning("Failed to search Stripe customer by email for user %s: %s", user_id, exc)

    try:
        cust = stripe.Customer.create(email=email, metadata=metadata)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to create Stripe customer: {exc}")

    customer_id = _stripe_id(cust)
    if not customer_id:
        raise HTTPException(status_code=500, detail="Stripe customer creation returned no id")
    db.set_user_stripe_customer_id(user_id, customer_id)
    return customer_id

def _plan_interval_from_subscription_object(obj: dict) -> tuple[str, str]:
    plan = "pro"
    interval = "monthly"
    try:
        items = (obj.get("items") or {}).get("data") or []
        if items:
            price = (items[0].get("price") or {})
            interval = _normalized_interval((price.get("recurring") or {}).get("interval"))
            inferred_plan = _infer_plan_from_price_obj(price)
            if inferred_plan:
                plan = inferred_plan
            else:
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


def _stripe_error_message(exc: Exception) -> str:
    try:
        user_msg = getattr(exc, "user_message", None)
        if user_msg:
            return str(user_msg)
    except Exception:
        pass
    return str(exc or "")


def _is_missing_stripe_subscription_error(exc: Exception) -> bool:
    msg = _stripe_error_message(exc).lower()
    return "no such subscription" in msg or "resource_missing" in msg


def _subscription_period_end_iso(subscription_obj) -> Optional[str]:
    try:
        value = subscription_obj.get("current_period_end") if isinstance(subscription_obj, dict) else getattr(subscription_obj, "current_period_end", None)
        if value:
            return datetime.fromtimestamp(int(value), tz=timezone.utc).replace(microsecond=0).isoformat()
    except Exception:
        pass
    return None


def _active_subscription_from_customer(stripe, customer_id: Optional[str]):
    """Return the newest usable Stripe subscription for a customer, or None.

    This heals local DB drift when the stored sub_ id is stale but the customer still has
    a valid active/trialing subscription in Stripe. Canceled/deleted subscriptions are not
    used for cancel/resume actions.
    """
    if not customer_id:
        return None
    try:
        result = stripe.Subscription.list(
            customer=customer_id,
            status="all",
            limit=20,
            expand=["data.items.data.price.product"],
        )
    except Exception as exc:
        logger.warning("Failed to list Stripe subscriptions for customer %s: %s", customer_id, exc)
        return None

    usable = []
    for sub in (result.get("data") or []):
        try:
            status = str(sub.get("status") or "").lower()
            if status in ("active", "trialing", "past_due", "unpaid"):
                usable.append(sub)
        except Exception:
            continue
    if not usable:
        return None
    usable.sort(key=lambda item: int(item.get("created") or item.get("current_period_start") or 0), reverse=True)
    return usable[0]


def _refresh_or_expire_missing_subscription(user_id: int, current: dict, *, action: str) -> Optional[dict]:
    """Recover from stale local sub_ ids.

    If Stripe says the stored subscription does not exist, Stripe is the source of truth:
    first try to find another active subscription for the same customer, otherwise clear
    the dead local subscription so the UI stops retrying the impossible action forever.
    """
    stripe = _stripe()
    customer_id = str(current.get("stripe_customer_id") or "").strip() or None
    replacement = _active_subscription_from_customer(stripe, customer_id)
    if replacement:
        logger.warning(
            "Recovered stale Stripe subscription for user %s during %s: old=%s new=%s",
            user_id,
            action,
            current.get("stripe_subscription_id"),
            _stripe_id(replacement),
        )
        updated = _apply_subscription_state(
            int(user_id),
            customer_id=customer_id,
            subscription_obj=replacement,
            fallback_plan=(current.get("plan") if str(current.get("plan") or "").lower() in ("pro", "analyst") else None),
            fallback_interval=(current.get("billing_interval") if str(current.get("billing_interval") or "").lower() in ("monthly", "yearly") else None),
        )
        return {**current, "stripe_subscription_id": _stripe_id(replacement), **updated}

    logger.warning(
        "Expiring stale local subscription for user %s during %s: missing Stripe subscription %s",
        user_id,
        action,
        current.get("stripe_subscription_id"),
    )
    try:
        db.expire_user_subscription_now(int(user_id), reason="stripe_missing")
    except Exception:
        logger.exception("Failed to expire stale local subscription for user %s", user_id)
    return None


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

    stripe = _stripe()
    try:
        stripe_sub = stripe.Subscription.retrieve(stripe_subscription_id, expand=["items.data.price.product"])
    except Exception as exc:
        if _is_missing_stripe_subscription_error(exc):
            recovered = _refresh_or_expire_missing_subscription(int(user_id), current, action="sync")
            return recovered or db.get_user_subscription(int(user_id))
        logger.warning("Stripe subscription sync failed for user %s / %s: %s", user_id, stripe_subscription_id, exc)
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
        "cancel_at_period_end": bool(stripe_sub.get("cancel_at_period_end") if isinstance(stripe_sub, dict) else getattr(stripe_sub, "cancel_at_period_end", False)),
        "stripe_subscription_id": _stripe_id(stripe_sub),
    }


@router.get("/api/billing/config")
def billing_config(user=Depends(require_user)):
    """Small frontend-safe Stripe config/status probe.

    Exposes only the publishable key (safe for clients) and key-mode health so the UI/admin
    can verify live/test mismatches without touching secrets.
    """
    del user  # authenticated probe only
    pk = _publishable_key()
    secret_mode = _secret_key_mode()
    publishable_mode = _publishable_key_mode()
    return {
        "publishable_key": pk or None,
        "has_publishable_key": bool(pk),
        "secret_mode": secret_mode,
        "publishable_mode": publishable_mode,
        "publishable_matches_secret": bool(pk) and secret_mode != "unknown" and publishable_mode == secret_mode,
    }


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
    current = db.get_user_subscription(int(user["id"]))
    if not current or not current.get("stripe_subscription_id"):
        raise HTTPException(status_code=400, detail="No active subscription")

    stripe = _stripe()
    sub_id = str(current.get("stripe_subscription_id") or "").strip()
    try:
        stripe_sub = stripe.Subscription.modify(
            sub_id,
            cancel_at_period_end=True,
            expand=["items.data.price.product"],
        )
    except Exception as exc:
        if _is_missing_stripe_subscription_error(exc):
            recovered = _refresh_or_expire_missing_subscription(int(user["id"]), current, action="cancel")
            if recovered and recovered.get("stripe_subscription_id") and recovered.get("stripe_subscription_id") != sub_id:
                try:
                    stripe_sub = stripe.Subscription.modify(
                        recovered["stripe_subscription_id"],
                        cancel_at_period_end=True,
                        expand=["items.data.price.product"],
                    )
                    current = recovered
                except Exception as retry_exc:
                    raise HTTPException(status_code=400, detail=f"Stripe error: {_stripe_error_message(retry_exc)}")
            else:
                raise HTTPException(
                    status_code=409,
                    detail="This subscription no longer exists in Stripe. Your local billing state was refreshed; please start a new subscription if you want to continue.",
                )
        else:
            raise HTTPException(status_code=400, detail=f"Stripe error: {_stripe_error_message(exc)}")

    period_end_iso = _subscription_period_end_iso(stripe_sub)

    db.set_user_subscription(
        int(user["id"]),
        plan=(current.get("plan") or "free"),
        status=stripe_sub.get("status") if isinstance(stripe_sub, dict) else stripe_sub.status,
        billing_interval=(current.get("billing_interval") or "monthly"),
        stripe_customer_id=current.get("stripe_customer_id"),
        stripe_subscription_id=_stripe_id(stripe_sub) or current.get("stripe_subscription_id"),
        current_period_end=period_end_iso,
        cancel_at_period_end=bool(stripe_sub.get("cancel_at_period_end") if isinstance(stripe_sub, dict) else getattr(stripe_sub, "cancel_at_period_end", False)),
    )

    return {
        "ok": True,
        "status": stripe_sub.get("status") if isinstance(stripe_sub, dict) else stripe_sub.status,
        "current_period_end": period_end_iso,
        "cancel_at_period_end": bool(stripe_sub.get("cancel_at_period_end") if isinstance(stripe_sub, dict) else getattr(stripe_sub, "cancel_at_period_end", False)),
    }


@router.post("/api/billing/resume")
def resume_subscription(user=Depends(require_user)):
    current = db.get_user_subscription(int(user["id"]))
    if not current or not current.get("stripe_subscription_id"):
        raise HTTPException(status_code=400, detail="No active subscription")

    stripe = _stripe()
    sub_id = str(current.get("stripe_subscription_id") or "").strip()
    try:
        stripe_sub = stripe.Subscription.modify(
            sub_id,
            cancel_at_period_end=False,
            expand=["items.data.price.product"],
        )
    except Exception as exc:
        if _is_missing_stripe_subscription_error(exc):
            recovered = _refresh_or_expire_missing_subscription(int(user["id"]), current, action="resume")
            if recovered and recovered.get("stripe_subscription_id") and recovered.get("stripe_subscription_id") != sub_id:
                try:
                    stripe_sub = stripe.Subscription.modify(
                        recovered["stripe_subscription_id"],
                        cancel_at_period_end=False,
                        expand=["items.data.price.product"],
                    )
                    current = recovered
                except Exception as retry_exc:
                    raise HTTPException(status_code=400, detail=f"Stripe error: {_stripe_error_message(retry_exc)}")
            else:
                raise HTTPException(
                    status_code=409,
                    detail="This subscription no longer exists in Stripe. Your local billing state was refreshed; please start a new subscription instead of resuming it.",
                )
        else:
            raise HTTPException(status_code=400, detail=f"Stripe error: {_stripe_error_message(exc)}")

    period_end_iso = _subscription_period_end_iso(stripe_sub)

    db.set_user_subscription(
        int(user["id"]),
        plan=(current.get("plan") or "free"),
        status=stripe_sub.get("status") if isinstance(stripe_sub, dict) else stripe_sub.status,
        billing_interval=(current.get("billing_interval") or "monthly"),
        stripe_customer_id=current.get("stripe_customer_id"),
        stripe_subscription_id=_stripe_id(stripe_sub) or current.get("stripe_subscription_id"),
        current_period_end=period_end_iso,
        cancel_at_period_end=bool(stripe_sub.get("cancel_at_period_end") if isinstance(stripe_sub, dict) else getattr(stripe_sub, "cancel_at_period_end", False)),
    )

    return {
        "ok": True,
        "status": stripe_sub.get("status") if isinstance(stripe_sub, dict) else stripe_sub.status,
        "current_period_end": period_end_iso,
        "cancel_at_period_end": bool(stripe_sub.get("cancel_at_period_end") if isinstance(stripe_sub, dict) else getattr(stripe_sub, "cancel_at_period_end", False)),
    }


@router.post("/api/billing/set-free")
def set_free(user=Depends(require_user)):
    db.set_user_subscription(int(user["id"]), plan="free", status="active", billing_interval="monthly")
    return {"status": "ok", "plan": "free"}


@router.post("/api/billing/checkout")
def create_checkout(payload: CheckoutIn, user=Depends(require_user)):
    current = _sync_user_subscription_from_stripe(int(user["id"]))
    if current:
        cur_plan = (current.get("plan") or "free").lower()
        cur_status = (current.get("status") or "active").lower()
        cur_interval = (current.get("billing_interval") or "monthly").lower()
        if cur_status in ("active", "trialing") and cur_plan == payload.plan and cur_interval == payload.interval:
            raise HTTPException(status_code=400, detail="Already subscribed to this plan.")
    if payload.plan == "free":
        db.set_user_subscription(int(user["id"]), plan="free", status="active", billing_interval="monthly")
        return {"url": f"{_public_base_url()}/?pricing=1"}

    stripe = _stripe()
    price_id = _resolve_checkout_price_id(stripe, payload.plan, payload.interval)

    stripe_customer_id = _get_or_create_checkout_customer(stripe, user)

    base = _public_base_url()
    success_url = f"{base}/?checkout=success&session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{base}/?pricing=1"

    try:
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
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to start Stripe checkout: {exc}")

    checkout_url = session.get("url")
    if not checkout_url:
        raise HTTPException(status_code=500, detail="Stripe checkout session was created without a redirect URL")
    return {"url": checkout_url, "price_id": price_id}


@router.post("/api/billing/checkout/complete")
def complete_checkout(session_id: str, user=Depends(require_user)):
    session_id = (session_id or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="Missing session_id")

    stripe = _stripe()

    try:
        sess = stripe.checkout.Session.retrieve(session_id, expand=["subscription", "customer"])
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to verify Stripe checkout session: {exc}")

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
        try:
            sub = stripe.Subscription.retrieve(sub)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Failed to load Stripe subscription: {exc}")

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
