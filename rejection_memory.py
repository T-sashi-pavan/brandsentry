"""Avoid Pool 2 bookkeeping: what this generation request has learned from its
own rejections, and how that is prioritised into the next LLM prompt.

SCOPE — WHAT THIS IS NOT
------------------------
This module holds NO storage of its own. It creates no table, no cache entry
and no file. Rejected names are persisted through the EXISTING mechanism —
`BrandRepository.save_generated_names` writing `generated_brand_names` rows
with `recommendation_status='high_risk'`, which is exactly what
`BrandRepository.get_high_risk_generated_names` (and therefore
`GeneratorService._load_history_avoid_pool` / Avoid Pool 1) already reads.

All this module does is:

  * read the rejection descriptors the screening pipeline ALREADY produced
    (`matched_parameter`, `conflict_type`, `reject_reason`, `stopped_stage_name`)
    so the next prompt can say WHY a candidate failed, not just that it did;
  * keep the current run's rejected names and collided roots (Avoid Pool 2);
  * rank Avoid Pool 1 + Avoid Pool 2 into a bounded, high-value prompt payload
    instead of a blind tail-slice.

It changes nothing about screening, scoring, thresholds, risk classification
or any workflow. It only decides what avoidance context the LLM is shown
BEFORE it generates.
"""
import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Ceilings on what is sent to the LLM. These are about keeping the prompt
# focused on high-value signal, not about storage — nothing is discarded from
# the database, only from one prompt payload.
MAX_PROMPT_NAMES = 140
MAX_PROMPT_PATTERNS = 24
MAX_PROMPT_FAMILIES = 15
MAX_PROMPT_FEEDBACK = 16

# A collision family is only called out as a "repeat offender" once it has
# actually repeated; below this the per-candidate feedback line already covers
# it.
_REPEAT_OFFENDER_MIN_HITS = 2

_NON_ALNUM = re.compile(r"[^a-z0-9]")

# Affix lengths for pattern extraction. These mirror EXACTLY what
# `generator._extract_avoid_patterns` already slices for its prompt hints
# ("Prefix 'Thry'", "Suffix '-vion'") so the deterministic gate below enforces
# the same territory the prompt describes — no new rule, no new threshold.
PREFIX_LEN = 4
SUFFIX_LEN = 4
_MIN_LEN_FOR_AFFIX = 5


def normalize_for_avoid(name: Optional[str]) -> str:
    """Case- and punctuation-insensitive key used ONLY for avoid-pool
    de-duplication, so "Fynara", "fynara" and "FYNARA" collapse to one entry.

    Deliberately separate from `tabular_import.normalize_name` (which only
    lowercases and collapses whitespace) and from anything in `screening.py`:
    no screening comparison, threshold or score uses this function.
    """
    return _NON_ALNUM.sub("", (name or "").strip().lower())


def dedupe_names(names: Iterable[str]) -> List[str]:
    """Order-preserving, case-insensitive de-duplication."""
    seen: set = set()
    out: List[str] = []
    for n in names:
        if not n or not str(n).strip():
            continue
        key = normalize_for_avoid(n)
        if key and key not in seen:
            seen.add(key)
            out.append(str(n).strip())
    return out


def _phonetic_code(name: str) -> str:
    """The SAME Metaphone helper screening.py uses. Imported lazily so this
    module stays importable without the screening stack."""
    try:
        from app.services.screening import safe_phonetic_code
        return (safe_phonetic_code(name) or "").strip().upper()
    except Exception:  # pragma: no cover - defensive
        return ""


def structured_patterns(
    candidate: str, collided_with: Optional[str] = None,
) -> List[Dict[str, str]]:
    """Machine-matchable twin of `generator._extract_avoid_patterns`.

    Same slices, same phonetic helper — the difference is only the shape: this
    returns `{"kind", "value", "origin"}` records a gate can compare against,
    where `_extract_avoid_patterns` returns display strings for the prompt.
    Both are kept: the prompt wording is unchanged, and the gate no longer has
    to parse prose to enforce what the prompt asks for.

    DELIBERATE ASYMMETRY (see the Avoid-Pool business rules): prefix/suffix
    territory is taken from the REJECTED CANDIDATE only, never from the
    external brand it matched. `Thryvion` failing against `THRIVE` makes
    "Thry-/-vion" a spent territory for our own coining; it does not make
    every name starting "Thri" unusable — that would blanket-block on a real
    market brand the generator was never proposing. The phonetic stem IS taken
    from the pair, because that is the family the screening actually scored.
    """
    out: List[Dict[str, str]] = []
    c = (candidate or "").strip()
    ckey = normalize_for_avoid(c)

    if len(ckey) >= _MIN_LEN_FOR_AFFIX:
        out.append({"kind": "prefix", "value": ckey[:PREFIX_LEN], "origin": c})
        out.append({"kind": "suffix", "value": ckey[-SUFFIX_LEN:], "origin": c})
    elif len(ckey) >= PREFIX_LEN:
        out.append({"kind": "exact", "value": ckey, "origin": c})

    cw = (collided_with or "").strip()
    if cw and len(ckey) >= PREFIX_LEN and len(normalize_for_avoid(cw)) >= PREFIX_LEN:
        code = _phonetic_code(c)
        if code:
            out.append({"kind": "sound", "value": code, "origin": f"{c} ~ {cw}"})
    return out


def pattern_matches(name: str, pattern: Dict[str, str]) -> bool:
    """Deterministic, ANCHORED match of one structured pattern against a name.

    Anchoring matters: prefix/suffix use startswith/endswith and the sound
    stem uses full-code equality. Nothing here does substring containment, so
    a candidate is never blocked for merely carrying an unrelated short
    sequence somewhere in the middle.
    """
    key = normalize_for_avoid(name)
    if not key:
        return False
    kind = pattern.get("kind")
    value = (pattern.get("value") or "").strip()
    if not value:
        return False
    if kind == "prefix":
        return len(key) >= len(value) and key.startswith(value.lower())
    if kind == "suffix":
        return len(key) >= len(value) and key.endswith(value.lower())
    if kind == "exact":
        return key == value.lower()
    if kind == "sound":
        code = _phonetic_code(name)
        return bool(code) and code == value.upper()
    return False


def describe_rejection(
    conflict: Optional[Dict[str, Any]],
    evidence: Optional[Dict[str, Any]] = None,
) -> Tuple[str, str, str, Optional[str]]:
    """Returns (matched_name, source, parameter, reason) by reading descriptors
    the EXISTING screening pipeline already set.

    Nothing here re-derives, re-scores or re-interprets a verdict. The fields
    read are produced by `BrandScreeningService._stage_conflict`
    (`matched_parameter`), `_iqvia_stage_conflict` (`matched_parameter`,
    `reject_reason`) and `_gather_evidence` (`stopped_stage_name`,
    `rejection_reason`, `conflict_type`).
    """
    conflict = conflict or {}
    evidence = evidence or {}

    matched = (conflict.get("name") or conflict.get("conflicting_name") or "").strip()
    source = (conflict.get("source") or evidence.get("stopped_stage_name") or "Screening").strip()

    parameter = (conflict.get("matched_parameter") or "").strip().lower()
    if not parameter:
        ctype = (conflict.get("conflict_type") or "").upper()
        if conflict.get("exact") or "EXACT" in ctype:
            parameter = "exact"
        elif "INN" in ctype:
            parameter = "who-inn stem"
        elif "LINGUISTIC" in ctype:
            parameter = "pronounceability"
        else:
            parameter = "similarity"

    reason = conflict.get("reject_reason") or evidence.get("rejection_reason") or None
    return matched, source, parameter, reason


class RejectionLedger:
    """Per-request Avoid Pool 2 accumulator and prompt-payload builder.

    `prior_rejected` / `prior_names` are injected by the caller from Avoid
    Pool 1 (which the generator already loads from `generated_brand_names`,
    `legal_reviews` and `review_batch_cart_items`) — this class never queries
    the database itself.
    """

    def __init__(self, prior_pool: Optional[List[Dict[str, Any]]] = None) -> None:
        # Avoid Pool 1, as already assembled by _load_history_avoid_pool.
        self.prior_pool: List[Dict[str, Any]] = list(prior_pool or [])

        # This request's own rejections (Avoid Pool 2), oldest first.
        self.session_names: List[str] = []
        self.session_patterns: Dict[str, int] = {}
        self.feedback: List[Dict[str, Any]] = []
        # Real reference names candidates collided WITH, and how often. Kept
        # apart from session_names so a genuine market brand never crowds a
        # rejected candidate out of the capped prompt list — previously both
        # were appended to the same list and shared the same 80-name budget.
        self.collision_hits: Dict[str, Dict[str, Any]] = {}

        self._session_keys: set = {normalize_for_avoid(n) for n in self.session_names}

        # --- deterministic gate state (Avoid Pool 1 + 2) ------------------
        # Structured, matchable twins of session_patterns. Keyed by
        # "kind:value" so the same territory recorded twice counts once.
        self.pattern_index: Dict[str, Dict[str, Any]] = {}
        # Distinct rejected candidates per short (3-char) opening/ending stem.
        # Drives the repeat-territory escalation in _escalate_stems(): one
        # rejection is bad luck and only spends its own 4-char affix; a stem
        # that has now sunk TWO different candidates is an exhausted territory,
        # and the shorter stem is promoted to a blocking pattern. This is the
        # existing "repeat offender" idea applied deterministically -- it is
        # why `Nexithon` (nexi) followed by `Nexolune` (nexo) is caught, which
        # a fixed 4-char prefix cannot see.
        self._stem_candidates: Dict[str, set] = {}
        # Exact names rejected in EARLIER runs, seeded from Avoid Pool 1 by
        # seed_historical(). Kept apart from _session_keys so the gate can
        # report which pool blocked a candidate.
        self._historical_keys: set = set()
        self._historical_meta: Dict[str, Dict[str, Any]] = {}

    # -- deterministic gate ------------------------------------------------

    def seed_historical(self, entries: Iterable[Dict[str, Any]]) -> int:
        """Seeds exact-name blocking from Avoid Pool 1.

        Takes the pool entries `_load_history_avoid_pool` already built from
        `generated_brand_names`, `legal_reviews` and `review_batch_cart_items`.
        Reads them only — no query, no new table, no new persistence.
        """
        added = 0
        for e in entries or []:
            name = (e or {}).get("name")
            key = normalize_for_avoid(name)
            if not key or key in self._historical_keys:
                continue
            self._historical_keys.add(key)
            self._historical_meta[key] = {
                "name": name,
                "source": (e or {}).get("source") or "Avoid Pool 1",
            }
            added += 1
        return added

    def exact_block(self, name: str) -> Optional[Dict[str, Any]]:
        """Exact-name gate. Returns a reason record, or None to allow.

        Current-run rejections are checked first so the more actionable
        reason wins when a name is in both pools.
        """
        key = normalize_for_avoid(name)
        if not key:
            return None
        if key in self._session_keys:
            for item in reversed(self.feedback):
                if normalize_for_avoid(item.get("candidate")) == key:
                    return {
                        "reason": "current_run_exact",
                        "original_rejection": item.get("source"),
                        "matched": item.get("collided_with"),
                        "parameter": item.get("parameter"),
                    }
            return {"reason": "current_run_exact"}
        if key in self._historical_keys:
            meta = self._historical_meta.get(key, {})
            return {
                "reason": "historical_exact",
                "original_rejection": meta.get("source"),
                "matched": meta.get("name"),
            }
        return None

    def pattern_block(self, name: str) -> Optional[Dict[str, Any]]:
        """Rejected-territory gate: prefix / suffix / phonetic family.

        Returns the first matching recorded pattern, or None to allow. Order
        is deterministic (sound stems first, then most-recorded) so the same
        candidate always reports the same reason.
        """
        if not self.pattern_index:
            return None
        ordered = sorted(
            self.pattern_index.values(),
            key=lambda p: (0 if p["kind"] == "sound" else 1, -p.get("hits", 1), p["value"]),
        )
        for pat in ordered:
            # Suffixes alone are natural inflectional word endings in pharma and are NOT
            # blanket-blocked by the prefilter gate (protected INN stems are handled via INN checks).
            if pat["kind"] == "suffix":
                continue
            min_hits = 2 if pat["kind"] == "prefix" else 1
            if pat.get("hits", 1) < min_hits:
                continue
            if pattern_matches(name, pat):
                # Reason vocabulary matches the spec's log contract:
                # phonetic_family / prefix / suffix / exact.
                reason = "phonetic_family" if pat["kind"] == "sound" else pat["kind"]
                return {
                    "reason": reason,
                    "kind": pat["kind"],
                    "value": pat["value"],
                    "origin": pat.get("origin"),
                    "hits": pat.get("hits", 1),
                }
        return None

    # -- recording ---------------------------------------------------------

    def record(
        self,
        candidate: str,
        conflict: Optional[Dict[str, Any]],
        evidence: Optional[Dict[str, Any]] = None,
        patterns: Optional[Iterable[str]] = None,
    ) -> Dict[str, Any]:
        """Records one rejection into Avoid Pool 2 and returns the feedback
        item for the next prompt."""
        candidate = (candidate or "").strip()
        matched, source, parameter, reason = describe_rejection(conflict, evidence)

        key = normalize_for_avoid(candidate)
        if key and key not in self._session_keys:
            self._session_keys.add(key)
            self.session_names.append(candidate)

        mkey = normalize_for_avoid(matched)
        if mkey:
            hit = self.collision_hits.setdefault(mkey, {"name": matched, "source": source, "hits": 0})
            hit["hits"] += 1

        for p in (patterns or []):
            if p:
                self.session_patterns[p] = self.session_patterns.get(p, 0) + 1

        # Structured twin of the display patterns above, so the deterministic
        # gate enforces the same territory the prompt describes. Recorded here
        # — inside record() — which is called immediately after every WHO /
        # IQVIA / e-pharmacy / Google / linguistic rejection, so the gate is
        # live for the very next batch with no reload step.
        for sp in structured_patterns(candidate, matched):
            pkey = f"{sp['kind']}:{sp['value']}"
            existing = self.pattern_index.get(pkey)
            if existing:
                existing["hits"] = existing.get("hits", 1) + 1
            else:
                self.pattern_index[pkey] = {**sp, "hits": 1}

        self._escalate_stems(candidate)

        item: Dict[str, Any] = {
            "candidate": candidate,
            "collided_with": matched,
            "source": source,
            "parameter": parameter,
            # Retained for backward compatibility with the existing prompt
            # builder and any caller still reading this key.
            "avoid_hint": f"'{candidate[:4]}' and similar roots" if candidate else "",
        }
        if reason:
            item["reason"] = reason
        self.feedback.append(item)
        return item

    def _escalate_stems(self, candidate: str) -> None:
        """Promotes a 4-char opening stem (e.g. 'dabr') to a blocking pattern once it
        has sunk at least 3 DIFFERENT candidates.
        Generic suffixes (-is, -on, -or, -ex, -ent, etc.) are common inflectional
        endings in pharma naming and are NOT blanket-banned, preventing artificial
        gate chokeholds on legitimate brand morphology.
        """
        ckey = normalize_for_avoid(candidate)
        if len(ckey) < _MIN_LEN_FOR_AFFIX:
            return
        # Only escalate recurring prefix roots (length >= 4), not generic suffixes
        stem = ckey[:PREFIX_LEN]
        if len(stem) < PREFIX_LEN:
            return
        bucket = self._stem_candidates.setdefault(f"prefix:{stem}", set())
        bucket.add(ckey)
        if len(bucket) < 3:
            return
        pkey = f"prefix:{stem}"
        if pkey not in self.pattern_index:
            self.pattern_index[pkey] = {
                "kind": "prefix",
                "value": stem,
                "origin": f"repeat prefix territory ({len(bucket)} candidates: "
                          f"{', '.join(sorted(bucket)[:3])})",
                "hits": len(bucket),
                "escalated": True,
            }
            logger.info(
                "[REJECTION MEMORY] prefix stem '%s' escalated to a blocking pattern "
                "after %d distinct rejected candidates",
                stem, len(bucket),
            )
        else:
            self.pattern_index[pkey]["hits"] = len(bucket)

    # -- prompt payload ----------------------------------------------------

    def repeat_offender_families(self, limit: int = MAX_PROMPT_FAMILIES) -> List[Dict[str, Any]]:
        """Reference names that have blocked more than one candidate this run.

        Entirely data-derived from what screening actually matched against —
        no name is hard-coded anywhere."""
        ranked = sorted(
            (h for h in self.collision_hits.values() if h["hits"] >= _REPEAT_OFFENDER_MIN_HITS),
            key=lambda h: h["hits"],
            reverse=True,
        )
        return [
            {"name": h["name"], "source": h["source"], "hits": h["hits"]}
            for h in ranked[:limit] if h.get("name")
        ]

    def ranked_patterns(
        self, extra_patterns: Optional[Iterable[str]] = None, limit: int = MAX_PROMPT_PATTERNS
    ) -> List[str]:
        """Collided prefixes / suffixes / sound-stems, most frequent first.

        Frequency beats recency here: a root that has collided five times is a
        territory to leave alone; one that collided once may be bad luck.
        Previously every pattern was passed in arbitrary `set` order, so once
        the set grew the genuinely recurrent roots were indistinguishable from
        one-offs."""
        counts = dict(self.session_patterns)
        for p in (extra_patterns or []):
            if p:
                counts.setdefault(p, 0)
        # Tie-break on the pattern text so ordering is deterministic run to
        # run. `extra_patterns` arrives from a set (avoid_pool_2_patterns), whose
        # iteration order varies between processes; without this, equally-ranked
        # patterns were included or dropped arbitrarily at the cap.
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return [p for p, _ in ranked[:limit]]

    def ranked_feedback(self, limit: int = MAX_PROMPT_FEEDBACK) -> List[Dict[str, Any]]:
        """Most recent rejections, while guaranteeing every distinct failure
        PARAMETER seen this run is represented.

        The previous `cumulative_rejection_feedback[-12:]` could hand the model
        twelve consecutive phonetic rejections and never mention that something
        also failed on spelling or on a WHO INN stem."""
        if not self.feedback:
            return []
        chosen: List[Dict[str, Any]] = []
        chosen_ids: set = set()

        by_param: Dict[str, Dict[str, Any]] = {}
        for item in self.feedback:
            by_param[item.get("parameter") or "similarity"] = item
        for item in by_param.values():
            if id(item) not in chosen_ids:
                chosen.append(item)
                chosen_ids.add(id(item))

        for item in reversed(self.feedback):
            if len(chosen) >= limit:
                break
            if id(item) not in chosen_ids:
                chosen.append(item)
                chosen_ids.add(id(item))

        order = {id(it): i for i, it in enumerate(self.feedback)}
        chosen.sort(key=lambda it: order.get(id(it), 0))
        return chosen[:limit]

    def prompt_avoid_names(
        self,
        also_avoid: Optional[Iterable[str]] = None,
        limit: int = MAX_PROMPT_NAMES,
    ) -> List[str]:
        """The capped "do not regenerate these" list, in priority order:

          1. names rejected in THIS run, most recent first — the model just
             produced them, so they are the likeliest to recur
          2. other names already emitted this run (approved / seen), so a
             duplicate is not proposed twice
          3. historical pipeline rejections from Avoid Pool 1

        Legal-review and cart names are deliberately NOT folded in here: they
        already have their own, clearly-labelled Avoid Pool 1 section in the
        prompt, and repeating them would spend this budget twice on the same
        information.

        Previously this was `avoid_pool_2_rejected_names + approved + seen`
        cut with a bare `[:80]` inside the prompt builder. Because collided
        reference names were appended to the same list, roughly half those
        slots went to real market brands the model was never going to
        generate, and anything past the cap was silently dropped — including
        the most recent rejections.
        """
        tiers: List[str] = []
        tiers.extend(reversed(self.session_names))
        tiers.extend(also_avoid or [])
        tiers.extend(
            e.get("name") for e in self.prior_pool
            if e.get("source") == "Previously Rejected (Pipeline History)" and e.get("name")
        )
        return dedupe_names(tiers)[:limit]

    # -- diagnostics -------------------------------------------------------

    def stats(self) -> Dict[str, int]:
        historical = sum(
            1 for e in self.prior_pool
            if e.get("source") == "Previously Rejected (Pipeline History)"
        )
        return {
            "session_rejected": len(self.session_names),
            "session_patterns": len(self.session_patterns),
            "collision_families": len(self.collision_hits),
            "historical_rejections_in_pool": historical,
            "avoid_pool_1_total": len(self.prior_pool),
            "gate_structured_patterns": len(self.pattern_index),
            "gate_historical_names": len(self._historical_keys),
        }
