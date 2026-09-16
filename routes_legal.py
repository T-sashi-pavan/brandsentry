"""
Legal Review workflow endpoints.

POST /legal/submit                          — business team submits a brand name for review
GET  /legal/reviews                         — list reviews (mine=true for submitter-only view)
GET  /legal/reviews/{id}                    — single review detail
PUT  /legal/reviews/{id}/approve            — legal team approves
PUT  /legal/reviews/{id}/reject             — legal team rejects
PUT  /legal/reviews/{id}/request-revision   — legal team requests changes
DELETE /legal/reviews/{id}                  — submitter can retract a pending review
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime, timezone
import uuid

from app.core.database import get_db
from app.core.permissions import has_permission
from app.core.rate_limit import get_client_ip
from app.api.deps import get_current_user, require_permission
from app.models.user import User
from app.models.legal import LegalReview, LegalReviewBatch, ReviewMessage
from app.models.screening import BrandSearch
from app.models.brand import GeneratedBrandName
from app.repositories.audit import AuditRepository
from app.services import notification as notif_svc
from pydantic import BaseModel, Field
from typing import List

router = APIRouter(prefix="/legal", tags=["Legal Review"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class SubmitReviewRequest(BaseModel):
    brand_name: str
    source_type: str = "manual"
    brand_search_id: Optional[str] = None
    generated_name_id: Optional[str] = None
    therapeutic_area: Optional[str] = None
    target_market: Optional[str] = None
    business_notes: Optional[str] = None
    risk_score: Optional[float] = None
    risk_level: Optional[str] = None
    risk_ai_assessment: Optional[str] = None
    market_ai_assessment: Optional[str] = None
    case_id: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,30}$")
    case_name: Optional[str] = None


class SubmitBatchRequest(BaseModel):
    description: Optional[str] = None
    items: List[SubmitReviewRequest]


class ReviewActionRequest(BaseModel):
    comments: Optional[str] = None
    legal_ref: Optional[str] = None


class ResubmitReviewRequest(BaseModel):
    comments: Optional[str] = None
    rationale: Optional[str] = None


class ReviewMessageCreate(BaseModel):
    message: str = Field(..., max_length=5000)


class ReviewMessageOut(BaseModel):
    id: str
    review_id: str
    sender_id: Optional[str] = None
    sender_name: str
    sender_role: Optional[str] = None
    message: str
    created_at: Optional[str] = None

    class Config:
        from_attributes = True


class LegalReviewOut(BaseModel):
    id: str
    brand_name: str
    proposed_by_name: Optional[str]
    proposed_by_dept: Optional[str]
    submitted_at: str
    source_type: str
    therapeutic_area: Optional[str]
    target_market: Optional[str]
    business_notes: Optional[str]
    risk_score: Optional[float]
    risk_level: Optional[str]
    risk_ai_assessment: Optional[str]
    market_ai_assessment: Optional[str]
    status: str
    reviewer_name: Optional[str]
    reviewed_at: Optional[str]
    reviewer_comments: Optional[str]
    legal_ref: Optional[str]
    created_at: str
    messages: List[ReviewMessageOut] = []
    messages_count: int = 0

    class Config:
        from_attributes = True


def _message_to_out(m: ReviewMessage) -> dict:
    return {
        "id": str(m.id),
        "review_id": str(m.review_id),
        "sender_id": str(m.sender_id) if m.sender_id else None,
        "sender_name": m.sender_name,
        "sender_role": m.sender_role,
        "message": m.message,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _to_out(r: LegalReview) -> dict:
    raw_msgs = r.messages if hasattr(r, "messages") and r.messages else []
    msgs = [_message_to_out(m) for m in raw_msgs]
    
    # If no explicit messages in table yet, synthesize from existing comments/notes if present
    if not msgs:
        if r.business_notes:
            msgs.append({
                "id": f"bn-{r.id}",
                "review_id": str(r.id),
                "sender_id": str(r.proposed_by_id) if r.proposed_by_id else None,
                "sender_name": r.proposed_by_name or "Brand Marketing Team",
                "sender_role": "Brand Marketing",
                "message": r.business_notes,
                "created_at": r.submitted_at.isoformat() if r.submitted_at else None,
            })
        if r.reviewer_comments:
            msgs.append({
                "id": f"rc-{r.id}",
                "review_id": str(r.id),
                "sender_id": str(r.reviewer_id) if r.reviewer_id else None,
                "sender_name": r.reviewer_name or "Trademark Counsel",
                "sender_role": "Trademark Counsel",
                "message": r.reviewer_comments,
                "created_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
            })

    return {
        "id": str(r.id),
        "brand_name": r.brand_name,
        "proposed_by_name": r.proposed_by_name,
        "proposed_by_dept": r.proposed_by_dept,
        "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
        "source_type": r.source_type,
        "therapeutic_area": r.therapeutic_area,
        "target_market": r.target_market,
        "business_notes": r.business_notes,
        "risk_score": r.risk_score,
        "risk_level": r.risk_level,
        "risk_ai_assessment": r.risk_ai_assessment,
        "market_ai_assessment": r.market_ai_assessment,
        "status": r.status,
        "reviewer_name": r.reviewer_name,
        "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "reviewer_comments": r.reviewer_comments,
        "legal_ref": r.legal_ref,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "messages": msgs,
        "messages_count": len(msgs),
    }


# ── Helpers (batch) ─────────────────────────────────────────────────────────

# Derived batch status — never stored, so it can't drift from its children.
def _batch_status(reviews) -> str:
    if not reviews:
        return "pending"
    if all(r.status == "pending" for r in reviews):
        return "pending"
    if all(r.status != "pending" for r in reviews):
        return "completed"
    return "in_progress"


def _generate_batch_code(db: Session) -> str:
    """LR-{year}-{seq}, seq scoped to the year — derived from the highest
    existing sequence number for this year, not a row count. A row count
    breaks the moment any batch for this year is ever deleted: e.g. with
    batches 0001/0004/0009 surviving after 0002/0003/0005-0008 were removed,
    "count + 1" (3 + 1 = 4) collides with the still-existing 0004 and the
    unique constraint rejects the insert."""
    year = datetime.now(timezone.utc).year
    prefix = f"LR-{year}-"
    codes = db.query(LegalReviewBatch.batch_code).filter(
        LegalReviewBatch.batch_code.like(f"{prefix}%")
    ).all()
    max_seq = 0
    for (code,) in codes:
        try:
            max_seq = max(max_seq, int(code[len(prefix):]))
        except ValueError:
            continue
    return f"{prefix}{max_seq + 1:04d}"


_MAX_PENDING_PER_CASE = 6


def _enforce_case_pending_cap(db: Session, items: list["SubmitReviewRequest"]) -> None:
    """At most _MAX_PENDING_PER_CASE names per case can be awaiting review at
    once — once Trademark Review has resolved (approved/rejected/requested
    revision on) all of a case's current batch, the business team can submit
    its next up-to-6. Rejects the whole submission (not a partial/silent
    trim) so the business team gets one clear reason instead of guessing
    which of their names silently didn't make it in."""
    by_case: dict[str, int] = {}
    for item in items:
        if item.case_id:
            by_case[item.case_id] = by_case.get(item.case_id, 0) + 1

    for case_id, new_count in by_case.items():
        pending = (
            db.query(LegalReview)
            .filter(LegalReview.case_id == case_id, LegalReview.status == "pending")
            .count()
        )
        if pending + new_count > _MAX_PENDING_PER_CASE:
            remaining = max(0, _MAX_PENDING_PER_CASE - pending)
            case_name = next((i.case_name for i in items if i.case_id == case_id and i.case_name), case_id)
            raise HTTPException(
                status_code=400,
                detail=(
                    f'"{case_name}" already has {pending} name(s) pending trademark review '
                    f"(max {_MAX_PENDING_PER_CASE} at a time). You can submit {remaining} more for this case "
                    f"right now — the rest can go in once Trademark Review resolves the current batch."
                ),
            )


def _build_review(body: SubmitReviewRequest, current_user: User, db: Session,
                  batch_id: Optional[uuid.UUID] = None) -> LegalReview:
    # H-08: brand_search_id/generated_name_id come from the request body —
    # confirm the referenced record actually belongs to the submitting user
    # (when it has an owner) before letting the review reference it.
    if body.brand_search_id:
        b_search_id = uuid.UUID(body.brand_search_id)
        search = db.query(BrandSearch).filter(BrandSearch.id == b_search_id).first()
        if search and search.user_id and search.user_id != current_user.id and not current_user.is_superuser:
            raise HTTPException(status_code=403, detail="Not authorized to reference another user's brand search")
    if body.generated_name_id:
        g_name_id = uuid.UUID(body.generated_name_id)
        gen = db.query(GeneratedBrandName).filter(GeneratedBrandName.id == g_name_id).first()
        if gen and gen.user_id and gen.user_id != current_user.id and not current_user.is_superuser:
            raise HTTPException(status_code=403, detail="Not authorized to reference another user's generated name")

    return LegalReview(
        id=uuid.uuid4(),
        batch_id=batch_id,
        brand_name=body.brand_name.strip(),
        proposed_by_id=current_user.id,
        proposed_by_name=current_user.full_name or current_user.email,
        proposed_by_dept=getattr(current_user, "department", None),
        source_type=body.source_type,
        brand_search_id=uuid.UUID(body.brand_search_id) if body.brand_search_id else None,
        generated_name_id=uuid.UUID(body.generated_name_id) if body.generated_name_id else None,
        therapeutic_area=body.therapeutic_area,
        target_market=body.target_market,
        business_notes=body.business_notes,
        risk_score=body.risk_score,
        risk_level=body.risk_level,
        risk_ai_assessment=body.risk_ai_assessment,
        market_ai_assessment=body.market_ai_assessment,
        case_id=body.case_id,
        case_name=body.case_name,
        status="pending",
    )


def _batch_to_out(batch: LegalReviewBatch, reviews=None) -> dict:
    reviews = batch.reviews if reviews is None else reviews
    reviewed = [r for r in reviews if r.status != "pending"]
    # Per-name outcome breakdown — drives the name-outcome KPI row.
    approved_count = sum(1 for r in reviews if r.status == "approved")
    rejected_count = sum(1 for r in reviews if r.status == "rejected")
    needs_revision_count = sum(1 for r in reviews if r.status == "needs_revision")
    pending_count = sum(1 for r in reviews if r.status == "pending")
    return {
        "id": str(batch.id),
        "batch_code": batch.batch_code,
        "description": batch.description,
        "proposed_by_name": batch.proposed_by_name,
        "proposed_by_dept": batch.proposed_by_dept,
        "submitted_at": batch.submitted_at.isoformat() if batch.submitted_at else None,
        "name_count": len(reviews),
        "reviewed_count": len(reviewed),
        "approved_count": approved_count,
        "rejected_count": rejected_count,
        "needs_revision_count": needs_revision_count,
        "pending_count": pending_count,
        "status": _batch_status(reviews),
        # Lightweight name list (not the full LegalReview rows) so the queue's
        # search can match a submitted name — e.g. "FYNARA" — against a batch
        # without a per-card detail fetch for every row in the list.
        "names": [r.brand_name for r in reviews],
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/submit", status_code=201)
def submit_for_review(
    body: SubmitReviewRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _enforce_case_pending_cap(db, [body])
    review = _build_review(body, current_user, db)
    db.add(review)
    db.flush()

    notif_svc.notify_reviewers_and_admins(
        db,
        ntype="legal_submitted",
        title=f"New legal review: {review.brand_name}",
        message=f"{current_user.full_name or current_user.email} submitted \"{review.brand_name}\" for legal review.",
        resource_id=review.id,
    )
    AuditRepository(db).create(
        action="LEGAL_REVIEW_SUBMITTED",
        user_id=current_user.id,
        resource_type="legal_review",
        resource_id=str(review.id),
        details=f'Submitted "{review.brand_name}" for legal review',
        metadata={"brand_name": review.brand_name, "case_id": review.case_id},
        ip_address=get_client_ip(http_request),
        status="success",
    )
    db.commit()
    db.refresh(review)
    return _to_out(review)


@router.get("/reviews")
def list_reviews(
    status: Optional[str] = Query(None),
    mine: bool = Query(False),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = db.query(LegalReview)
    # H-05: only Super Admin / trademark_review-permitted roles may see every
    # submitter's reviews — everyone else is force-scoped to their own,
    # regardless of the `mine` flag.
    is_tm_or_admin = current_user.is_superuser or has_permission(current_user, "trademark_review")
    if mine or not is_tm_or_admin:
        q = q.filter(LegalReview.proposed_by_id == current_user.id)
    if status:
        q = q.filter(LegalReview.status == status)
    return [
        _to_out(r)
        for r in q.order_by(LegalReview.submitted_at.desc()).offset(offset).limit(limit).all()
    ]


@router.get("/reviews/submitted-names")
def list_submitted_names(
    limit: int = Query(1000, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every brand name that has ever been submitted for Trademark Review,
    across every status (pending/approved/rejected/needs_revision) — a name
    doesn't stop being "already submitted" just because it was later decided
    on. Used by the Review Batch add-to-cart gate on every other page (Brand
    Analysis, Compare, AI Generator) so a name can't be re-added to the cart
    once it's already gone through this workflow.

    M-02: scoped to the caller's own submissions unless they hold a
    trademark role or are a superuser — this endpoint previously returned
    every submitter's brand names to any authenticated user, exposing
    confidential pre-launch brand strategy across divisions. This narrows
    (rather than removes) the pre-submission duplicate check for non-privileged
    users: a genuine cross-division duplicate is no longer blocked before
    submission, but it would still surface when Trademark Review actually
    processes it (the same conflict/screening pipeline every other submission
    goes through) — there is no separate server-side uniqueness check on
    LegalReview.brand_name today, here or in cart.py's add_cart_item.
    """
    q = db.query(LegalReview.brand_name).distinct()
    is_tm_or_admin = current_user.is_superuser or has_permission(current_user, "trademark_review")
    if not is_tm_or_admin:
        q = q.filter(LegalReview.proposed_by_id == current_user.id)
    rows = q.offset(offset).limit(limit).all()
    return [r[0] for r in rows]


@router.get("/reviews/{review_id}")
def get_review(
    review_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    review = db.query(LegalReview).filter(LegalReview.id == uuid.UUID(review_id)).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    allowed = (
        current_user.is_superuser
        or review.proposed_by_id == current_user.id
        or has_permission(current_user, "trademark_review")
    )
    if not allowed:
        raise HTTPException(status_code=403, detail="Access denied to this legal review")

    return _to_out(review)


# ── Batch routes ──────────────────────────────────────────────────────────────

@router.post("/batches", status_code=201)
def submit_batch(
    body: SubmitBatchRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    items = [i for i in body.items if i.brand_name and i.brand_name.strip()]
    if not items:
        raise HTTPException(status_code=400, detail="Batch must contain at least one name")
    _enforce_case_pending_cap(db, items)

    batch = LegalReviewBatch(
        id=uuid.uuid4(),
        batch_code=_generate_batch_code(db),
        description=(body.description or "").strip() or None,
        proposed_by_id=current_user.id,
        proposed_by_name=current_user.full_name or current_user.email,
        proposed_by_dept=getattr(current_user, "department", None),
    )
    db.add(batch)
    db.flush()

    reviews = [_build_review(item, current_user, db, batch_id=batch.id) for item in items]
    db.add_all(reviews)
    db.flush()

    notif_svc.notify_reviewers_and_admins(
        db,
        ntype="legal_submitted",
        title=f"New legal review batch: {batch.batch_code} ({len(reviews)} names)",
        message=(
            f"{current_user.full_name or current_user.email} submitted a batch of "
            f"{len(reviews)} name(s) for legal review"
            + (f": {batch.description}" if batch.description else ".")
        ),
        resource_id=batch.id,
    )
    AuditRepository(db).create(
        action="LEGAL_REVIEW_BATCH_SUBMITTED",
        user_id=current_user.id,
        resource_type="legal_review_batch",
        resource_id=str(batch.id),
        details=f"Submitted batch {batch.batch_code} ({len(reviews)} name(s)) for legal review",
        metadata={"batch_code": batch.batch_code, "count": len(reviews)},
        ip_address=get_client_ip(http_request),
        status="success",
    )
    db.commit()
    db.refresh(batch)
    return _batch_to_out(batch, reviews)


@router.get("/batches")
def list_batches(
    mine: bool = Query(False),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = db.query(LegalReviewBatch)
    # H-05: same scoping gap as list_reviews — force-scope to own batches
    # unless the caller is Super Admin or holds trademark_review access.
    is_tm_or_admin = current_user.is_superuser or has_permission(current_user, "trademark_review")
    if mine or not is_tm_or_admin:
        q = q.filter(LegalReviewBatch.proposed_by_id == current_user.id)
    batches = q.order_by(LegalReviewBatch.submitted_at.desc()).offset(offset).limit(limit).all()
    return [_batch_to_out(b) for b in batches]


@router.get("/batches/{batch_id}")
def get_batch(
    batch_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    batch = db.query(LegalReviewBatch).filter(LegalReviewBatch.id == uuid.UUID(batch_id)).first()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    reviews = sorted(batch.reviews, key=lambda r: r.submitted_at or datetime.min)
    return {
        **_batch_to_out(batch, reviews),
        "reviews": [_to_out(r) for r in reviews],
    }


def _legal_action(review_id: str, new_status: str, body: ReviewActionRequest,
                  db: Session, current_user: User, http_request: Request) -> dict:
    # H-04 defense-in-depth: each of the three call sites (approve/reject/
    # request-revision) already gates on Depends(require_permission(...)),
    # but re-check here too so this helper is never callable from a future
    # route that forgets the dependency.
    if not (
        current_user.is_superuser
        or has_permission(current_user, "trademark_review", "action_approve")
        or has_permission(current_user, "trademark_review", "action_reject")
        or has_permission(current_user, "trademark_review", "action_request_revision")
    ):
        raise HTTPException(status_code=403, detail="Trademark review privileges required")

    review = db.query(LegalReview).filter(LegalReview.id == uuid.UUID(review_id)).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    review.status = new_status
    review.reviewer_id = current_user.id
    review.reviewer_name = current_user.full_name or current_user.email
    review.reviewed_at = datetime.now(timezone.utc)
    review.reviewer_comments = body.comments
    if body.legal_ref:
        review.legal_ref = body.legal_ref

    # Save to conversation history thread
    if body.comments and body.comments.strip():
        user_role = (current_user.role or "").lower()
        role_label = "Trademark Counsel" if ("trademark" in user_role or "counsel" in user_role) else (current_user.role or "Reviewer")
        msg = ReviewMessage(
            id=uuid.uuid4(),
            review_id=review.id,
            sender_id=current_user.id,
            sender_name=current_user.full_name or current_user.email,
            sender_role=role_label,
            message=body.comments.strip(),
            created_at=datetime.now(timezone.utc),
        )
        db.add(msg)

    _STATUS_META = {
        "approved":       ("legal_approved",      "approved",           "approved"),
        "rejected":       ("legal_rejected",       "rejected",           "rejected"),
        "needs_revision": ("legal_needs_revision", "needs revision",     "requested revisions on"),
    }
    ntype, label, verb = _STATUS_META.get(new_status, ("legal_action", new_status, new_status))
    reviewer_display = current_user.full_name or current_user.email
    title = f'Legal review {label}: {review.brand_name}'
    message = f'{reviewer_display} has {verb} the legal review for "{review.brand_name}".'
    if body.comments:
        message += f" Note: {body.comments}"

    # H-09: notify Trademark/Admin reviewers plus the original submitter
    # directly, instead of broadcasting confidential review outcomes to
    # every active user regardless of role.
    notif_svc.notify_reviewers_and_admins(db, ntype, title, message, review.id)
    if review.proposed_by_id and review.proposed_by_id != current_user.id:
        notif_svc._create(db, review.proposed_by_id, ntype, title, message, review.id)

    AuditRepository(db).create(
        action=f"LEGAL_REVIEW_{new_status.upper()}",
        user_id=current_user.id,
        resource_type="legal_review",
        resource_id=str(review.id),
        details=f'{reviewer_display} {verb} the legal review for "{review.brand_name}"',
        metadata={"brand_name": review.brand_name, "comments": body.comments, "legal_ref": body.legal_ref},
        ip_address=get_client_ip(http_request),
        status="success",
    )

    db.commit()
    db.refresh(review)
    return _to_out(review)


@router.put("/reviews/{review_id}/approve")
def approve_review(
    review_id: str,
    http_request: Request,
    body: ReviewActionRequest = ReviewActionRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("trademark_review", "action_approve")),
):
    return _legal_action(review_id, "approved", body, db, current_user, http_request)


@router.put("/reviews/{review_id}/reject")
def reject_review(
    review_id: str,
    http_request: Request,
    body: ReviewActionRequest = ReviewActionRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("trademark_review", "action_reject")),
):
    return _legal_action(review_id, "rejected", body, db, current_user, http_request)


@router.put("/reviews/{review_id}/request-revision")
def request_revision(
    review_id: str,
    http_request: Request,
    body: ReviewActionRequest = ReviewActionRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("trademark_review", "action_request_revision")),
):
    return _legal_action(review_id, "needs_revision", body, db, current_user, http_request)


@router.put("/reviews/{review_id}/resubmit")
def resubmit_review(
    review_id: str,
    http_request: Request,
    body: ResubmitReviewRequest = ResubmitReviewRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """BMT user or Admin sends a subcase that required revision back to the Trademark Team."""
    review = db.query(LegalReview).filter(LegalReview.id == uuid.UUID(review_id)).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    if review.proposed_by_id != current_user.id and not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="You can only resubmit your own reviews")
    if review.status != "needs_revision":
        raise HTTPException(status_code=400, detail="Only reviews with needs_revision status can be resubmitted")

    review.status = "pending"
    review.submitted_at = datetime.now(timezone.utc)

    # Append revision clarification/notes and save to conversation thread
    comment_text = (body.comments or body.rationale or "").strip()
    if comment_text:
        user_name = current_user.full_name or current_user.email
        user_role = (current_user.role or "").lower()
        role_label = "Brand Marketing" if ("brand" in user_role or "market" in user_role) else (current_user.role or "Submitter")
        
        msg = ReviewMessage(
            id=uuid.uuid4(),
            review_id=review.id,
            sender_id=current_user.id,
            sender_name=user_name,
            sender_role=role_label,
            message=comment_text,
            created_at=datetime.now(timezone.utc),
        )
        db.add(msg)

        revised_note = f"[Revised by {user_name} on {datetime.now(timezone.utc).strftime('%d %b %Y, %H:%M UTC')}]: {comment_text}"
        if review.business_notes:
            review.business_notes = f"{review.business_notes}\n\n{revised_note}"
        else:
            review.business_notes = revised_note

    # H-09: notify Trademark/Admin reviewers plus the submitter directly,
    # instead of broadcasting to every active user regardless of role.
    case_label = review.case_name or review.case_id or "Case"
    ntype = "legal_submitted"
    title = f"Subcase Resubmitted: {review.brand_name} ({case_label})"
    message = f"{current_user.full_name or current_user.email} (Brand Marketing) resubmitted '{review.brand_name}' for case '{case_label}' with revised information to the Trademark Team."
    notif_svc.notify_reviewers_and_admins(db, ntype, title, message, review.id)
    if review.proposed_by_id and review.proposed_by_id != current_user.id:
        notif_svc._create(db, review.proposed_by_id, ntype, title, message, review.id)

    AuditRepository(db).create(
        action="LEGAL_REVIEW_RESUBMITTED",
        user_id=current_user.id,
        resource_type="legal_review",
        resource_id=str(review.id),
        details=f'Resubmitted "{review.brand_name}" to the Trademark Team ({case_label})',
        metadata={"brand_name": review.brand_name, "case": case_label},
        ip_address=get_client_ip(http_request),
        status="success",
    )

    db.commit()
    db.refresh(review)
    return _to_out(review)


@router.get("/reviews/{review_id}/messages")
def get_review_messages(
    review_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    review = db.query(LegalReview).filter(LegalReview.id == uuid.UUID(review_id)).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    allowed = (
        current_user.is_superuser
        or review.proposed_by_id == current_user.id
        or has_permission(current_user, "trademark_review")
    )
    if not allowed:
        raise HTTPException(status_code=403, detail="Access denied to this legal review")

    msgs = db.query(ReviewMessage).filter(ReviewMessage.review_id == review.id).order_by(ReviewMessage.created_at.asc()).all()
    if not msgs:
        out = []
        if review.business_notes:
            out.append({
                "id": f"bn-{review.id}",
                "review_id": str(review.id),
                "sender_id": str(review.proposed_by_id) if review.proposed_by_id else None,
                "sender_name": review.proposed_by_name or "Brand Marketing Team",
                "sender_role": "Brand Marketing",
                "message": review.business_notes,
                "created_at": review.submitted_at.isoformat() if review.submitted_at else None,
            })
        if review.reviewer_comments:
            out.append({
                "id": f"rc-{review.id}",
                "review_id": str(review.id),
                "sender_id": str(review.reviewer_id) if review.reviewer_id else None,
                "sender_name": review.reviewer_name or "Trademark Counsel",
                "sender_role": "Trademark Counsel",
                "message": review.reviewer_comments,
                "created_at": review.reviewed_at.isoformat() if review.reviewed_at else None,
            })
        return out
    return [_message_to_out(m) for m in msgs]


@router.post("/reviews/{review_id}/messages", status_code=201)
def post_review_message(
    review_id: str,
    body: ReviewMessageCreate,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    review = db.query(LegalReview).filter(LegalReview.id == uuid.UUID(review_id)).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    is_tm_or_admin = current_user.is_superuser or has_permission(current_user, "trademark_review")
    if review.proposed_by_id != current_user.id and not is_tm_or_admin:
        raise HTTPException(status_code=403, detail="Not authorized to post messages on this review")

    text = (body.message or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    if len(text) > 5000:
        raise HTTPException(status_code=400, detail="Message cannot exceed 5000 characters")

    user_role = (current_user.role or "").lower()
    role_label = "Trademark Counsel" if ("trademark" in user_role or "counsel" in user_role) else "Brand Marketing" if ("brand" in user_role or "market" in user_role) else (current_user.role or "Team Member")

    msg = ReviewMessage(
        id=uuid.uuid4(),
        review_id=review.id,
        sender_id=current_user.id,
        sender_name=current_user.full_name or current_user.email,
        sender_role=role_label,
        message=text,
        created_at=datetime.now(timezone.utc),
    )
    db.add(msg)

    sender_name = current_user.full_name or current_user.email
    # H-09: notify Trademark/Admin reviewers plus the submitter directly,
    # instead of broadcasting this note to every active user regardless of role.
    ntype = "legal_comment"
    title = f"New Note on {review.brand_name}"
    message = f"{sender_name} ({role_label}) posted a note on '{review.brand_name}': {text[:120]}"
    notif_svc.notify_reviewers_and_admins(db, ntype, title, message, review.id)
    if review.proposed_by_id and review.proposed_by_id != current_user.id:
        notif_svc._create(db, review.proposed_by_id, ntype, title, message, review.id)
    AuditRepository(db).create(
        action="LEGAL_REVIEW_MESSAGE_POSTED",
        user_id=current_user.id,
        resource_type="legal_review",
        resource_id=str(review.id),
        details=f'Posted a note on "{review.brand_name}"',
        metadata={"brand_name": review.brand_name},
        ip_address=get_client_ip(http_request),
        status="success",
    )
    db.commit()
    db.refresh(msg)
    return _message_to_out(msg)


@router.delete("/reviews/{review_id}", status_code=204)
def retract_review(
    review_id: str,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    review = db.query(LegalReview).filter(LegalReview.id == uuid.UUID(review_id)).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    if review.status != "pending":
        raise HTTPException(status_code=400, detail="Only pending reviews can be retracted")
    if review.proposed_by_id != current_user.id and not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="You can only retract your own submissions")
    brand = review.brand_name
    review_id_str = str(review.id)
    db.delete(review)
    notif_svc.notify_admins(
        db,
        ntype="legal_retracted",
        title=f"Review retracted: {brand}",
        message=f"{current_user.full_name or current_user.email} retracted the legal review for \"{brand}\".",
    )
    AuditRepository(db).create(
        action="LEGAL_REVIEW_RETRACTED",
        user_id=current_user.id,
        resource_type="legal_review",
        resource_id=review_id_str,
        details=f'Retracted the legal review for "{brand}"',
        metadata={"brand_name": brand},
        ip_address=get_client_ip(http_request),
        status="success",
    )
    db.commit()
