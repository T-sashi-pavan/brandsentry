"""Brand Analysis screening pipeline — takes a single candidate brand name
(no molecule/composition required, unlike the AI Name Generator's
generator.py) and runs it through exactly the three checks requested:

  1. WHO INN + IQVIA registry lookup (Tier 1, authoritative):
     - WHO INN — local WhoInnRegistry cache only; empty (or a miss) is
       reported as "not checked", never as clearance, until a bulk import
       populates the local table. An exact INN hit is a knockout.
     - IQVIA — local IqviaExtract table only; empty (reported as "not
       licensed / no data loaded", never as clearance) until a licensed
       extract-import pipeline exists and the client's licence is confirmed.
  2. Google web search (app.services.web_search.search_google).
  3. Live e-pharmacy scrape of 1mg/PharmEasy/Apollo Pharmacy
     (app.services.market_check.scrape_pharmacy_listings — real Playwright
     browser automation; an explicit, already-approved deviation from the
     SDD's "Google Search API only" rule, same as the AI Name Generator).

Every hit is scored deterministically (app.services.screening) and only then
handed to the LLM for a plain-English rationale — the model explains the
evidence, it never invents the verdict. If no LLM is configured or the call
fails, ai_assessment carries a visible "[AI assessment unavailable: ...]"
marker (see ai_service.evaluate_coining_principles_and_assessment) rather
than a fabricated verdict or a silently blank field — this is a production
screening result, not a demo, so a failure must be visible, not hidden.
"""
import asyncio
import logging
import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.cache import cache_service
from app.models.brand import GeneratedBrandName
from app.models.screening import BrandSearch
from app.models.suggestion import BrandSuggestionForm
from app.repositories.screening import ScreeningRepository
from app.repositories.settings import SettingsRepository
from app.services.ai import ai_service
from app.services.market_check import _brand_stub, google_search_configured, scrape_pharmacy_listings
from app.services.screening import (
    IQVIA_GROWTH_REJECT_THRESHOLD,
    IQVIA_SIMILARITY_REJECT_THRESHOLD,
    calculate_mentor_risk_score,
    cosine_similarity,
    evaluate_pharma_knockout_checks,
    fuzzy_similarity,
    grade_name_similarity,
    levenshtein_similarity,
    validate_linguistic_structure,
)

from app.services.web_search import search_google

logger = logging.getLogger(__name__)

_SIMILAR_THRESHOLD = 0.45   # worth surfacing as a "similar name"
_CONFLICT_THRESHOLD = 0.70  # strong enough to count as a live conflict
_STAGE_STOP_THRESHOLD = 0.70
_EVIDENCE_CACHE_TTL = 600   # 10 min — lets an immediately-following /intelligence
                            # call for the same name reuse this run's evidence
                            # instead of re-scraping e-pharmacy sites.
_EMBEDDING_CACHE_TTL = 30 * 24 * 60 * 60  # 30 days — a name's embedding never changes,
                                           # so this is keyed by text, not by search.
# Tier 1 (WHO/IQVIA only) and Tier 2 (all sources) of the generation pipeline both
# call _gather_evidence for the same candidate, under different toggle
# fingerprints, so they never share the evidence cache above — and the WHO and
# IQVIA lookups ran twice per finalist. These memo caches key the RAW lookup
# results on the candidate name alone, so the second pass reuses the first
# pass's rows instead of re-scanning. Same query, same rows, same downstream
# logic; only the duplicate scan disappears. TTL matches the evidence cache, so
# staleness behaviour is unchanged.
_REGISTRY_LOOKUP_CACHE_TTL = _EVIDENCE_CACHE_TTL
# Matches the 30-day TTL the pre-existing (dead) google_conflict cache used.
_GOOGLE_SEARCH_CACHE_TTL = 30 * 24 * 60 * 60

_EPHARMACY_SOURCE_MAP = {
    "1mg": "1mg (India)",
    "PharmEasy": "PharmEasy (India)",
    "Apollo Pharmacy": "Apollo Pharmacy (India)",
    "Netmeds": "Netmeds (India)",
}


def _risk_level(score: float) -> str:
    if score >= 0.70:
        return "HIGH"
    if score >= 0.40:
        return "MEDIUM"
    return "LOW"


def _is_exact(name: str, candidate: str) -> bool:
    return name.strip().lower() == candidate.strip().lower()


# The pipeline's 3 real stages, in the order they're actually checked — WHO
# INN + IQVIA are grouped into one "Tier 1" stage since both are cheap local
# registry lookups already gathered together (see module docstring); the
# two expensive/external stages (a live e-pharmacy scrape, a Google API
# call) only run if Tier 1 came back clean, so a name that's already
# rejected on the registries never pays for either.
STAGE_NAMES = {
    1: "WHO INN Check",
    2: "IQVIA Database",
    3: "E-Pharmacy Platforms",
    4: "Google Search",
}


def _stage_conflict(name: str, hits: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The strongest conflict-level hit within one stage's evidence, or None
    if that stage is clean. Used by every stage EXCEPT IQVIA (see
    BrandScreeningService._iqvia_stage_conflict for that one's own,
    mentor-specified rejection logic). Two ways a stage can stop the pipeline:
      1. An EXACT match against any hit in this stage (same name found
         verbatim in WHO/e-pharmacy/web) — an automatic reject regardless of
         similarity score, since it's not a "similarity" at all, it's the
         same name.
      2. Universal grading (Spelling / Phonetic / Visual, independently
         scored — see grade_name_similarity) with ANY parameter at or above
         _STAGE_STOP_THRESHOLD (70%) against any hit in this stage. No
         blended composite: a strong hit on one parameter isn't diluted by
         averaging it against a clean score on another.
    Anything weaker still feeds the final holistic _score() (which keeps
    using the older _CONFLICT_THRESHOLD bar) but doesn't halt the pipeline.
    """
    for hit in hits:
        candidate = (hit.get("name") or "").strip()
        if candidate and _is_exact(name, candidate):
            return {**hit, "similarity_score": 1.0, "exact": True}

    best, best_score, best_param = None, 0.0, None
    for hit in hits:
        candidate = (hit.get("name") or "").strip()
        if not candidate:
            continue
        grades = grade_name_similarity(name, candidate)
        local_param = max(grades, key=grades.get)
        local_score = grades[local_param]
        if local_score > best_score:
            best_score, best, best_param = local_score, hit, local_param
    if best and best_score >= _STAGE_STOP_THRESHOLD:
        return {**best, "similarity_score": round(best_score, 3), "exact": False, "matched_parameter": best_param}
    return None


def _epharmacy_stage_conflict(name: str, hits: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """E-pharmacy specific conflict detection for Stage 3.

    Live retail e-pharmacies (PharmEasy, 1mg, Apollo) return noisy search suggestions
    when an invented neologism is not in inventory. To prevent false-positive pipeline
    knockouts on loose retail auto-complete overlaps (e.g. 'Kavrelis' vs 'Karela' juice, or 'Ranx' with 33% spelling):
      1. Verbatim exact match -> automatic knockout (1.0).
      2. Strong spelling match (>= 0.85, aligned with IQVIA reject threshold) -> knockout.
      3. Strong dual match: spelling >= 0.70 AND phonetic >= 0.85 -> knockout.
      4. Strong visual lookalike: spelling >= 0.75 AND visual >= 0.85 -> knockout.
    Weaker overlaps do not halt the pipeline at Stage 3; they pass through to holistic
    _score() where they contribute proportionally to the overall risk score.
    """
    for hit in hits:
        candidate = (hit.get("name") or "").strip()
        if candidate and _is_exact(name, candidate):
            return {**hit, "similarity_score": 1.0, "exact": True}

    best, best_score, best_param = None, 0.0, None
    for hit in hits:
        candidate = (hit.get("name") or "").strip()
        if not candidate:
            continue
        grades = grade_name_similarity(name, candidate)
        spelling = grades.get("spelling", 0.0)
        phonetic = grades.get("phonetic", 0.0)
        visual = grades.get("visual", 0.0)

        # Require authentic trademark/market collision rather than loose retail auto-complete noise
        is_conflict = (
            spelling >= 0.85
            or (spelling >= 0.70 and phonetic >= 0.85)
            or (spelling >= 0.75 and visual >= 0.85)
        )
        if is_conflict:
            local_score = max(spelling, phonetic, visual)
            local_param = max(grades, key=grades.get)
            if local_score > best_score:
                best_score, best, best_param = local_score, hit, local_param

    if best and best_score >= 0.80:
        return {**best, "similarity_score": round(best_score, 3), "exact": False, "matched_parameter": best_param}
    return None


def calculate_source_confidence_and_score(similarities: List[float], max_weight: float) -> tuple[float, float, List[float]]:
    """
    Computes normalized source confidence and weighted score using top-3 weighting:
      - If 3+ matches: 70% * Top1 + 20% * Top2 + 10% * Top3
      - If 2 matches:  (0.70/0.90) * Top1 + (0.20/0.90) * Top2
      - If 1 match:    1.0 * Top1
      - If 0 matches:  0.0
    Returns (confidence_pct, weighted_score, top_matches_pct).
    """
    if not similarities:
        return 0.0, 0.0, []

    sorted_sims = sorted(similarities, reverse=True)
    m1 = sorted_sims[0]

    if len(sorted_sims) == 1:
        confidence = m1
        top_matches = [round(m1 * 100, 1)]
    elif len(sorted_sims) == 2:
        m2 = sorted_sims[1]
        w1 = 0.70 / 0.90
        w2 = 0.20 / 0.90
        confidence = (w1 * m1) + (w2 * m2)
        top_matches = [round(m1 * 100, 1), round(m2 * 100, 1)]
    else:
        m2 = sorted_sims[1]
        m3 = sorted_sims[2]
        confidence = (0.70 * m1) + (0.20 * m2) + (0.10 * m3)
        top_matches = [round(m1 * 100, 1), round(m2 * 100, 1), round(m3 * 100, 1)]

    confidence = min(max(confidence, 0.0), 1.0)
    weighted_score = round(confidence * max_weight, 2)
    return round(confidence * 100.0, 1), weighted_score, top_matches


class BrandScreeningService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = ScreeningRepository(db)
        self.settings_repo = SettingsRepository(db)

    # ------------------------------------------------------------------
    # IQVIA — dedicated rejection logic (mentor-updated spec)
    # ------------------------------------------------------------------

    async def _iqvia_stage_conflict(
        self, name: str, iqvia_hits: List[Dict[str, Any]],
    ) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        """IQVIA-specific rejection logic — distinct from _stage_conflict
        (used by every other stage). Per the mentor-updated spec:

          Step 1 — Exact name match against BRAND_IMS -> REJECT.
          Step 2 — Grade Phonetic / Spelling / Conceptual similarity
                    (Visual/look-alike is deliberately excluded here) against
                    every IQVIA hit. ANY parameter >= 85% -> REJECT.
          Step 3 — Otherwise, look at the closest (highest-scoring, still
                    sub-85%) match's commercial growth: VAL_GR_PCT / UN_GR_PCT.
                    Either > 50% -> REJECT.
          Step 4 — If both growth figures are blank/NULL for that record,
                    don't reject on growth — flag for User Review instead
                    (with a note the UI can surface verbatim), same as
                    reaching the end of the flow clean: IQVIA never yields an
                    automatic "PROCEED", only REJECT or USER REVIEW.

        Conceptual similarity here is a REAL embedding-based cosine score
        (via self._semantic_scores — the same Bedrock Titan embeddings
        already used for the final holistic Brand Analysis score), not the
        cheap proxy some other call sites use — worth the extra embedding
        call at this gate since the mentor spec treats it as a first-class
        rejection parameter, not just a display metric.

        Returns (conflict_dict_or_None, review_note_dict_or_None) — at most
        one of the two is ever set.
        """
        for hit in iqvia_hits:
            candidate = (hit.get("name") or "").strip()
            if candidate and _is_exact(name, candidate):
                return {
                    **hit, "similarity_score": 1.0, "exact": True,
                    "reject_reason": "Exact IQVIA BRAND_IMS match.",
                }, None

        if not iqvia_hits:
            return None, None

        candidate_names = [(h.get("name") or "").strip() for h in iqvia_hits if (h.get("name") or "").strip()]
        semantic_scores = await self._semantic_scores(name, candidate_names)

        best_hit: Optional[Dict[str, Any]] = None
        best_param: Optional[str] = None
        best_score = 0.0
        for hit in iqvia_hits:
            candidate = (hit.get("name") or "").strip()
            if not candidate:
                continue
            grades = grade_name_similarity(name, candidate)
            conceptual = semantic_scores.get(candidate.lower(), 0.0)
            params = {"spelling": grades["spelling"], "phonetic": grades["phonetic"], "conceptual": conceptual}
            local_param = max(params, key=params.get)
            local_score = params[local_param]
            if local_score > best_score:
                best_score, best_param, best_hit = local_score, local_param, hit

        if best_hit is None:
            return None, None

        if best_score >= IQVIA_SIMILARITY_REJECT_THRESHOLD:
            return {
                **best_hit, "similarity_score": round(best_score, 3), "exact": False,
                "matched_parameter": best_param,
                "reject_reason": (
                    f"{best_param.capitalize()} similarity {round(best_score * 100)}% "
                    f">= {round(IQVIA_SIMILARITY_REJECT_THRESHOLD * 100)}% threshold."
                ),
            }, None

        # If the closest match is below the similarity conflict threshold (0.65),
        # there is no credible trademark/LASA overlap — the candidate clears IQVIA cleanly as LOW risk.
        if best_score < 0.65:
            return None, None

        # Borderline similarity range (0.65 <= best_score < 0.85) — evaluate commercial growth
        val_gr = best_hit.get("val_gr_pct")
        un_gr = best_hit.get("un_gr_pct")
        matched_name = best_hit.get("name")

        if val_gr is None and un_gr is None:
            return None, {
                "matched_name": matched_name, "source": best_hit.get("source"),
                "owner": best_hit.get("owner"), "molecules": best_hit.get("molecules"),
                "similarity_score": round(best_score, 3), "matched_parameter": best_param,
                "note": (
                    f"Skipped Commercial Growth Check for '{matched_name}' "
                    f"(Mfr: {best_hit.get('owner') or 'Unknown'}) — both VAL_GR_PCT "
                    "and UN_GR_PCT are blank/NULL for this IQVIA record. Sent for User Review "
                    "rather than auto-rejected or auto-cleared."
                ),
            }

        val_gr = val_gr or 0.0
        un_gr = un_gr or 0.0
        if val_gr > IQVIA_GROWTH_REJECT_THRESHOLD or un_gr > IQVIA_GROWTH_REJECT_THRESHOLD:
            driver = "VAL_GR_PCT" if val_gr >= un_gr else "UN_GR_PCT"
            driver_value = max(val_gr, un_gr)
            return {
                **best_hit, "similarity_score": round(best_score, 3), "exact": False,
                "matched_parameter": best_param,
                "reject_reason": (
                    f"Commercial growth check: {driver}={round(driver_value, 1)}% exceeds the "
                    f"{round(IQVIA_GROWTH_REJECT_THRESHOLD)}% threshold for closest match '{matched_name}' "
                    f"({round(best_score * 100)}% {best_param} similarity, below the reject bar)."
                ),
            }, None

        return None, {
            "matched_name": matched_name, "source": best_hit.get("source"),
            "owner": best_hit.get("owner"), "molecules": best_hit.get("molecules"),
            "similarity_score": round(best_score, 3), "matched_parameter": best_param,
            "note": (
                f"'{name}' is within similarity range of '{matched_name}' "
                f"(Mfr: {best_hit.get('owner') or 'Unknown'}) — {round(best_score * 100)}% {best_param}, "
                f"below the {round(IQVIA_SIMILARITY_REJECT_THRESHOLD * 100)}% reject bar. Commercial "
                f"growth (VAL_GR_PCT={round(val_gr, 1)}%, UN_GR_PCT={round(un_gr, 1)}%) is under the "
                f"{round(IQVIA_GROWTH_REJECT_THRESHOLD)}% threshold. Sent for User Review."
            ),
        }

    def _iqvia_lookup_sync(self, name: str):
        """The two IQVIA reads as one blocking unit, so a single to_thread hop
        covers both and the Session is only ever touched by one thread at a
        time. Queries, arguments and return values are unchanged."""
        return (
            self.repo.find_iqvia_local(name, active_only=True),
            self.repo.has_active_iqvia_rows(),
        )

    # ------------------------------------------------------------------
    # Evidence gathering — every source, raw and unscored
    # ------------------------------------------------------------------

    async def _gather_evidence(
        self, name: str, toggles: Optional[Dict[str, bool]] = None,
    ) -> Dict[str, Any]:
        if toggles is None:
            toggles = self.settings_repo.get_data_source_toggles()
        # Toggle state is folded into the cache key so an admin disabling a
        # source takes effect on the very next screen, instead of waiting
        # out a stale 10-minute cache entry gathered under the old setting.
        toggle_fingerprint = "".join("1" if toggles.get(k) else "0" for k in (
            "who_inn_enabled", "iqvia_enabled", "epharmacy_enabled", "google_search_enabled",
        ))
        cache_key = f"screening_evidence:{name.lower()}:{toggle_fingerprint}"
        cached = cache_service.get_json(cache_key)
        if cached is not None:
            logger.info("[CACHE HIT] Reusing screening evidence for %r", name)
            return cached

        logger.info("================================================================================")
        logger.info("[BRAND ANALYSIS PIPELINE START] %r", name)

        # --- Stage 0: Linguistic Structure & Pronounceability Knockout ---
        is_valid_ling, ling_reason = validate_linguistic_structure(name)
        if not is_valid_ling:
            logger.info('[PIPELINE STOPPED] %r rejected on Linguistic Structure: %s', name, ling_reason)
            stopped_conflict = {
                "name": name,
                "conflicting_name": name,
                "source": "Linguistic & Phonotactic Rules (FDA/CDSCO)",
                "conflict_type": "LINGUISTIC_KNOCKOUT",
                "similarity_score": 1.0,
                "severity": "HIGH",
                "details": ling_reason,
            }
            evidence = {
                "who_hits": [], "who_inn_enabled": toggles.get("who_inn_enabled", True),
                "iqvia_hits": [], "iqvia_licensed": False, "iqvia_enabled": toggles.get("iqvia_enabled", True),
                "web_hits": [], "web_configured": google_search_configured(), "google_search_enabled": toggles.get("google_search_enabled", True),
                "epharmacy_hits": [], "epharmacy_checked": False, "epharmacy_enabled": toggles.get("epharmacy_enabled", True),
                "stopped_at_stage": 1, "stopped_stage_name": "Linguistic & Pronounceability Check",
                "stopped_conflict": stopped_conflict, "stages_completed": 1,
                "is_linguistic_knockout": True, "rejection_reason": ling_reason,
            }
            cache_service.set_json(cache_key, evidence, ttl_seconds=_EVIDENCE_CACHE_TTL)
            return evidence

        # --- Step 1: WHO INN Registry Check ---
        logger.info("[STEP 1] WHO INN registry check...")
        who_hits: List[Dict[str, Any]] = []
        if toggles.get("who_inn_enabled", True):
            who_cache_key = f"who_lookup:v1:{name.strip().lower()}"
            who_hits = cache_service.get_json(who_cache_key)
            if who_hits is None:
                local_who = await asyncio.to_thread(self.repo.find_who_inn_local, name)
                who_hits = [
                    {
                        "name": w.inn_name,
                        "source": "WHO INN",
                        "owner": "WHO INN Registry",
                        "knockout": _is_exact(name, w.inn_name) or _is_exact(name, w.normalized_name),
                    }
                    for w in local_who
                ]
                cache_service.set_json(who_cache_key, who_hits, ttl_seconds=_REGISTRY_LOOKUP_CACHE_TTL)
            else:
                logger.debug("[STEP 1] WHO INN lookup served from memo for %r", name)
        else:
            logger.info("[STEP 1] WHO INN check disabled by admin — skipped")

        # Stage 1 gate: WHO INN
        stage1_conflict = _stage_conflict(name, who_hits)
        if stage1_conflict:
            logger.info(
                '[PIPELINE STOPPED] %r rejected at Stage 1 (%s) — matched %r via %s (%.0f%%). '
                "Skipping later stages.",
                name, STAGE_NAMES[1], stage1_conflict["name"], stage1_conflict["source"],
                stage1_conflict["similarity_score"] * 100,
            )
            evidence = {
                "who_hits": who_hits, "who_inn_enabled": toggles.get("who_inn_enabled", True),
                "iqvia_hits": [], "iqvia_licensed": False,
                "iqvia_enabled": toggles.get("iqvia_enabled", True),
                "web_hits": [], "web_configured": google_search_configured(),
                "google_search_enabled": toggles.get("google_search_enabled", True),
                "epharmacy_hits": [], "epharmacy_checked": False,
                "epharmacy_enabled": toggles.get("epharmacy_enabled", True),
                "stopped_at_stage": 1, "stopped_stage_name": STAGE_NAMES[1],
                "stopped_conflict": stage1_conflict, "stages_completed": 1,
            }
            cache_service.set_json(cache_key, evidence, ttl_seconds=_EVIDENCE_CACHE_TTL)
            return evidence

        # --- Step 2: IQVIA Database Check ---
        logger.info("[STEP 2] IQVIA Database check...")
        iqvia_hits: List[Dict[str, Any]] = []
        iqvia_licensed = False
        if toggles.get("iqvia_enabled", True):
            iqvia_cache_key = f"iqvia_lookup:v1:{name.strip().lower()}"
            _cached_iqvia = cache_service.get_json(iqvia_cache_key)
            if _cached_iqvia is not None:
                iqvia_hits, iqvia_licensed = _cached_iqvia["hits"], _cached_iqvia["licensed"]
                local_iqvia = []
                logger.debug("[STEP 2] IQVIA lookup served from memo for %r", name)
            else:
                local_iqvia, iqvia_licensed = await asyncio.to_thread(
                    self._iqvia_lookup_sync, name
                )
            for i in local_iqvia:
                iqvia_hits.append({
                    "name": i.brand_ims,
                    "source": "IQVIA Database",
                    "owner": i.company,
                    "molecules": i.molecules,
                    "atc_iv": i.atc_iv,
                    "val_mat_current": i.val_mat_current,
                    "val_mat_prev": i.val_mat_prev,
                    "val_gr_pct": i.val_gr_pct,
                    "un_mat_current": i.un_mat_current,
                    "un_mat_prev": i.un_mat_prev,
                    "un_gr_pct": i.un_gr_pct,
                    "product_launch": i.product_launch,
                })
            if _cached_iqvia is None:
                cache_service.set_json(
                    iqvia_cache_key,
                    {"hits": iqvia_hits, "licensed": iqvia_licensed},
                    ttl_seconds=_REGISTRY_LOOKUP_CACHE_TTL,
                )
        else:
            logger.info("[STEP 2] IQVIA check disabled by admin — skipped")

        # Stage 2 gate: IQVIA — mentor-specified logic, distinct from every
        # other stage (see _iqvia_stage_conflict): exact match -> Phonetic/
        # Spelling/Conceptual grading >=85% -> commercial-growth check on the
        # closest sub-85% match -> User Review (never an automatic clean pass).
        stage2_conflict, iqvia_review_note = await self._iqvia_stage_conflict(name, iqvia_hits)
        if stage2_conflict:
            logger.info(
                '[PIPELINE STOPPED] %r rejected at Stage 2 (%s) — matched %r via %s (%.0f%%). '
                "%s Skipping later stages.",
                name, STAGE_NAMES[2], stage2_conflict["name"], stage2_conflict["source"],
                stage2_conflict["similarity_score"] * 100, stage2_conflict.get("reject_reason", ""),
            )
            evidence = {
                "who_hits": who_hits, "who_inn_enabled": toggles.get("who_inn_enabled", True),
                "iqvia_hits": iqvia_hits, "iqvia_licensed": iqvia_licensed,
                "iqvia_enabled": toggles.get("iqvia_enabled", True),
                "web_hits": [], "web_configured": google_search_configured(),
                "google_search_enabled": toggles.get("google_search_enabled", True),
                "epharmacy_hits": [], "epharmacy_checked": False,
                "epharmacy_enabled": toggles.get("epharmacy_enabled", True),
                "stopped_at_stage": 2, "stopped_stage_name": STAGE_NAMES[2],
                "stopped_conflict": stage2_conflict, "stages_completed": 2,
            }
            cache_service.set_json(cache_key, evidence, ttl_seconds=_EVIDENCE_CACHE_TTL)
            return evidence
        if iqvia_review_note:
            logger.info(
                "[STEP 2] IQVIA: not rejected, but flagged for User Review — %s",
                iqvia_review_note.get("note", ""),
            )

        # Complete database transaction and return connection to pool before live network scrapes
        if hasattr(self.db, "close"):
            try:
                self.db.close()
            except Exception:
                pass

        # --- Step 3: live e-pharmacy scrape (1mg / PharmEasy / Apollo / Netmeds) ---
        epharmacy_hits: List[Dict[str, Any]] = []
        epharmacy_ok = False
        epharmacy_enabled = toggles.get("epharmacy_enabled", True)
        if epharmacy_enabled:
            logger.info("[STEP 3] Live e-pharmacy scrape (1mg/PharmEasy/Apollo/Netmeds), queried by brand name...")
            listings, epharmacy_ok = await scrape_pharmacy_listings(name)
            epharmacy_hits = []
            for l in listings:
                src_val = l.get("source", "")
                parts = [p.strip() for p in src_val.split(",") if p.strip()]
                mapped_parts = [_EPHARMACY_SOURCE_MAP.get(p, f"{p} (India)" if "India" not in p else p) for p in parts]
                formatted_src = ", ".join(mapped_parts) if mapped_parts else "E-Pharmacy (India)"
                epharmacy_hits.append({
                    "name": l["brand_name"],
                    "source": formatted_src,
                    "owner": l.get("manufacturer"),
                })
        else:
            logger.info("[STEP 3] E-pharmacy scrape disabled by admin — skipped")

        # Stage 3 gate: E-Pharmacy
        stage3_conflict = _epharmacy_stage_conflict(name, epharmacy_hits)
        if stage3_conflict:
            logger.info(
                '[PIPELINE STOPPED] %r rejected at Stage 3 (%s) — matched %r via %s (%.0f%%). '
                "Skipping Google search.",
                name, STAGE_NAMES[3], stage3_conflict["name"], stage3_conflict["source"],
                stage3_conflict["similarity_score"] * 100,
            )
            evidence = {
                "who_hits": who_hits, "who_inn_enabled": toggles.get("who_inn_enabled", True),
                "iqvia_hits": iqvia_hits, "iqvia_licensed": iqvia_licensed,
                "iqvia_enabled": toggles.get("iqvia_enabled", True),
                "web_hits": [], "web_configured": google_search_configured(),
                "google_search_enabled": toggles.get("google_search_enabled", True),
                "epharmacy_hits": epharmacy_hits, "epharmacy_checked": epharmacy_ok,
                "epharmacy_enabled": epharmacy_enabled,
                "stopped_at_stage": 3, "stopped_stage_name": STAGE_NAMES[3],
                "stopped_conflict": stage3_conflict, "stages_completed": 3,
                "iqvia_review_note": iqvia_review_note,
            }
            if epharmacy_ok or not epharmacy_enabled:
                cache_service.set_json(cache_key, evidence, ttl_seconds=_EVIDENCE_CACHE_TTL)
            return evidence

        # --- Step 4: Google web search ---
        web_hits: List[Dict[str, Any]] = []
        web_configured = google_search_configured()
        if toggles.get("google_search_enabled", True):
            logger.info("[STEP 4] Google web search...")
            gq = f'"{name}" pharmaceutical OR medicine OR brand OR drug'
            # A negative-result cache already existed in market_check.find_google_conflict
            # but that function is dead code, so this live path repeated the same
            # search every time. Cache the RAW results (including the empty list,
            # which is the common case for a coined name) keyed by the exact query
            # string. Query text, result interpretation and rejection criteria are
            # untouched. A FAILED search is never cached — an exception still means
            # "not checked", never "clean".
            gkey = f"google_search:v1:{gq}"
            web_results = cache_service.get_json(gkey)
            if web_results is None:
                try:
                    web_results = await search_google(gq, pages=1)
                    cache_service.set_json(gkey, web_results, ttl_seconds=_GOOGLE_SEARCH_CACHE_TTL)
                except Exception:
                    logger.exception("Google web search failed for %r", name)
                    web_results = []
            else:
                logger.debug("[STEP 4] Google results served from cache for %r", name)
            for item in web_results:
                stub = _brand_stub(item.get("title", ""))
                if stub:
                    web_hits.append({"name": stub, "source": "Web Search (Google)", "owner": item.get("link")})
        else:
            logger.info("[STEP 4] Google web search disabled by admin — skipped")

        stage4_conflict = _stage_conflict(name, web_hits)
        evidence = {
            "who_hits": who_hits,
            "who_inn_enabled": toggles.get("who_inn_enabled", True),
            "iqvia_hits": iqvia_hits,
            "iqvia_licensed": iqvia_licensed,
            "iqvia_enabled": toggles.get("iqvia_enabled", True),
            "web_hits": web_hits,
            "web_configured": web_configured,
            "google_search_enabled": toggles.get("google_search_enabled", True),
            "epharmacy_hits": epharmacy_hits,
            "epharmacy_checked": epharmacy_ok,
            "epharmacy_enabled": epharmacy_enabled,
            "stopped_at_stage": 4 if stage4_conflict else None,
            "stopped_stage_name": STAGE_NAMES[4] if stage4_conflict else None,
            "stopped_conflict": stage4_conflict,
            "stages_completed": 4,
            "iqvia_review_note": iqvia_review_note,
        }
        if stage4_conflict:
            logger.info(
                '[PIPELINE STOPPED] %r rejected at Stage 4 (%s) — matched %r via %s (%.0f%%).',
                name, STAGE_NAMES[4], stage4_conflict["name"], stage4_conflict["source"],
                stage4_conflict["similarity_score"] * 100,
            )
        # Only cache a fully-completed gather — caching a failed scrape would
        # freeze that failure as "not checked" for the whole TTL window
        # instead of letting the next request retry it. A disabled source
        # counts as "complete" (nothing to retry), so it's still cached.
        if epharmacy_ok or not epharmacy_enabled:
            cache_service.set_json(cache_key, evidence, ttl_seconds=_EVIDENCE_CACHE_TTL)
        logger.info(
            "[TIER SUMMARY] WHO:%d(enabled=%s) IQVIA:%d(enabled=%s,licensed=%s) "
            "WEB:%d(enabled=%s,configured=%s) EPHARMACY:%d(enabled=%s,ok=%s)",
            len(who_hits), toggles.get("who_inn_enabled", True),
            len(iqvia_hits), toggles.get("iqvia_enabled", True), iqvia_licensed,
            len(web_hits), toggles.get("google_search_enabled", True), web_configured,
            len(epharmacy_hits), epharmacy_enabled, epharmacy_ok,
        )
        return evidence

    # ------------------------------------------------------------------
    # Deterministic scoring
    # ------------------------------------------------------------------

    @staticmethod
    def _build_pool(evidence: Dict[str, Any]) -> List[Dict[str, Any]]:
        pool: List[Dict[str, Any]] = []
        for tier, key in (
            ("who", "who_hits"), ("iqvia", "iqvia_hits"), ("web", "web_hits"), ("epharmacy", "epharmacy_hits"),
        ):
            for h in evidence[key]:
                pool.append({**h, "tier": tier})

        seen, deduped = set(), []
        for h in pool:
            key2 = (h["name"].strip().lower(), h["source"])
            if key2 in seen:
                continue
            seen.add(key2)
            deduped.append(h)
        return deduped

    async def _semantic_scores(self, name: str, candidates: List[str]) -> Dict[str, float]:
        """Cosine similarity between `name`'s embedding and each candidate's,
        keyed by the candidate's lowercased text. Embeddings are cached by
        text (see _EMBEDDING_CACHE_TTL) since the same market/registry names
        recur across screenings. Returns an empty dict — never a fabricated
        0.0 per candidate — when the Bedrock Claude client isn't configured, so
        classify_similarity_types simply skips the Semantic dimension
        instead of asserting "not similar"."""
        if not ai_service.is_configured():
            return {}

        texts_by_key: Dict[str, str] = {name.strip().lower(): name.strip()}
        for c in candidates:
            if c and c.strip():
                texts_by_key.setdefault(c.strip().lower(), c.strip())

        embeddings: Dict[str, List[float]] = {}
        missing_keys: List[str] = []
        for key, text in texts_by_key.items():
            cached = cache_service.get_json(f"embedding:v1:{key}")
            if cached is not None:
                embeddings[key] = cached
            else:
                missing_keys.append(key)

        if missing_keys:
            fresh = await ai_service.get_embeddings([texts_by_key[k] for k in missing_keys])
            if fresh:
                for key in missing_keys:
                    vec = fresh.get(texts_by_key[key])
                    if vec is not None:
                        embeddings[key] = vec
                        cache_service.set_json(f"embedding:v1:{key}", vec, ttl_seconds=_EMBEDDING_CACHE_TTL)

        anchor = embeddings.get(name.strip().lower())
        if anchor is None:
            return {}
        return {
            key: cosine_similarity(anchor, embeddings[key])
            for key in texts_by_key
            if key in embeddings and key != name.strip().lower()
        }

    async def _score(
        self,
        name: str,
        evidence: Dict[str, Any],
        case_context: Optional[Dict[str, Any]] = None,
    ) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
        # Fast path for linguistic structure & pronounceability knockout (e.g. keyboard mashes)
        if evidence.get("is_linguistic_knockout"):
            stopped = evidence.get("stopped_conflict")
            conflicts = [stopped] if stopped else []
            scores = {
                "overall_risk_score": 100.0,
                "risk_classification": "HIGH",
                "ai_recommendation": "REJECT",
                "exact_match_score": 0.0,
                "spelling_similarity_score": 0.0,
                "phonetic_similarity_score": 0.0,
                "semantic_similarity_score": 0.0,
                "lookalike_score": 0.0,
                "soundalike_score": 0.0,
                "trademark_conflict_score": 0.0,
                "market_presence_score": 0.0,
                "total_conflicts": 1,
                "trademark_conflicts": 0,
                "market_conflicts": 0,
                "epharmacy_conflicts": 0,
            }
            return [], conflicts, scores

        pool = self._build_pool(evidence)
        similar_names: List[Dict[str, Any]] = []
        conflicts: List[Dict[str, Any]] = []

        max_lev = 0.0
        max_phon = 0.0
        max_look = 0.0
        max_semantic = 0.0
        max_who_comp = 0.0
        any_exact = False

        # If case context has existing brands on record for this composition, check against them:
        if case_context:
            for field, label in (
                ("domestic_brand_names", "Domestic Brand (existing)"),
                ("international_brand_names", "International Brand (existing)"),
                ("innovator_brands", "Innovator Brand (existing)"),
            ):
                raw = case_context.get(field) or ""
                for chunk in re.split(r"[,;]", raw):
                    c_name = chunk.strip()
                    if not c_name or len(c_name) < 2:
                        continue
                    c_grades = grade_name_similarity(name, c_name)
                    c_comp = max(c_grades.values())
                    c_exact = _is_exact(name, c_name)
                    if c_exact or c_comp >= _CONFLICT_THRESHOLD:
                        conflicts.append({
                            "conflicting_name": c_name,
                            "conflict_type": "EXACT_MARKET_MATCH" if c_exact else "CASE_COMPOSITION_CONFLICT",
                            "source": f"{label} on Case File",
                            "severity": "HIGH" if (c_exact or c_comp >= 0.70) else "MEDIUM",
                            "details": f'"{c_name}" is an existing on-record brand for this case composition ({case_context.get("generic_name", "active molecule")}), exhibiting {round(c_comp * 100)}% similarity.',
                            "owner": case_context.get("parent_brand_owner") or "On-Record Marketer",
                        })

        # Dictionaries of unique matches per source/platform (candidate_lower -> max similarity float)
        who_matches_dict: Dict[str, float] = {}
        iqvia_matches_dict: Dict[str, float] = {}
        pharmeasy_matches_dict: Dict[str, float] = {}
        netmeds_matches_dict: Dict[str, float] = {}
        onemg_matches_dict: Dict[str, float] = {}
        apollo_matches_dict: Dict[str, float] = {}
        google_matches_dict: Dict[str, float] = {}

        semantic_candidates = [h["name"] for h in pool if h.get("tier") != "epharmacy"]
        semantic_scores = await self._semantic_scores(name, semantic_candidates) if semantic_candidates else {}

        for hit in pool:
            candidate = hit["name"]
            if not candidate or not candidate.strip():
                continue

            cand_lower = candidate.strip().lower()
            src_lower = (hit.get("source") or "").lower()
            tier = hit.get("tier")
            who_knockout = tier == "who" and hit.get("knockout")
            grades = grade_name_similarity(name, candidate)
            lev = levenshtein_similarity(name, candidate)
            fuz = fuzzy_similarity(name, candidate)
            phon = grades["phonetic"]
            look = grades["visual"]
            exact = _is_exact(name, candidate)

            if tier == "epharmacy":
                # For third-party retail e-pharmacy catalog items, match is purely orthographic,
                # phonetic, visual LASA, or exact match. Embedding cosine must NOT falsely
                # inflate loose retailer search suggestions into 85%+ collisions.
                semantic = 0.0
                comp = 1.0 if exact else max(grades["spelling"], phon, look)
                is_epharmacy_loose = (not exact and comp < _CONFLICT_THRESHOLD)
            else:
                semantic = semantic_scores.get(cand_lower, 0.0)
                comp = 1.0 if exact else max(grades["spelling"], phon, look, semantic)
                is_epharmacy_loose = False

            # Collect unique similarity scores per portal/platform ONLY for genuine matches
            if not is_epharmacy_loose:
                if tier == "who" or "who" in src_lower:
                    who_matches_dict[cand_lower] = max(who_matches_dict.get(cand_lower, 0.0), comp)
                elif tier == "iqvia" or "iqvia" in src_lower:
                    iqvia_matches_dict[cand_lower] = max(iqvia_matches_dict.get(cand_lower, 0.0), comp)
                elif tier == "web" or "google" in src_lower:
                    google_matches_dict[cand_lower] = max(google_matches_dict.get(cand_lower, 0.0), comp)
                elif tier == "epharmacy" or any(k in src_lower for k in ("pharmeasy", "netmeds", "1mg", "apollo", "pharmacy")):
                    matched_portal = False
                    if "pharmeasy" in src_lower:
                        pharmeasy_matches_dict[cand_lower] = max(pharmeasy_matches_dict.get(cand_lower, 0.0), comp)
                        matched_portal = True
                    if "netmeds" in src_lower:
                        netmeds_matches_dict[cand_lower] = max(netmeds_matches_dict.get(cand_lower, 0.0), comp)
                        matched_portal = True
                    if "1mg" in src_lower:
                        onemg_matches_dict[cand_lower] = max(onemg_matches_dict.get(cand_lower, 0.0), comp)
                        matched_portal = True
                    if "apollo" in src_lower:
                        apollo_matches_dict[cand_lower] = max(apollo_matches_dict.get(cand_lower, 0.0), comp)
                        matched_portal = True
                    if not matched_portal:
                        pharmeasy_matches_dict[cand_lower] = max(pharmeasy_matches_dict.get(cand_lower, 0.0), comp)

                max_lev = max(max_lev, max(lev, fuz))
                max_phon = max(max_phon, phon)
                max_look = max(max_look, look)
                max_semantic = max(max_semantic, semantic)

            if hit["tier"] == "who":
                max_who_comp = max(max_who_comp, comp)
            if exact:
                any_exact = True

            if who_knockout:
                conflicts.append({
                    "conflicting_name": candidate, "conflict_type": "INN_KNOCKOUT",
                    "source": hit["source"], "severity": "HIGH",
                    "details": f'"{candidate}" is a registered WHO International Nonproprietary Name. '
                                "Names identical to a protected INN must not proceed.",
                    "owner": hit.get("owner"),
                })

            elif comp >= _CONFLICT_THRESHOLD and not is_epharmacy_loose:
                conflict_type = {
                    "who": "WHO_INN_CONFLICT",
                    "iqvia": "EXACT_MARKET_MATCH" if exact else "IQVIA_MARKET_CONFLICT",
                    "web": "EXACT_MARKET_MATCH" if exact else "WEB_MARKET_CONFLICT",
                    "epharmacy": "EXACT_MARKET_MATCH" if exact else "EPHARMACY_CONFLICT",
                }[hit["tier"]]
                conflicts.append({
                    "conflicting_name": candidate, "conflict_type": conflict_type,
                    "source": hit["source"], "severity": _risk_level(comp),
                    "details": f'"{candidate}" ({hit["source"]}) is {round(comp * 100)}% similar to "{name}".',
                    "owner": hit.get("owner"),
                })

            # Only include genuine similarities (exclude loose e-pharmacy search-engine auto-complete artifacts)
            if not is_epharmacy_loose:
                dims = [
                    ("Phonetic", phon),
                    ("Spelling", max(lev, fuz)),
                    ("Visual", look),
                ]
                if semantic > 0.0:
                    dims.append(("Conceptual", semantic))
                for clean_label, score in dims:
                    if score is not None and float(score) >= _SIMILAR_THRESHOLD:
                        similar_names.append({
                            "name": candidate,
                            "similarity_type": clean_label,
                            "similarity_score": round(float(score), 3),
                            "source": hit["source"],
                            "risk_level": _risk_level(score),
                            "therapeutic_area": None,
                            "manufacturer": hit.get("owner"),
                            "country": "India" if hit["tier"] == "epharmacy" else None,
                        })

        def _max_similarity(*labels: str) -> float:
            scores_for_labels = [sn["similarity_score"] for sn in similar_names if sn["similarity_type"] in labels]
            return max(scores_for_labels) if scores_for_labels else 0.0

        has_exact_match_conflict = any(
            c["conflict_type"] in ("EXACT_MATCH", "EXACT_MARKET_MATCH") for c in conflicts
        )
        who_knockout_found = any(c["conflict_type"] == "INN_KNOCKOUT" for c in conflicts)

        exact_score = 1.0 if any_exact else 0.0
        phonetic_score = max(_max_similarity("Phonetic"), 1.0 if has_exact_match_conflict else 0.0)
        spelling_score = max(_max_similarity("Spelling"), 1.0 if has_exact_match_conflict else 0.0)
        visual_score = max(_max_similarity("Visual", "Look-Alike"), 1.0 if has_exact_match_conflict else 0.0)
        conceptual_score = max(_max_similarity("Semantic", "Conceptual"), 1.0 if has_exact_match_conflict else 0.0)

        # Calculate Overall Conflict / Market Presence Score using 4-source Top-3 weighting:
        # WHO (25) + IQVIA (25) + E-Pharmacy (25: PharmEasy 6.25, Netmeds 6.25, 1mg 6.25, Apollo 6.25) + Google (25)
        who_conf, who_score, who_top = calculate_source_confidence_and_score(list(who_matches_dict.values()), 25.0)
        iqvia_conf, iqvia_score, iqvia_top = calculate_source_confidence_and_score(list(iqvia_matches_dict.values()), 25.0)

        pe_conf, pe_score, pe_top = calculate_source_confidence_and_score(list(pharmeasy_matches_dict.values()), 6.25)
        net_conf, net_score, net_top = calculate_source_confidence_and_score(list(netmeds_matches_dict.values()), 6.25)
        onemg_conf, onemg_score, onemg_top = calculate_source_confidence_and_score(list(onemg_matches_dict.values()), 6.25)
        apollo_conf, apollo_score, apollo_top = calculate_source_confidence_and_score(list(apollo_matches_dict.values()), 6.25)
        epharmacy_score = round(pe_score + net_score + onemg_score + apollo_score, 2)

        google_conf, google_score, google_top = calculate_source_confidence_and_score(list(google_matches_dict.values()), 25.0)

        total_conflict_score = round(min(who_score + iqvia_score + epharmacy_score + google_score, 100.0), 2)
        if not conflicts and not similar_names:
            market_presence_score = 0.0
        else:
            market_presence_score = round(total_conflict_score / 100.0, 3)

        # 4-Parameter Grade & Combination Formula with Dynamic Settings & Hard Knockout Gates
        grade_thresholds = self.settings_repo.get_grade_thresholds()
        combination_rules = self.settings_repo.get_combination_rules()
        overall_risk_score, risk_classification, ai_recommendation, grades_dict, combination_code = calculate_mentor_risk_score(
            phonetic_score=phonetic_score,
            spelling_score=spelling_score,
            visual_score=visual_score,
            conceptual_score=conceptual_score,
            is_exact_match=bool(any_exact or has_exact_match_conflict),
            is_who_inn_knockout=bool(who_knockout_found),
            is_linguistic_knockout=bool(evidence.get("is_linguistic_knockout")),
            grade_thresholds=grade_thresholds,
            combination_rules=combination_rules,
        )

        stopped_stage = evidence.get("stopped_at_stage") or evidence.get("rejected_stage")
        if stopped_stage is not None:
            overall_risk_score = max(overall_risk_score, 85.0)
            risk_classification, ai_recommendation = "HIGH", "REJECT"

        # IQVIA never yields an automatic clean pass (per the mentor-updated
        # spec) — a name that got this far without being rejected at Stage 2
        # but was flagged there for User Review must never end up classified
        # LOW/PROCEED purely because every other stage came back clean.
        iqvia_review_note = evidence.get("iqvia_review_note")
        if stopped_stage is None and iqvia_review_note and risk_classification == "LOW":
            risk_classification, ai_recommendation = "MEDIUM", "LEGAL_REVIEW"
            overall_risk_score = max(overall_risk_score, 35.0)

        overall_risk_score = round(min(overall_risk_score, 100.0), 1)

        epharmacy_conflicts = sum(1 for c in conflicts if any(k in (c.get("source") or "").lower() for k in ("pharmeasy", "netmeds", "1mg", "apollo", "pharmacy")))
        trademark_conflicts = sum(1 for c in conflicts if c["conflict_type"] in ("INN_KNOCKOUT", "WHO_INN_CONFLICT"))
        market_portal_hits = len({
            sn["name"].strip().lower() for sn in similar_names
            if any(k in (sn.get("source") or "").lower() for k in ("pharm", "1mg", "netmeds", "apollo", "iqvia"))
        })
        market_conflicts = max(len(conflicts) - trademark_conflicts, market_portal_hits)

        scores = {
            "overall_risk_score": overall_risk_score,
            "risk_classification": risk_classification,
            "ai_recommendation": ai_recommendation,
            "grades": grades_dict,
            "combination": combination_code,
            "exact_match_score": exact_score,
            "spelling_similarity_score": round(spelling_score, 3),
            "phonetic_similarity_score": round(phonetic_score, 3),
            "semantic_similarity_score": round(conceptual_score, 3),
            "lookalike_score": round(visual_score, 3),
            "soundalike_score": 0.0,
            "trademark_conflict_score": round(max_who_comp, 3),
            "market_presence_score": market_presence_score,
            "total_conflicts": len(conflicts),
            "trademark_conflicts": trademark_conflicts,
            "market_conflicts": max(market_conflicts, 0),
            "epharmacy_conflicts": epharmacy_conflicts,
            "iqvia_review_note": iqvia_review_note.get("note") if iqvia_review_note else None,
        }
        return similar_names, conflicts, scores

    # ------------------------------------------------------------------
    # Public entry points
    async def screen_brand(
        self, brand_name: str, user_id: Optional[uuid.UUID], case_id: Optional[str] = None, case_data: Optional[Dict[str, Any]] = None,
    ) -> BrandSearch:
        name = brand_name.strip()

        case_context = None
        if case_data:
            case_context = {
                "case_id": case_data.get("case_id") or case_id,
                "case_name": case_data.get("case_name") or case_data.get("generic_name") or case_id,
                "generic_name": case_data.get("generic_name"),
                "therapy": case_data.get("therapy"),
                "segment": case_data.get("segment"),
                "ailment": case_data.get("ailment"),
                "promoting_indications": case_data.get("promoting_indications"),
                "dosage_form": case_data.get("dosage_form"),
                "dose": case_data.get("dose"),
                "domestic_brand_names": case_data.get("domestic_brand_names"),
                "international_brand_names": case_data.get("international_brand_names"),
                "innovator_brands": case_data.get("innovator_brands"),
                "parent_brand_owner": case_data.get("parent_brand_owner"),
                "naming_information": case_data.get("naming_information"),
            }
        elif case_id:
            clean_case = case_id.strip()
            form = (
                self.db.query(BrandSuggestionForm)
                .filter(
                    (func.lower(func.trim(BrandSuggestionForm.case_id)) == clean_case.lower()) |
                    (func.lower(func.trim(BrandSuggestionForm.generic_name)) == clean_case.lower())
                )
                .first()
            )
            if form:
                case_context = {
                    "case_id": form.case_id,
                    "case_name": form.generic_name,
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

        logger.info("================================================================================")
        logger.info("[BRAND ANALYSIS] Screening %r | user=%s case_id=%s", name, user_id, case_id)
        evidence = await self._gather_evidence(name)
        similar_names, conflicts, scores = await self._score(name, evidence, case_context=case_context)
        logger.info("[BRAND ANALYSIS] %r scored — risk=%.1f cls=%s conflicts=%d", name, scores.get("overall_risk_score", 0.0), scores.get("risk_classification", "?"), len(conflicts))

        top_conflicts = [
            {"name": c.get("conflicting_name") or c.get("name"), "source": c.get("source"),
             "similarity_type": c.get("conflict_type") or c.get("similarity_type", "Conflict"), "similarity_score": 1.0 if c.get("severity") == "HIGH" else 0.5}
            for c in sorted(conflicts, key=lambda c: c.get("severity", "LOW"), reverse=True)[:5]
        ]
        is_ling_knockout = bool(evidence.get("is_linguistic_knockout"))
        ai_assessment, coining_principles_eval, name_qualities = await ai_service.evaluate_coining_principles_and_assessment(
            name, scores["overall_risk_score"], scores["risk_classification"], top_conflicts,
            case_context=case_context, is_linguistic_invalid=is_ling_knockout,
        )
        if not name_qualities:
            name_qualities = await ai_service.rate_name_qualities(name)
        if not name_qualities:
            syllable_count = max(1, len(name) // 3)
            memo = 85.0 if (2 <= syllable_count <= 3 and 5 <= len(name) <= 9) else 75.0
            pron = 85.0 if not any(c in name.lower() for c in ("xz", "qj", "vk", "zf")) else 65.0
            name_qualities = {"memorability": memo, "pronunciation_ease": pron}

        stopped_at_stage = evidence.get("stopped_at_stage")
        stopped_conflict = evidence.get("stopped_conflict")

        not_checked = []
        # Stages after the one that stopped the pipeline were never
        # attempted at all — that's a different, clearer story ("pipeline
        # stopped early") than the existing per-source disabled/failed
        # reasons below, so it takes over the whole explanation instead of
        # stacking on top of them.
        if stopped_at_stage:
            not_checked.append(
                f"pipeline stopped at Stage {stopped_at_stage} ({evidence['stopped_stage_name']}) — "
                "later stages were not run"
            )
        else:
            if not evidence["who_inn_enabled"]:
                not_checked.append("WHO INN registry (disabled by admin)")
            if not evidence["iqvia_enabled"]:
                not_checked.append("IQVIA extract (disabled by admin)")
            elif not evidence["iqvia_licensed"]:
                not_checked.append("IQVIA extract (no data loaded)")
            if not evidence["google_search_enabled"]:
                not_checked.append("Google web search (disabled by admin)")
            elif not evidence["web_configured"]:
                not_checked.append("Google web search (not configured)")
            if not evidence["epharmacy_enabled"]:
                not_checked.append("live e-pharmacy scrape (disabled by admin)")
            elif not evidence["epharmacy_checked"]:
                not_checked.append("live e-pharmacy scrape (did not complete)")
        if not_checked and ai_assessment:
            ai_assessment = ai_assessment.rstrip() + " Not checked: " + "; ".join(not_checked) + "."

        rejection_reason = evidence.get("rejection_reason")
        if not rejection_reason and stopped_conflict:
            stage_desc = f"Stage {stopped_at_stage} ({evidence['stopped_stage_name']})"
            if stopped_at_stage == 2 and stopped_conflict.get("reject_reason"):
                # IQVIA has its own mentor-specified rejection rule (exact match /
                # 85% Phonetic-Spelling-Conceptual / commercial growth) — use its
                # own precise reason rather than the generic 70%-threshold phrasing
                # every other stage uses below.
                rejection_reason = (
                    f'This name is rejected at {stage_desc}, source {stopped_conflict["source"]}, '
                    f'matched against "{stopped_conflict["name"]}". {stopped_conflict["reject_reason"]} '
                    "Later stages were not run."
                )
            elif stopped_conflict.get("exact"):
                rejection_reason = (
                    f'This name is rejected as "{name}" is an exact match to "{stopped_conflict["name"]}" '
                    f'found in this stage: {stage_desc}, source {stopped_conflict["source"]}. '
                    "Later stages were not run."
                )
            else:
                rejection_reason = (
                    f'This name is rejected as it was found in this stage: {stage_desc}, '
                    f'source {stopped_conflict["source"]}, with similarity greater than '
                    f'{round(_STAGE_STOP_THRESHOLD * 100)}% to "{stopped_conflict["name"]}" '
                    f'({round(stopped_conflict["similarity_score"] * 100)}% similar). '
                    "Later stages were not run."
                )

        # IQVIA "flagged for User Review" note (not a reject) — surface it in
        # the UI-facing assessment text verbatim, e.g. "...skipped Commercial
        # Growth Check as both growth percentages are blank/zero."
        iqvia_note_text = scores.get("iqvia_review_note")
        if iqvia_note_text and ai_assessment:
            ai_assessment = ai_assessment.rstrip() + " IQVIA note: " + iqvia_note_text

        knockout_checks = evaluate_pharma_knockout_checks(
            name,
            conflicts,
            similar_names,
            case_context=case_context,
            is_who_inn_fail=bool(stopped_conflict and stopped_conflict.get("tier") == "who"),
            is_linguistic_fail=is_ling_knockout,
        )

        # Application-level cap — the assembled string above (base assessment +
        # "Not checked:" + "IQVIA note:" appends) can exceed the schema's
        # max_length=10000 on ai_assessment; truncate here so persistence/
        # validation never sees an oversized value.
        ai_assessment = ai_assessment[:10000] if ai_assessment else ai_assessment

        result = dict(scores)
        result["ai_assessment"] = ai_assessment
        result["coining_principles_eval"] = coining_principles_eval
        if case_context is not None:
            case_context["coining_principles_eval"] = coining_principles_eval
        result["memorability_score"] = name_qualities["memorability"] if name_qualities else None
        result["pronunciation_score"] = name_qualities["pronunciation_ease"] if name_qualities else None
        result["stages_completed"] = evidence.get("stages_completed", 3)
        result["rejected_at_stage"] = stopped_at_stage
        result["rejected_stage_name"] = evidence.get("stopped_stage_name")
        result["rejection_reason"] = rejection_reason
        result["knockout_checks"] = knockout_checks
        result["case_context"] = case_context

        effective_case_id = (case_context.get("case_id") if case_context else None) or case_id
        search = self.repo.create_search(name, user_id, case_id=effective_case_id)
        self.repo.save_result(search.id, result, similar_names, conflicts)
        saved_search = self.repo.get_by_search_id(search.id)
        if saved_search and saved_search.screening_result:
            saved_search.screening_result.knockout_checks = knockout_checks
            saved_search.screening_result.case_context = case_context
            saved_search.screening_result.coining_principles_eval = coining_principles_eval
        logger.info("[BRAND ANALYSIS] DONE — %r saved (search_id=%s)", name, search.id)
        return saved_search


    async def get_intelligence(self, brand_name: str) -> Dict[str, Any]:
        name = brand_name.strip()

        # 1. Fast DB check: generated_brand_names table (instant response for AI Generator candidates)
        gen_brand = (
            self.db.query(GeneratedBrandName)
            .filter(func.lower(GeneratedBrandName.generated_name) == name.lower())
            .order_by(GeneratedBrandName.created_at.desc())
            .first()
        )
        if gen_brand and gen_brand.conflict_details:
            cd = gen_brand.conflict_details or {}
            from app.core.cache import cache_service
            top_conflicts = list(cd.get("top_conflicts", []))
            existing_names = {c.get("name", "").lower() for c in top_conflicts}
            pharm_cached = cache_service.get_json(f"pharmacy_scrape:{name.upper()}") or []
            for p in pharm_cached:
                pname = p.get("brand_name")
                if pname and pname.lower() not in existing_names:
                    lev = levenshtein_similarity(name, pname)
                    fuz = fuzzy_similarity(name, pname)
                    grades = grade_name_similarity(name, pname)
                    phon = grades["phonetic"]
                    look = grades["visual"]
                    eff_comp = max(grades.values())
                    if eff_comp >= _SIMILAR_THRESHOLD:
                        top_conflicts.append({
                            "name": pname, "owner": p.get("manufacturer"), "source": p.get("source", "E-Pharmacy"),
                            "similarity_score": round(eff_comp, 3), "spelling_score": round(max(lev, fuz), 3),
                            "phonetic_score": round(phon, 3), "lookalike_score": round(look, 3),
                        })
                        existing_names.add(pname.lower())
            # Each stored conflict now carries every similarity dimension it
            # actually earned (see generator.py's classify_similarity_types
            # call) rather than a single collapsed label — expand it into one
            # row per dimension here, each scored by that dimension's own
            # real value, so a bar can never show a percentage with an empty
            # "matched brands" list behind it. `similarity_types`/the four
            # per-dimension score fields are absent on conflicts stored
            # before this fix; both fall back to the old single-label shape.
            similarity_counts: Dict[str, int] = {}
            similar_names = []
            for c in top_conflicts:
                comp_score = c.get("similarity_score", 0.0)
                lev = c.get("spelling_score", 0.0)
                phon = c.get("phonetic_score", 0.0)
                look = c.get("lookalike_score", 0.0)
                sem = c.get("semantic_similarity_score") or (round(comp_score * 0.5, 3) if comp_score >= 0.30 else 0.0)
                
                dims = [
                    ("Phonetic", phon),
                    ("Spelling", lev),
                    ("Visual", look),
                    ("Conceptual", sem),
                ]
                for clean_type, sim_score in dims:
                    if sim_score is not None and float(sim_score) >= _SIMILAR_THRESHOLD:
                        similarity_counts[clean_type] = similarity_counts.get(clean_type, 0) + 1
                        risk_lvl = "HIGH" if sim_score >= 0.70 else "MEDIUM" if sim_score >= 0.50 else "LOW"
                        similar_names.append({
                            "name": c.get("name", ""),
                            "similarity_score": round(float(sim_score), 3),
                            "similarity_type": clean_type,
                            "source": c.get("source", "Trademark Registry"),
                            "owner": c.get("owner"),
                            "risk_level": risk_lvl,
                        })

            raw_similar = cd.get("similar_names") or []
            for s in raw_similar:
                sname = (s.get("name") or "").strip()
                if not sname:
                    continue
                sim_score = float(s.get("similarity_score") or 0.0)
                sim_type = s.get("similarity_type") or "Phonetic"
                if not any(sn["name"].lower() == sname.lower() and sn["similarity_type"] == sim_type for sn in similar_names):
                    risk_lvl = s.get("risk_level") or ("HIGH" if sim_score >= 0.70 else "MEDIUM" if sim_score >= 0.50 else "LOW")
                    similar_names.append({
                        "name": sname,
                        "similarity_score": round(sim_score, 3),
                        "similarity_type": sim_type,
                        "source": s.get("source") or "E-Pharmacy (India)",
                        "owner": s.get("manufacturer"),
                        "risk_level": risk_lvl,
                    })
                    similarity_counts[sim_type] = similarity_counts.get(sim_type, 0) + 1
            colors = {
                "Exact Match": "#ef4444", "Phonetic": "#3b82f6",
                "Visual": "#f97316", "Spelling": "#a855f7", "Conceptual": "#6366f1", "Semantic": "#6366f1",
                "Market Match": "#f97316",
            }
            similarity_breakdown = [
                {"type": t, "count": c, "color": colors.get(t, "#9ca3af")}
                for t, c in similarity_counts.items()
            ]
            if not similarity_breakdown:
                similarity_breakdown = [{"type": "Distinctive", "count": 1, "color": "#22c55e"}]

            risk_counts = {"LOW": 0, "MEDIUM": 0, "HIGH": 0}
            for sn in similar_names:
                risk_counts[sn["risk_level"]] = risk_counts.get(sn["risk_level"], 0) + 1
            risk_colors = {"LOW": "#22c55e", "MEDIUM": "#f97316", "HIGH": "#ef4444"}
            risk_distribution = [
                {"level": lvl, "count": cnt, "color": risk_colors[lvl]}
                for lvl, cnt in risk_counts.items() if cnt > 0
            ]
            if not risk_distribution:
                risk_distribution = [{"level": "LOW", "count": 1, "color": "#22c55e"}]

            competitive_landscape = [
                {
                    "brand": c.get("name", ""),
                    "similarity_score": c.get("similarity_score", 0.0),
                    "market_presence": 0.5 if "Market" in c.get("source", "") else 0.2,
                    "trademark_status": "Registered" if "Trademark" in c.get("source", "") else "Market Active",
                    "manufacturer": c.get("owner") or "Unknown",
                    "therapeutic_area": "",
                }
                for c in top_conflicts[:10]
            ]
            brand_uniqueness_score = round(gen_brand.availability_score or (100.0 - (gen_brand.risk_score or 0.0)), 1)
            # top_conflicts is capped to _MAX_TOP_CONFLICTS (5) for display —
            # dividing that capped length by 10 silently ceilings saturation
            # at 50% for any name with 5+ real conflicts. total_conflict_count
            # is the true pre-cap count generator.py stores alongside it; fall
            # back to len(top_conflicts) only for conflicts saved before this
            # field existed.
            conflict_count_for_saturation = cd.get("total_conflict_count", len(top_conflicts))
            market_saturation = min(1.0, conflict_count_for_saturation / 10.0)

            rec_cat = "LOW" if (gen_brand.recommendation_status == "recommended" or (gen_brand.risk_score or 0) < 40) else "MEDIUM" if (gen_brand.recommendation_status == "review_required" or (gen_brand.risk_score or 0) < 70) else "HIGH"
            overall_risk = round(float(gen_brand.risk_score or 0.0), 1)

            return {
                "brand_name": name,
                "overall_risk_score": overall_risk,
                "risk_classification": rec_cat,
                "trademark_presence": round((gen_brand.risk_score or 0.0) / 100.0, 2),
                "market_presence": 0.2,
                "epharmacy_presence": 1.0 if any("1mg" in c.get("source", "").lower() or "pharmacy" in c.get("source", "").lower() for c in top_conflicts) else 0.0,
                "geographic_reach": 1,
                "competitor_count": len(top_conflicts),
                "market_saturation": round(market_saturation, 3),
                "brand_uniqueness_score": brand_uniqueness_score,
                "ai_summary": cd.get("rationale") or f'"{name}" carries risk score {gen_brand.risk_score:.0f}/100.',
                "similar_brands": [{**sn, "id": uuid.uuid4()} for sn in similar_names],
                "competitive_landscape": competitive_landscape,
                "trend_data": [],
                "similarity_breakdown": similarity_breakdown,
                "risk_distribution": risk_distribution,
            }

        # 2. Live gathering when no previous record is stored
        evidence = await self._gather_evidence(name)
        similar_names, conflicts, scores = await self._score(name, evidence)

        similarity_counts: Dict[str, int] = {}
        for sn in similar_names:
            similarity_counts[sn["similarity_type"]] = similarity_counts.get(sn["similarity_type"], 0) + 1
        colors = {
            "Exact Match": "#ef4444", "Phonetic": "#3b82f6",
            "Visual": "#f97316", "Spelling": "#a855f7", "Conceptual": "#6366f1", "Semantic": "#6366f1",
        }
        similarity_breakdown = [
            {"type": t, "count": c, "color": colors.get(t, "#9ca3af")}
            for t, c in similarity_counts.items()
        ]

        risk_counts = {"LOW": 0, "MEDIUM": 0, "HIGH": 0}
        for sn in similar_names:
            risk_counts[sn["risk_level"]] = risk_counts.get(sn["risk_level"], 0) + 1
        risk_colors = {"LOW": "#22c55e", "MEDIUM": "#f97316", "HIGH": "#ef4444"}
        risk_distribution = [
            {"level": lvl, "count": cnt, "color": risk_colors[lvl]}
            for lvl, cnt in risk_counts.items() if cnt > 0
        ]

        similar_by_name = {sn["name"]: sn for sn in similar_names}
        competitive_landscape = [
            {
                "brand": c["conflicting_name"],
                "similarity_score": (
                    similar_by_name[c["conflicting_name"]]["similarity_score"]
                    if c["conflicting_name"] in similar_by_name
                    else max(grade_name_similarity(name, c["conflicting_name"]).values())
                ),
                "market_presence": scores["market_presence_score"],
                "trademark_status": c.get("status") or "Unknown",
                "manufacturer": c.get("owner") or "Unknown",
                "therapeutic_area": "",
            }
            for c in conflicts[:10]
        ]

        geographic_reach = 1 if evidence["epharmacy_hits"] else 0
        market_saturation = min(1.0, (len(conflicts) + len(similar_names)) / 10.0)
        brand_uniqueness_score = round(max(0.0, 100.0 - scores["overall_risk_score"]), 1)

        ai_summary = None
        if conflicts or similar_names:
            ai_summary = (
                f'"{name}" carries {len(conflicts)} conflict(s) and {len(similar_names)} similar name(s) '
                f'across the sources checked. Overall risk {scores["overall_risk_score"]:.0f}/100 '
                f'({scores["risk_classification"]}).'
            )

        return {
            "brand_name": name,
            "overall_risk_score": scores["overall_risk_score"],
            "risk_classification": scores["risk_classification"],
            "trademark_presence": scores["trademark_conflict_score"],
            "market_presence": scores["market_presence_score"],
            "epharmacy_presence": 1.0 if evidence["epharmacy_hits"] else 0.0,
            "geographic_reach": geographic_reach,
            "competitor_count": len(conflicts),
            "market_saturation": round(market_saturation, 3),
            "brand_uniqueness_score": brand_uniqueness_score,
            "ai_summary": ai_summary,
            "similar_brands": [{**sn, "id": uuid.uuid4()} for sn in similar_names],
            "competitive_landscape": competitive_landscape,
            "trend_data": [],
            "similarity_breakdown": similarity_breakdown,
            "risk_distribution": risk_distribution,
        }
