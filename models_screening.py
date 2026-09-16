import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, Float, ForeignKey, Integer, JSON, String, Text, Uuid
from sqlalchemy.orm import relationship
from app.core.database import Base


class BrandSearch(Base):
    __tablename__ = "brand_searches"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    brand_name = Column(String(255), nullable=False, index=True)
    status = Column(String(30), nullable=False, default="completed")
    # Loosely-typed on purpose (a human-readable case_id string, not a real
    # FK) — matches GeneratedBrandName.case_id's own pattern, so both tables
    # can be looked up by the same case identifier (see /brands/case-names).
    case_id = Column(String(30), nullable=True, index=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    screening_result = relationship(
        "ScreeningResult", back_populates="brand_search", uselist=False,
        cascade="all, delete-orphan",
    )


class ScreeningResult(Base):
    __tablename__ = "screening_results"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    brand_search_id = Column(Uuid(as_uuid=True), ForeignKey("brand_searches.id"), nullable=False, unique=True)

    overall_risk_score = Column(Float, nullable=False, default=0.0)
    risk_classification = Column(String(10), nullable=False, default="LOW")

    exact_match_score = Column(Float, nullable=False, default=0.0)
    spelling_similarity_score = Column(Float, nullable=False, default=0.0)
    phonetic_similarity_score = Column(Float, nullable=False, default=0.0)
    semantic_similarity_score = Column(Float, nullable=False, default=0.0)
    lookalike_score = Column(Float, nullable=False, default=0.0)
    soundalike_score = Column(Float, nullable=False, default=0.0)
    trademark_conflict_score = Column(Float, nullable=False, default=0.0)
    market_presence_score = Column(Float, nullable=False, default=0.0)

    # LLM-rated, not deterministic (see ai_service.rate_name_qualities) —
    # nullable because a name screened before this existed, or screened with
    # no LLM configured, genuinely has no rating rather than a fabricated
    # default. Mirrors GeneratedBrandName's own two fields of the same name
    # so Compare Names can show real values for a Brand-Analysis-sourced
    # name instead of always reading "N/A".
    memorability_score = Column(Float, nullable=True)
    pronunciation_score = Column(Float, nullable=True)

    # Sequential-pipeline outcome (see brand_screening.py's _gather_evidence)
    # — stages_completed is always set (1-3, how many of the 3 stages
    # actually ran); rejected_at_stage/rejected_stage_name/rejection_reason
    # are only set when a stage's own conflict stopped the pipeline before
    # later stages ran at all, not just before they're displayed.
    stages_completed = Column(Integer, nullable=True, default=3)
    rejected_at_stage = Column(Integer, nullable=True)
    rejected_stage_name = Column(String(100), nullable=True)
    rejection_reason = Column(Text, nullable=True)

    # Set only when IQVIA (Stage 2) did NOT reject the name but flagged it
    # for User Review under the mentor-updated IQVIA logic — either a
    # sub-85%-similarity match whose commercial growth is blank/NULL (growth
    # check skipped, not auto-cleared) or one that's clean on growth too but
    # still close enough to warrant a human look. See
    # BrandScreeningService._iqvia_stage_conflict. Never set together with
    # rejected_at_stage == 2 (that's a hard reject, not a review flag).
    iqvia_review_note = Column(Text, nullable=True)

    # The 4-parameter grade (A/B/C/D per parameter) + combination code,
    # computed by calculate_mentor_risk_score() using whatever grade
    # thresholds/combination rules were configured in Settings AT THE TIME
    # this screening ran (see brand_screening.py's _score()). Persisted as
    # computed — never recomputed later with a later admin's settings, so a
    # threshold change only ever affects new screenings, not historical ones.
    grades = Column(JSON, nullable=True)
    combination = Column(String(10), nullable=True)

    ai_assessment = Column(Text, nullable=True)
    ai_recommendation = Column(String(20), nullable=True)

    total_conflicts = Column(Integer, nullable=False, default=0)
    trademark_conflicts = Column(Integer, nullable=False, default=0)
    market_conflicts = Column(Integer, nullable=False, default=0)
    epharmacy_conflicts = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    brand_search = relationship("BrandSearch", back_populates="screening_result")
    similar_names = relationship(
        "SimilarBrandName", back_populates="screening_result", cascade="all, delete-orphan",
    )
    conflicts = relationship(
        "ScreeningConflict", back_populates="screening_result", cascade="all, delete-orphan",
    )


class SimilarBrandName(Base):
    __tablename__ = "similar_brand_names"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    screening_result_id = Column(Uuid(as_uuid=True), ForeignKey("screening_results.id"), nullable=False)

    name = Column(String(255), nullable=False)
    similarity_type = Column(String(50), nullable=False)
    similarity_score = Column(Float, nullable=False)
    source = Column(String(100), nullable=False)
    risk_level = Column(String(10), nullable=False, default="LOW")
    therapeutic_area = Column(String(150), nullable=True)
    manufacturer = Column(String(300), nullable=True)
    country = Column(String(100), nullable=True)

    screening_result = relationship("ScreeningResult", back_populates="similar_names")


class ScreeningConflict(Base):
    __tablename__ = "screening_conflicts"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    screening_result_id = Column(Uuid(as_uuid=True), ForeignKey("screening_results.id"), nullable=False)

    conflicting_name = Column(String(255), nullable=False)
    conflict_type = Column(String(50), nullable=False)
    source = Column(String(100), nullable=False)
    severity = Column(String(10), nullable=False, default="LOW")
    details = Column(Text, nullable=True)
    registration_number = Column(String(100), nullable=True)
    owner = Column(String(300), nullable=True)
    status = Column(String(50), nullable=True)

    screening_result = relationship("ScreeningResult", back_populates="conflicts")
