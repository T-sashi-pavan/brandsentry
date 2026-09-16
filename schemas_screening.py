import uuid
from datetime import datetime
from typing import Literal, Optional, Union
from pydantic import BaseModel, Field, model_validator


class ScreeningRequest(BaseModel):
    # L-19: schema-level cap matching the route-level check in brands.py
    # (screen_brand/compare_brand_name/get_brand_intelligence all reject
    # over 100 chars) — previously enforced only in route handler code.
    brand_name: str = Field(..., max_length=100)
    include_semantic: bool = True
    # Which case this screening was run for, if any — lets Compare Names'
    # case-scoped name validation (see brands.py's /case-names) know this
    # name was legitimately analyzed for that case via Brand Analysis, not
    # just typed in ad-hoc.
    case_id: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_-]{1,30}$")
    case_data: Optional[Union[dict, str]] = None


class SimilarNameSchema(BaseModel):

    id: uuid.UUID
    name: str
    similarity_type: str
    similarity_score: float
    source: str
    risk_level: Literal["LOW", "MEDIUM", "HIGH"]
    therapeutic_area: Optional[str] = None
    manufacturer: Optional[str] = None
    country: Optional[str] = None

    class Config:
        from_attributes = True


class ConflictSchema(BaseModel):
    id: uuid.UUID
    conflicting_name: str
    conflict_type: str
    source: str
    severity: Literal["LOW", "MEDIUM", "HIGH"]
    details: Optional[str] = None
    registration_number: Optional[str] = None
    owner: Optional[str] = None
    status: Optional[str] = None

    class Config:
        from_attributes = True


class ScreeningResultSchema(BaseModel):
    id: uuid.UUID
    brand_search_id: Optional[uuid.UUID] = None
    overall_risk_score: float
    risk_classification: Literal["LOW", "MEDIUM", "HIGH"]
    exact_match_score: float
    spelling_similarity_score: float
    phonetic_similarity_score: float
    semantic_similarity_score: float
    lookalike_score: float
    soundalike_score: float
    trademark_conflict_score: float
    market_presence_score: float
    # LLM-rated (see ai_service.rate_name_qualities), not part of the
    # deterministic screening pipeline itself — None (not a fabricated
    # number) only when no LLM is configured or the rating call failed.
    memorability_score: Optional[float] = None
    pronunciation_score: Optional[float] = None
    ai_assessment: Optional[str] = Field(None, max_length=10000)
    ai_recommendation: Optional[str] = None
    total_conflicts: int
    trademark_conflicts: int
    market_conflicts: int
    epharmacy_conflicts: int
    # Sequential-pipeline outcome (see brand_screening.py's
    # _gather_evidence) — stages_completed is how many of the pipeline's 3
    # stages actually ran; rejected_at_stage/rejected_stage_name/
    # rejection_reason are only set when a stage's own conflict stopped the
    # pipeline before later stages ran at all.
    stages_completed: Optional[int] = 3
    rejected_at_stage: Optional[int] = None
    rejected_stage_name: Optional[str] = None
    rejection_reason: Optional[str] = None
    # Set only when IQVIA (Stage 2) did NOT reject but flagged the name for
    # User Review (e.g. commercial growth data blank/NULL) — see
    # BrandScreeningService._iqvia_stage_conflict.
    iqvia_review_note: Optional[str] = None
    knockout_checks: Optional[list[dict]] = None
    case_context: Optional[dict] = None
    coining_principles_eval: Optional[list[dict]] = None
    grades: Optional[dict] = None
    combination: Optional[str] = None
    similar_names: list[SimilarNameSchema] = []
    conflicts: list[ConflictSchema] = []
    created_at: datetime

    @model_validator(mode="after")
    def populate_grades_and_combination(self):
        if not self.grades or not self.combination:
            p_pct = round(self.phonetic_similarity_score * 100.0, 1) if self.phonetic_similarity_score <= 1.0 else round(self.phonetic_similarity_score, 1)
            s_pct = round(self.spelling_similarity_score * 100.0, 1) if self.spelling_similarity_score <= 1.0 else round(self.spelling_similarity_score, 1)
            c_pct = round(self.semantic_similarity_score * 100.0, 1) if self.semantic_similarity_score <= 1.0 else round(self.semantic_similarity_score, 1)
            v_pct = round(self.lookalike_score * 100.0, 1) if self.lookalike_score <= 1.0 else round(self.lookalike_score, 1)

            def _g(pct: float) -> str:
                if pct <= 30.0:
                    return "A"
                if pct <= 50.0:
                    return "B"
                if pct <= 70.0:
                    return "C"
                return "D"

            p_g, s_g, c_g, v_g = _g(p_pct), _g(s_pct), _g(c_pct), _g(v_pct)
            comb = f"{p_g}{s_g}{c_g}{v_g}"
            if not self.grades:
                self.grades = {
                    "phonetic": {"score": p_pct, "grade": p_g},
                    "spelling": {"score": s_pct, "grade": s_g},
                    "conceptual": {"score": c_pct, "grade": c_g},
                    "visual": {"score": v_pct, "grade": v_g},
                    "combination": comb,
                    "risk_classification": self.risk_classification,
                }
            if not self.combination:
                self.combination = comb
        return self

    class Config:
        from_attributes = True


class BrandSearchResponse(BaseModel):
    id: uuid.UUID
    brand_name: str
    status: str
    screening_result: Optional[ScreeningResultSchema] = None
    created_at: datetime

    class Config:
        from_attributes = True


class CompareRequest(BaseModel):
    # L-19: same schema-level cap as ScreeningRequest.brand_name above.
    brand_name: str = Field(..., max_length=100)
    case_id: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_-]{1,30}$")
    case_data: Optional[Union[dict, str]] = None



class CompareResultSchema(BrandSearchResponse):
    """Same shape the Compare screen already renders (BrandSearchResponse),
    plus where this particular result came from — a DB-first history hit or a
    freshly-run pipeline — so the frontend can skip the pipeline-progress
    animation for cached results and show a "from history" badge instead."""

    source: Literal["screening_history", "generator_history", "fresh_pipeline", "live_screening"]


class CompetitorEntrySchema(BaseModel):
    brand: str
    similarity_score: float
    market_presence: float
    trademark_status: str
    manufacturer: str
    therapeutic_area: str


class SimilarityBreakdownSchema(BaseModel):
    type: str
    count: int
    color: str


class RiskDistributionSchema(BaseModel):
    level: str
    count: int
    color: str


class TrendDataPointSchema(BaseModel):
    month: str
    trademark: float
    market: float
    epharmacy: float


class IntelligenceData(BaseModel):
    brand_name: str
    trademark_presence: float
    market_presence: float
    epharmacy_presence: float
    geographic_reach: int
    competitor_count: int
    market_saturation: float
    brand_uniqueness_score: float
    ai_summary: Optional[str] = None
    similar_brands: list[SimilarNameSchema] = []
    competitive_landscape: list[CompetitorEntrySchema] = []
    trend_data: list[TrendDataPointSchema] = []
    similarity_breakdown: list[SimilarityBreakdownSchema] = []
    risk_distribution: list[RiskDistributionSchema] = []
