import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.models.brand import GeneratedBrandName


class BrandRepository:
    def __init__(self, db: Session):
        self.db = db

    def save_generated_names(self, names: List[dict]) -> List[GeneratedBrandName]:
        # L-03: generated_brand_names now has a UniqueConstraint on
        # (generated_name, user_id, case_id) — commit per-row instead of
        # batching the whole list into one commit, so a single duplicate
        # name (IntegrityError) is skipped instead of aborting the entire
        # generation batch's save.
        saved = []
        valid_cols = {c.name for c in GeneratedBrandName.__table__.columns}
        for data in names:
            clean_data = {k: v for k, v in data.items() if k in valid_cols}
            obj = GeneratedBrandName(**clean_data)
            try:
                self.db.add(obj)
                self.db.commit()
                self.db.refresh(obj)
                saved.append(obj)
            except IntegrityError:
                self.db.rollback()
        return saved

    def get_generated_names(
        self, user_id: Optional[uuid.UUID] = None, limit: int = 50, case_id: Optional[str] = None,
    ) -> List[GeneratedBrandName]:
        from app.services.screening import calculate_mentor_risk_score
        query = self.db.query(GeneratedBrandName)
        if user_id:
            query = query.filter(GeneratedBrandName.user_id == user_id)
        if case_id:
            clean_case = case_id.strip()
            query = query.filter(func.lower(func.trim(GeneratedBrandName.case_id)) == clean_case.lower())
        items = query.order_by(GeneratedBrandName.created_at.desc()).limit(limit).all()
        for g in items:
            cd = g.conflict_details or {}
            phon = cd.get("phonetic_similarity_score", 0.0)
            spel = cd.get("spelling_similarity_score", 0.0)
            look = cd.get("lookalike_score", 0.0)
            sem = cd.get("semantic_similarity_score", 0.0)
            exact = bool(cd.get("exact_match_score", 0.0) >= 0.98)
            if cd.get("grades") or phon or spel:
                score, risk_cls, rec, grades, comb = calculate_mentor_risk_score(
                    phonetic_score=phon,
                    spelling_score=spel,
                    visual_score=look,
                    conceptual_score=sem,
                    is_exact_match=exact,
                )
                g.risk_score = round(score, 1)
                g.availability_score = round(max(0.0, 100.0 - score), 1)
                g.recommendation_status = "high_risk" if risk_cls == "HIGH" else ("review_required" if risk_cls == "MEDIUM" else "recommended")
                if "grades" not in cd:
                    cd["grades"] = grades
                    cd["combination"] = comb
                    cd["risk_classification"] = risk_cls
                    g.conflict_details = cd
        return items

    def get_all_generated_names(self) -> List[GeneratedBrandName]:
        """Every name this system has ever generated, across all users/cases —
        used as an additional uniqueness check so the LLM isn't asked to
        re-invent (and risk re-suggesting) a name it already produced before."""
        return self.db.query(GeneratedBrandName).all()

    def get_high_risk_generated_names(
        self, max_age_days: Optional[int] = None
    ) -> List[GeneratedBrandName]:
        """Names this system has flagged high_risk, across all users/cases —
        a durable "previously rejected pattern" list fed back to the LLM as
        an avoid-hint (see generator.py's _load_history_avoid_pool) so a
        rejected pattern from an old case doesn't get silently reproposed in
        a brand-new one. Pass max_age_days to bound this to a rolling window
        (e.g. 7) instead of every high_risk name ever recorded — otherwise
        the avoid-pool only ever grows, eventually crowding out the prompt's
        avoid-list budget with names stale enough no longer to matter."""
        query = self.db.query(GeneratedBrandName).filter(
            GeneratedBrandName.recommendation_status == "high_risk"
        )
        if max_age_days is not None:
            cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
            query = query.filter(GeneratedBrandName.created_at >= cutoff)
        return query.all()

    def get_latest_by_generated_name(
        self, brand_name: str, max_age_days: Optional[int] = None,
    ) -> Optional[GeneratedBrandName]:
        """Most recent AI Name Generator record for this exact name
        (case-insensitive), used by Compare's DB-first history check —
        mirrors ScreeningRepository.get_latest_by_name's freshness semantics."""
        query = self.db.query(GeneratedBrandName).filter(
            func.lower(GeneratedBrandName.generated_name) == brand_name.lower()
        )
        if max_age_days is not None:
            cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
            query = query.filter(GeneratedBrandName.created_at >= cutoff)
        return query.order_by(GeneratedBrandName.created_at.desc()).first()
