from sqlalchemy import Column, String, Float, Text, DateTime, ForeignKey, Uuid, UniqueConstraint
import uuid
from datetime import datetime, timezone
from app.core.database import Base


class ReviewBatchCartItem(Base):
    """A brand name staged for submission to Trademark Review, before the
    user has actually clicked Submit — the "shopping cart" step.

    Scoped per-user (user_id) rather than per-browser, so it's visible from
    any device once logged in, unlike the old localStorage-only version.
    Once the user submits it, ReviewBatchPage removes the matching row(s)
    here and creates the real LegalReviewBatch/LegalReview rows — this table
    only ever holds *pending, not-yet-submitted* selections."""
    __tablename__ = "review_batch_cart_items"
    __table_args__ = (
        # One cart entry per (user, brand name) — mirrors the old
        # CartContext.add()'s case-insensitive dedupe (enforced in the
        # service layer, since Postgres UNIQUE is case-sensitive by default).
        UniqueConstraint("user_id", "brand_name", name="uq_cart_user_brand_name"),
    )

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)

    brand_name = Column(String(255), nullable=False)
    source_type = Column(String(50), nullable=True)  # generated | screening | compare | manual
    brand_search_id = Column(Uuid(as_uuid=True), ForeignKey("brand_searches.id"), nullable=True)
    generated_name_id = Column(Uuid(as_uuid=True), ForeignKey("generated_brand_names.id"), nullable=True)
    therapeutic_area = Column(String(255), nullable=True)
    target_market = Column(String(255), nullable=True)
    business_notes = Column(Text, nullable=True)
    risk_score = Column(Float, nullable=True)
    risk_level = Column(String(20), nullable=True)
    risk_ai_assessment = Column(Text, nullable=True)
    market_ai_assessment = Column(Text, nullable=True)

    # Local-only grouping labels carried over from the old CartItem shape —
    # case_id is the business-facing reference (brand_suggestion_forms.case_id),
    # not a hard FK, same soft-reference pattern GeneratedBrandName.case_id uses.
    case_id = Column(String(30), nullable=True, index=True)
    case_name = Column(String(255), nullable=True)

    added_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
