from sqlalchemy import Column, String, Float, Text, DateTime, ForeignKey, Uuid
from sqlalchemy.orm import relationship
import uuid
from datetime import datetime, timezone
from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class LegalReviewBatch(Base):
    """A group of brand names submitted to the legal/trademark team in one go.

    Acts as the parent ("cart order") for many LegalReview rows. Each name keeps
    its own per-name review status; the batch status is derived on read."""
    __tablename__ = "legal_review_batches"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    batch_code = Column(String(40), unique=True, index=True, nullable=False)  # e.g. LR-2026-0042
    description = Column(Text, nullable=True)

    # L-02: indexed for fast per-user filtering (list_batches(mine=True)).
    proposed_by_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True)
    proposed_by_name = Column(String(255), nullable=True)
    proposed_by_dept = Column(String(100), nullable=True)

    submitted_at = Column(DateTime, default=_utcnow)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    proposer = relationship("User", foreign_keys=[proposed_by_id])
    reviews = relationship("LegalReview", back_populates="batch")


class LegalReview(Base):
    __tablename__ = "legal_reviews"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    brand_name = Column(String(255), nullable=False, index=True)

    # Parent batch (nullable — legacy single-name submissions have no batch).
    batch_id = Column(Uuid(as_uuid=True), ForeignKey("legal_review_batches.id"), nullable=True, index=True)

    # Submitter (business team)
    # L-02: indexed — list_reviews(mine=True) and the pending-count cap both
    # filter on this column, and it grows with every review submitted.
    proposed_by_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True)
    proposed_by_name = Column(String(255), nullable=True)
    proposed_by_dept = Column(String(100), nullable=True)
    submitted_at = Column(DateTime, default=_utcnow)

    # Where the name came from
    source_type = Column(String(50), default="manual")  # screening | generated | manual
    brand_search_id = Column(Uuid(as_uuid=True), ForeignKey("brand_searches.id"), nullable=True)
    generated_name_id = Column(Uuid(as_uuid=True), ForeignKey("generated_brand_names.id"), nullable=True)

    # Which case this name belongs to — loosely-typed on purpose (a
    # human-readable case_id string, not a real FK), matching the same
    # pattern already used on BrandSearch/GeneratedBrandName. Powers the
    # 6-pending-per-case submission cap (see legal.py's submit_batch).
    case_id = Column(String(30), nullable=True, index=True)
    case_name = Column(String(255), nullable=True)

    # Context from business team
    therapeutic_area = Column(String(255), nullable=True)
    target_market = Column(String(255), nullable=True)
    business_notes = Column(Text, nullable=True)
    risk_score = Column(Float, nullable=True)
    risk_level = Column(String(20), nullable=True)

    # AI assessments captured at submission time (so the legal team sees the
    # rationale): from Risk Screening and from Market Intelligence respectively.
    risk_ai_assessment = Column(Text, nullable=True)
    market_ai_assessment = Column(Text, nullable=True)

    # Review outcome
    status = Column(String(50), default="pending")  # pending | approved | rejected | needs_revision

    reviewer_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    reviewer_name = Column(String(255), nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    reviewer_comments = Column(Text, nullable=True)
    legal_ref = Column(String(100), nullable=True)  # internal clearance reference

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    proposer = relationship("User", foreign_keys=[proposed_by_id])
    reviewer = relationship("User", foreign_keys=[reviewer_id])
    batch = relationship("LegalReviewBatch", foreign_keys=[batch_id], back_populates="reviews")
    messages = relationship("ReviewMessage", back_populates="review", order_by="ReviewMessage.created_at.asc()", cascade="all, delete-orphan")


class ReviewMessage(Base):
    """Discussion/chat message exchanged between Trademark Counsel and Brand Marketing."""
    __tablename__ = "legal_review_messages"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    review_id = Column(Uuid(as_uuid=True), ForeignKey("legal_reviews.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    sender_name = Column(String(255), nullable=False)
    sender_role = Column(String(100), nullable=True)  # e.g., "Trademark Counsel", "Brand Marketing", "Super Admin"
    message = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_utcnow)

    review = relationship("LegalReview", back_populates="messages")
    sender = relationship("User")
