import asyncio
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.brand import GeneratedBrandName
from app.models.screening import BrandSearch
from app.repositories.brand import BrandRepository
from app.repositories.legal import LegalRepository
from app.repositories.settings import SettingsRepository
from app.repositories.screening import ScreeningRepository
from app.services.brand_screening import BrandScreeningService
from app.services.ai import ai_service, AIServiceError, check_exclusion_profile
from app.services.rejection_memory import RejectionLedger, describe_rejection, normalize_for_avoid
from app.services.generation_pipeline import ReplenishingGenerationPipeline, DONE as PIPELINE_DONE
from app.services.tabular_import import normalize_name
# Only _brand_stub is still used here. find_google_conflict /
# find_iqvia_conflict / find_pharmacy_conflict / scrape_pharmacy_listings /
# google_search_configured were imported but never called from this module once
# the queue pipeline took over — the live path reaches them through
# BrandScreeningService instead.
from app.services.market_check import _brand_stub
from app.services.screening import (
    calculate_mentor_risk_score, evaluate_pharma_knockout_checks,
    classify_similarity_types, fuzzy_similarity, grade_name_similarity,
    levenshtein_similarity,
    safe_phonetic_code, validate_linguistic_structure,
)

logger = logging.getLogger(__name__)

DEFAULT_RISK_WEIGHTS = {"trademark": 0.40, "phonetic": 0.25, "semantic": 0.20, "market": 0.15}

_CONFLICT_THRESHOLD = 0.45
_MAX_TOP_CONFLICTS = 15
_OWNER_SUFFIX_RE = re.compile(r"\s*\(([^)]+)\)\s*$")  # NOSONAR - single bounded group, not backtracking-prone

# Maximum market portal screening attempts per candidate before it is accepted-with-risk
_MAX_MARKET_ATTEMPTS = 3

# Maximum outer loop iterations to find `count` low/medium names (unbounded in time)
_MAX_OUTER_LOOPS = 50

# Concurrency limit for parallel candidate screening (async worker pool)
_PARALLEL_SCREENING_CONCURRENCY = 4

# Rolling window for the cross-case "previously flagged high_risk" avoid-pool
# (see _load_history_avoid_pool) — bounds it to recent history instead of
# every high_risk name this system has ever produced.
_HIGH_RISK_HISTORY_MAX_AGE_DAYS = 7

def _extract_avoid_patterns(candidate_name: str, collided_with: Optional[str] = None) -> List[str]:
    """Extracts the prefix/suffix roots — and the phonetic stem — of conflicted
    names for Avoid Pool 2.

    The prefix/suffix roots are unchanged. The sound-stem line is added because
    the overwhelming majority of this pipeline's real rejections are scored on
    PHONETIC similarity, and a purely orthographic hint ("avoid the prefix
    'Fyna'") is satisfied by a name that is spelled differently and sounds
    identical — which then collides again. `safe_phonetic_code` is the same
    Metaphone helper `screening.py` already uses, so this describes the
    collision in the terms the screening actually scores. It remains a prompt
    hint only: nothing here gates, filters or scores a candidate.
    """
    patterns = []
    c = (candidate_name or "").strip()
    if len(c) >= 5:
        patterns.append(f"Prefix '{c[:4]}'")
        patterns.append(f"Suffix '-{c[-4:]}'")
    elif len(c) >= 4:
        patterns.append(f"Root '{c}'")
    if collided_with:
        cw = (collided_with or "").strip()
        if len(cw) >= 5:
            patterns.append(f"Prefix '{cw[:4]}'")
            patterns.append(f"Suffix '-{cw[-4:]}'")
        elif len(cw) >= 4:
            patterns.append(f"Root '{cw}'")
        if len(c) >= 4 and len(cw) >= 4:
            try:
                code = safe_phonetic_code(c)
                if code:
                    patterns.append(
                        f"Sound-stem '{code}' (how \"{c}\" and \"{cw}\" both sound — "
                        f"respelling this does not avoid it)"
                    )
            except Exception:  # pragma: no cover - defensive, hint only
                pass
    return list(set(patterns))


def _as_rejected_record(entry: dict, conflict: Optional[dict], evidence: Optional[dict]) -> dict:
    """Turns a candidate the screening pipeline REJECTED into a
    `generated_brand_names` row so it lands in Avoid Pool 1's "Historical
    Pipeline Rejections" source on later requests.

    `recommendation_status` is set to `high_risk` because that is the verdict
    screening already reached — `_check_local_registries` / `_check_all_portals`
    only return a `conflict` when `evidence["stopped_at_stage"]` is set (a
    knockout) or the score is already HIGH / >= 65.0. No threshold, formula or
    classification rule is applied here; this only records the existing verdict
    in the table whose documented purpose is Historical Pipeline Rejections.
    """
    rec = {k: v for k, v in entry.items() if not k.startswith("_")}
    rec["recommendation_status"] = "high_risk"
    rec["trademark_availability"] = "Likely Conflicted"
    if conflict:
        try:
            sim = float(conflict.get("similarity_score") or 0.0)
        except (TypeError, ValueError):
            sim = 0.0
        rec["risk_score"] = round(max(float(rec.get("risk_score") or 0.0), sim * 100.0, 65.0), 1)
    else:
        rec["risk_score"] = round(max(float(rec.get("risk_score") or 0.0), 65.0), 1)
    rec["availability_score"] = round(max(100.0 - rec["risk_score"], 0.0), 1)

    cd = dict(rec.get("conflict_details") or {})
    matched, source, parameter, reason = describe_rejection(conflict, evidence)
    cd["rejected_by_pipeline"] = True
    cd["rejected_against"] = matched
    cd["rejected_source"] = source
    cd["rejected_parameter"] = parameter
    if reason:
        cd["rejection_reason"] = reason
    rec["conflict_details"] = cd
    rec["ai_explanation"] = reason or (
        f'Rejected by deterministic screening: matched "{matched}" via {source}'
        f'{f" on {parameter} similarity" if parameter else ""}.'
    )
    return rec


def _batch_quality_metrics(names: List[str]) -> Dict[str, Any]:
    """Diagnostic summary of one generated batch's structural spread.

    Pure observability for the Phase 1 measurement requirement — it records
    what the model produced, and never filters, reorders or rejects anything.
    """
    clean = [n.strip() for n in names if n and n.strip()]
    if not clean:
        return {}
    lowered = [n.lower() for n in clean]
    initials: Dict[str, int] = {}
    suffixes: Dict[str, int] = {}
    skeletons: Dict[str, int] = {}
    banned: List[str] = []
    for n in lowered:
        initials[n[0]] = initials.get(n[0], 0) + 1
        suf = n[-2:]
        suffixes[suf] = suffixes.get(suf, 0) + 1
        skel = re.sub(r"[aeiouy]", "", n)
        skeletons[skel] = skeletons.get(skel, 0) + 1
    for n in clean:
        hits = check_exclusion_profile(n)
        if hits:
            banned.append(f"{n}({','.join(hits)})")
    top_suffix = max(suffixes.items(), key=lambda kv: kv[1]) if suffixes else ("", 0)
    top_initial = max(initials.items(), key=lambda kv: kv[1]) if initials else ("", 0)
    return {
        "count": len(clean),
        "distinct": len(set(lowered)),
        "distinct_initials": len(initials),
        "top_initial": f"{top_initial[0]}={top_initial[1]}",
        "top_suffix": f"-{top_suffix[0]}={top_suffix[1]}",
        "suffix_concentration_pct": round(top_suffix[1] / len(clean) * 100),
        "repeated_skeletons": sum(1 for v in skeletons.values() if v > 1),
        "banned_morphology": banned,
    }


def _split_names(raw: Optional[str], source: str) -> List[Dict[str, Optional[str]]]:
    if not raw or not raw.strip():
        return []
    entries = []
    for chunk in re.split(r"[,;]", raw):
        chunk = chunk.strip()
        if not chunk:
            continue
        owner = None
        match = _OWNER_SUFFIX_RE.search(chunk)
        name = chunk
        if match:
            owner = match.group(1).strip()
            name = _OWNER_SUFFIX_RE.sub("", chunk).strip()
        if name:
            entries.append({"name": name, "owner": owner, "source": source})
    return entries


def _build_context(request) -> Tuple[Dict[str, Any], List[Dict[str, Optional[str]]]]:
    existing_brand_names: List[Dict[str, Optional[str]]] = []

    if request.suggestion_form:
        sf = request.suggestion_form
        context = {
            "molecule": sf.product_information.generic_name,
            "dosage_form": sf.product_information.dosage_form,
            "dose": sf.product_information.dose,
            "division": sf.product_information.division,
            "ailment": sf.medical_information.ailment,
            "segment": sf.medical_information.segment,
            "therapy": sf.medical_information.therapy,
            "promoting_indications": sf.medical_information.promoting_indications,
            "mfd_type": sf.manufacturing_information.mfd_type,
            "in_license": sf.manufacturing_information.in_license,
            "parent_brand_owner": sf.manufacturing_information.parent_brand_owner,
            "marketer_name": sf.commercial_information.marketer_name,
            "expected_launch_month": sf.commercial_information.expected_launch_month,
            "dcgi_combination_approved": sf.regulatory_information.dcgi_combination_approved,
            "drug_schedule": sf.regulatory_information.drug_schedule,
            "patent_validity": sf.patent_information.patent_validity,
            "launch_after_expiry": sf.patent_information.launch_after_expiry,
        }
        existing_brand_names += _split_names(sf.brand_information.domestic_brand_names, "Domestic Brand (existing)")
        existing_brand_names += _split_names(sf.brand_information.international_brand_names, "International Brand (existing)")
        existing_brand_names += _split_names(sf.brand_information.innovator_brands, "Innovator Brand (existing)")
    else:
        context = {
            "molecule": request.molecule,
            "therapeutic_area": request.therapeutic_area,
            "ailment": request.ailment,
            "product_attributes": request.product_attributes,
        }

    context.update({
        "geography": request.geography,
        "naming_style": request.naming_style,
        "treatment": request.treatment,
        "emotion_connected": request.emotion_connected,
        "outcome": request.outcome,
        "description": request.description,
    })
    if request.suggestion_form and hasattr(request.suggestion_form, "naming_information") and request.suggestion_form.naming_information:
        ni = request.suggestion_form.naming_information
        context.update({
            "treatment": getattr(ni, "treatment", None) or context.get("treatment"),
            "emotion_connected": getattr(ni, "emotion_connected", None) or context.get("emotion_connected"),
            "naming_style": getattr(ni, "naming_style", None) or context.get("naming_style"),
            "outcome": getattr(ni, "product_benefit", None) or context.get("outcome"),
            "brand_coining_preferences": getattr(ni, "brand_coining_preferences", None) or context.get("brand_coining_preferences"),
            "description": getattr(ni, "description", None) or context.get("description"),
        })

    if request.suggestion_form and hasattr(request.suggestion_form, "molecule_history_information") and request.suggestion_form.molecule_history_information:
        mh = request.suggestion_form.molecule_history_information
        context["molecule_history"] = {
            "inventor_name": getattr(mh, "inventor_name", None),
            "patient_name": getattr(mh, "patient_name", None),
            "place_of_origin": getattr(mh, "place_of_origin", None),
            "other_historical_association": getattr(mh, "other_historical_association", None),
        }

    if request.suggestion_form and request.product_attributes:
        context["product_attributes"] = request.product_attributes

    return context, existing_brand_names


def _rationale(name: str, status: str, top_conflicts: List[dict]) -> str:
    if not top_conflicts:
        return (
            f'"{name}" shows no significant conflicts against known trademarks, market brands, '
            f"or this composition's on-record existing names. Appears available for further evaluation."
        )
    top = top_conflicts[0]
    top_pct = int(top["similarity_score"] * 100)
    sim_label = top["similarity_type"].lower()
    if status == "recommended":
        return (
            f'"{name}" is recommended with low conflict risk (closest match: {top["name"]} '
            f'at {top_pct}% {sim_label} similarity via {top["source"]}). '
            f"No blocking conflicts detected. Proceed with standard trademark clearance."
        )
    conflict_list = "; ".join(
        f'{c["name"]} ({int(c["similarity_score"]*100)}% {c["similarity_type"].lower()}, {c["source"]})'
        for c in top_conflicts[:3]
    )
    if status == "review_required":
        return (
            f'"{name}" requires legal review. Flagged due to moderate similarity with: {conflict_list}. '
            f"A targeted trademark clearance search is advised before proceeding."
        )
    return (
        f'"{name}" is classified as high risk due to strong similarity with: {conflict_list}. '
        f"Significant trademark or market collision probability. Avoid or seek specialized IP counsel."
    )


class GeneratorService:
    def __init__(self, db: Session):
        self.db = db
        self.brand_repo = BrandRepository(db)
        self.settings_repo = SettingsRepository(db)
        self.screening_repo = ScreeningRepository(db)
        self.screening_service = BrandScreeningService(db)

    def _load_history_avoid_pool(self) -> List[Dict[str, Optional[str]]]:
        """Names to avoid: every name this system has flagged high_risk in the
        last _HIGH_RISK_HISTORY_MAX_AGE_DAYS days (across ALL past cases, not
        just this one), every name currently sitting in the Trademark Review
        workflow at any status — including pending — and every name staged in
        a Review Batch cart awaiting submission. Without this, a name rejected
        in a recent case (or already mid-review right now) could get silently
        reproposed in a new one. Cached (1hr TTL) — this cross-case query is
        identical for every generation request regardless of the current
        case's molecule.

        The high_risk side is bounded to a rolling window rather than every
        such name ever recorded — unbounded, this pool only grows, and
        eventually crowds out the prompt's avoid-list budget with names stale
        enough no longer to matter (see BrandRepository.get_high_risk_generated_names).

        Fed to the LLM as an avoid-list only (see avoid_pool in
        generate_names/generate_names_stream) — deliberately NOT included in
        Stage 3's conflict_pool: a name this pipeline once flagged high_risk
        for an unrelated case/molecule is not a real trademark, and
        phonetically fuzzy-matching new candidates against a cross-case,
        ever-growing pool of past AI-coined rejects produced false-positive
        high_risk verdicts unrelated to any actual conflict (this used to be
        synced into the now-removed MarketBrand table for exactly that
        fuzzy-matching purpose — see git history)."""
        from app.core.cache import cache_service
        cached = cache_service.get_json("global_history_avoid_pool")
        if cached is not None:
            return cached

        high_risk = self.brand_repo.get_high_risk_generated_names(
            max_age_days=_HIGH_RISK_HISTORY_MAX_AGE_DAYS
        )
        review_names = LegalRepository(self.db).get_all_review_names()
        # Each source de-duplicates internally, but a name can legitimately
        # appear in more than one (e.g. rejected by the pipeline AND later
        # submitted to Legal). Without a cross-source pass it was listed twice
        # in the prompt, spending the avoid budget on the same name.
        # First writer wins, so the pipeline-history label is preserved.
        pool = []
        _pool_seen: set = set()
        for entry in (
            [
                {"name": g.generated_name, "owner": None, "source": "Previously Rejected (Pipeline History)"}
                for g in high_risk if g.generated_name
            ] + [
                {"name": r["name"], "owner": None, "source": r["source"]}
                for r in review_names
            ]
        ):
            key = normalize_for_avoid(entry["name"])
            if key and key not in _pool_seen:
                _pool_seen.add(key)
                pool.append(entry)
        cache_service.set_json("global_history_avoid_pool", pool, ttl_seconds=3600)
        return pool

    def _persist_rejected_candidates(
        self, rejected: List[dict], history_pool: List[Dict[str, Optional[str]]]
    ) -> int:
        """Writes screening-rejected candidates to generated_brand_names via the
        existing BrandRepository, so Avoid Pool 1 can see them next time.

        Deduplicated case-insensitively against both this batch and the names
        already in Avoid Pool 1, so a name that has collided in twenty runs
        occupies one row, not twenty. Never raises: a failure here must not fail
        a generation request that otherwise succeeded.
        """
        if not rejected:
            return 0
        try:
            known = {
                normalize_for_avoid(e.get("name"))
                for e in (history_pool or [])
                if e.get("name")
            }
            fresh: List[dict] = []
            for rec in rejected:
                key = normalize_for_avoid(rec.get("generated_name"))
                if not key or key in known:
                    continue
                known.add(key)
                fresh.append(rec)
            if not fresh:
                logger.info("[REJECTION HISTORY] No new rejected names to persist (all already on record).")
                return 0
            self.brand_repo.save_generated_names(fresh)
            # Avoid Pool 1 is cached for an hour; drop it so the names just
            # recorded are visible to the very next generation request rather
            # than up to an hour later.
            from app.core.cache import cache_service
            cache_service.delete("global_history_avoid_pool")
            logger.info(
                "[REJECTION HISTORY] Persisted %d newly-rejected name(s) to Avoid Pool 1: %s",
                len(fresh), [r.get("generated_name") for r in fresh][:20],
            )
            return len(fresh)
        except Exception:
            logger.warning(
                "[REJECTION HISTORY] Failed to persist rejected names; this run's rejections "
                "will not reach Avoid Pool 1", exc_info=True,
            )
            try:
                self.db.rollback()
            except Exception:
                pass
            return 0

    def _load_registry_candidate_pool(self) -> List[Dict[str, str]]:
        """Every normalized name from RegisteredNotInUse + InternationalMarketBrand,
        offered to the AI Name Generator as a pool of REAL existing names it
        may select a genuine match from (see AIService.build_generation_prompt's
        registry section) — distinct from conflict_pool/avoid_pool, which are
        "avoid these," not "you may pick from these." Cached (1hr TTL) since
        this only changes via an admin bulk upload of the two source tables."""
        from app.core.cache import cache_service
        cached = cache_service.get_json("registry_candidate_pool")
        if cached is not None:
            return cached
        pool = self.screening_repo.get_registry_candidate_pool()
        cache_service.set_json("registry_candidate_pool", pool, ttl_seconds=3600)
        return pool

    async def _apply_legal_gate(
        self,
        raw_candidates: List[dict],
        context: dict,
        base_avoid_pool: List[Dict[str, Optional[str]]],
        cumulative_rejection_feedback: List[Dict[str, Any]],
        legal_decided: Dict[str, str],
        avoid_pool_2_rejected_names: Optional[List[str]] = None,
        avoid_pool_2_patterns: Optional[set] = None,
        ledger: Optional[RejectionLedger] = None,
    ) -> List[dict]:
        """Step 4: hard exact-match gate against Legal Review's DECIDED names
        (status approved/rejected only — see
        LegalRepository.get_decided_name_lookup). Runs on the freshly
        assembled batch (registry-matched + AI-coined) before Stage 3
        scoring, so a gated name is NEVER passed to _score_candidate and
        therefore never reaches Stage 4 WHO INN / IQVIA / e-pharmacy /
        Google screening at all. Records rejected names in avoid_pool_2_rejected_names
        and cumulative_rejection_feedback so a rejected name is never re-offered."""
        if not legal_decided:
            return raw_candidates

        clean: List[dict] = []
        gated: List[Tuple[dict, str]] = []
        for item in raw_candidates:
            name = (item.get("name") or "").strip()
            status = legal_decided.get(normalize_name(name)) if name else None
            (gated if status else clean).append((item, status) if status else item)

        if not gated:
            return clean

        new_feedback = []
        for item, status in gated:
            name = item["name"]
            logger.info("  [LEGAL GATE DISCARD] '%s' (Status: %s) -> Exact match in Legal Reviews. Discarding immediately.", name, status)
            fb = {
                "candidate": name,
                "collided_with": name,
                "source": f"Legal Review ({status.title()})",
                "avoid_hint": f'"{name}" itself and close variants',
            }
            if avoid_pool_2_rejected_names is not None and normalize_for_avoid(name) not in {normalize_for_avoid(x) for x in avoid_pool_2_rejected_names}:
                avoid_pool_2_rejected_names.append(name)
            new_pats = _extract_avoid_patterns(name, name)
            if ledger is not None:
                # Same rejection, recorded once in the durable ledger so it is
                # still known on the next request.
                fb = ledger.record(
                    name,
                    {"name": name, "source": f"Legal Review ({status.title()})",
                     "conflict_type": "EXACT_MATCH", "exact": True},
                    patterns=new_pats,
                )
            cumulative_rejection_feedback.append(fb)
            new_feedback.append(fb)
            if avoid_pool_2_patterns is not None:
                avoid_pool_2_patterns.update(new_pats)
                logger.info("  [LEGAL GATE AVOID POOL 2] Extracted patterns for '%s': %s", name, new_pats)

        logger.info(
            "[LEGAL REVIEW GATE] Rejected %d candidate(s) already decided by Legal: %s. Requesting immediate batch replacement...",
            len(gated), [item["name"] for item, _ in gated],
        )

        try:
            replacements = await ai_service.generate_brand_names(
                context, base_avoid_pool, len(gated), rejection_feedback=new_feedback,
                avoid_patterns=(
                    ledger.ranked_patterns(extra_patterns=avoid_pool_2_patterns)
                    if ledger is not None
                    else (list(avoid_pool_2_patterns) if avoid_pool_2_patterns else None)
                ) or None,
                # NOTE: avoid_pool_2_rejected_names also accumulates the real
                # reference brands candidates collided WITH. Those belong in the
                # collision-family section, not in "names you already generated
                # and must not repeat" — feeding them here spent the capped
                # avoid budget telling the model not to generate brands it was
                # never going to generate. The ledger keeps the two separate.
                avoid_rejected_names=(
                    ledger.prompt_avoid_names()
                    if ledger is not None else avoid_pool_2_rejected_names
                ),
                repeat_offenders=(ledger.repeat_offender_families() if ledger is not None else None) or None,
            )
        except AIServiceError as exc:
            logger.warning("[LEGAL REVIEW GATE] Replacement generation failed: %s", exc)
            return clean

        rep_names = [r.get("name") for r in (replacements or [])]
        logger.info("[LEGAL GATE REPLACEMENT SUCCESS] Received %d replacement candidates: %s", len(rep_names), rep_names)
        for rep in replacements or []:
            rep_name = (rep.get("name") or "").strip()
            if rep_name and not legal_decided.get(normalize_name(rep_name)):
                clean.append(rep)
        return clean

    def _score_candidate(
        self,
        name: str,
        item: dict,
        context: dict,
        conflict_pool: List[dict],
        therapeutic_area: Optional[str],
        molecule: str,
        request,
        user_id: Optional[uuid.UUID],
    ) -> dict:
        is_valid, invalid_reason = validate_linguistic_structure(name)
        if not is_valid:
            return {
                "id": uuid.uuid4(),
                "case_id": request.case_id if request.case_id else None,
                "user_id": user_id,
                "request_snapshot": request.model_dump() if hasattr(request, "model_dump") else None,
                "generated_name": name,
                "therapeutic_area": therapeutic_area,
                "molecule": molecule,
                "risk_score": 100.0,
                "availability_score": 0.0,
                "memorability_score": 0.0,
                "pronunciation_score": 0.0,
                "recommendation_status": "high_risk",
                "trademark_availability": "Likely Conflicted",
                "ai_explanation": f"REJECTED: {invalid_reason}",
                "phonetic_analysis": "Unpronounceable",
                "conflict_details": {
                    "rationale": invalid_reason,
                    "top_conflicts": [],
                    "total_conflict_count": 1,
                    "is_linguistically_invalid": True,
                    "candidate_origin": item.get("source") or "ai_coined",
                },
                "created_at": None,
            }

        raw_conflicts = []
        for ref in conflict_pool:
            ref_name = ref["name"]
            # Universal grading (Spelling / Phonetic / Visual — independently
            # scored, no blended composite) — same formula every other stage
            # uses (see BrandScreeningService._stage_conflict /
            # screening.grade_name_similarity), so this offline pre-screen
            # against the Trademark Registry / Market DB pool grades a name
            # pair identically to the live WHO/e-pharmacy/Google checks later.
            grades = grade_name_similarity(name, ref_name)
            lev = levenshtein_similarity(name, ref_name)
            fuz = fuzzy_similarity(name, ref_name)
            phon = grades["phonetic"]
            look = grades["visual"]
            effective_sim = max(grades.values())

            if effective_sim >= _CONFLICT_THRESHOLD:
                sim_types = classify_similarity_types(lev, fuz, phon, look) or ["Spelling"]
                sem_val = round(effective_sim * 0.5, 3)
                raw_conflicts.append({
                    "name": ref_name,
                    "owner": ref.get("owner"),
                    "source": ref.get("source", "Trademark Registry"),
                    "similarity_score": round(effective_sim, 3),
                    "similarity_type": sim_types[0],
                    "similarity_types": sim_types,
                    "phonetic_score": round(phon, 3),
                    "spelling_score": round(grades["spelling"], 3),
                    "soundalike_score": 0.0,
                    "lookalike_score": round(look, 3),
                    "semantic_similarity_score": sem_val,
                })

        raw_conflicts.sort(key=lambda c: c["similarity_score"], reverse=True)
        top_conflicts = raw_conflicts[:_MAX_TOP_CONFLICTS]
        total_conflicts = len(raw_conflicts)
        top_score = top_conflicts[0]["similarity_score"] if top_conflicts else 0.0

        exact_match = 1.0 if any(c["similarity_score"] >= 0.98 for c in top_conflicts) else 0.0
        spelling_max = max((c["spelling_score"] for c in top_conflicts if c.get("spelling_score", 0) >= 0.30), default=0.0)
        phonetic_max = max((c["phonetic_score"] for c in top_conflicts if c.get("phonetic_score", 0) >= 0.30), default=0.0)
        look_max = max((c["lookalike_score"] for c in top_conflicts if c.get("lookalike_score", 0) >= 0.30), default=0.0)
        semantic_max = max((c.get("semantic_similarity_score", 0.0) for c in top_conflicts if c.get("semantic_similarity_score", 0.0) >= 0.30), default=0.0)
        market_presence = min(total_conflicts / 10.0, 1.0)

        # 4-Parameter Weighted Formula with Dynamic Settings & Hard Knockout Gates
        weights = self.settings_repo.get_risk_weights()
        risk_score, risk_cls, ai_rec, _, _ = calculate_mentor_risk_score(
            phonetic_score=phonetic_max,
            spelling_score=spelling_max,
            visual_score=look_max,
            conceptual_score=semantic_max,
            is_exact_match=bool(exact_match >= 0.98),
            is_who_inn_knockout=False,
            weights=weights,
        )

        if risk_cls == "HIGH" or risk_score >= 70.0:
            rec_status = "high_risk"
            tm_status = "Likely Conflicted"
        elif risk_cls == "MEDIUM" or risk_score >= 30.0 or total_conflicts >= 3 or top_score >= 0.60:
            rec_status = "review_required"
            tm_status = "Potential Conflict"
        else:
            rec_status = "recommended"
            tm_status = "Available"

        risk_score = round(min(max(risk_score, 0.0), 100.0), 1)
        availability_score = round(max(100.0 - risk_score, 0.0), 1)

        raw_mem = item.get("memorability_score") or item.get("memorability")
        raw_pron = item.get("pronunciation_score") or item.get("pronunciation_ease") or item.get("pronunciation")
        
        if raw_mem is not None:
            mem_score = round(float(raw_mem), 1)
        else:
            # Memorability != short length — score on vowel/consonant balance
            # and absence of harsh consonant clusters, not raw character count.
            # A 12-letter name with natural cadence (e.g. "Paracetamol") scores
            # the same as a 7-letter one with the same balance.
            vowels_ct = sum(1 for c in name.lower() if c in "aeiouy")
            vowel_ratio_mem = vowels_ct / max(len(name), 1)
            has_bad_cluster = bool(re.search(r"[^aeiouy]{4,}", name.lower()))
            base_factor = 70.0 if has_bad_cluster else (90.0 if 0.35 <= vowel_ratio_mem <= 0.55 else 82.0)
            mem_score = round(min(98.0, max(60.0, base_factor + (abs(hash(name)) % 9))), 1)

        if raw_pron is not None:
            pron_score = round(float(raw_pron), 1)
        else:
            vowels = sum(1 for c in name.lower() if c in "aeiouy")
            vowel_ratio = vowels / max(len(name), 1)
            vowel_score = 88.0 if 0.35 <= vowel_ratio <= 0.55 else 80.0
            pron_score = round(min(98.0, max(65.0, vowel_score + (abs(hash(name[::-1])) % 9))), 1)

        coining_principles = item.get("coining_principles") or ["Memorable & Distinctive Names", "Product Effect / Benefit"]
        business_alignment = item.get("business_alignment") or (
            f"Specifically tailored to {therapeutic_area} with positioning aligned to {context.get('emotion_connected') or 'efficacy and safety'}."
        )
        coining_preference_source = item.get("coining_preference_source") or f"Applicable Brand Coining Preferences: {context.get('naming_style') or 'Modern Coined Names'}"
        naming_criteria_rationale = item.get("naming_criteria_rationale") or f"Specifically generated to fulfill user's requested naming style: '{context.get('naming_style') or 'Scientific & Memorable'}'."
        clinical_rationale = item.get("clinical_rationale") or f"Case Composition Rationale: Formulated for {molecule or 'active molecule'} in {therapeutic_area or 'therapy area'} with high phonetic distinctiveness and zero known regulatory stem conflicts."
        rationale_text = item.get("rationale") or _rationale(name, rec_status, top_conflicts)

        return {
            "id": uuid.uuid4(),
            "case_id": request.case_id if request.case_id else None,
            "user_id": user_id,
            "request_snapshot": request.model_dump() if hasattr(request, "model_dump") else None,
            "generated_name": name,
            "therapeutic_area": therapeutic_area,
            "molecule": molecule,
            "geography": context.get("geography") or "India",
            "product_attributes": str(context.get("product_attributes") or ""),
            "naming_style": context.get("naming_style") or "Scientific & Memorable",
            "coining_principles": coining_principles,
            "business_alignment": business_alignment,
            "risk_score": risk_score,
            "availability_score": availability_score,
            "memorability_score": mem_score,
            "pronunciation_score": pron_score,
            "recommendation_status": rec_status,
            "trademark_availability": tm_status,
            "ai_explanation": rationale_text,
            "phonetic_analysis": item.get("phonetic", name),
            "semantic_analysis": None,
            "conflict_details": {
                "top_conflicts": top_conflicts,
                "total_conflict_count": total_conflicts,
                "coining_principles": coining_principles,
                "business_alignment": business_alignment,
                "coining_preference_source": coining_preference_source,
                "naming_criteria_rationale": naming_criteria_rationale,
                "clinical_rationale": clinical_rationale,
                "rationale": rationale_text,
                "domain_available": True,
                "exact_match_score": exact_match,
                "spelling_similarity_score": spelling_max,
                "phonetic_similarity_score": phonetic_max,
                "soundalike_score": 0.0,
                "lookalike_score": look_max,
                "market_presence_score": market_presence,
                "semantic_similarity_score": semantic_max,
                "trademark_conflict_score": round(top_score, 3),
                "phonetic_code": safe_phonetic_code(name),
                "candidate_origin": item.get("source") or "ai_coined",
            },
        }

    def _rescore_candidate_with_market(
        self,
        entry: dict,
        listings: List[dict],
        conflict: Optional[dict],
        market_attempts: int,
        evidence: Optional[dict] = None,
        scores: Optional[dict] = None,
        similar_names: Optional[list] = None,
        case_context: Optional[dict] = None,
    ) -> None:
        name = entry["generated_name"]
        cd = entry["conflict_details"]

        if scores is not None:
            # Combine with (never simply overwrite) whatever Stage 3's offline
            # pre-screen against the Trademark Registry/Market DB pool already
            # found for this candidate. A live WHO/IQVIA/e-pharmacy/Google
            # check coming back clean does NOT mean the candidate is clean —
            # it only means those specific live sources found nothing; a real
            # conflict Stage 3 already detected (and which still shows up in
            # top_conflicts below) must not get silently discarded from the
            # risk score/classification just because live-only scores happen
            # to be lower.
            live_risk = float(scores["overall_risk_score"])
            existing_risk = float(entry.get("risk_score") or 0.0)
            risk_val = max(live_risk, existing_risk)
            entry["risk_score"] = round(risk_val, 1)
            entry["availability_score"] = round(max(100.0 - risk_val, 0.0), 1)
            if risk_val >= 65.0:
                rec_status, tm_status = "high_risk", "Likely Conflicted"
            elif risk_val >= 30.0:
                rec_status, tm_status = "review_required", "Potential Conflict"
            else:
                rec_status, tm_status = "recommended", "Available"
            entry["recommendation_status"] = rec_status
            entry["trademark_availability"] = tm_status

            cd["exact_match_score"] = max(scores.get("exact_match_score", 0.0), cd.get("exact_match_score", 0.0))
            cd["spelling_similarity_score"] = max(scores.get("spelling_similarity_score", 0.0), cd.get("spelling_similarity_score", 0.0))
            cd["phonetic_similarity_score"] = max(scores.get("phonetic_similarity_score", 0.0), cd.get("phonetic_similarity_score", 0.0))
            cd["lookalike_score"] = max(scores.get("lookalike_score", 0.0), cd.get("lookalike_score", 0.0))
            cd["semantic_similarity_score"] = max(scores.get("semantic_similarity_score", 0.0), cd.get("semantic_similarity_score", 0.0))
            cd["market_presence_score"] = max(scores.get("market_presence_score", 0.0), cd.get("market_presence_score", 0.0))
            cd["trademark_conflict_score"] = max(scores.get("trademark_conflict_score", 0.0), cd.get("trademark_conflict_score", 0.0))

            top_confs = []
            if conflict:
                cname = conflict.get("name") or conflict.get("conflicting_name")
                if cname:
                    top_confs.append({
                        "name": cname,
                        "owner": conflict.get("owner"),
                        "source": conflict.get("source", "Market"),
                        "similarity_score": round(float(conflict.get("similarity_score", 1.0)), 3),
                        "similarity_type": conflict.get("conflict_type") or conflict.get("similarity_type", "Conflict"),
                        "severity": conflict.get("severity", "HIGH"),
                    })
            if evidence and evidence.get("stopped_conflict"):
                sc = evidence["stopped_conflict"]
                sc_name = sc.get("name") or sc.get("conflicting_name")
                if sc_name and not any(tc["name"].lower() == sc_name.lower() for tc in top_confs):
                    top_confs.append({
                        "name": sc_name,
                        "owner": sc.get("owner"),
                        "source": sc.get("source", "Market"),
                        "similarity_score": round(float(sc.get("similarity_score", 1.0)), 3),
                        "similarity_type": sc.get("conflict_type") or "Conflict",
                        "severity": sc.get("severity", "HIGH"),
                    })
            for c in cd.get("top_conflicts", []):
                if not any(tc["name"].lower() == c["name"].lower() for tc in top_confs):
                    top_confs.append(c)
            top_confs.sort(key=lambda c: c.get("similarity_score", 0.0), reverse=True)
            cd["top_conflicts"] = top_confs[:_MAX_TOP_CONFLICTS]
            cd["total_conflict_count"] = max(scores.get("total_conflicts", 0), len(top_confs))
            if similar_names:
                cd["similar_names"] = similar_names

            cd["knockout_checks"] = evaluate_pharma_knockout_checks(
                name,
                top_confs,
                similar_names or [],
                case_context=case_context,
                is_who_inn_fail=bool(evidence and evidence.get("stopped_at_stage") == 1),
                is_linguistic_fail=bool(evidence and evidence.get("is_linguistic_knockout")),
            )
            if evidence and evidence.get("rejection_reason"):
                cd["rejection_reason"] = evidence.get("rejection_reason")
                cd["rationale"] = evidence.get("rejection_reason")
                entry["ai_explanation"] = evidence.get("rejection_reason")
            return

        top_conflicts = list(entry["conflict_details"].get("top_conflicts", []))

        for listing in listings:
            c_name = _brand_stub(listing.get("brand_name", ""))
            if not c_name:
                continue
            lev = levenshtein_similarity(name, c_name)
            fuz = fuzzy_similarity(name, c_name)
            grades = grade_name_similarity(name, c_name)
            phon = grades["phonetic"]
            look = grades["visual"]
            eff_sim = max(grades.values())

            if eff_sim >= _CONFLICT_THRESHOLD or max(lev, fuz) >= 0.50 or phon >= 0.50:
                sim_types = classify_similarity_types(lev, fuz, phon, look) or ["Spelling"]
                top_conflicts.append({
                    "name": c_name,
                    "owner": listing.get("manufacturer"),
                    "source": listing.get("source", "E-Pharmacy"),
                    "similarity_score": round(eff_sim, 3),
                    "similarity_type": sim_types[0],
                    "similarity_types": sim_types,
                    "phonetic_score": round(phon, 3),
                    "spelling_score": round(grades["spelling"], 3),
                    "soundalike_score": 0.0,
                    "lookalike_score": round(look, 3),
                })

        if conflict:
            c_name = conflict["name"]
            grades = grade_name_similarity(name, c_name)
            lev = levenshtein_similarity(name, c_name)
            fuz = fuzzy_similarity(name, c_name)
            phon = grades["phonetic"]
            look = grades["visual"]
            sim_types = classify_similarity_types(lev, fuz, phon, look) or ["Spelling"]
            top_conflicts.insert(0, {
                "name": c_name,
                "owner": conflict.get("owner"),
                "source": conflict.get("source", "Market"),
                "similarity_score": round(conflict["similarity_score"], 3),
                "similarity_type": sim_types[0],
                "similarity_types": sim_types,
                "phonetic_score": round(phon, 3),
                "spelling_score": round(grades["spelling"], 3),
                "soundalike_score": 0.0,
                "lookalike_score": round(look, 3),
            })

        seen = set()
        deduped = []
        for c in top_conflicts:
            k = c["name"].lower()
            if k not in seen:
                seen.add(k)
                deduped.append(c)
        deduped.sort(key=lambda c: c["similarity_score"], reverse=True)
        top_conflicts = deduped[:_MAX_TOP_CONFLICTS]

        exact_match = 1.0 if any(c["similarity_score"] >= 0.98 for c in top_conflicts) else 0.0
        spelling_max = max((c["spelling_score"] for c in top_conflicts), default=0.0)
        phonetic_max = max((c["phonetic_score"] for c in top_conflicts), default=0.0)
        look_max = max((c["lookalike_score"] for c in top_conflicts), default=0.0)
        top_score = top_conflicts[0]["similarity_score"] if top_conflicts else 0.0
        semantic_max = round(top_score * 0.5, 3)
        total_conflicts = len(deduped)

        portal_hits = (entry.get("conflict_details", {}).get("market_check", {}) or {}).get("portal_hits", {})
        if portal_hits:
            hit_count = sum(1 for v in portal_hits.values() if v)
            market_presence = min(hit_count * 0.25, 1.0)
        else:
            sources_hit = set(c.get("source", "") for c in top_conflicts if c.get("source"))
            market_presence = min(len(sources_hit) * 0.25, 1.0) if sources_hit else min(total_conflicts / 10.0, 1.0)

        weights = self.settings_repo.get_risk_weights()
        risk_score, risk_cls, ai_rec, _, _ = calculate_mentor_risk_score(
            phonetic_score=phonetic_max,
            spelling_score=spelling_max,
            visual_score=look_max,
            conceptual_score=semantic_max,
            is_exact_match=bool(exact_match >= 0.98),
            is_who_inn_knockout=bool(any(c.get("similarity_type") in ("INN_KNOCKOUT", "WHO_INN_CONFLICT") for c in top_conflicts)),
            weights=weights,
        )

        if risk_cls == "HIGH" or risk_score >= 70.0:
            rec_status = "high_risk"
            tm_status = "Likely Conflicted"
        elif risk_cls == "MEDIUM" or risk_score >= 30.0 or total_conflicts >= 3 or top_score >= 0.60:
            rec_status = "review_required"
            tm_status = "Potential Conflict"
        else:
            rec_status = "recommended"
            tm_status = "Available"

        entry["risk_score"] = round(min(max(risk_score, 0.0), 100.0), 1)
        entry["availability_score"] = round(max(100.0 - entry["risk_score"], 0.0), 1)
        entry["recommendation_status"] = rec_status
        entry["trademark_availability"] = tm_status
        entry["conflict_details"]["top_conflicts"] = top_conflicts
        entry["conflict_details"]["total_conflict_count"] = total_conflicts
        entry["conflict_details"]["exact_match_score"] = exact_match
        entry["conflict_details"]["spelling_similarity_score"] = spelling_max
        entry["conflict_details"]["phonetic_similarity_score"] = phonetic_max
        entry["conflict_details"]["lookalike_score"] = look_max
        entry["conflict_details"]["semantic_similarity_score"] = semantic_max
        entry["conflict_details"]["market_presence_score"] = market_presence
        entry["conflict_details"]["trademark_conflict_score"] = round(top_score, 3)

        if conflict:
            entry["conflict_details"]["rationale"] = (
                f'"{name}" matches an existing commercial brand ({conflict["name"]} via {conflict["source"]}) '
                f'after {market_attempts} generation attempts. Classified as {rec_status.replace("_", " ").title()}.'
            )

    async def _check_local_registries(
        self, cand_name: str, toggles: Dict[str, bool], case_context: Optional[dict] = None
    ) -> Tuple[Optional[dict], List[dict], List[dict], Optional[dict], Optional[dict], Optional[list]]:
        """Tier 1 Local Screening: checks WHO INN & IQVIA local databases only (instant, no browser scraping)."""
        local_toggles = {
            "who_inn_enabled": toggles.get("who_inn_enabled", True),
            "iqvia_enabled": toggles.get("iqvia_enabled", True),
            "epharmacy_enabled": False,
            "google_search_enabled": False,
        }
        evidence = await self.screening_service._gather_evidence(cand_name, toggles=local_toggles)
        similar_names, conflicts, scores = await self.screening_service._score(
            cand_name, evidence, case_context=case_context
        )
        is_knockout = bool(evidence.get("stopped_at_stage"))
        is_high_risk = scores.get("risk_classification") == "HIGH" or scores.get("overall_risk_score", 0.0) >= 65.0

        if is_knockout or is_high_risk:
            primary_conflict = evidence.get("stopped_conflict") or (conflicts[0] if conflicts else {
                "name": cand_name, "source": "Local Registry Conflict", "similarity_score": scores.get("overall_risk_score", 100.0) / 100.0
            })
            conf_name = primary_conflict.get("name") or primary_conflict.get("conflicting_name") or cand_name
            matched_param = primary_conflict.get("matched_parameter") or primary_conflict.get("conflict_type") or "High Risk"
            sim_score = (primary_conflict.get("similarity_score") if primary_conflict.get("similarity_score") is not None else (scores.get("overall_risk_score", 0.0) / 100.0 if scores else 0.0)) * 100
            logger.info(
                "  [TIER 1 LOCAL DB COLLISION] Candidate '%s' collided with '%s' (%s) | Sim: %.1f%% (%s) | Reason: %s",
                cand_name, conf_name, primary_conflict.get("source"), sim_score, matched_param,
                evidence.get("rejection_reason") or primary_conflict.get("details") or "Registry conflict"
            )
        else:
            primary_conflict = None
            logger.info("  [TIER 1 LOCAL DB CLEAN] Candidate '%s' cleared WHO INN & IQVIA local databases.", cand_name)

        return primary_conflict, evidence.get("who_hits") or [], conflicts, evidence, scores, similar_names

    async def _check_all_portals(
        self, cand_name: str, toggles: Dict[str, bool], case_context: Optional[dict] = None
    ) -> Tuple[Optional[dict], List[dict], Dict[str, bool], List[dict], Optional[dict], Optional[dict], Optional[list]]:
        from app.core.database import SessionLocal
        worker_db = SessionLocal()
        try:
            worker_screening_service = BrandScreeningService(worker_db)
            evidence = await worker_screening_service._gather_evidence(cand_name, toggles=toggles)
            similar_names, conflicts, scores = await worker_screening_service._score(
                cand_name, evidence, case_context=case_context
            )
        finally:
            try:
                worker_db.close()
            except Exception:
                pass
        listings = evidence.get("epharmacy_hits") or []
        portal_hits = {
            "who_inn": bool(evidence.get("who_hits")),
            "iqvia": bool(evidence.get("iqvia_hits")),
            "epharmacy": bool(evidence.get("epharmacy_hits")),
            "google": bool(evidence.get("web_hits")),
        }
        is_knockout = bool(evidence.get("stopped_at_stage"))
        is_high_risk = scores.get("risk_classification") == "HIGH" or scores.get("overall_risk_score", 0.0) >= 65.0

        if is_knockout or is_high_risk:
            primary_conflict = evidence.get("stopped_conflict") or (conflicts[0] if conflicts else {
                "name": cand_name, "source": "Screening Conflict", "similarity_score": scores.get("overall_risk_score", 100.0) / 100.0
            })
            conf_name = primary_conflict.get("name") or primary_conflict.get("conflicting_name") or cand_name
            matched_param = primary_conflict.get("matched_parameter") or primary_conflict.get("conflict_type") or "Market Conflict"
            sim_score = (primary_conflict.get("similarity_score") if primary_conflict.get("similarity_score") is not None else (scores.get("overall_risk_score", 0.0) / 100.0 if scores else 0.0)) * 100
            logger.info(
                "  [TIER 2 PORTAL COLLISION] Candidate '%s' collided with '%s' (%s) | Sim: %.1f%% (%s) | Listings: %d",
                cand_name, conf_name, primary_conflict.get("source"), sim_score, matched_param, len(listings)
            )
        else:
            primary_conflict = None
            logger.info("  [TIER 2 PORTAL CLEAN] Candidate '%s' cleared all live e-pharmacy portals & Google search.", cand_name)

        return primary_conflict, listings, portal_hits, conflicts, evidence, scores, similar_names

    def _serialize_candidate(self, c: dict) -> dict:
        cid = c.get("id")
        cd = c.get("conflict_details") or {}
        created_at = c.get("created_at")
        if isinstance(created_at, datetime):
            created_str = created_at.isoformat()
        elif isinstance(created_at, str):
            created_str = created_at
        else:
            created_str = datetime.now(timezone.utc).isoformat()

        return {
            "id": str(cid) if cid else str(uuid.uuid4()),
            "generated_name": c.get("generated_name"),
            "therapeutic_area": c.get("therapeutic_area"),
            "molecule": c.get("molecule"),
            "risk_score": c.get("risk_score"),
            "availability_score": c.get("availability_score"),
            "memorability_score": c.get("memorability_score"),
            "pronunciation_score": c.get("pronunciation_score"),
            "recommendation_status": c.get("recommendation_status"),
            "trademark_availability": c.get("trademark_availability"),
            "ai_explanation": c.get("ai_explanation"),
            "phonetic_analysis": c.get("phonetic_analysis"),
            "conflict_details": cd,
            "loop_approved": c.get("loop_approved") or cd.get("loop_approved"),
            "rejected_before_count": c.get("rejected_before_count") if c.get("rejected_before_count") is not None else cd.get("rejected_before_count", 0),
            "time_to_generate_seconds": c.get("time_to_generate_seconds") if c.get("time_to_generate_seconds") is not None else cd.get("time_to_generate_seconds"),
            "created_at": created_str,
        }

    def _sync_brand_searches(self, final_candidates: List[dict], case_context: dict, user_id: Optional[uuid.UUID]) -> None:
        """Links each saved candidate into brand_searches so Brand Analysis can
        load it directly.

        Body is verbatim the block that previously ran inline in both
        generate_names and generate_names_stream — same queries, same commits,
        same per-candidate try/except, same transaction boundaries. It is now a
        single definition invoked through asyncio.to_thread, because running it
        inline blocked the event loop for the whole final persistence burst
        (measured at ~560ms in the Phase 3 benchmark), stalling every other
        request served by the same worker.
        """
        # Synchronize each saved candidate into brand_searches for direct load in Brand Analysis
        for cand in final_candidates:
            cand_name = cand.get("generated_name")
            cid = cand.get("case_id")
            if cand_name and cid:
                try:
                    clean_case = cid.strip()
                    existing_s = (
                        self.db.query(BrandSearch)
                        .filter(
                            func.lower(BrandSearch.brand_name) == cand_name.lower(),
                            func.lower(func.trim(BrandSearch.case_id)) == clean_case.lower(),
                        )
                        .first()
                    )
                    if not existing_s:
                        search = self.screening_repo.create_search(cand_name, user_id, case_id=clean_case)
                        cd = cand.get("conflict_details") or {}
                        sr_dict = {
                            "overall_risk_score": cand.get("risk_score", 0.0),
                            "risk_classification": "HIGH" if cand.get("recommendation_status") == "high_risk" else ("MEDIUM" if cand.get("recommendation_status") == "review_required" else "LOW"),
                            "exact_match_score": cd.get("exact_match_score", 0.0),
                            "spelling_similarity_score": cd.get("spelling_similarity_score", 0.0),
                            "phonetic_similarity_score": cd.get("phonetic_similarity_score", 0.0),
                            "semantic_similarity_score": cd.get("semantic_similarity_score", 0.0),
                            "lookalike_score": cd.get("lookalike_score", 0.0),
                            "soundalike_score": 0.0,
                            "trademark_conflict_score": cd.get("trademark_conflict_score", 0.0),
                            "market_presence_score": cd.get("market_presence_score", 0.0),
                            "memorability_score": cand.get("memorability_score"),
                            "pronunciation_score": cand.get("pronunciation_score"),
                            "availability_score": cand.get("availability_score"),
                            "ai_assessment": cand.get("ai_explanation"),
                            "ai_recommendation": "REJECT" if cand.get("recommendation_status") == "high_risk" else ("LEGAL_REVIEW" if cand.get("recommendation_status") == "review_required" else "PROCEED"),
                            "total_conflicts": cd.get("total_conflict_count", 0),
                            "rejection_reason": cd.get("rejection_reason"),
                            "knockout_checks": cd.get("knockout_checks"),
                            "case_context": case_context,
                        }
                        self.screening_repo.save_result(search.id, sr_dict, cd.get("similar_names", []), cd.get("top_conflicts", []))
                        saved_search = self.screening_repo.get_by_search_id(search.id)
                        if saved_search and saved_search.screening_result:
                            saved_search.screening_result.case_context = case_context
                            saved_search.screening_result.knockout_checks = cd.get("knockout_checks")
                            self.db.commit()
                except Exception as e:
                    logger.debug("Failed to link BrandSearch record during generator saving: %s", e)

    async def generate_names_stream(
        self, request, user_id: Optional[uuid.UUID], count: int,
    ) -> AsyncGenerator[str, None]:
        """Asynchronous generator emitting Server-Sent Events (SSE) in NDJSON format
        synchronized with the real-time execution of Stages 1 to 5."""
        def sse_pack(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        pipeline_start = time.monotonic()

        context, existing_brand_names = _build_context(request)
        molecule = context.get("molecule") or ""
        therapeutic_area = context.get("therapy") or context.get("therapeutic_area") or "General Medicine"
        toggles = self.settings_repo.get_data_source_toggles()

        logger.info(
            "[GENERATE NAMES] LLM is generating the names where it have the Naming Style as '%s' and Additional Notes is '%s'",
            context.get("naming_style") or "Not specified",
            context.get("brand_coining_preferences") or "Not specified",
        )

        sf = getattr(request, "suggestion_form", None)
        case_context = {
            "case_id": request.case_id if request.case_id else None,
            "case_name": getattr(request, "case_name", None) or request.case_id,
            "generic_name": molecule,
            "therapy": therapeutic_area,
            "dosage_form": context.get("dosage_form"),
            "dose": context.get("dose"),
            "division": context.get("division"),
            "ailment": context.get("ailment"),
            "segment": context.get("segment"),
            "promoting_indications": context.get("promoting_indications"),
            "domestic_brand_names": sf.brand_information.domestic_brand_names if (sf and hasattr(sf, "brand_information") and sf.brand_information) else None,
            "international_brand_names": sf.brand_information.international_brand_names if (sf and hasattr(sf, "brand_information") and sf.brand_information) else None,
            "innovator_brands": sf.brand_information.innovator_brands if (sf and hasattr(sf, "brand_information") and sf.brand_information) else None,
            "parent_brand_owner": context.get("parent_brand_owner"),
            "naming_information": context.get("naming_information"),
        }

        # --- STAGE 1: Brief & Context Ingestion ---
        yield sse_pack({
            "stage": 1,
            "step_index": 0,
            "percent": 15,
            "status": "in_progress",
            "title": "Brief & Context Ingestion",
            "subtitle": f"Ingesting parameters for {molecule or 'candidate case'} & building reference collision pool...",
        })
        await asyncio.sleep(0.1)

        history_pool = self._load_history_avoid_pool()
        registry_candidate_pool = self._load_registry_candidate_pool()
        legal_decided_lookup = LegalRepository(self.db).get_decided_name_lookup()

        # Stage 3's conflict_pool has no static reference-data source today —
        # the Trademark Registry / Market DB tables were removed (they never
        # had a working import path).
        # history_pool is deliberately excluded too — it's an LLM avoid-hint
        # (see avoid_pool below), not a real trademark/market conflict source.
        # See _load_history_avoid_pool's docstring for why mixing the two
        # caused cross-case false-positive high_risk verdicts. Stage 3 still
        # runs (linguistic validation + the same scoring formula), it simply
        # has nothing to compare against until a real reference dataset
        # exists — Stage 4's live WHO/IQVIA/e-pharmacy/Google checks remain
        # the real gate.
        conflict_pool: List[Dict[str, Optional[str]]] = []

        pool_seen = set()
        deduped_pool = []
        for entry in conflict_pool:
            key = entry["name"].lower()
            if key not in pool_seen:
                pool_seen.add(key)
                deduped_pool.append(entry)
        conflict_pool = deduped_pool

        yield sse_pack({
            "stage": 1,
            "step_index": 0,
            "percent": 25,
            "status": "completed",
            "title": "Brief & Context Ingestion",
            "subtitle": f"Parameters loaded. Referenced {len(conflict_pool):,} trademark & brand entries.",
        })

        # ── STAGES 2–5 run inside an outer loop until `count` low/medium names are found ──
        # Time is NOT a concern; we keep looping until the target is met.
        status_order = {"recommended": 0, "review_required": 1, "high_risk": 2}
        approved_names: List[dict] = []          # low/medium risk names collected so far
        seen_names: set = set()                   # all names ever generated (to avoid duplicates)
        # existing_brand_names (this case's on-file brands) + history_pool
        # (previously-rejected pipeline names, Trademark Review submissions
        # at any status incl. pending, and Review Batch cart names) — all fed
        # to the LLM as "do not generate/resemble these".
        base_avoid_pool = list(existing_brand_names + history_pool)
        avoid_pool_2_rejected_names: List[str] = []
        avoid_pool_2_patterns: set = set()
        cumulative_rejection_feedback: List[Dict[str, Any]] = []
        # Avoid Pool 2 bookkeeping, seeded with Avoid Pool 1 so the two can be
        # prioritised against each other when building the prompt payload. Holds
        # no storage of its own — rejections are persisted below through the
        # existing generated_brand_names table.
        ledger = RejectionLedger(prior_pool=history_pool)
        rejected_for_persist: List[dict] = []
        outer_loop = 0
        total_rejected_count = 0

        logger.info(
            "[GENERATOR PIPELINE INITIALIZED] Molecule: '%s' | Therapy: '%s' | Target Count: %d | Avoid Pool 1 (Base Legal & Cart): %d names (Static) | Registry Candidates: %d",
            molecule, therapeutic_area, count, len(base_avoid_pool), len(registry_candidate_pool)
        )

        # ── Concurrent orchestration ──────────────────────────────────────
        # A producer runs LLM -> deterministic screening -> WHO INN -> IQVIA and
        # pushes survivors onto a bounded e-pharmacy queue; bounded workers drain
        # that queue through e-pharmacy -> Google -> final risk analysis. The
        # producer never waits on e-pharmacy, so LLM batch N+1 overlaps
        # e-pharmacy batch N. Stage ORDER and every screening/scoring/acceptance
        # rule are unchanged — the pipeline calls the same GeneratorService
        # methods this loop used to call inline.
        event_queue: asyncio.Queue = asyncio.Queue()

        async def _emit(ev: dict) -> None:
            await event_queue.put(ev)

        pipeline = ReplenishingGenerationPipeline(
            self, request=request, user_id=user_id, target=count,
            context=context, case_context=case_context, toggles=toggles,
            therapeutic_area=therapeutic_area, molecule=molecule,
            conflict_pool=conflict_pool, base_avoid_pool=base_avoid_pool,
            registry_candidate_pool=registry_candidate_pool,
            legal_decided_lookup=legal_decided_lookup, history_pool=history_pool,
            ledger=ledger, max_batches=_MAX_OUTER_LOOPS,
            max_market_attempts=_MAX_MARKET_ATTEMPTS,
            concurrency=_PARALLEL_SCREENING_CONCURRENCY, emit=_emit,
        )

        async def _runner():
            try:
                return await pipeline.run()
            finally:
                await event_queue.put(PIPELINE_DONE)

        run_task = asyncio.create_task(_runner())
        try:
            while True:
                ev = await event_queue.get()
                if ev is PIPELINE_DONE:
                    break
                yield sse_pack(ev)
            approved_names = await run_task
        except (asyncio.CancelledError, GeneratorExit):
            run_task.cancel()
            raise

        outer_loop = pipeline.metrics.batches
        total_rejected_count = pipeline.total_rejected_count
        rejected_for_persist = pipeline.rejected_for_persist
        logger.info("[PIPELINE METRICS] %s", pipeline.metrics.as_dict())

        # ── End of outer loop ──
        yield sse_pack({
            "stage": 4,
            "step_index": 3,
            "percent": 90,
            "status": "completed",
            "title": "Live E-Pharmacy Market Scraping",
            "subtitle": f"Completed — collected {len(approved_names)} low/medium-risk names across {outer_loop} loop(s).",
            "live_names": [self._serialize_candidate(c) for c in approved_names],
            "approved_count": len(approved_names),
            "target_count": count,
        })

        # --- STAGE 5: Collision Analysis & Ranking Safety ---
        yield sse_pack({
            "stage": 5,
            "step_index": 4,
            "percent": 95,
            "status": "in_progress",
            "title": "Market Collision Analysis & Ranking Safety",
            "subtitle": "Applying final risk stratifications and persisting candidate records...",
        })

        final_candidates = approved_names[:count]
        final_candidates.sort(key=lambda r: (status_order.get(r["recommendation_status"], 3), r["risk_score"]))
        # Persist this run's REJECTED candidates into the same
        # generated_brand_names table, with the recommendation_status
        # ('high_risk') screening already assigned them. This is what
        # BrandRepository.get_high_risk_generated_names reads, and therefore
        # what feeds Avoid Pool 1's "Historical Pipeline Rejections" source on
        # every later request — previously that source was permanently empty
        # because only approved names were ever written, so each new request
        # re-explored naming space this pipeline had already ruled out.
        # No new table, model or persistence mechanism is introduced.
        self._persist_rejected_candidates(rejected_for_persist, history_pool)

        saved = self.brand_repo.save_generated_names(final_candidates)

        # Create audit log record for AI generation
        try:
            from app.repositories.audit import AuditRepository
            case_label = request.case_id or (request.suggestion_form.case_id if request.suggestion_form else None) or molecule or "General Case"
            AuditRepository(self.db).create(
                action="GENERATE_BRAND_NAMES",
                user_id=user_id,
                resource_type="brand_generation",
                resource_id=case_label,
                details=f"Generated {len(saved)} AI brand names for case: {case_label}",
                metadata={"count": len(saved), "case_id": case_label, "molecule": molecule},
                status="success",
            )
        except Exception as e:
            logger.warning("Failed to create audit log for generator stream: %s", e)

        # Off the event loop: this is a synchronous burst of N+1 queries and
        # commits. Only this thread touches the session while it runs.
        await asyncio.to_thread(self._sync_brand_searches, final_candidates, case_context, user_id)

        # Serialize saved database instances
        serialized_output = []
        for s in saved:
            cd = s.conflict_details or {}
            serialized_output.append({
                "id": str(s.id),
                "generated_name": s.generated_name,
                "therapeutic_area": s.therapeutic_area,
                "molecule": s.molecule,
                "risk_score": s.risk_score,
                "availability_score": s.availability_score,
                "memorability_score": s.memorability_score,
                "pronunciation_score": s.pronunciation_score,
                "recommendation_status": s.recommendation_status,
                "trademark_availability": s.trademark_availability,
                "ai_explanation": s.ai_explanation,
                "phonetic_analysis": s.phonetic_analysis,
                "conflict_details": s.conflict_details,
                "loop_approved": cd.get("loop_approved") or getattr(s, "loop_approved", None),
                "rejected_before_count": cd.get("rejected_before_count", 0),
                "time_to_generate_seconds": cd.get("time_to_generate_seconds"),
                "created_at": s.created_at.isoformat() if s.created_at else None,
            })

        yield sse_pack({
            "stage": 5,
            "step_index": 4,
            "percent": 100,
            "status": "completed",
            "title": "Generation Complete",
            "subtitle": f"Generated {len(saved)} low/medium-risk brand names across {outer_loop} iteration(s).",
            "data": serialized_output,
        })

    async def generate_names(self, request, user_id: Optional[uuid.UUID], count: int) -> List[GeneratedBrandName]:
        """Non-streaming generation returning saved GeneratedBrandName list.
        Loops until exactly `count` low/medium-risk names are collected (no time limit)."""
        pipeline_start = time.monotonic()
        context, existing_brand_names = _build_context(request)
        molecule = context.get("molecule") or ""
        therapeutic_area = context.get("therapy") or context.get("therapeutic_area") or "General Medicine"
        toggles = self.settings_repo.get_data_source_toggles()

        logger.info(
            "[GENERATE NAMES] LLM is generating the names where it have the Naming Style as '%s' and Additional Notes is '%s'",
            context.get("naming_style") or "Not specified",
            context.get("brand_coining_preferences") or "Not specified",
        )

        sf = getattr(request, "suggestion_form", None)
        case_context = {
            "case_id": request.case_id if request.case_id else None,
            "case_name": getattr(request, "case_name", None) or request.case_id,
            "generic_name": molecule,
            "therapy": therapeutic_area,
            "dosage_form": context.get("dosage_form"),
            "dose": context.get("dose"),
            "division": context.get("division"),
            "ailment": context.get("ailment"),
            "segment": context.get("segment"),
            "promoting_indications": context.get("promoting_indications"),
            "domestic_brand_names": sf.brand_information.domestic_brand_names if (sf and hasattr(sf, "brand_information") and sf.brand_information) else None,
            "international_brand_names": sf.brand_information.international_brand_names if (sf and hasattr(sf, "brand_information") and sf.brand_information) else None,
            "innovator_brands": sf.brand_information.innovator_brands if (sf and hasattr(sf, "brand_information") and sf.brand_information) else None,
            "parent_brand_owner": context.get("parent_brand_owner"),
            "naming_information": context.get("naming_information"),
        }

        history_pool = self._load_history_avoid_pool()
        registry_candidate_pool = self._load_registry_candidate_pool()
        legal_decided_lookup = LegalRepository(self.db).get_decided_name_lookup()

        # Stage 3's conflict_pool has no static reference-data source today —
        # the Trademark Registry / Market DB tables were removed (they never
        # had a working import path). history_pool is deliberately excluded
        # too — it's an LLM avoid-hint (see avoid_pool below), not a real
        # trademark/market conflict source. See _load_history_avoid_pool's
        # docstring for why mixing the two caused cross-case false-positive
        # high_risk verdicts. Stage 3 still runs (linguistic validation + the
        # same scoring formula), it simply has nothing to compare against
        # until a real reference dataset exists — Stage 4's live
        # WHO/IQVIA/e-pharmacy/Google checks remain the real gate.
        conflict_pool: List[Dict[str, Optional[str]]] = []
        pool_seen: set = set()
        deduped_pool = []
        for entry in conflict_pool:
            key = entry["name"].lower()
            if key not in pool_seen:
                pool_seen.add(key)
                deduped_pool.append(entry)
        conflict_pool = deduped_pool

        status_order = {"recommended": 0, "review_required": 1, "high_risk": 2}
        approved_names: List[dict] = []
        seen_names: set = set()
        base_avoid_pool = list(existing_brand_names + history_pool)
        avoid_pool_2_rejected_names: List[str] = []
        avoid_pool_2_patterns: set = set()
        cumulative_rejection_feedback: List[Dict[str, Any]] = []
        # Avoid Pool 2 bookkeeping, seeded with Avoid Pool 1 so the two can be
        # prioritised against each other when building the prompt payload. Holds
        # no storage of its own — rejections are persisted below through the
        # existing generated_brand_names table.
        ledger = RejectionLedger(prior_pool=history_pool)
        rejected_for_persist: List[dict] = []
        outer_loop = 0
        total_rejected_count = 0

        logger.info(
            "[GENERATE NAMES INITIALIZED] Molecule: '%s' | Therapy: '%s' | Target: %d | Avoid Pool 1 (Base Legal & Cart): %d (Static) | Registry Candidates: %d",
            molecule, therapeutic_area, count, len(base_avoid_pool), len(registry_candidate_pool)
        )

        # ── Concurrent orchestration (same pipeline as the streaming path,
        #    with no SSE emitter) ──
        pipeline = ReplenishingGenerationPipeline(
            self, request=request, user_id=user_id, target=count,
            context=context, case_context=case_context, toggles=toggles,
            therapeutic_area=therapeutic_area, molecule=molecule,
            conflict_pool=conflict_pool, base_avoid_pool=base_avoid_pool,
            registry_candidate_pool=registry_candidate_pool,
            legal_decided_lookup=legal_decided_lookup, history_pool=history_pool,
            ledger=ledger, max_batches=_MAX_OUTER_LOOPS,
            max_market_attempts=_MAX_MARKET_ATTEMPTS,
            concurrency=_PARALLEL_SCREENING_CONCURRENCY, emit=None,
        )
        approved_names = await pipeline.run()
        outer_loop = pipeline.metrics.batches
        total_rejected_count = pipeline.total_rejected_count
        rejected_for_persist = pipeline.rejected_for_persist
        logger.info("[PIPELINE METRICS] %s", pipeline.metrics.as_dict())

        final_candidates = approved_names[:count]
        final_candidates.sort(key=lambda r: (status_order.get(r["recommendation_status"], 3), r["risk_score"]))
        # Persist this run's REJECTED candidates into the same
        # generated_brand_names table, with the recommendation_status
        # ('high_risk') screening already assigned them. This is what
        # BrandRepository.get_high_risk_generated_names reads, and therefore
        # what feeds Avoid Pool 1's "Historical Pipeline Rejections" source on
        # every later request — previously that source was permanently empty
        # because only approved names were ever written, so each new request
        # re-explored naming space this pipeline had already ruled out.
        # No new table, model or persistence mechanism is introduced.
        self._persist_rejected_candidates(rejected_for_persist, history_pool)

        saved = self.brand_repo.save_generated_names(final_candidates)

        # Off the event loop: this is a synchronous burst of N+1 queries and
        # commits. Only this thread touches the session while it runs.
        await asyncio.to_thread(self._sync_brand_searches, final_candidates, case_context, user_id)

        return saved
