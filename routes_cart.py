"""Review Batch cart — the pre-submission staging list of brand names a
user has picked to send to Trademark Review. Stored server-side, scoped per
user, so it's visible from any device/session once logged in (replaces the
old localStorage-only `pharma_legal_cart`).

Namespaced under /legal (not a bare top-level /cart) to match every other
endpoint in this domain — /legal/submit, /legal/reviews, /legal/batches —
since this is the staging step that precedes /legal/batches, not an
unrelated e-commerce concept.

GET    /legal/cart          — list the current user's cart items
POST   /legal/cart          — add an item (no-ops with added=false if already present)
DELETE /legal/cart/{item_id} — remove one item
DELETE /legal/cart          — clear every item for the current user
"""
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.user import User
from app.models.cart import ReviewBatchCartItem
from app.models.brand import GeneratedBrandName
from app.models.screening import BrandSearch

router = APIRouter(prefix="/legal/cart", tags=["Review Batch Cart"])


class CartItemIn(BaseModel):
    brand_name: str
    source_type: Optional[str] = None
    brand_search_id: Optional[str] = None
    generated_name_id: Optional[str] = None
    therapeutic_area: Optional[str] = None
    target_market: Optional[str] = None
    business_notes: Optional[str] = None
    risk_score: Optional[float] = None
    risk_level: Optional[str] = None
    risk_ai_assessment: Optional[str] = None
    market_ai_assessment: Optional[str] = None
    case_id: Optional[str] = None
    case_name: Optional[str] = None


def _to_out(item: ReviewBatchCartItem) -> dict:
    return {
        "id": str(item.id),
        "brand_name": item.brand_name,
        "source_type": item.source_type,
        "brand_search_id": str(item.brand_search_id) if item.brand_search_id else None,
        "generated_name_id": str(item.generated_name_id) if item.generated_name_id else None,
        "therapeutic_area": item.therapeutic_area,
        "target_market": item.target_market,
        "business_notes": item.business_notes,
        "risk_score": item.risk_score,
        "risk_level": item.risk_level,
        "risk_ai_assessment": item.risk_ai_assessment,
        "market_ai_assessment": item.market_ai_assessment,
        "case_id": item.case_id,
        "case_name": item.case_name,
        "added_at": item.added_at.isoformat() if item.added_at else None,
    }


@router.get("")
def list_cart_items(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    items = (
        db.query(ReviewBatchCartItem)
        .filter(ReviewBatchCartItem.user_id == current_user.id)
        .order_by(ReviewBatchCartItem.added_at)
        .all()
    )
    return [_to_out(i) for i in items]


@router.post("", status_code=status.HTTP_201_CREATED)
def add_cart_item(
    body: CartItemIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    name = body.brand_name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="brand_name is required")

    existing = (
        db.query(ReviewBatchCartItem)
        .filter(
            ReviewBatchCartItem.user_id == current_user.id,
            func.lower(ReviewBatchCartItem.brand_name) == name.lower(),
        )
        .first()
    )
    if existing:
        return {"item": _to_out(existing), "added": False}

    # generated_name_id / brand_search_id are soft references (see
    # GeneratedBrandName.case_id's docstring for the same pattern): the
    # frontend can hand back an id for a candidate that was only ever
    # streamed live and never persisted (e.g. generation was stopped before
    # the run's final save, so it never reached generated_brand_names).
    # Every field the UI actually needs is already snapshotted onto this row
    # directly, so a stale id should be dropped rather than fail the whole
    # add-to-cart call with a foreign key violation.
    brand_search_id = uuid.UUID(body.brand_search_id) if body.brand_search_id else None
    if brand_search_id and not db.query(BrandSearch.id).filter(BrandSearch.id == brand_search_id).first():
        brand_search_id = None

    generated_name_id = uuid.UUID(body.generated_name_id) if body.generated_name_id else None
    if generated_name_id and not db.query(GeneratedBrandName.id).filter(GeneratedBrandName.id == generated_name_id).first():
        generated_name_id = None

    item = ReviewBatchCartItem(
        id=uuid.uuid4(),
        user_id=current_user.id,
        brand_name=name,
        source_type=body.source_type,
        brand_search_id=brand_search_id,
        generated_name_id=generated_name_id,
        therapeutic_area=body.therapeutic_area,
        target_market=body.target_market,
        business_notes=body.business_notes,
        risk_score=body.risk_score,
        risk_level=body.risk_level,
        risk_ai_assessment=body.risk_ai_assessment,
        market_ai_assessment=body.market_ai_assessment,
        case_id=body.case_id,
        case_name=body.case_name,
        added_at=datetime.now(timezone.utc),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"item": _to_out(item), "added": True}


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_cart_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = (
        db.query(ReviewBatchCartItem)
        .filter(ReviewBatchCartItem.id == uuid.UUID(item_id), ReviewBatchCartItem.user_id == current_user.id)
        .first()
    )
    if item:
        db.delete(item)
        db.commit()


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def clear_cart(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    db.query(ReviewBatchCartItem).filter(ReviewBatchCartItem.user_id == current_user.id).delete()
    db.commit()
