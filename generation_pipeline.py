"""Concurrent orchestration for the AI Name Generator.

WHAT THIS CHANGES: only WHEN work runs, never WHAT the work decides.

Every screening call, threshold, formula, risk classification and acceptance
rule is executed by the SAME GeneratorService methods as before
(`_score_candidate`, `_check_local_registries`, `_check_all_portals`,
`_rescore_candidate_with_market`). This module calls them; it does not
reimplement or reinterpret any of them.

THE LOGICAL ORDER IS UNCHANGED. Every candidate still travels:

    LLM -> deterministic screening -> WHO INN -> IQVIA -> e-pharmacy -> Google
    -> final collision/risk analysis -> recommended / review_required / high_risk

BEFORE (strictly serial — batch N+1's LLM call could not start until batch N's
e-pharmacy screening had completely finished):

    generate -> score -> WHO/IQVIA -> [e-pharmacy ... wait ...] -> generate ...

AFTER (the producer does not wait on e-pharmacy):

    producer:  generate -> score -> WHO/IQVIA -> enqueue survivors -> repeat
    workers:   drain queue -> e-pharmacy + Google -> rescore -> accept/reject

The producer re-generates as soon as the DOWNSTREAM SUPPLY (accepted + queued +
in-flight) is below target, so LLM batch N+1 overlaps e-pharmacy batch N.
"""
import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Sentinel pushed onto the event queue when the run is finished.
DONE = object()

# How many of each structural trait to feed back into the next prompt. Kept
# small deliberately: the point is a pointed "you already tried these" signal,
# not a data dump.
_MAX_EXPLORED_PER_TRAIT = 6

_VOWELS_RE = re.compile(r"[aeiouy]")

# Over-generation: ask the LLM for this multiple of the batch's external
# budget, filter the larger pool locally, then send only the budget onward.
# The number of candidates that reach WHO/IQVIA is UNCHANGED -- only the pool
# they are chosen from grows, and every extra candidate is discarded locally
# at zero external cost.
_OVERGENERATION_FACTOR = 3
_MAX_LLM_POOL = 75


def _structural_signature(names: List[str]) -> Dict[str, Dict[str, int]]:
    """Counts the structural traits of a set of names: opening letter, 2-letter
    ending, and consonant framework (the name with vowels removed).

    These are exactly the traits `_batch_quality_metrics` already reports for
    diagnostics — reused here so the next batch can be steered away from
    territory this run has already covered. No threshold, score or screening
    decision uses any of this.
    """
    initials: Dict[str, int] = {}
    suffixes: Dict[str, int] = {}
    skeletons: Dict[str, int] = {}
    for raw in names:
        n = (raw or "").strip().lower()
        if len(n) < 2:
            continue
        initials[n[0]] = initials.get(n[0], 0) + 1
        # 3-char endings, not 2. A 2-letter tail ("ra", "on") collapses the
        # distinct territories this run actually exhausts (-ara, -ora, -ithra,
        # -vion) into one unusable bucket, so the steering signal was too
        # coarse to act on. 2-char is kept alongside for short names.
        suffixes[n[-2:]] = suffixes.get(n[-2:], 0) + 1
        if len(n) >= 4:
            suffixes[n[-3:]] = suffixes.get(n[-3:], 0) + 1
        skel = _VOWELS_RE.sub("", n)
        if skel:
            skeletons[skel] = skeletons.get(skel, 0) + 1
    return {"initials": initials, "suffixes": suffixes, "skeletons": skeletons}


def synthesize_syllable_variants(base_name: str, count: int = 4) -> List[str]:
    """Generates phonotactically similar sibling neologisms by mutating 1 or 2 syllables
    of a proven low-risk cleared brand name (e.g. onset blend, vowel cadence, terminal suffix)."""
    clean = re.sub(r"[^a-zA-Z]", "", base_name)
    if len(clean) < 5:
        return []

    onsets = ["Br", "Dr", "Kl", "Pl", "Sk", "Sp", "Tr", "B", "D", "G", "K", "P", "V", "Z", "M", "T"]
    suffixes_4 = ["gard", "stor", "ndex", "traz", "vix", "vent", "tron", "pres", "stat", "clor"]
    suffixes_3 = ["dex", "tis", "lin", "nor", "ast", "lis", "dra", "lor", "via", "cal"]

    variants: List[str] = []
    # 1. Onset mutation
    m = re.match(r"^([^aeiouyAEIOUY]+)(.*)$", clean)
    if m:
        orig_onset, rest = m.group(1), m.group(2)
        for ons in onsets:
            if ons.lower() != orig_onset.lower():
                candidate = ons + rest
                if len(candidate) in range(8, 15) and candidate.lower() != clean.lower() and candidate not in variants:
                    variants.append(candidate)
                    if len(variants) >= count // 2:
                        break

    # 2. Suffix mutation
    if len(clean) >= 9:
        stem = clean[:-4]
    elif len(clean) >= 7:
        stem = clean[:-3]
    else:
        stem = clean[:-2]

    # Ensure stem ends cleanly before appending suffix
    for sfx in suffixes_4 + suffixes_3:
        # Avoid duplicate trailing/leading consonants like 'gg'
        s = stem
        if s and sfx and s[-1].lower() == sfx[0].lower():
            s = s[:-1]
        cand = s + sfx
        cand = cand.capitalize()
        if len(cand) in range(8, 15) and cand.lower() != clean.lower() and cand not in variants:
            variants.append(cand)
            if len(variants) >= count:
                break

    return variants[:count]


def synthesize_phonetic_rebus(base_name: str) -> List[str]:
    """Synthesizes meaningful phonetic rebus brand names from a base name or root morpheme.
    Replaces phonetic sounds with morphemic digits (e.g. 1=one/won, 2=to/tu, 4=for/fore, 8=ate/eight)
    rather than appending arbitrary dosage digits.
    Examples: '1derful', 'A2pine', 'Go8rine', 'Stabi8', 'Haven2', 'Bravis2'."""
    clean = re.sub(r"[^a-zA-Z]", "", base_name)
    if len(clean) < 4:
        return []

    rebus_candidates: List[str] = []
    lower = clean.lower()

    # 1. Phonetic substring substitutions
    if "to" in lower:
        rebus_candidates.append(re.sub(r"to", "2", lower, count=1).capitalize())
    elif "tu" in lower:
        rebus_candidates.append(re.sub(r"tu", "2", lower, count=1).capitalize())

    if "ate" in lower:
        rebus_candidates.append(re.sub(r"ate", "8", lower, count=1).capitalize())
    elif lower.endswith("at") or "at" in lower[3:]:
        rebus_candidates.append(re.sub(r"at", "8", lower, count=1).capitalize())

    if "for" in lower:
        rebus_candidates.append(re.sub(r"for", "4", lower, count=1).capitalize())

    if lower.endswith("on"):
        rebus_candidates.append((clean[:-2] + "1").capitalize())
    elif "one" in lower:
        rebus_candidates.append(re.sub(r"one", "1", lower, count=1).capitalize())

    # 2. Morphemic prefix rebus fusions
    stem_short = clean[:5].lower()
    rebus_candidates.append(f"A2{stem_short}".capitalize())
    rebus_candidates.append(f"1{stem_short}".capitalize())
    rebus_candidates.append(f"Go8{stem_short}".capitalize())
    rebus_candidates.append(f"{stem_short}8".capitalize())

    results: List[str] = []
    for r in rebus_candidates:
        r_clean = re.sub(r"[^a-zA-Z0-9]", "", r)
        if 5 <= len(r_clean) <= 12 and r_clean not in results:
            results.append(r_clean)
    return results


def _merge_counts(target: Dict[str, int], source: Dict[str, int]) -> None:
    for k, v in source.items():
        target[k] = target.get(k, 0) + v


def _top(counts: Dict[str, int], limit: int = _MAX_EXPLORED_PER_TRAIT,
         min_count: int = 1) -> List[Tuple[str, int]]:
    return [
        (k, v) for k, v in
        sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:limit]
        if v >= min_count
    ]


@dataclass
class BatchStats:
    """Per-batch funnel, for the yield metrics."""
    batch: int
    generated: int = 0
    deterministic_survivors: int = 0
    prefilter_evaluated: int = 0
    prefilter_rejected: int = 0
    rejection_memory_blocked: int = 0
    phase2_blocked: int = 0
    local_eligible: int = 0
    external_selected: int = 0
    who_evaluated: int = 0
    who_survivors: int = 0
    epharmacy_entered: int = 0
    final_accepted: int = 0

    @property
    def yield_pct(self) -> float:
        return round(self.final_accepted / self.generated * 100, 1) if self.generated else 0.0

    def as_row(self) -> str:
        return (
            f"  Batch {self.batch:>2} | generated={self.generated:>3} | "
            f"deterministic={self.deterministic_survivors:>3} | "
            f"prefilter_rej={self.prefilter_rejected:>3} | who_eval={self.who_evaluated:>3} | "
            f"who_survivors={self.who_survivors:>3} | epharmacy={self.epharmacy_entered:>3} | "
            f"final={self.final_accepted:>3} | batch_yield={self.yield_pct:>5.1f}%"
        )


@dataclass
class PipelineMetrics:
    """Observability counters. Read-only reporting; influences no decision."""
    batches: int = 0
    total_generated: int = 0
    entered_deterministic: int = 0
    prefilter_evaluated: int = 0
    prefilter_rejected: int = 0
    prefilter_survivors: int = 0
    prefilter_reasons: Dict[str, int] = field(default_factory=dict)
    rejection_memory_evaluated: int = 0
    rejection_memory_blocked: int = 0
    rejection_memory_reasons: Dict[str, int] = field(default_factory=dict)
    phase2_evaluated: int = 0
    phase2_blocked: int = 0
    phase2_reasons: Dict[str, int] = field(default_factory=dict)
    llm_generated: int = 0
    normalized_unique: int = 0
    banned_morphology_blocked: int = 0
    inn_stem_blocked: int = 0
    local_eligible: int = 0
    external_selected: int = 0
    external_not_selected: int = 0
    sparse_generated: int = 0
    entered_who_iqvia: int = 0
    who_iqvia_survivors: int = 0
    who_iqvia_rejected: int = 0
    entered_epharmacy: int = 0
    epharmacy_rejected: int = 0
    epharmacy_failed: int = 0
    accepted: int = 0
    duplicates_skipped: int = 0
    max_observed_concurrency: int = 0
    llm_seconds: float = 0.0
    deterministic_seconds: float = 0.0
    who_iqvia_seconds: float = 0.0
    epharmacy_seconds: float = 0.0
    overlap_events: int = 0
    started_at: float = field(default_factory=time.monotonic)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "batches": self.batches,
            "total_generated": self.total_generated,
            "prefilter_evaluated": self.prefilter_evaluated,
            "prefilter_rejected": self.prefilter_rejected,
            "prefilter_survivors": self.prefilter_survivors,
            "prefilter_reasons": dict(self.prefilter_reasons),
            "rejection_memory_evaluated": self.rejection_memory_evaluated,
            "rejection_memory_blocked": self.rejection_memory_blocked,
            "rejection_memory_reasons": dict(self.rejection_memory_reasons),
            "phase2_evaluated": self.phase2_evaluated,
            "phase2_blocked": self.phase2_blocked,
            "phase2_reasons": dict(self.phase2_reasons),
            "llm_generated": self.llm_generated,
            "normalized_unique": self.normalized_unique,
            "banned_morphology_blocked": self.banned_morphology_blocked,
            "inn_stem_blocked": self.inn_stem_blocked,
            "local_eligible": self.local_eligible,
            "external_selected": self.external_selected,
            "external_not_selected": self.external_not_selected,
            "local_survival_rate": (
                round(self.local_eligible / self.normalized_unique, 3)
                if self.normalized_unique else 0.0
            ),
            "external_selection_rate": (
                round(self.external_selected / self.normalized_unique, 3)
                if self.normalized_unique else 0.0
            ),
            "external_verification_avoided": (
                self.prefilter_rejected + self.rejection_memory_blocked + self.phase2_blocked
            ),
            "entered_who_iqvia": self.entered_who_iqvia,
            "who_iqvia_survivors": self.who_iqvia_survivors,
            "who_iqvia_rejected": self.who_iqvia_rejected,
            "entered_epharmacy": self.entered_epharmacy,
            "epharmacy_rejected": self.epharmacy_rejected,
            "epharmacy_failed": self.epharmacy_failed,
            "accepted": self.accepted,
            "duplicates_skipped": self.duplicates_skipped,
            "max_observed_epharmacy_concurrency": self.max_observed_concurrency,
            "llm_seconds": round(self.llm_seconds, 2),
            "deterministic_seconds": round(self.deterministic_seconds, 2),
            "who_iqvia_seconds": round(self.who_iqvia_seconds, 2),
            "epharmacy_seconds": round(self.epharmacy_seconds, 2),
            "generation_epharmacy_overlap_events": self.overlap_events,
            "total_seconds": round(time.monotonic() - self.started_at, 2),
        }


class EPharmacyQueue:
    """Bounded-worker async queue sitting between WHO/IQVIA and e-pharmacy.

    In-process `asyncio.Queue` only — no Redis/RabbitMQ/Kafka/SQS/Celery, and
    no new database table.
    """

    def __init__(self, concurrency: int) -> None:
        self.concurrency = max(1, int(concurrency))
        self._queue: asyncio.Queue = asyncio.Queue()
        self.queued = 0
        self.in_flight = 0
        self._active = 0
        self._peak = 0

    def qsize(self) -> int:
        return self.queued

    async def put(self, item: Any) -> None:
        self.queued += 1
        await self._queue.put(item)

    async def get(self) -> Any:
        item = await self._queue.get()
        if item is not DONE:
            self.queued -= 1
            self.in_flight += 1
        return item

    def task_done(self, was_item: bool = True) -> None:
        if was_item:
            self.in_flight -= 1
        self._queue.task_done()

    def enter(self) -> int:
        self._active += 1
        self._peak = max(self._peak, self._active)
        return self._active

    def leave(self) -> None:
        self._active -= 1

    @property
    def peak_concurrency(self) -> int:
        return self._peak

    async def shutdown(self, workers: int) -> None:
        for _ in range(workers):
            await self._queue.put(DONE)


class ReplenishingGenerationPipeline:
    """Producer/consumer orchestration around the existing GeneratorService."""

    def __init__(
        self,
        service: Any,
        *,
        request: Any,
        user_id: Any,
        target: int,
        context: Dict[str, Any],
        case_context: Dict[str, Any],
        toggles: Dict[str, bool],
        therapeutic_area: Optional[str],
        molecule: str,
        conflict_pool: List[Dict[str, Any]],
        base_avoid_pool: List[Dict[str, Any]],
        registry_candidate_pool: List[Dict[str, str]],
        legal_decided_lookup: Dict[str, str],
        history_pool: List[Dict[str, Any]],
        ledger: Any,
        max_batches: int,
        max_market_attempts: int,
        concurrency: int,
        emit: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
    ) -> None:
        self.svc = service
        self.request = request
        self.user_id = user_id
        self.target = target
        self.context = context
        self.case_context = case_context
        self.toggles = toggles
        self.therapeutic_area = therapeutic_area
        self.molecule = molecule
        self.conflict_pool = conflict_pool
        self.base_avoid_pool = base_avoid_pool
        self.registry_candidate_pool = registry_candidate_pool
        self.legal_decided_lookup = legal_decided_lookup
        self.history_pool = history_pool
        self.ledger = ledger
        self.max_batches = max_batches
        self.max_market_attempts = max_market_attempts
        self._emit = emit

        self.queue = EPharmacyQueue(concurrency)
        self.metrics = PipelineMetrics()

        # Per-batch funnel + yield (see report_yield()).
        self.batch_stats: Dict[int, BatchStats] = {}
        # Structural territory covered so far this run, and the subset screening
        # actually rejected. Fed into the next prompt so batch N+1 explores a
        # different part of the naming space.
        self.explored = {"initials": {}, "suffixes": {}, "skeletons": {}}
        self.explored_rejected = {"initials": {}, "suffixes": {}}
        # WHO/IQVIA survivors that have cleared screening but are not yet on the
        # queue. Counted in downstream supply so a mid-enqueue deficit check can
        # never double-generate.
        self.survivors_pending = 0

        self.accepted: List[dict] = []
        self.seen_names: set = set()          # normalized, duplicate prevention
        self.accepted_keys: set = set()
        self.rejected_for_persist: List[dict] = []
        self.cumulative_feedback: List[Dict[str, Any]] = []
        self.avoid_pool_2_patterns: set = set()
        self._case_brands: Optional[Dict[str, Dict[str, str]]] = None
        # --- generation feedback from the deterministic gates -------------
        # DISTINCT from rejection memory. A candidate stopped at the gate was
        # never screened, so it produces no external evidence and must NOT be
        # recorded as a rejection (that would fabricate conflict data and could
        # escalate stems on invented grounds). What it DOES prove is that the
        # model spent a slot on territory it had already been told to avoid --
        # which is generation-quality information, and the only thing that can
        # change the next prompt. Counts how many candidates each territory has
        # actually blocked, which is the signal ranked_patterns cannot express.
        self.blocked_territory_counts: Dict[str, int] = {}
        self.blocked_candidate_names: List[str] = []
        # Territory map: built once per run from a single aggregate query.
        self.territory = None
        self._territory_loaded = False
        # Structural spread of what has actually been SELECTED for external
        # verification, used to keep successive batches from converging.
        self.selected_openings: Dict[str, int] = {}
        self.selected_suffixes: Dict[str, int] = {}
        self._external_budget: Optional[int] = None
        self.avoid_pool_2_rejected_names: List[str] = []
        self.total_rejected_count = 0

        self._producer_running = False
        self._target_met = asyncio.Event()
        self._supply_changed = asyncio.Event()
        self._lock = asyncio.Lock()
        self._pipeline_start = time.monotonic()

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    async def emit(self, event: Dict[str, Any]) -> None:
        if self._emit is not None:
            await self._emit(event)

    def _norm(self, name: Optional[str]) -> str:
        from app.services.rejection_memory import normalize_for_avoid
        return normalize_for_avoid(name)

    def serialize_live(self) -> List[dict]:
        return [self.svc._serialize_candidate(c) for c in self.accepted]

    def downstream_supply(self) -> int:
        """accepted + queued + in-flight. Candidates already moving through the
        pipeline are counted exactly once, so replenishment cannot double-count
        and over-generate (see the brief's deficit formula)."""
        return (
            len(self.accepted)
            + self.queue.queued
            + self.queue.in_flight
            + self.survivors_pending
        )

    def deficit(self) -> int:
        return self.target - self.downstream_supply()

    def explored_families(self) -> Optional[Dict[str, Any]]:
        """Structural traits already covered this run, for the next prompt."""
        if not self.batch_stats:
            return None
        payload = {
            "batches": len(self.batch_stats),
            "initials": _top(self.explored["initials"], min_count=2),
            "suffixes": _top(self.explored["suffixes"], min_count=2),
            "skeletons": [k for k, _ in _top(self.explored["skeletons"], min_count=1)],
            "rejected_initials": _top(self.explored_rejected["initials"], min_count=2),
            "rejected_suffixes": _top(self.explored_rejected["suffixes"], min_count=2),
        }
        return payload if any(payload[k] for k in
                              ("initials", "suffixes", "skeletons",
                               "rejected_initials", "rejected_suffixes")) else None

    def report_yield(self) -> None:
        """Generation-efficiency report (brief §8)."""
        total_gen = sum(b.generated for b in self.batch_stats.values())
        total_final = sum(b.final_accepted for b in self.batch_stats.values())
        n = len(self.batch_stats) or 1
        logger.info("[GENERATION EFFICIENCY] per-batch funnel and yield:")
        cumulative = 0
        for b in sorted(self.batch_stats.values(), key=lambda x: x.batch):
            cumulative += b.final_accepted
            cum_pct = round(cumulative / total_gen * 100, 1) if total_gen else 0.0
            logger.info("%s | cumulative_yield=%5.1f%%", b.as_row(), cum_pct)
        logger.info(
            "[GENERATION EFFICIENCY] Total generation batches=%d | Total candidates generated=%d | "
            "Total final candidates=%d | Overall yield=%.1f%% | Avg final per batch=%.2f",
            len(self.batch_stats), total_gen, total_final,
            round(total_final / total_gen * 100, 1) if total_gen else 0.0,
            round(total_final / n, 2),
        )

        m = self.metrics
        r = m.rejection_memory_reasons
        led = self.ledger.stats() if hasattr(self.ledger, "stats") else {}
        logger.info(
            "\n[GENERATION QUALITY SUMMARY]\n"
            "  Total LLM candidates generated:      %d\n"
            "  Exact duplicates skipped:            %d\n"
            "  Historical rejected names skipped:   %d\n"
            "  Current-run rejected names skipped:  %d\n"
            "  Phonetic-family collisions skipped:  %d\n"
            "  Prefix collisions skipped:           %d\n"
            "  Suffix collisions skipped:           %d\n"
            "  Phase 2 existing-case-brand blocked: %d\n"
            "  Linguistic knockouts:                %d\n"
            "  Sent to WHO/IQVIA:                   %d\n"
            "  Rejected by WHO/IQVIA:               %d\n"
            "  Sent to e-pharmacy:                  %d\n"
            "  Rejected by e-pharmacy:              %d\n"
            "  Final accepted:                      %d\n"
            "  WHO/IQVIA calls avoided by memory:   %d\n"
            "  Gate state: historical=%d patterns=%d families=%d",
            m.total_generated,
            m.duplicates_skipped,
            r.get("historical_exact", 0),
            r.get("current_run_exact", 0),
            r.get("phonetic_family", 0),
            r.get("prefix", 0),
            r.get("suffix", 0),
            m.phase2_reasons.get("existing_case_brand", 0),
            m.prefilter_reasons.get("linguistic_knockout", 0),
            m.entered_who_iqvia,
            m.who_iqvia_rejected,
            m.entered_epharmacy,
            m.epharmacy_rejected,
            m.accepted,
            m.rejection_memory_blocked,
            led.get("gate_historical_names", 0),
            led.get("gate_structured_patterns", 0),
            led.get("collision_families", 0),
        )

    # ------------------------------------------------------------------
    # producer: LLM -> deterministic -> WHO/IQVIA -> queue
    # ------------------------------------------------------------------

    async def _generate_batch(self, batch_no: int, still_needed: int) -> List[dict]:
        """Existing generation-quantity rule, unchanged: min(still_needed*3, 30)."""
        from app.services.ai import ai_service

        # EXTERNAL BUDGET -- the existing rule, untouched. This is how many
        # candidates may reach WHO/IQVIA from this batch.
        external_budget = min(still_needed * 3, 30)
        self._external_budget = external_budget
        # LLM POOL -- larger, filtered locally, costs no external call. The
        # surplus is discarded by the local gates and the ranked selection.
        ai_count = min(external_budget * _OVERGENERATION_FACTOR, _MAX_LLM_POOL)
        territory_payload = None
        terr = self._load_territory()
        if terr is not None:
            territory_payload = terr.prompt_payload()
        combined_avoid_names = self.ledger.prompt_avoid_names(
            also_avoid=[c["generated_name"] for c in self.accepted] + list(self.seen_names)
        )
        recent_feedback = self.ledger.ranked_feedback() or None
        # Collect approved candidates with low risk to guide LLM and syllable mutation
        low_risk_cleared = [
            c["generated_name"] for c in self.accepted
            if (c.get("recommendation_status") == "recommended" or c.get("risk_score", 100) < 50)
            and c.get("generated_name")
        ]

        # Burn prefixes of already-approved candidates only if 2+ share the prefix (allow sibling variants)
        prefix_counts: Dict[str, int] = {}
        for c in self.accepted:
            pfx = re.sub(r"[^a-zA-Z]", "", c.get("generated_name", ""))[:4].upper()
            if len(pfx) >= 3:
                prefix_counts[pfx] = prefix_counts.get(pfx, 0) + 1

        accepted_prefix_patterns = {
            f"Prefix '{pfx}' (already multiple approved brands with this stem — do NOT repeat this prefix)"
            for pfx, count in prefix_counts.items()
            if count >= 2
        }
        all_avoid_patterns = self.avoid_pool_2_patterns.union(accepted_prefix_patterns)
        ranked_patterns = self.ledger.ranked_patterns(extra_patterns=all_avoid_patterns)
        repeat_offenders = self.ledger.repeat_offender_families()
        passed_registry = self.registry_candidate_pool if batch_no == 1 else None

        logger.info(
            "[GENERATION BATCH] Batch=%d | target=%d | still_needed=%d | llm_pool=%d | "
            "external_budget=%d | avoid_names=%d | patterns=%d | repeat_offender_brands=%d | "
            "burned_territories=%d | territory_steering=%s | low_risk_cleared=%s",
            batch_no, self.target, still_needed, ai_count, external_budget,
            len(combined_avoid_names), len(ranked_patterns), len(repeat_offenders),
            len(self.burned_territories()),
            "on" if territory_payload else "off",
            low_risk_cleared or "none",
        )

        t0 = time.monotonic()
        try:
            raw = await ai_service.generate_brand_names(
                self.context, self.base_avoid_pool, ai_count,
                rejection_feedback=recent_feedback,
                registry_candidates=passed_registry,
                avoid_patterns=ranked_patterns or None,
                avoid_rejected_names=combined_avoid_names,
                repeat_offenders=repeat_offenders or None,
                explored_families=self.explored_families(),
                burned_territories=self.burned_territories() or None,
                available_territory=territory_payload,
                low_risk_cleared_names=low_risk_cleared or None,
            )
        finally:
            self.metrics.llm_seconds += time.monotonic() - t0

        # Programmatically synthesize syllable & alphanumeric variations of low-risk cleared models
        if low_risk_cleared:
            pref_str = (self.context.get("brand_coining_preferences") or "").lower()
            desc_str = (self.context.get("description") or "").lower()
            style_str = (self.context.get("naming_style") or "").lower()
            attr_str = (self.context.get("product_attributes") or "").lower()
            combined_user_text = f"{pref_str} {desc_str} {style_str} {attr_str}".lower()
            disallow_alphanumeric_triggers = [
                "don't allow alpha", "dont allow alpha", "no alpha", "without alpha",
                "no numbers", "no numerals", "no digits", "zero alphanumeric",
                "pure alphabetic", "pure word", "pure neologism", "don't include numbers",
                "dont include numbers", "no numeric", "without numbers", "exclude alphanumeric"
            ]
            disallow_alphanumeric = any(trigger in combined_user_text for trigger in disallow_alphanumeric_triggers)

            syllable_derived: List[dict] = []
            for lr_name in low_risk_cleared[-2:]:
                # Clean clean base name if already has suffix
                base_clean = re.sub(r"-\d+$", "", lr_name)
                variants = synthesize_syllable_variants(base_clean, count=2)
                if not disallow_alphanumeric:
                    rebus_variants = synthesize_phonetic_rebus(base_clean)
                    if rebus_variants:
                        variants.append(rebus_variants[0])

                for v in variants:
                    v_key = self._norm(v)
                    if v_key and v_key not in self.seen_names:
                        syllable_derived.append({
                            "name": v,
                            "rationale": f"Derived variant from cleared low-risk brand '{lr_name}'.",
                            "creative_concept": "Mutation / formulation variant of low-risk cleared candidate",
                            "phonetic_appeal": "High phonotactic similarity to cleared model",
                        })
            if syllable_derived:
                logger.info(
                    "[SYLLABLE MUTATION] Injected %d sibling variants from cleared models %s: %s",
                    len(syllable_derived), low_risk_cleared[-2:], [x["name"] for x in syllable_derived],
                )
                raw = (raw or []) + syllable_derived

        raw = await self.svc._apply_legal_gate(
            raw, self.context, self.base_avoid_pool, self.cumulative_feedback,
            self.legal_decided_lookup,
            avoid_pool_2_rejected_names=self.avoid_pool_2_rejected_names,
            avoid_pool_2_patterns=self.avoid_pool_2_patterns,
            ledger=self.ledger,
        )
        raw = raw or []
        self.metrics.total_generated += len(raw)
        self.metrics.llm_generated += len(raw)
        stats = self.batch_stats.setdefault(batch_no, BatchStats(batch=batch_no))
        stats.generated = len(raw)
        # Record the structural territory this batch covered.
        sig = _structural_signature([c.get("name") for c in raw])
        for trait in ("initials", "suffixes", "skeletons"):
            _merge_counts(self.explored[trait], sig[trait])
        logger.info("[GENERATION BATCH] Batch=%d | Generated count=%d", batch_no, len(raw))
        return raw

    def _score_batch(self, raw: List[dict], batch_no: int) -> List[dict]:
        """Existing deterministic screening, unchanged (`_score_candidate`)."""
        from app.services.generator import _batch_quality_metrics

        t0 = time.monotonic()
        scored: List[dict] = []
        for item in raw:
            name = (item.get("name") or "").strip()
            key = self._norm(name)
            if not name or not key:
                continue
            if key in self.seen_names:
                self.metrics.duplicates_skipped += 1
                logger.info("  [DUPLICATE SKIPPED] '%s' already seen this run", name)
                continue
            self.seen_names.add(key)
            entry = self.svc._score_candidate(
                name, item, self.context, self.conflict_pool,
                self.therapeutic_area, self.molecule, self.request, self.user_id,
            )
            # Origin batch, for yield attribution and for `loop_approved`. In the
            # old serial loop a candidate was generated and approved in the same
            # iteration, so this preserves that field's original meaning.
            entry["_origin_batch"] = batch_no
            scored.append(entry)
        self.metrics.deterministic_seconds += time.monotonic() - t0
        self.metrics.entered_deterministic += len(scored)
        self.metrics.normalized_unique += len(scored)
        self.batch_stats.setdefault(batch_no, BatchStats(batch=batch_no)).deterministic_survivors = len(scored)
        logger.info(
            "[BATCH QUALITY] %s", _batch_quality_metrics([c.get("name") for c in raw])
        )
        return scored

    def _load_territory(self):
        """Builds the run-level IQVIA/WHO opening-density map — ONE aggregate
        query per run, never per candidate.

        Guidance only: no screening decision, threshold or verdict reads it.
        A failure here degrades to no steering, never to a blocked run.
        """
        if self._territory_loaded:
            return self.territory
        self._territory_loaded = True
        try:
            from app.core.database import SessionLocal
            from app.repositories.screening import ScreeningRepository
            from app.services.territory import TerritoryMap

            with SessionLocal() as db:
                repo = ScreeningRepository(db)
                iqvia = repo.iqvia_prefix_density(active_only=True)
                try:
                    who = repo.who_inn_prefix_density()
                except Exception:
                    who = {}
            self.territory = TerritoryMap(iqvia_density=iqvia, who_density=who)
            payload = self.territory.prompt_payload()
            logger.info(
                "[TERRITORY MAP] Built from 1 aggregate query | IQVIA prefixes=%d | "
                "WHO prefixes=%d | sparse_cut<=%d | crowded_cut>=%d | sparse_sample=%s",
                len(iqvia), len(who), self.territory.sparse_cut, self.territory.crowded_cut,
                (payload or {}).get("sparse_openings", [])[:8] or "none",
            )
        except Exception as exc:
            logger.warning(
                "[TERRITORY MAP] Unavailable (%s) — generation proceeds without "
                "positive steering; screening is unaffected.", exc,
            )
            self.territory = None
        return self.territory

    def _local_eligibility(self, scored: List[dict], batch_no: int) -> List[dict]:
        """Generation-time quality filter on the OVER-GENERATED pool.

        Drops candidates that use banned morphology or a protected INN stem.
        This is NOT a business rejection: these candidates are simply not worth
        an external-verification slot while better ones are available in the
        same pool. Nothing is persisted as a rejection and no screening rule
        changes -- screening would have reached the same verdict later, at the
        cost of a WHO/IQVIA call.

        Length is never a criterion.
        """
        from app.services.ai import check_exclusion_profile
        from app.services.territory import ends_with_protected_stem

        eligible: List[dict] = []
        banned_n = inn_n = 0
        for entry in scored:
            name = entry["generated_name"]
            stem = ends_with_protected_stem(name)
            if stem:
                inn_n += 1
                logger.info(
                    "[LOCAL FILTER] Candidate='%s' | reason='inn_stem' | stem='-%s' "
                    "| not selected for external verification", name, stem,
                )
                continue
            hits = check_exclusion_profile(name)
            if hits:
                banned_n += 1
                logger.info(
                    "[LOCAL FILTER] Candidate='%s' | reason='banned_morphology' | hits=%s "
                    "| not selected for external verification", name, ",".join(hits),
                )
                continue
            eligible.append(entry)

        self.metrics.banned_morphology_blocked += banned_n
        self.metrics.inn_stem_blocked += inn_n
        self.metrics.local_eligible += len(eligible)
        stats = self.batch_stats.setdefault(batch_no, BatchStats(batch=batch_no))
        stats.local_eligible = len(eligible)
        if banned_n or inn_n:
            logger.info(
                "[LOCAL FILTER] Batch=%d | evaluated=%d | banned_morphology=%d | "
                "inn_stem=%d | eligible=%d",
                batch_no, len(scored), banned_n, inn_n, len(eligible),
            )
        # Never starve the batch: if the quality filter removed everything, fall
        # back to the un-filtered pool rather than returning nothing. Screening
        # stays authoritative either way.
        if not eligible and scored:
            logger.warning(
                "[LOCAL FILTER] Batch=%d | every candidate used banned morphology or a "
                "protected stem — falling back to the unfiltered pool so the batch is "
                "not starved", batch_no,
            )
            return scored
        return eligible

    def _select_for_external(self, entries: List[dict], batch_no: int) -> List[dict]:
        """Ranks the eligible pool and takes only the batch's external budget.

        THE NUMBER REACHING WHO/IQVIA IS UNCHANGED. Over-generation widens the
        pool this selection draws from; it does not widen what leaves it.
        """
        from app.services.territory import rank_candidates

        budget = self._external_budget or len(entries)
        ranked = rank_candidates(
            entries,
            territory=self._load_territory(),
            burned_territories=self.burned_territories(),
            seen_openings=self.selected_openings,
            seen_suffixes=self.selected_suffixes,
        )
        selected = [e for e, _s, _w in ranked[:budget]]
        not_selected = len(entries) - len(selected)

        for e, score, why in ranked[:budget]:
            key = self._norm(e["generated_name"])
            self.selected_openings[key[:2]] = self.selected_openings.get(key[:2], 0) + 1
            end = key[-3:] if len(key) >= 4 else key
            self.selected_suffixes[end] = self.selected_suffixes.get(end, 0) + 1

        self.metrics.external_selected += len(selected)
        self.metrics.external_not_selected += not_selected
        terr = self._load_territory()
        if terr is not None and not terr.is_empty():
            sparse_n = sum(1 for e in selected if terr.classify(e["generated_name"]) == "sparse")
            self.metrics.sparse_generated += sparse_n
        else:
            sparse_n = 0
        stats = self.batch_stats.setdefault(batch_no, BatchStats(batch=batch_no))
        stats.external_selected = len(selected)
        logger.info(
            "[EXTERNAL SELECTION] Batch=%d | eligible=%d | budget=%d | selected=%d | "
            "held_back=%d | sparse_territory=%d | top=%s",
            batch_no, len(entries), budget, len(selected), not_selected, sparse_n,
            [(e["generated_name"], s) for e, s, _ in ranked[:3]],
        )
        return selected

    def _note_blocked(self, cand_name: str, block: Dict[str, Any]) -> None:
        """Records that a gate stopped this candidate — generation feedback only.

        Nothing here touches the ledger, the rejection memory or any verdict.
        It exists so the NEXT prompt can say "this exact territory has now
        burned N of your candidates", which is the one fact the previous
        prompt had no way to express.
        """
        self.blocked_candidate_names.append(cand_name)
        kind, value = block.get("kind"), block.get("value")
        if kind and value:
            key = f"{kind}:{value}"
        else:
            key = block.get("reason") or "unknown"
        self.blocked_territory_counts[key] = self.blocked_territory_counts.get(key, 0) + 1
        # Blocked names still describe territory the model has explored, so
        # they belong in the structural signature that steers diversification.
        sig = _structural_signature([cand_name])
        for trait in ("initials", "suffixes", "skeletons"):
            _merge_counts(self.explored[trait], sig[trait])
        _merge_counts(self.explored_rejected["initials"], sig["initials"])
        _merge_counts(self.explored_rejected["suffixes"], sig["suffixes"])

    def burned_territories(self, limit: int = 12) -> List[Dict[str, Any]]:
        """Territories ranked by how many candidates they have actually blocked.

        This is the actionable steering signal: `ranked_patterns` can only say
        a pattern exists, not that it has already cost the model 15 slots.
        """
        ordered = sorted(
            self.blocked_territory_counts.items(), key=lambda kv: (-kv[1], kv[0])
        )
        out: List[Dict[str, Any]] = []
        for key, count in ordered[:limit]:
            if ":" in key:
                kind, value = key.split(":", 1)
            else:
                kind, value = key, ""
            out.append({"kind": kind, "value": value, "blocked": count})
        return out

    def _rejection_memory_gate(self, scored: List[dict], batch_no: int) -> List[dict]:
        """Deterministic Avoid-Pool enforcement, BEFORE any external call.

        The prompt already carries Avoid Pool 1 + 2, but an LLM instruction is
        advisory. This gate is authoritative: whatever the model emits, a name
        already known bad never reaches WHO/IQVIA again.

        Three checks, in order of how specific the evidence is:
          1. exact rejection this run   (ledger.session_names)
          2. exact rejection previously (Avoid Pool 1, seeded at run start)
          3. rejected territory         (prefix / suffix / phonetic family)

        Introduces NO threshold and NO score. Every check is a lookup against
        evidence an EXISTING screening stage already produced; territory
        matching is anchored (startswith / endswith / whole phonetic code),
        never substring, so an unrelated shared fragment cannot block a name.
        """
        survivors: List[dict] = []
        reasons: Dict[str, int] = {}
        stats = self.batch_stats.setdefault(batch_no, BatchStats(batch=batch_no))

        for entry in scored:
            cand_name = entry["generated_name"]

            block = self.ledger.exact_block(cand_name)
            if block is None:
                block = self.ledger.pattern_block(cand_name)

            if block is None:
                # Prevent prefix saturation (allow max 2 brands per 4-letter prefix to enable sibling syllable variations)
                cand_prefix = re.sub(r"[^a-zA-Z]", "", cand_name)[:4].lower()
                if len(cand_prefix) >= 3:
                    prefix_hit_count = sum(
                        1 for acc in self.accepted
                        if re.sub(r"[^a-zA-Z]", "", acc.get("generated_name", ""))[:4].lower() == cand_prefix
                    )
                    if prefix_hit_count >= 2:
                        block = {
                            "reason": "approved_prefix_duplicate",
                            "kind": "prefix",
                            "value": cand_prefix.upper(),
                            "origin": f"2+ already-approved brands share prefix '{cand_prefix.upper()}'",
                            "hits": prefix_hit_count,
                        }

            if block is None:
                survivors.append(entry)
                continue

            reason = block["reason"]
            reasons[reason] = reasons.get(reason, 0) + 1
            self.metrics.rejection_memory_blocked += 1
            self._note_blocked(cand_name, block)
            self.metrics.rejection_memory_reasons[reason] = (
                self.metrics.rejection_memory_reasons.get(reason, 0) + 1
            )
            if reason.endswith("_exact"):
                logger.info(
                    "[PREFILTER REJECT] Candidate='%s' | reason='%s' | original_rejection='%s' "
                    "| matched='%s' | WHO/IQVIA NOT CALLED",
                    cand_name, reason, block.get("original_rejection") or "n/a",
                    block.get("matched") or "n/a",
                )
            else:
                logger.info(
                    "[PREFILTER REJECT] Candidate='%s' | reason='%s' | %s='%s' | from='%s' "
                    "| seen=%dx | WHO/IQVIA NOT CALLED",
                    cand_name, reason, block.get("kind"), block.get("value"),
                    block.get("origin") or "n/a", block.get("hits", 1),
                )

        self.metrics.rejection_memory_evaluated += len(scored)
        stats.rejection_memory_blocked = len(scored) - len(survivors)
        logger.info(
            "[REJECTION MEMORY] Batch=%d | evaluated=%d | blocked=%d %s | survivors=%d | "
            "WHO/IQVIA calls avoided=%d",
            batch_no, len(scored), len(scored) - len(survivors), reasons or "{}",
            len(survivors), len(scored) - len(survivors),
        )
        if scored:
            b = self.batch_stats.setdefault(batch_no, BatchStats(batch=batch_no))
            m, r = self.metrics, self.metrics.rejection_memory_reasons
            uniq = b.deterministic_survivors or len(scored)
            logger.info(
                "\n[GENERATION QUALITY] Batch=%d\n"
                "  llm_generated=%d  normalized_unique=%d  duplicate_count=%d\n"
                "  historical_blocked=%d  current_run_blocked=%d  phonetic_family_blocked=%d\n"
                "  prefix_blocked=%d  suffix_blocked=%d\n"
                "  banned_morphology_blocked=%d  inn_stem_blocked=%d\n"
                "  local_eligible=%d  external_selected=%d  external_not_selected=%d\n"
                "  local_survival_rate=%.2f  external_selection_rate=%.2f\n"
                "  gate_block_rate=%.0f%%  top_burned=%s",
                batch_no,
                b.generated, uniq, m.duplicates_skipped,
                r.get("historical_exact", 0), r.get("current_run_exact", 0),
                r.get("phonetic_family", 0), r.get("prefix", 0), r.get("suffix", 0),
                m.banned_morphology_blocked, m.inn_stem_blocked,
                m.local_eligible, m.external_selected, m.external_not_selected,
                (m.local_eligible / m.normalized_unique) if m.normalized_unique else 0.0,
                (m.external_selected / m.normalized_unique) if m.normalized_unique else 0.0,
                (len(scored) - len(survivors)) / len(scored) * 100,
                [f"{t['kind']}:{t['value']}={t['blocked']}" for t in self.burned_territories(3)] or "none",
            )
        return survivors

    def _case_brand_index(self) -> Dict[str, Dict[str, str]]:
        """Normalized index of the brands THIS CASE's brief already lists.

        Built once, lazily, from `base_avoid_pool` entries tagged by
        `generator._split_names` ("Domestic Brand (existing)", "International
        Brand (existing)", "Innovator Brand (existing)"). Those are supplied on
        the request itself, so this costs no query, no network and no LLM call.

        These are REFERENCE brands, deliberately kept out of Phase 1's
        rejection memory: they were never candidates this system generated and
        rejected, and folding them in would corrupt the ledger's
        rejected-candidate / matched-brand distinction.
        """
        if self._case_brands is not None:
            return self._case_brands
        from app.services.rejection_memory import normalize_for_avoid

        index: Dict[str, Dict[str, str]] = {}
        for entry in self.base_avoid_pool or []:
            source = (entry or {}).get("source") or ""
            if "(existing)" not in source:
                continue
            name = (entry or {}).get("name")
            key = normalize_for_avoid(name)
            if key and key not in index:
                index[key] = {"name": name, "source": source}
        self._case_brands = index
        return index

    def _phase2_gate(self, scored: List[dict], batch_no: int) -> List[dict]:
        """Phase 2: cheap deterministic checks, after Phase 1, before WHO/IQVIA.

        Currently one rule -- `existing_case_brand`: a candidate whose
        normalized form is EXACTLY a brand the case brief already lists as in
        use (domestic / international / innovator). Such a candidate is not a
        new brand at all, so paying WHO + IQVIA to discover that is waste.

        Deliberately EXACT-match only. No prefix, suffix, substring or
        phonetic matching is applied to reference brands -- that is Phase 1's
        job for rejected candidates, and applying it here would blanket-block
        legitimate coinages that merely resemble a marketed product, which is
        precisely what WHO/IQVIA exist to adjudicate.

        Length is never a criterion here.
        """
        from app.services.rejection_memory import normalize_for_avoid

        brands = self._case_brand_index()
        if not brands:
            self.metrics.phase2_evaluated += len(scored)
            return scored

        survivors: List[dict] = []
        reasons: Dict[str, int] = {}
        for entry in scored:
            cand_name = entry["generated_name"]
            hit = brands.get(normalize_for_avoid(cand_name))
            if hit is None:
                survivors.append(entry)
                continue

            reasons["existing_case_brand"] = reasons.get("existing_case_brand", 0) + 1
            self.metrics.phase2_blocked += 1
            self.metrics.phase2_reasons["existing_case_brand"] = (
                self.metrics.phase2_reasons.get("existing_case_brand", 0) + 1
            )
            self._note_blocked(cand_name, {"reason": "existing_case_brand"})
            self.total_rejected_count += 1
            logger.info(
                "[PREFILTER REJECT] Candidate='%s' | reason='existing_case_brand' "
                "| detail='already listed on this case as %s (%s)' | WHO/IQVIA NOT CALLED",
                cand_name, hit["name"], hit["source"],
            )

        self.metrics.phase2_evaluated += len(scored)
        stats = self.batch_stats.setdefault(batch_no, BatchStats(batch=batch_no))
        stats.phase2_blocked = len(scored) - len(survivors)
        if reasons:
            logger.info(
                "[PHASE 2] Batch=%d | evaluated=%d | blocked=%d %s | survivors=%d | "
                "WHO/IQVIA calls avoided=%d",
                batch_no, len(scored), len(scored) - len(survivors), reasons,
                len(survivors), len(scored) - len(survivors),
            )
        return survivors

    def _prefilter(self, scored: List[dict], batch_no: int) -> List[dict]:
        """Cheap deterministic gate between deterministic screening and WHO/IQVIA.

        This introduces NO new rule and NO new threshold. It only acts on a
        verdict `_score_candidate` has ALREADY reached for this candidate, by
        running the existing `validate_linguistic_structure` check.

        Previously that verdict was computed and then ignored: a candidate
        already marked `is_linguistically_invalid` was still sent to
        `_check_local_registries`, where `_gather_evidence`'s Stage 0 ran the
        very same check and rejected it for the very same reason — after paying
        for the WHO INN and IQVIA lookups (and, on that path, an embeddings
        round-trip). Gating here means those external calls are never made.

        RESULT PRESERVATION: for such a candidate the old pipeline produced
        `stopped_at_stage=1`, `conflict_type=LINGUISTIC_KNOCKOUT`,
        `severity=HIGH`, `similarity_score=1.0`, with the reason string from
        `validate_linguistic_structure`. The conflict built below is that same
        shape with that same reason, so the verdict is identical — only its
        timing changes. A candidate that passes still reaches WHO/IQVIA.
        """
        from app.services.generator import _extract_avoid_patterns, _as_rejected_record

        survivors: List[dict] = []
        reasons: Dict[str, int] = {}

        for entry in scored:
            cd = entry.get("conflict_details") or {}
            if not cd.get("is_linguistically_invalid"):
                survivors.append(entry)
                continue

            cand_name = entry["generated_name"]
            detail = cd.get("rationale") or "Failed linguistic & phonotactic validation."
            # Same conflict shape Stage 0 of _gather_evidence produces.
            conflict = {
                "name": cand_name,
                "conflicting_name": cand_name,
                "source": "Linguistic & Phonotactic Rules (FDA/CDSCO)",
                "conflict_type": "LINGUISTIC_KNOCKOUT",
                "similarity_score": 1.0,
                "severity": "HIGH",
                "details": detail,
            }
            evidence = {
                "is_linguistic_knockout": True,
                "stopped_at_stage": 1,
                "stopped_stage_name": "Linguistic & Pronounceability Check",
                "stopped_conflict": conflict,
                "rejection_reason": detail,
            }
            entry["_market_conflict"] = conflict
            entry["_market_evidence"] = evidence

            reasons["linguistic_knockout"] = reasons.get("linguistic_knockout", 0) + 1
            self.total_rejected_count += 1
            self.metrics.prefilter_rejected += 1
            new_pats = _extract_avoid_patterns(cand_name, None)
            self.avoid_pool_2_patterns.update(new_pats)
            self.cumulative_feedback.append(
                self.ledger.record(cand_name, conflict, evidence=evidence, patterns=new_pats)
            )
            self.rejected_for_persist.append(_as_rejected_record(entry, conflict, evidence))
            logger.info(
                "  [PREFILTER REJECTION] '%s' -> linguistic_knockout: %s "
                "(WHO/IQVIA and all external verification skipped)",
                cand_name, detail,
            )

        self.metrics.prefilter_evaluated += len(scored)
        self.metrics.prefilter_survivors += len(survivors)
        for k, v in reasons.items():
            self.metrics.prefilter_reasons[k] = self.metrics.prefilter_reasons.get(k, 0) + v
        stats = self.batch_stats.setdefault(batch_no, BatchStats(batch=batch_no))
        stats.prefilter_evaluated = len(scored)
        stats.prefilter_rejected = len(scored) - len(survivors)
        logger.info(
            "[PREFILTER] Batch=%d | evaluated=%d | rejected=%d %s | survivors=%d | "
            "external verification avoided for %d candidate(s)",
            batch_no, len(scored), len(scored) - len(survivors),
            reasons or "{}", len(survivors), len(scored) - len(survivors),
        )
        return survivors

    async def _screen_who_iqvia(self, scored: List[dict]) -> List[dict]:
        """Existing Tier 1 (WHO INN + IQVIA), unchanged call and concurrency."""
        from app.services.generator import _extract_avoid_patterns, _as_rejected_record
        from app.services.rejection_memory import normalize_for_avoid

        t0 = time.monotonic()
        local_sem = asyncio.Semaphore(1)

        async def _one(entry: dict):
            async with local_sem:
                res = await self.svc._check_local_registries(
                    entry["generated_name"], self.toggles, self.case_context
                )
            conflict, _who_hits, conflicts, ev, sc, sm = res
            entry["_market_conflict"] = conflict
            entry["_market_evidence"] = ev
            entry["_market_scores"] = sc
            entry["_market_sims"] = sm
            entry["_market_all_conflicts"] = conflicts

        self.metrics.entered_who_iqvia += len(scored)
        await asyncio.gather(*(_one(e) for e in scored))
        self.metrics.who_iqvia_seconds += time.monotonic() - t0

        survivors: List[dict] = []
        rejected = 0
        for entry in scored:
            conflict = entry.get("_market_conflict")
            if not conflict:
                survivors.append(entry)
                continue
            rejected += 1
            self.total_rejected_count += 1
            cand_name = entry["generated_name"]
            conf_name = conflict.get("name") or cand_name
            conf_src = conflict.get("source", "Local DB")
            new_pats = _extract_avoid_patterns(cand_name, conf_name)
            self.avoid_pool_2_patterns.update(new_pats)
            # Only the REJECTED CANDIDATE goes in the rejected-name pool. The
            # brand it matched (conf_name) is evidence for WHY it failed, not a
            # name we generated — appending it here previously spent the capped
            # prompt budget on real market brands the model never proposes, and
            # blurred "candidate we must not repeat" into "external reference".
            # The ledger keeps the matched brand separately, in collision_hits.
            existing = {normalize_for_avoid(x) for x in self.avoid_pool_2_rejected_names}
            if normalize_for_avoid(cand_name) not in existing:
                self.avoid_pool_2_rejected_names.append(cand_name)
            self.cumulative_feedback.append(
                self.ledger.record(
                    cand_name, conflict,
                    evidence=entry.get("_market_evidence"), patterns=new_pats,
                )
            )
            self.rejected_for_persist.append(
                _as_rejected_record(entry, conflict, entry.get("_market_evidence"))
            )
            logger.info(
                "  [TIER 1 REJECTION] '%s' collided with '%s' (%s) -> Avoid Pool 2 patterns: %s",
                cand_name, conf_name, conf_src, new_pats,
            )

        self.metrics.who_iqvia_survivors += len(survivors)
        self.metrics.who_iqvia_rejected += rejected
        for entry in scored:
            b = self.batch_stats.setdefault(
                entry.get("_origin_batch", 0), BatchStats(batch=entry.get("_origin_batch", 0))
            )
            b.who_evaluated += 1
            if not entry.get("_market_conflict"):
                b.who_survivors += 1
        # Structural traits screening actually rejected — the strongest signal
        # for steering the next batch elsewhere.
        rej_sig = _structural_signature(
            [e["generated_name"] for e in scored if e.get("_market_conflict")]
        )
        _merge_counts(self.explored_rejected["initials"], rej_sig["initials"])
        _merge_counts(self.explored_rejected["suffixes"], rej_sig["suffixes"])
        logger.info(
            "[WHO/IQVIA SUMMARY] Generated=%d | Deterministic survivors=%d | WHO/IQVIA evaluated=%d | "
            "survivors=%d | rejected=%d",
            len(scored), len(scored), len(scored), len(survivors), rejected,
        )
        return survivors

    async def _producer(self) -> None:
        """Generates, screens and enqueues — never waits on e-pharmacy."""
        from app.services.ai import AIServiceError

        status_order = {"recommended": 0, "review_required": 1, "high_risk": 2}
        batch_no = 0
        try:
            while batch_no < self.max_batches and not self._target_met.is_set():
                deficit = self.deficit()
                if deficit <= 0:
                    # Downstream already holds enough candidates to satisfy the
                    # target — do NOT generate. Wait for a worker verdict to
                    # change supply, then re-evaluate.
                    logger.info(
                        "[REPLENISHMENT] Target=%d | Downstream Supply=%d | Deficit=%d | "
                        "No further generation required — waiting on e-pharmacy verdicts",
                        self.target, self.downstream_supply(), deficit,
                    )
                    self._supply_changed.clear()
                    waiter = asyncio.create_task(self._supply_changed.wait())
                    met = asyncio.create_task(self._target_met.wait())
                    done, pending = await asyncio.wait(
                        {waiter, met}, return_when=asyncio.FIRST_COMPLETED
                    )
                    for p in pending:
                        p.cancel()
                    if self._target_met.is_set():
                        break
                    if self.queue.queued == 0 and self.queue.in_flight == 0 and self.deficit() <= 0:
                        break
                    continue

                batch_no += 1
                self.metrics.batches = batch_no
                if self.queue.in_flight > 0 or self.queue.queued > 0:
                    self.metrics.overlap_events += 1
                    logger.info(
                        "[OVERLAP] Starting LLM batch %d while %d candidate(s) are in e-pharmacy "
                        "(queued=%d, in-flight=%d)",
                        batch_no, self.queue.queued + self.queue.in_flight,
                        self.queue.queued, self.queue.in_flight,
                    )
                logger.info(
                    "[REPLENISHMENT] Target=%d | Downstream Supply=%d | Deficit=%d",
                    self.target, self.downstream_supply(), deficit,
                )
                logger.info("[REPLENISHMENT] Starting candidate batch %d", batch_no)

                await self.emit({
                    "stage": 2, "step_index": 1, "percent": 35, "status": "in_progress",
                    "title": "AI Linguistic Brand Synthesis",
                    "subtitle": (
                        f"Batch {batch_no}: Generating {min(deficit * 3, 30)} coined candidates "
                        f"(need {deficit} more low/medium names)..."
                    ),
                    "live_names": self.serialize_live(),
                    "approved_count": len(self.accepted),
                    "target_count": self.target,
                })

                try:
                    raw = await self._generate_batch(batch_no, deficit)
                except AIServiceError as exc:
                    logger.error("[AI SYNTHESIS ERROR] batch=%d %s", batch_no, exc)
                    await self.emit({
                        "stage": 2, "step_index": 1, "percent": 35, "status": "failed",
                        "title": "AI Linguistic Brand Synthesis", "error": str(exc),
                        "live_names": self.serialize_live(),
                        "approved_count": len(self.accepted),
                        "target_count": self.target,
                    })
                    return

                await self.emit({
                    "stage": 2, "step_index": 1, "percent": 50, "status": "completed",
                    "title": "AI Linguistic Brand Synthesis",
                    "subtitle": f"Batch {batch_no}: Generated {len(raw)} candidate proposals.",
                    "live_names": self.serialize_live(),
                    "approved_count": len(self.accepted),
                    "target_count": self.target,
                })

                scored = self._score_batch(raw, batch_no)
                if not scored:
                    logger.warning("[BATCH %d] No new candidates after dedupe/scoring", batch_no)
                    continue

                await self.emit({
                    "stage": 3, "step_index": 2, "percent": 65, "status": "in_progress",
                    "title": "Local Registry Screening (WHO INN & IQVIA)",
                    "subtitle": (
                        f"Batch {batch_no}: Screening all {len(scored)} candidates through "
                        "local WHO INN & IQVIA registries..."
                    ),
                    "live_names": self.serialize_live(),
                    "approved_count": len(self.accepted),
                    "target_count": self.target,
                })

                # Authoritative rejection-memory gate BEFORE the linguistic
                # prefilter and BEFORE any external verification. A name the
                # run (or an earlier run) already rejected stops here, however
                # the LLM chose to spell it.
                scored = self._rejection_memory_gate(scored, batch_no)
                if not scored:
                    logger.warning(
                        "[BATCH %d] All candidates blocked by rejection memory — "
                        "no WHO/IQVIA calls made", batch_no,
                    )
                    continue

                # Phase 2: cheap deterministic checks, after Phase 1's
                # rejection memory and before the linguistic prefilter.
                scored = self._phase2_gate(scored, batch_no)
                if not scored:
                    logger.warning(
                        "[BATCH %d] All candidates blocked by Phase 2 deterministic checks — "
                        "no WHO/IQVIA calls made", batch_no,
                    )
                    continue

                # Cheap deterministic prefilter BEFORE any external
                # verification. Same rules, applied earlier.
                # Generation-time quality filter on the over-generated pool.
                # Not a business rejection -- these candidates simply do not
                # earn an external slot while better ones exist in the pool.
                scored = self._local_eligibility(scored, batch_no)

                scored = self._prefilter(scored, batch_no)
                if not scored:
                    logger.warning(
                        "[BATCH %d] All candidates rejected by the deterministic prefilter — "
                        "no external verification performed", batch_no,
                    )
                    continue
                # Rank the eligible pool and take only this batch's external
                # budget. Over-generation widens the pool, never the number of
                # candidates that reach WHO/IQVIA.
                scored = self._select_for_external(scored, batch_no)
                survivors = await self._screen_who_iqvia(scored)
                survivors.sort(
                    key=lambda r: (status_order.get(r["recommendation_status"], 3), r["risk_score"])
                )

                await self.emit({
                    "stage": 3, "step_index": 2, "percent": 70, "status": "completed",
                    "title": "Local Registry Screening Complete",
                    "subtitle": (
                        f"Batch {batch_no}: Forwarding {len(survivors)} WHO/IQVIA-clean "
                        "candidates to live e-pharmacy screening."
                    ),
                    "live_names": self.serialize_live(),
                    "approved_count": len(self.accepted),
                    "target_count": self.target,
                })

                self.survivors_pending = len(survivors)
                for entry in survivors:
                    entry.setdefault("_epharmacy_attempt", 1)
                    await self.queue.put(entry)
                    self.survivors_pending -= 1
                    self.metrics.entered_epharmacy += 1
                    self.batch_stats.setdefault(
                        entry.get("_origin_batch", batch_no),
                        BatchStats(batch=entry.get("_origin_batch", batch_no)),
                    ).epharmacy_entered += 1
                    logger.info(
                        "[E-PHARMACY QUEUE] Added '%s' | Queue Size=%d",
                        entry["generated_name"], self.queue.qsize(),
                    )
                self.survivors_pending = 0
                self._supply_changed.set()
                # Loop straight back to the deficit check — no waiting on
                # e-pharmacy. This is what produces the overlap.
        finally:
            self._producer_running = False
            self._supply_changed.set()
            logger.info(
                "[PRODUCER] Finished after %d batch(es) (max=%d)", batch_no, self.max_batches
            )

    # ------------------------------------------------------------------
    # workers: e-pharmacy + Google -> rescore -> accept/reject
    # ------------------------------------------------------------------

    async def _worker(self, worker_id: int) -> None:
        while True:
            item = await self.queue.get()
            if item is DONE:
                self.queue.task_done(was_item=False)
                return
            entry = item
            cand_name = entry.get("generated_name", "?")
            active = self.queue.enter()
            self.metrics.max_observed_concurrency = max(
                self.metrics.max_observed_concurrency, active
            )
            logger.info(
                "[E-PHARMACY WORKER %d] Started '%s' | active=%d | queue=%d",
                worker_id, cand_name, active, self.queue.qsize(),
            )
            t0 = time.monotonic()
            try:
                if self._target_met.is_set():
                    logger.info(
                        "[E-PHARMACY WORKER %d] Target already met — skipping '%s'",
                        worker_id, cand_name,
                    )
                    continue

                res = await self.svc._check_all_portals(cand_name, self.toggles, self.case_context)
                conflict, listings, portal_hits, all_conflicts, ev, sc, sm = res
                entry["_market_conflict"] = conflict
                entry["_market_listings"] = listings
                entry["_market_portal_hits"] = portal_hits
                entry["_market_all_conflicts"] = all_conflicts
                entry["_market_evidence"] = ev
                entry["_market_scores"] = sc
                entry["_market_sims"] = sm

                await self._finalise(entry, conflict, worker_id)
                logger.info("[E-PHARMACY WORKER %d] Completed '%s'", worker_id, cand_name)

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Infrastructure/browser failure (e.g. the Windows
                # NotImplementedError from asyncio.create_subprocess_exec).
                # The candidate is NOT accepted and NOT treated as clean — it is
                # dropped from this run's supply so replenishment can replace it.
                # Other workers keep running.
                self.metrics.epharmacy_failed += 1
                logger.error(
                    "[E-PHARMACY WORKER %d] FAILED '%s': %s — candidate dropped as UNVERIFIED "
                    "(not treated as clean); queue continues",
                    worker_id, cand_name, exc, exc_info=True,
                )
            finally:
                self.metrics.epharmacy_seconds += time.monotonic() - t0
                self.queue.leave()
                self.queue.task_done()
                self._supply_changed.set()

    async def _finalise(self, entry: dict, conflict: Optional[dict], worker_id: int) -> None:
        """Applies the EXISTING rescore + acceptance rules. Nothing here
        redefines what 'approved' means."""
        from app.services.generator import _extract_avoid_patterns, _as_rejected_record
        from app.services.market_check import google_search_configured
        from app.services.rejection_memory import normalize_for_avoid

        market_evidence = {
            "who_inn_checked": self.toggles.get("who_inn_enabled", True),
            "iqvia_checked": self.toggles.get("iqvia_enabled", True),
            "pharmacy_checked": self.toggles.get("epharmacy_enabled", True),
            "google_checked": google_search_configured() and self.toggles.get("google_search_enabled", True),
            "conflicts_found": entry.get("_market_all_conflicts") or ([conflict] if conflict else []),
            "portal_hits": entry.get("_market_portal_hits") or {},
        }
        entry["conflict_details"]["market_check"] = market_evidence
        self.svc._rescore_candidate_with_market(
            entry, entry.get("_market_listings") or [], conflict, self.max_market_attempts,
            evidence=entry.get("_market_evidence"), scores=entry.get("_market_scores"),
            similar_names=entry.get("_market_sims"), case_context=self.case_context,
        )

        async with self._lock:
            cand_clean = {k: v for k, v in entry.items() if not k.startswith("_")}
            status = cand_clean.get("recommendation_status", "high_risk")
            risk = cand_clean.get("risk_score", 100.0)
            key = self._norm(cand_clean["generated_name"])

            cand_name_raw = cand_clean["generated_name"]
            from Levenshtein import ratio as levenshtein_similarity
            cand_prefix = re.sub(r"[^a-zA-Z0-9]", "", cand_name_raw)[:4].lower()
            cand_len = len(re.sub(r"[^a-zA-Z0-9]", "", cand_name_raw))
            prefix_hit_count = sum(
                1 for c in self.accepted
                if re.sub(r"[^a-zA-Z0-9]", "", c.get("generated_name", ""))[:4].lower() == cand_prefix
            ) if len(cand_prefix) >= 3 else 0
            is_prefix_dup = (prefix_hit_count >= 2)
            is_near_dup = any(
                levenshtein_similarity(cand_name_raw.lower(), c.get("generated_name", "").lower()) >= 0.88
                for c in self.accepted
            )
            is_forbidden_len = (cand_len < 5 or cand_len > 15)

            if is_prefix_dup:
                logger.info("  [ACCEPTANCE SKIP] '%s' saturated prefix '%s' (>= 2 already accepted)", cand_name_raw, cand_prefix.upper())
            if is_near_dup:
                logger.info("  [ACCEPTANCE SKIP] '%s' is a near-duplicate of an already-accepted brand", cand_name_raw)
            if is_forbidden_len:
                logger.info("  [ACCEPTANCE SKIP] '%s' has %d letters (must be between 5 and 15 letters)", cand_name_raw, cand_len)

            # Acceptance rule allowing syllable variations while preventing prefix saturation and near-duplicates
            if (
                status in ("recommended", "review_required")
                and risk < 65.0
                and key not in self.accepted_keys
                and not is_prefix_dup
                and not is_near_dup
                and not is_forbidden_len
            ):
                origin = entry.get("_origin_batch", self.metrics.batches)
                cand_clean["loop_approved"] = origin
                cand_clean["rejected_before_count"] = self.total_rejected_count
                cd = cand_clean.get("conflict_details")
                if not isinstance(cd, dict):
                    cd = {}
                    cand_clean["conflict_details"] = cd
                cd["loop_approved"] = origin
                cd["rejected_before_count"] = self.total_rejected_count
                elapsed = round(time.monotonic() - self._pipeline_start, 1)
                cand_clean["time_to_generate_seconds"] = elapsed
                cd["time_to_generate_seconds"] = elapsed

                self.accepted.append(cand_clean)
                self.accepted_keys.add(key)
                self.metrics.accepted = len(self.accepted)
                self.batch_stats.setdefault(origin, BatchStats(batch=origin)).final_accepted += 1
                logger.info(
                    "[NAME APPROVED] '%s' | Status: %s | Risk: %.1f | accepted=%d/%d",
                    cand_clean["generated_name"], status.upper(), risk,
                    len(self.accepted), self.target,
                )
                if len(self.accepted) >= self.target:
                    self._target_met.set()
            else:
                self.total_rejected_count += 1
                self.metrics.epharmacy_rejected += 1
                cand_name = cand_clean["generated_name"]
                if conflict:
                    conf_name = conflict.get("name", "") or cand_name
                    source = conflict.get("source", "Market Database")
                    new_pats = _extract_avoid_patterns(cand_name, conf_name)
                    self.avoid_pool_2_patterns.update(new_pats)
                    # Only the REJECTED CANDIDATE enters the rejected-name pool.
                    # `conf_name` is the external brand that explains WHY this
                    # candidate failed -- it is evidence, not something we
                    # generated. The ledger keeps it separately in
                    # collision_hits (and surfaces it via repeat_offender_families).
                    existing = {normalize_for_avoid(x) for x in self.avoid_pool_2_rejected_names}
                    if normalize_for_avoid(cand_name) not in existing:
                        self.avoid_pool_2_rejected_names.append(cand_name)
                    # Recorded here, inside the e-pharmacy worker, so an
                    # e-pharmacy rejection updates the gate immediately -- the
                    # very next batch's prefilter sees this territory.
                    self.cumulative_feedback.append(
                        self.ledger.record(
                            cand_name, conflict,
                            evidence=entry.get("_market_evidence"), patterns=new_pats,
                        )
                    )
                    self.rejected_for_persist.append(
                        _as_rejected_record(entry, conflict, entry.get("_market_evidence"))
                    )
                    logger.info(
                        "  [TIER 2 COLLISION] '%s' collided with '%s' (%s). Avoid Pool 2: %s",
                        cand_name, conf_name, source, new_pats,
                    )

        await self.emit({
            "stage": 4, "step_index": 3,
            "percent": min(90, 72 + int(len(self.accepted) / max(self.target, 1) * 18)),
            "status": "in_progress",
            "title": "Live E-Pharmacy Market Scraping",
            "subtitle": (
                f"Screened '{entry.get('generated_name')}' "
                f"({len(self.accepted)}/{self.target} collected, "
                f"{self.queue.qsize()} queued, {self.queue.in_flight} in flight)"
            ),
            "live_names": self.serialize_live(),
            "approved_count": len(self.accepted),
            "target_count": self.target,
        })

    # ------------------------------------------------------------------
    # run
    # ------------------------------------------------------------------

    async def run(self) -> List[dict]:
        # Seed exact-name blocking from Avoid Pool 1 (already loaded from
        # generated_brand_names / legal_reviews / review_batch_cart_items).
        # Without this the gate only knows THIS run's rejections, so a name
        # rejected in an earlier run could be regenerated and sent to WHO/IQVIA
        # all over again.
        seeded = self.ledger.seed_historical(self.history_pool)
        logger.info(
            "[REJECTION MEMORY] Gate armed | historical exact names=%d (Avoid Pool 1) | "
            "current-run rejections=%d | structured patterns=%d",
            seeded, len(self.ledger.session_names), len(self.ledger.pattern_index),
        )
        self._producer_running = True
        workers = [
            asyncio.create_task(self._worker(i + 1))
            for i in range(self.queue.concurrency)
        ]
        producer = asyncio.create_task(self._producer())

        try:
            await producer
            # Producer is done; drain whatever is still queued/in flight.
            while not self._target_met.is_set() and (self.queue.queued or self.queue.in_flight):
                self._supply_changed.clear()
                try:
                    await asyncio.wait_for(self._supply_changed.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
        finally:
            await self.queue.shutdown(len(workers))
            for w in workers:
                try:
                    await asyncio.wait_for(w, timeout=30)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    w.cancel()
                except Exception:
                    logger.warning("[E-PHARMACY WORKER] terminated with an error", exc_info=True)

        logger.info(
            "[FINAL] Final accepted count=%d (returning %d) | Target count=%d | Total batches=%d | "
            "Total generated=%d | Total rejected=%d | Max e-pharmacy concurrency=%d",
            len(self.accepted), min(len(self.accepted), self.target), self.target,
            self.metrics.batches, self.metrics.total_generated, self.total_rejected_count,
            self.queue.peak_concurrency,
        )
        self.report_yield()
        logger.info("[METRICS] %s", self.metrics.as_dict())
        return self.accepted[: self.target]
