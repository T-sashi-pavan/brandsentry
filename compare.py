"""Compare Names — DB-first history lookup in front of the Brand Analysis
screening pipeline.

For each name submitted to Compare, checks whether it has already been
screened (Brand Analysis history, `brand_searches`/`screening_results`) or
generated+market-verified (AI Name Generator history, `generated_brand_names`)
within the last 90 days, and serves that record directly instead of
re-running the full WHO INN -> IQVIA -> Google -> e-pharmacy pipeline. Only a
genuinely new (or stale) name pays for a fresh pipeline run — which is the
exact same `BrandScreeningService.screen_brand()` used by `/brands/screen`,
unmodified, so Brand Analysis's own behavior (always fresh) is untouched.

A generator-history hit is treated as equally trustworthy evidence as a
screening-history hit, since the generator's own `_verify_against_market()`
already checks the same four tiers per candidate. But its stored evidence is
handled carefully: `conflict_details.top_conflicts` (scored against the
Trademark Registry / Market Database / prior-generated-names pool) is always
about the name that was actually persisted, so it's safe to reuse as the sole
source of conflict/score data. `conflict_details.market_check.conflicts_found`
(the WHO/IQVIA/pharmacy/Google evidence) is NOT safe to reuse for per-tier
scores or counts — the generator's auto-regeneration loop can leave entries in
that list that describe an earlier, discarded candidate name rather than the
one that was saved. Only its four `*_checked` booleans are used (they
describe whether a tier ran, which is accurate regardless of which attempt it
ran against) — surfaced as a note in the assessment text rather than a
fabricated similarity number.
"""
import logging
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.brand import GeneratedBrandName
from app.models.screening import BrandSearch
from app.models.suggestion import BrandSuggestionForm
from app.repositories.brand import BrandRepository
from app.repositories.screening import ScreeningRepository
from app.repositories.settings import SettingsRepository
from app.services.brand_screening import BrandScreeningService, _CONFLICT_THRESHOLD, _SIMILAR_THRESHOLD, _risk_level
from app.services.screening import (
    levenshtein_similarity, fuzzy_similarity, phonetic_similarity,
    lookalike_score, composite_similarity,
    prefix_suffix_collision_score, calculate_mentor_risk_score,
    evaluate_pharma_knockout_checks,
)

logger = logging.getLogger(__name__)

HISTORY_FRESHNESS_DAYS = 90

_GEN_STATUS_TO_RECOMMENDATION = {
    "recommended": "PROCEED",
    "review_required": "LEGAL_REVIEW",
    "high_risk": "REJECT",
}
_TRADEMARK_SOURCE = "Trademark Registry"
# market_presence_score is surfaced by the frontend specifically as the
# "Google Search" workflow step's presence index (see
# ScreeningResultBlocks.tsx) — scoped to genuine Google-sourced hits only,
# matching brand_screening.py's fresh-pipeline scoring, so it never
# silently absorbs a WHO INN/IQVIA/E-Pharmacy hit under the Google label.
_GOOGLE_SOURCE = "Google Search"


class CompareService:
    def __init__(self, db: Session):
        self.db = db
        self.screening_repo = ScreeningRepository(db)
        self.brand_repo = BrandRepository(db)
        self.screening_service = BrandScreeningService(db)

    async def compare_one(
        self, brand_name: str, user_id: Optional[uuid.UUID], case_id: Optional[str] = None, case_data: Optional[Any] = None,
    ) -> Dict[str, Any]:
        name = brand_name.strip()
        if isinstance(case_data, str):
            case_data = {"case_name": case_data}
        effective_case_id = (case_id or (case_data.get("case_id") if isinstance(case_data, dict) else None) or "").strip()
        logger.info("================================================================================")
        logger.info("[COMPARE PIPELINE START] %r (case_id=%s)", name, effective_case_id or "None")

        if effective_case_id and (not isinstance(case_data, dict) or not case_data.get("generic_name")):
            form = self.db.query(BrandSuggestionForm).filter(
                func.lower(func.trim(BrandSuggestionForm.case_id)) == effective_case_id.lower()
            ).first()
            if form:
                case_name = f"{form.generic_name} - {form.therapy or form.division or ''}".strip(" -")
                enriched = {
                    "case_id": form.case_id,
                    "case_name": case_name,
                    "generic_name": form.generic_name,
                    "therapy": form.therapy,
                    "segment": form.segment,
                    "ailment": form.ailment,
                    "promoting_indications": form.promoting_indications,
                    "dosage_form": form.dosage_form,
                    "dose": form.dose,
                }
                if isinstance(case_data, dict):
                    enriched.update(case_data)
                case_data = enriched

        if effective_case_id or case_data:
            clean_case = effective_case_id
            existing_for_case = None
            if clean_case:
                existing_for_case = self.db.query(BrandSearch).filter(
                    func.lower(BrandSearch.brand_name) == name.lower(),
                    func.lower(func.trim(BrandSearch.case_id)) == clean_case.lower(),
                ).order_by(BrandSearch.created_at.desc()).first()
            if existing_for_case and existing_for_case.screening_result:
                logger.info("[HISTORY HIT] Found case-specific screening for %r (case_id=%s)", name, clean_case)
                return {**_from_brand_search(existing_for_case, db=self.db, case_data=case_data), "source": "screening_history"}

            # If the name was already generated for this exact case, load directly from generator history
            if clean_case:
                gen_for_case = self.db.query(GeneratedBrandName).filter(
                    func.lower(GeneratedBrandName.generated_name) == name.lower(),
                    func.lower(func.trim(GeneratedBrandName.case_id)) == clean_case.lower(),
                ).order_by(GeneratedBrandName.created_at.desc()).first()
                if gen_for_case:
                    logger.info("[GENERATOR HISTORY HIT] Found candidate %r already generated for case_id=%s — direct loading without re-running pipeline", name, clean_case)
                    return {**_from_generated_name(gen_for_case, db=self.db, case_data=case_data), "source": "generator_history"}

            logger.info("[CASE-AWARE SCREENING] No screening found for %r under case_id=%s — running fresh case-aware screening", name, clean_case)
            search = await self.screening_service.screen_brand(name, user_id, case_id=clean_case, case_data=case_data)
            return {**_from_brand_search(search, db=self.db, case_data=case_data), "source": "live_screening"}

        screening_hit = self.screening_repo.get_latest_by_name(name, max_age_days=HISTORY_FRESHNESS_DAYS)
        generator_hit = self.brand_repo.get_latest_by_generated_name(name, max_age_days=HISTORY_FRESHNESS_DAYS)

        chosen = _pick_more_recent(screening_hit, generator_hit)
        if chosen == "screening":
            age = _age_days(screening_hit.created_at)
            logger.info(
                "[HISTORY HIT] %r served from Brand Screening history (search_id=%s, screened_at=%s, age=%dd)",
                name, screening_hit.id, screening_hit.created_at, age,
            )
            result = {**_from_brand_search(screening_hit, db=self.db, case_data=case_data), "source": "screening_history"}
        elif chosen == "generator":
            age = _age_days(generator_hit.created_at)
            logger.info(
                "[HISTORY HIT] %r served from AI Name Generator history (id=%s, generated_at=%s, age=%dd)",
                name, generator_hit.id, generator_hit.created_at, age,
            )
            # If case_id is provided, associate this screening with this case
            if case_id:
                clean_case = case_id.strip()
                existing_for_case = self.db.query(BrandSearch).filter(
                    func.lower(BrandSearch.brand_name) == name.lower(),
                    func.lower(func.trim(BrandSearch.case_id)) == clean_case.lower(),
                ).first()
                if not existing_for_case:
                    new_search = self.screening_repo.create_search(name, user_id, case_id=clean_case)
                    gen_data = _from_generated_name(generator_hit, self.db)
                    sr_data = gen_data["screening_result"]
                    sims = [
                        {
                            "name": sn["name"],
                            "similarity_type": sn["similarity_type"],
                            "similarity_score": sn["similarity_score"],
                            "source": sn["source"],
                            "risk_level": sn.get("risk_level", "LOW"),
                            "therapeutic_area": sn.get("therapeutic_area"),
                            "manufacturer": sn.get("manufacturer"),
                            "country": sn.get("country"),
                        }
                        for sn in sr_data.get("similar_names", [])
                    ]
                    confs = [
                        {
                            "conflicting_name": c["conflicting_name"],
                            "conflict_type": c["conflict_type"],
                            "source": c["source"],
                            "severity": c.get("severity", "LOW"),
                            "details": c.get("details"),
                            "registration_number": c.get("registration_number"),
                            "owner": c.get("owner"),
                            "status": c.get("status"),
                        }
                        for c in sr_data.get("conflicts", [])
                    ]
                    res_dict = {
                        "overall_risk_score": sr_data.get("overall_risk_score", 0.0),
                        "risk_classification": sr_data.get("risk_classification", "LOW"),
                        "exact_match_score": sr_data.get("exact_match_score", 0.0),
                        "spelling_similarity_score": sr_data.get("spelling_similarity_score", 0.0),
                        "phonetic_similarity_score": sr_data.get("phonetic_similarity_score", 0.0),
                        "semantic_similarity_score": sr_data.get("semantic_similarity_score", 0.0),
                        "lookalike_score": sr_data.get("lookalike_score", 0.0),
                        "soundalike_score": sr_data.get("soundalike_score", 0.0),
                        "trademark_conflict_score": sr_data.get("trademark_conflict_score", 0.0),
                        "market_presence_score": sr_data.get("market_presence_score", 0.0),
                        "memorability_score": sr_data.get("memorability_score"),
                        "pronunciation_score": sr_data.get("pronunciation_score"),
                        "stages_completed": sr_data.get("stages_completed", 3),
                        "rejected_at_stage": sr_data.get("rejected_at_stage"),
                        "rejected_stage_name": sr_data.get("rejected_stage_name"),
                        "rejection_reason": sr_data.get("rejection_reason"),
                        "ai_assessment": sr_data.get("ai_assessment"),
                        "ai_recommendation": sr_data.get("ai_recommendation"),
                        "total_conflicts": sr_data.get("total_conflicts", 0),
                        "trademark_conflicts": sr_data.get("trademark_conflicts", 0),
                        "market_conflicts": sr_data.get("market_conflicts", 0),
                        "epharmacy_conflicts": sr_data.get("epharmacy_conflicts", 0),
                    }
                    self.screening_repo.save_result(new_search.id, res_dict, sims, confs)
            result = {**_from_generated_name(generator_hit, self.db), "source": "generator_history"}
        else:
            logger.info(
                "[HISTORY MISS] %r not found in either history table within %d days — running full screening pipeline",
                name, HISTORY_FRESHNESS_DAYS,
            )
            search = await self.screening_service.screen_brand(name, user_id, case_id=case_id)
            result = {**_from_brand_search(search), "source": "fresh_pipeline"}

        logger.info("[COMPARE PIPELINE COMPLETE] %r resolved via %s", name, result["source"])
        return result


def _age_days(created_at) -> int:
    from datetime import datetime, timezone
    if created_at is None:
        return 0
    # created_at is read back from a plain (non-tz-aware) DateTime column, so
    # it comes back naive even though it was written with datetime.now(timezone.utc)
    # (see ScreeningRepository.get_latest_by_name's docstring) — treat that
    # naive value as UTC rather than subtracting it from an aware "now", which
    # would raise TypeError: can't subtract offset-naive and offset-aware datetimes.
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - created_at).days


def _pick_more_recent(
    screening_hit: Optional[BrandSearch], generator_hit: Optional[GeneratedBrandName],
) -> Optional[str]:
    """Both history sources are equally trustworthy evidence (confirmed
    product decision) — when both exist within the freshness window, prefer
    whichever is more recent rather than a fixed table priority, since
    recency is the entire point of the freshness rule."""
    if screening_hit and generator_hit:
        return "screening" if screening_hit.created_at >= generator_hit.created_at else "generator"
    if screening_hit:
        return "screening"
    if generator_hit:
        return "generator"
    return None


def _from_brand_search(search: BrandSearch, db: Optional[Session] = None, case_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    sr = search.screening_result
    sr_dict = None
    if sr:
        case_ctx = getattr(sr, "case_context", None) or case_data
        if not case_ctx and search.case_id and db:
            clean_case = search.case_id.strip()
            form = (
                db.query(BrandSuggestionForm)
                .filter(func.lower(func.trim(BrandSuggestionForm.case_id)) == clean_case.lower())
                .first()
            )
            if form:
                case_name = f"{form.generic_name} - {form.therapy or form.division or ''}".strip(" -")
                case_ctx = {
                    "case_id": form.case_id,
                    "case_name": case_name,
                    "generic_name": form.generic_name,
                    "therapy": form.therapy,
                    "segment": form.segment,
                    "ailment": form.ailment,
                    "promoting_indications": form.promoting_indications,
                    "dosage_form": form.dosage_form,
                    "dose": form.dose,
                    "domestic_brand_names": form.domestic_brand_names,
                    "international_brand_names": form.international_brand_names,
                    "innovator_brands": form.innovator_brands,
                    "parent_brand_owner": form.parent_brand_owner,
                }

        # Dynamic Mentor Grade & Combination Evaluation using active DB thresholds
        grade_thresholds = SettingsRepository(db).get_grade_thresholds() if db else None
        combination_rules = SettingsRepository(db).get_combination_rules() if db else None
        calc_score, calc_risk, calc_rec, grades_dict, comb_code = calculate_mentor_risk_score(
            phonetic_score=sr.phonetic_similarity_score or 0.0,
            spelling_score=sr.spelling_similarity_score or 0.0,
            visual_score=sr.lookalike_score or 0.0,
            conceptual_score=sr.semantic_similarity_score or 0.0,
            is_exact_match=bool((sr.exact_match_score or 0.0) >= 1.0),
            is_who_inn_knockout=bool(sr.rejected_at_stage == 2),
            is_linguistic_knockout=bool(sr.rejected_at_stage == 1),
            grade_thresholds=grade_thresholds,
            combination_rules=combination_rules,
        )
        if sr.rejected_at_stage is not None:
            calc_score = max(calc_score, 85.0)
            calc_risk = "HIGH"
            calc_rec = "REJECT"

        sr_dict = {
            "id": sr.id,
            "brand_search_id": sr.brand_search_id,
            "overall_risk_score": calc_score,
            "risk_classification": calc_risk,
            "grades": grades_dict,
            "combination": comb_code,
            "exact_match_score": sr.exact_match_score,
            "spelling_similarity_score": sr.spelling_similarity_score,
            "phonetic_similarity_score": sr.phonetic_similarity_score,
            "semantic_similarity_score": sr.semantic_similarity_score,
            "lookalike_score": sr.lookalike_score,
            "soundalike_score": sr.soundalike_score,
            "trademark_conflict_score": sr.trademark_conflict_score,
            "market_presence_score": sr.market_presence_score,
            "memorability_score": sr.memorability_score,
            "pronunciation_score": sr.pronunciation_score,
            "ai_assessment": sr.ai_assessment,
            "ai_recommendation": calc_rec,
            "total_conflicts": sr.total_conflicts,
            "trademark_conflicts": sr.trademark_conflicts,
            "market_conflicts": sr.market_conflicts,
            "epharmacy_conflicts": sr.epharmacy_conflicts,
            "stages_completed": sr.stages_completed,
            "rejected_at_stage": sr.rejected_at_stage,
            "rejected_stage_name": sr.rejected_stage_name,
            "rejection_reason": sr.rejection_reason,
            "similar_names": sr.similar_names,
            "conflicts": sr.conflicts,
            "created_at": sr.created_at,
            "knockout_checks": getattr(sr, "knockout_checks", None),
            "coining_principles_eval": getattr(sr, "coining_principles_eval", None) or (case_ctx.get("coining_principles_eval") if isinstance(case_ctx, dict) else None),
            "case_context": case_ctx,
        }
        if not sr_dict.get("knockout_checks"):
            sr_dict["knockout_checks"] = evaluate_pharma_knockout_checks(
                search.brand_name,
                [{"conflicting_name": c.conflicting_name, "source": c.source, "similarity_score": 1.0 if c.severity == "HIGH" else 0.5, "severity": c.severity, "conflict_type": c.conflict_type} for c in (sr.conflicts or [])],
                [{"name": sn.name, "source": sn.source, "similarity_score": sn.similarity_score, "similarity_type": sn.similarity_type} for sn in (sr.similar_names or [])],
                case_context=case_ctx,
                is_who_inn_fail=bool(sr.rejected_at_stage == 2),
                is_linguistic_fail=bool(sr.rejected_at_stage == 1),
            )
    return {
        "id": search.id,
        "brand_name": search.brand_name,
        "status": search.status,
        "created_at": search.created_at,
        "screening_result": sr_dict,
    }



def _from_generated_name(g: GeneratedBrandName, db: Optional[Session] = None, case_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    conflict_details = g.conflict_details or {}
    top_conflicts: List[dict] = conflict_details.get("top_conflicts") or []
    market_check: Dict[str, Any] = conflict_details.get("market_check") or {}

    similar_names: List[dict] = []
    conflicts: List[dict] = []
    max_trademark = max_market = 0.0
    any_exact = False

    # A stored conflict (see generator.py's _score_candidate) carries every
    # similarity dimension it actually earned, each with its own real score,
    # so a row here is scored by the dimension it's tagged with rather than
    # the generic composite `score`. similarity_types/the four score fields
    # are absent on conflicts stored before this existed; both fall back to
    # the old single-label shape.

    for c in top_conflicts:
        cname = (c.get("name") or "").strip()
        if not cname:
            continue
        score = float(c.get("similarity_score") or 0.0)
        source = c.get("source") or "Unknown"

        if source == _TRADEMARK_SOURCE:
            max_trademark = max(max_trademark, score)
        elif source == _GOOGLE_SOURCE:
            max_market = max(max_market, score)
        is_exact = cname.lower() == g.generated_name.strip().lower()
        if is_exact:
            any_exact = True

        if score >= _CONFLICT_THRESHOLD:
            conflicts.append({
                "id": uuid.uuid4(),
                "conflicting_name": cname,
                "conflict_type": "EXACT_MARKET_MATCH" if is_exact else (c.get("similarity_type") or "MARKET_MATCH"),
                "source": source,
                "severity": _risk_level(score),
                "details": f'"{cname}" ({source}) is {round(score * 100)}% similar to "{g.generated_name}".',
                "owner": c.get("owner"),
            })

        lev = c.get("spelling_score") or levenshtein_similarity(g.generated_name, cname)
        phon = c.get("phonetic_score") or phonetic_similarity(g.generated_name, cname)
        look = c.get("lookalike_score") or lookalike_score(g.generated_name, cname)
        sem = c.get("semantic_similarity_score") or (round(score * 0.5, 3) if score >= 0.30 else 0.0)
        
        dims = [
            ("Phonetic", phon),
            ("Spelling", lev),
            ("Visual", look),
            ("Conceptual", sem),
        ]
        for dim_type, dim_score in dims:
            if dim_score is not None and float(dim_score) >= _SIMILAR_THRESHOLD:
                similar_names.append({
                    "id": uuid.uuid4(),
                    "name": cname,
                    "similarity_type": dim_type,
                    "similarity_score": round(float(dim_score), 3),
                    "source": source,
                    "risk_level": _risk_level(dim_score),
                    "manufacturer": c.get("owner"),
                })

    raw_similar = conflict_details.get("similar_names") or []
    for s in raw_similar:
        sname = (s.get("name") or "").strip()
        if not sname:
            continue
        sim_score = float(s.get("similarity_score") or 0.0)
        sim_type = s.get("similarity_type") or "Phonetic"
        if not any(sn["name"].lower() == sname.lower() and sn["similarity_type"] == sim_type for sn in similar_names):
            similar_names.append({
                "id": uuid.uuid4(),
                "name": sname,
                "similarity_type": sim_type,
                "similarity_score": round(sim_score, 3),
                "source": s.get("source") or "E-Pharmacy (India)",
                "risk_level": s.get("risk_level") or _risk_level(sim_score),
                "therapeutic_area": s.get("therapeutic_area"),
                "manufacturer": s.get("manufacturer"),
            })

    # Evaluate against cached pharmacy listings (no static trademark/market
    # reference dataset exists — those tables were removed, they never had
    # a working import path).
    from app.core.cache import cache_service

    pool_candidates: List[Dict[str, Any]] = []

    # Also check cached pharmacy scrape listings for this name
    pharm_cached = cache_service.get_json(f"pharmacy_scrape:{g.generated_name.upper()}") or []
    for p in pharm_cached:
        if p.get("brand_name"):
            pool_candidates.append({"name": p["brand_name"], "owner": p.get("manufacturer"), "source": p.get("source", "E-Pharmacy")})

    for ref in pool_candidates:
        bname = ref.get("name")
        bowner = ref.get("owner")
        bsource = ref.get("source", "Trademark Registry")
        if not bname:
            continue
        lev = levenshtein_similarity(g.generated_name, bname)
        fuz = fuzzy_similarity(g.generated_name, bname)
        phon = phonetic_similarity(g.generated_name, bname)
        look = lookalike_score(g.generated_name, bname)
        comp = composite_similarity(g.generated_name, bname)
        ps = prefix_suffix_collision_score(g.generated_name, bname)

        effective_comp = max(comp, ps, phon) if (ps >= 0.80 or phon >= 0.85) else comp

        dims = [
            ("Phonetic", phon),
            ("Spelling", max(lev, fuz)),
            ("Visual", look),
            ("Conceptual", round(effective_comp * 0.5, 3) if effective_comp >= 0.30 else 0.0),
        ]
        for clean_label, label_score in dims:
            if label_score is not None and float(label_score) >= _SIMILAR_THRESHOLD:
                if not any(s["name"].lower() == bname.lower() and s["similarity_type"] == clean_label for s in similar_names):
                    similar_names.append({
                        "id": uuid.uuid4(),
                        "name": bname,
                        "similarity_type": clean_label,
                        "similarity_score": round(float(label_score), 3),
                        "source": bsource,
                        "risk_level": _risk_level(label_score),
                        "manufacturer": bowner,
                    })

    def _max_similarity(*labels: str) -> float:
        scores_for_labels = [sn["similarity_score"] for sn in similar_names if sn["similarity_type"] in labels and sn["similarity_score"] >= _SIMILAR_THRESHOLD]
        return max(scores_for_labels) if scores_for_labels else 0.0

    max_lev = _max_similarity("Spelling")
    max_phon = _max_similarity("Phonetic")
    max_look = _max_similarity("Visual", "Look-Alike")
    max_sem = _max_similarity("Conceptual", "Semantic")

    similar_names.sort(key=lambda s: s["similarity_score"], reverse=True)

    def _is_epharmacy_source(src: str) -> bool:
        s = (src or "").lower()
        return any(k in s for k in ("1mg", "pharmeasy", "apollo", "netmeds", "pharmacy", "e-pharmacy"))

    trademark_conflicts = sum(1 for c in conflicts if c["source"] == _TRADEMARK_SOURCE)
    epharmacy_conflicts = sum(1 for c in conflicts if _is_epharmacy_source(c["source"]))
    market_hits = len({
        sn["name"].strip().lower() for sn in similar_names
        if _is_epharmacy_source(sn.get("source", "")) or "iqvia" in (sn.get("source") or "").lower()
    })
    market_conflicts = max(len(conflicts) - trademark_conflicts, market_hits)

    exact_val = conflict_details.get("exact_match_score")
    exact_score = float(exact_val) if exact_val is not None else (1.0 if any_exact else 0.0)
    phonetic_val = conflict_details.get("phonetic_similarity_score")
    phonetic_score = float(phonetic_val) if phonetic_val is not None else max_phon
    spelling_val = conflict_details.get("spelling_similarity_score")
    spelling_score = float(spelling_val) if spelling_val is not None else max_lev
    visual_val = conflict_details.get("lookalike_score")
    visual_score = float(visual_val) if visual_val is not None else max_look
    sem_val = conflict_details.get("semantic_similarity_score")
    conceptual_score = float(sem_val) if sem_val is not None else max_sem
    market_presence_score = 0.0 if (not conflicts and not similar_names) else float(conflict_details.get("market_presence_score") or max_market or 0.0)

    # 4-Parameter Grade & Combination Formula with Dynamic Settings & Hard Knockout Gates
    grade_thresholds = SettingsRepository(db).get_grade_thresholds() if db else None
    combination_rules = SettingsRepository(db).get_combination_rules() if db else None
    calculated_risk, risk_classification, ai_recommendation, grades_dict, combination_code = calculate_mentor_risk_score(
        phonetic_score=phonetic_score,
        spelling_score=spelling_score,
        visual_score=visual_score,
        conceptual_score=conceptual_score,
        is_exact_match=bool(any_exact),
        is_who_inn_knockout=False,
        grade_thresholds=grade_thresholds,
        combination_rules=combination_rules,
    )
    risk_score = calculated_risk

    tiers_checked = ", ".join(
        f"{label}: {'checked' if market_check.get(key) else 'not checked'}"
        for label, key in (
            ("WHO INN", "who_inn_checked"), ("IQVIA", "iqvia_checked"),
            ("E-Pharmacy", "pharmacy_checked"), ("Google", "google_checked"),
        )
    )
    ai_assessment = g.ai_explanation or conflict_details.get("rationale") or None
    if tiers_checked:
        note = f"Market verification at generation time: {tiers_checked}."
        ai_assessment = f"{ai_assessment.rstrip()} {note}" if ai_assessment else note

    knockout_checks = conflict_details.get("knockout_checks")
    if not knockout_checks:
        knockout_checks = evaluate_pharma_knockout_checks(
            g.generated_name,
            conflicts,
            similar_names,
            case_context={
                "generic_name": g.molecule,
                "therapy": g.therapeutic_area,
                "segment": g.therapeutic_area,
                "coining_principles": conflict_details.get("coining_principles"),
                "business_alignment": conflict_details.get("business_alignment"),
            },
        )

    screening_result = {
        "id": uuid.uuid4(),
        "brand_search_id": g.id,
        "brand_name": g.generated_name,
        "overall_risk_score": risk_score,
        "risk_classification": risk_classification,
        "grades": grades_dict,
        "combination": combination_code,
        "exact_match_score": exact_score,
        "spelling_similarity_score": round(spelling_score, 3),
        "phonetic_similarity_score": round(phonetic_score, 3),
        "semantic_similarity_score": round(conceptual_score, 3),
        "lookalike_score": round(visual_score, 3),
        "soundalike_score": 0.0,
        "trademark_conflict_score": round(max_trademark, 3),
        "market_presence_score": round(market_presence_score, 3),
        # Real values captured at generation time (see generator.py's
        # _score_candidate) — not recomputed here, just finally threaded
        # through to Compare instead of being silently dropped.
        "availability_score": round(max(100.0 - risk_score, 0.0), 1),
        "memorability_score": g.memorability_score or 80.0,
        "pronunciation_score": g.pronunciation_score or 85.0,
        "ai_assessment": ai_assessment,
        "ai_recommendation": ai_recommendation,
        "total_conflicts": len(conflicts),
        "trademark_conflicts": trademark_conflicts,
        "market_conflicts": max(market_conflicts, 0),
        "epharmacy_conflicts": epharmacy_conflicts,
        "stages_completed": 4,
        "rejected_at_stage": None,
        "rejected_stage_name": None,
        "rejection_reason": conflict_details.get("rejection_reason"),
        "similar_names": similar_names,
        "conflicts": conflicts,
        "knockout_checks": knockout_checks,
        "coining_principles_eval": conflict_details.get("coining_principles_eval"),
        "case_context": {
            "case_id": (case_data.get("case_id") if case_data else None) or g.case_id,
            "case_name": (case_data.get("case_name") if case_data else None) or g.case_id,
            "generic_name": (case_data.get("generic_name") if case_data else None) or g.molecule,
            "therapy": (case_data.get("therapy") if case_data else None) or g.therapeutic_area,
            "segment": (case_data.get("segment") if case_data else None) or g.therapeutic_area,
            "ailment": (case_data.get("ailment") if case_data else None) or (case_data.get("promoting_indications") if case_data else None),
            "promoting_indications": (case_data.get("promoting_indications") if case_data else None),
            "dosage_form": (case_data.get("dosage_form") if case_data else None),
            "coining_principles": conflict_details.get("coining_principles"),
            "business_alignment": conflict_details.get("business_alignment"),
            "coining_preference_source": conflict_details.get("coining_preference_source"),
            "naming_criteria_rationale": conflict_details.get("naming_criteria_rationale"),
            "clinical_rationale": conflict_details.get("clinical_rationale"),
        },
        "created_at": g.created_at,
    }
    return {
        "id": g.id,
        "brand_name": g.generated_name,
        "status": "completed",
        "created_at": g.created_at,
        "screening_result": screening_result,
    }

