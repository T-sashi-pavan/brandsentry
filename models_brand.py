import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, Float, ForeignKey, JSON, String, Text, Uuid, UniqueConstraint
from app.core.database import Base


class GeneratedBrandName(Base):
    __tablename__ = "generated_brand_names"
    # L-03: prevents the same generated name from accumulating duplicate
    # rows for the same user/case (inflates analytics, confuses the UI).
    # repositories/brand.py::save_generated_names() catches the resulting
    # IntegrityError per-row so one duplicate doesn't abort a whole batch.
    __table_args__ = (
        UniqueConstraint("generated_name", "user_id", "case_id", name="uq_generated_name_user_case"),
    )

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)

    # Human-readable business reference of the Suggestion Form case this
    # generation was requested for, if any. Not a hard FK — the frontend still
    # saves cases to localStorage rather than the backend's own
    # brand_suggestion_forms table, so a matching row may not exist server-side.
    case_id = Column(String(30), nullable=True, index=True)
    # Full structured suggestion_form payload (or flat molecule/therapeutic_area/
    # etc. criteria) that produced this name, snapshotted at generation time so
    # the input is traceable even if the source case is edited/deleted later.
    request_snapshot = Column(JSON, nullable=True)

    generated_name = Column(String(255), nullable=False)
    molecule = Column(String(255), nullable=True)
    therapeutic_area = Column(String(255), nullable=True)
    geography = Column(String(255), nullable=True)
    product_attributes = Column(Text, nullable=True)
    naming_style = Column(String(100), nullable=True)

    risk_score = Column(Float, nullable=False, default=0.0)
    availability_score = Column(Float, nullable=False, default=100.0)
    memorability_score = Column(Float, nullable=False, default=0.0)
    pronunciation_score = Column(Float, nullable=False, default=0.0)
    recommendation_status = Column(String(50), nullable=False, default="review_required")

    ai_explanation = Column(Text, nullable=True)
    phonetic_analysis = Column(Text, nullable=True)
    semantic_analysis = Column(Text, nullable=True)
    trademark_availability = Column(String(50), nullable=True)
    conflict_details = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
