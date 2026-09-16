from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel, field_validator

from app.core.database import get_db
from app.core.rate_limit import get_client_ip
from app.repositories.settings import SettingsRepository
from app.repositories.audit import AuditRepository
from app.api.deps import get_current_user
from app.models.user import User

router = APIRouter(prefix="/settings", tags=["Settings"])


class RiskWeightsSchema(BaseModel):
    spelling: float = 0.40
    phonetic: float = 0.20
    conceptual: float = 0.20
    visual: float = 0.20

    @field_validator("phonetic", "spelling", "conceptual", "visual")
    @classmethod
    def must_be_fraction(cls, v: float) -> float:
        if not (0.0 <= v <= 1.0):
            raise ValueError("Each weight must be between 0.0 and 1.0")
        return round(v, 4)

    def validate_sum(self):
        total = self.phonetic + self.spelling + self.conceptual + self.visual
        if abs(total - 1.0) > 0.01:
            raise ValueError(f"Weights must sum to 1.0 (100%), got {total:.4f}")


@router.get("/risk-weights", response_model=RiskWeightsSchema)
def get_risk_weights(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = SettingsRepository(db)
    weights = repo.get_risk_weights()
    return RiskWeightsSchema(**weights)


@router.put("/risk-weights", response_model=RiskWeightsSchema)
def update_risk_weights(
    payload: RiskWeightsSchema,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not current_user.is_superuser and current_user.role not in ("admin", "super_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")

    payload.validate_sum()
    repo = SettingsRepository(db)
    saved = repo.update_risk_weights(payload.model_dump())
    AuditRepository(db).create(
        action="SETTINGS_UPDATE",
        user_id=current_user.id,
        resource_type="settings",
        resource_id="risk_weights",
        details="Updated platform risk assessment weights",
        metadata=saved,
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return RiskWeightsSchema(**saved)


class GradeRange(BaseModel):
    min: int
    max: int


class GradeThresholdsSchema(BaseModel):
    A: GradeRange = GradeRange(min=0, max=30)
    B: GradeRange = GradeRange(min=31, max=50)
    C: GradeRange = GradeRange(min=51, max=70)
    D: GradeRange = GradeRange(min=71, max=100)


class CombinationRulesSchema(BaseModel):
    rules: dict[str, str] = {}
    total_combinations: int = 256
    low_count: int = 8
    medium_count: int = 46
    high_count: int = 202


@router.get("/grade-thresholds", response_model=GradeThresholdsSchema)
def get_grade_thresholds(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = SettingsRepository(db)
    thresholds = repo.get_grade_thresholds()
    return GradeThresholdsSchema(**thresholds)


@router.put("/grade-thresholds", response_model=GradeThresholdsSchema)
def update_grade_thresholds(
    payload: GradeThresholdsSchema,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "super_admin" and not current_user.is_superuser:
        raise HTTPException(
            status_code=403,
            detail="Only Super Admin has permission to configure Similarity Grade Thresholds.",
        )

    # Validate range continuity
    if not (0 <= payload.A.min <= payload.A.max < payload.B.min <= payload.B.max < payload.C.min <= payload.C.max < payload.D.min <= payload.D.max <= 100):
        raise HTTPException(
            status_code=400,
            detail="Invalid grade ranges. Grade ranges must be sequential, non-overlapping from 0% to 100%.",
        )

    repo = SettingsRepository(db)
    saved = repo.update_grade_thresholds(payload.model_dump())
    AuditRepository(db).create(
        action="SETTINGS_UPDATE",
        user_id=current_user.id,
        resource_type="settings",
        resource_id="grade_thresholds",
        details="Updated similarity grade threshold ranges (A, B, C, D)",
        metadata=saved,
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return GradeThresholdsSchema(**saved)


@router.get("/combination-rules", response_model=CombinationRulesSchema)
def get_combination_rules(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.services.screening import evaluate_combination_risk
    repo = SettingsRepository(db)
    rules = repo.get_combination_rules()
    
    grades = ["A", "B", "C", "D"]
    low = 0
    med = 0
    high = 0
    for p in grades:
        for s in grades:
            for c in grades:
                for v in grades:
                    r, _ = evaluate_combination_risk(p, s, c, v, rules)
                    if r == "LOW":
                        low += 1
                    elif r == "MEDIUM":
                        med += 1
                    else:
                        high += 1

    return CombinationRulesSchema(
        rules=rules,
        total_combinations=256,
        low_count=low,
        medium_count=med,
        high_count=high,
    )


@router.put("/combination-rules", response_model=CombinationRulesSchema)
def update_combination_rules(
    payload: CombinationRulesSchema,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "super_admin" and not current_user.is_superuser:
        raise HTTPException(
            status_code=403,
            detail="Only Super Admin has permission to configure Combination Risk Rules.",
        )

    from app.services.screening import evaluate_combination_risk
    repo = SettingsRepository(db)
    saved = repo.update_combination_rules(payload.rules)
    
    grades = ["A", "B", "C", "D"]
    low = 0
    med = 0
    high = 0
    for p in grades:
        for s in grades:
            for c in grades:
                for v in grades:
                    r, _ = evaluate_combination_risk(p, s, c, v, saved)
                    if r == "LOW":
                        low += 1
                    elif r == "MEDIUM":
                        med += 1
                    else:
                        high += 1

    AuditRepository(db).create(
        action="SETTINGS_UPDATE",
        user_id=current_user.id,
        resource_type="settings",
        resource_id="combination_rules",
        details="Updated custom combination risk rules",
        metadata={"count": len(saved)},
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return CombinationRulesSchema(
        rules=saved,
        total_combinations=256,
        low_count=low,
        medium_count=med,
        high_count=high,
    )
