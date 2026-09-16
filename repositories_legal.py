from typing import Any, Dict, List
from sqlalchemy.orm import Session
from app.models.legal import LegalReview
from app.models.cart import ReviewBatchCartItem
from app.services.tabular_import import normalize_name

# Statuses Legal has already reached a final decision on. Everything else
# (pending/under_review/needs_revision/revision_required) is still in-flight —
# see get_decided_name_lookup().
_DECIDED_STATUSES = ("approved", "rejected")


class LegalRepository:
    """Read access to the Trademark Review workflow's own name history —
    used by the AI Name Generator so it doesn't waste a generation attempt
    re-proposing a name that's already sitting somewhere in that workflow."""

    def __init__(self, db: Session):
        self.db = db

    def get_all_review_names(self) -> List[Dict[str, Any]]:
        """Every brand name ever submitted to Trademark Review — across all
        users, cases, and every status (pending/approved/rejected/
        needs_revision; a name doesn't stop being "already in the workflow"
        just because it was later decided on) — plus every name currently
        staged in a user's Review Batch cart (added but not yet submitted).
        Deduped case-insensitively, Review cart entries losing to a real
        submission if the same name appears in both."""
        reviews = self.db.query(LegalReview.brand_name, LegalReview.status).distinct().all()
        cart_items = self.db.query(ReviewBatchCartItem.brand_name).distinct().all()

        seen = set()
        out: List[Dict[str, Any]] = []
        for name, status in reviews:
            key = (name or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append({"name": name.strip(), "source": f"Trademark Review ({status or 'pending'})"})
        for (name,) in cart_items:
            key = (name or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append({"name": name.strip(), "source": "Review Batch (Cart — pending submission)"})
        return out

    def get_decided_name_lookup(self) -> Dict[str, str]:
        """normalize_name(brand_name) -> status, for every legal_reviews row
        Legal has already reached a final decision on (approved/rejected
        only). Hard exact-match gate input for the Name Generator — distinct
        from get_all_review_names() above, which is a soft avoid-hint fed
        into the LLM prompt at ANY status, including still-pending ones this
        gate deliberately leaves alone."""
        rows = (
            self.db.query(LegalReview.brand_name, LegalReview.status)
            .filter(LegalReview.status.in_(_DECIDED_STATUSES))
            .distinct()
            .all()
        )
        lookup: Dict[str, str] = {}
        for name, status in rows:
            if not name or not name.strip():
                continue
            lookup[normalize_name(name)] = status
        return lookup
