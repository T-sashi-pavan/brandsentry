"""Positive territory steering for candidate generation.

WHY THIS EXISTS
---------------
Every signal the generator receives today is negative: avoid these names,
avoid these patterns, avoid these repeat offenders, avoid this burned
territory, avoid this banned morphology. Nothing has ever told it WHERE THE
EMPTY SPACE IS. The banned-morphology list already contains the exact suffixes
the model keeps producing (-ara, -vion, -ora, -ion, -via), which is direct
evidence that more prohibition does not change behaviour.

A candidate's survival at the IQVIA gate is largely decided by its opening.
`ScreeningRepository.find_iqvia_local` retrieves comparison rows with
`lower(normalized_name) LIKE '<first 4 chars>%'` (plus phonetic variants), and
the gate then rejects if any retrieved row clears the similarity bar. So a
candidate opening in a crowded region is compared against hundreds of rows and
very likely trips; one opening in an empty region is compared against nothing.

That density is knowable BEFORE generation, from one aggregate query.

SCOPE — WHAT THIS IS NOT
------------------------
Nothing here screens, scores risk, or rejects on business grounds. Sparse
territory is NOT a claim of trademark availability — it is a generation
preference only. WHO/IQVIA remain authoritative and unchanged.
"""
import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

# The ONE authoritative protected-stem list. Imported, never copied — a second
# list would drift from the rules screening actually enforces.
from app.services.screening import _WHO_INN_STEMS

logger = logging.getLogger(__name__)

#: Public alias so callers do not reach for a private name.
PROTECTED_INN_STEMS: Tuple[str, ...] = tuple(_WHO_INN_STEMS)

_NON_ALNUM = re.compile(r"[^a-z0-9]")

# Mirrors find_iqvia_local's prefix length exactly.
PREFIX_LEN = 4

# How many openings to name in the prompt. Small on purpose: a compact,
# usable subset beats a dump the model skims past.
PROMPT_SPARSE_LIMIT = 18
PROMPT_CROWDED_LIMIT = 10


def _norm(name: Optional[str]) -> str:
    return _NON_ALNUM.sub("", (name or "").strip().lower())


def prefix_variants(prefix: str) -> List[str]:
    """The phonetic-variant expansion `find_iqvia_local` performs.

    Density has to account for these because the retrieval does: a candidate
    opening "syra" is also compared against everything under "sira", "zyra"
    and so on, so its effective crowding is the sum over all variants.
    """
    p = prefix
    out = {p, p.replace("y", "i"), p.replace("i", "y")}
    if p.startswith("ce"):
        out.add("se" + p[2:])
    elif p.startswith("se"):
        out.add("ce" + p[2:])
    if p.startswith("ci"):
        out.add("si" + p[2:])
    elif p.startswith("si"):
        out.add("ci" + p[2:])
    if p.startswith("ph"):
        out.add("f" + p[2:])
    elif p.startswith("f"):
        out.add("ph" + p[1:])
    if p.startswith("z"):
        out.add("s" + p[1:])
    elif p.startswith("s"):
        out.add("z" + p[1:])
    return [v for v in out if v]


class TerritoryMap:
    """Run-level view of how crowded each IQVIA opening is.

    Built once per generation run from a single aggregate query. Read-only
    thereafter; it issues no query of its own.
    """

    def __init__(
        self,
        iqvia_density: Optional[Dict[str, int]] = None,
        who_density: Optional[Dict[str, int]] = None,
    ) -> None:
        self.iqvia_density: Dict[str, int] = dict(iqvia_density or {})
        self.who_density: Dict[str, int] = dict(who_density or {})
        self._combined: Dict[str, int] = dict(self.iqvia_density)
        for k, v in self.who_density.items():
            self._combined[k] = self._combined.get(k, 0) + v
        self.sparse_cut, self.crowded_cut = self._thresholds()

    # -- classification ----------------------------------------------------

    def _thresholds(self) -> Tuple[int, int]:
        """Cut-points taken from the ACTUAL distribution, not hard-coded.

        Terciles of the observed per-prefix counts, so the words "sparse" and
        "crowded" mean something on this dataset rather than on an assumed one.
        """
        counts = sorted(self._combined.values())
        if not counts:
            return 0, 0
        lo = counts[len(counts) // 3]
        hi = counts[(2 * len(counts)) // 3]
        return lo, max(hi, lo + 1)

    def density_for(self, name: str) -> int:
        """Rows a candidate's opening would be compared against, summed over
        the same phonetic variants the retrieval expands to."""
        key = _norm(name)[:PREFIX_LEN]
        if not key:
            return 0
        return sum(self._combined.get(v, 0) for v in prefix_variants(key))

    def classify(self, name: str) -> str:
        n = self.density_for(name)
        if n <= self.sparse_cut:
            return "sparse"
        if n >= self.crowded_cut:
            return "crowded"
        return "medium"

    def is_empty(self) -> bool:
        return not self._combined

    # -- prompt payload ----------------------------------------------------

    def prompt_payload(
        self,
        sparse_limit: int = PROMPT_SPARSE_LIMIT,
        crowded_limit: int = PROMPT_CROWDED_LIMIT,
    ) -> Optional[Dict[str, Any]]:
        """Compact positive-steering payload, or None when there is no data.

        Sparse openings are filtered to pronounceable, brand-plausible alphabetic shapes
        (consonant-vowel starts, no numeric chemical artifacts or awkward repetitions),
        distributed across diverse starting letters to give wide creative territory.
        """
        if not self._combined:
            return None
        ordered = sorted(self._combined.items(), key=lambda kv: (kv[1], kv[0]))
        eligible = [
            p for p, n in ordered
            if n <= self.sparse_cut and _plausible_opening(p)
        ]
        import random
        # Distribute across diverse starting letters to prevent alphabetical clumping
        by_initial: Dict[str, List[str]] = {}
        for p in eligible:
            by_initial.setdefault(p[0].lower(), []).append(p.capitalize())

        for initial in by_initial:
            random.shuffle(by_initial[initial])

        sparse: List[str] = []
        for i in range(10):
            for initial in sorted(by_initial.keys()):
                if i < len(by_initial[initial]):
                    sparse.append(by_initial[initial][i])
                    if len(sparse) >= sparse_limit:
                        break
            if len(sparse) >= sparse_limit:
                break

        crowded = [
            {"opening": p.capitalize(), "brands": n}
            for p, n in sorted(self._combined.items(), key=lambda kv: -kv[1])
            if p.isalpha()
        ][:crowded_limit]
        if not sparse and not crowded:
            return None
        return {
            "sparse_openings": sparse,
            "crowded_openings": crowded,
            "total_prefixes": len(self._combined),
            "sparse_cut": self.sparse_cut,
            "crowded_cut": self.crowded_cut,
        }


_VOWELS = set("aeiouy")


def _plausible_opening(p: str) -> bool:
    """A usable brand opening: purely alphabetic, length >= 3, has a vowel,
    no triple-consonant pile-up, no double letters (e.g. 'aa', 'zz'),
    and no awkward unpronounceable consonant combinations (e.g. 'bt', 'cn')."""
    if not p or not p.isalpha() or len(p) < 3:
        return False
    if not any(c in _VOWELS for c in p):
        return False
    if re.search(r"([a-z])\1", p.lower()):
        return False
    # Avoid unnatural consonant coda clashes
    if re.search(r"(bt|cn|bd|pt|dn|gn|tm|pm|km|fn)$", p.lower()):
        return False
    # Avoid saturated pharma stems that easily collide
    if p.lower().startswith(("dab", "cab", "hab", "mab", "nab", "pab", "fab", "zab")):
        return False
    run = 0
    for c in p.lower():
        run = run + 1 if c not in _VOWELS else 0
        if run >= 3:
            return False
    return True


# ---------------------------------------------------------------- INN stems

def inn_stem_hits(name: str) -> List[str]:
    """Protected INN stems this name uses, by the SAME test
    `evaluate_pharma_knockout_checks` applies (screening.py check 1).

    Reported for generation-time selection only. It does not reject anything:
    a hit means "do not spend an external verification slot on this when
    better candidates are available", not "this name is invalid".
    """
    clean = _norm(name)
    if not clean:
        return []
    hits: List[str] = []
    for stem in PROTECTED_INN_STEMS:
        if len(stem) < 3:
            continue
        if clean.endswith(stem) or clean.startswith(stem) or (len(stem) >= 5 and stem in clean):
            hits.append(stem)
    return hits


def ends_with_protected_stem(name: str) -> Optional[str]:
    """The stricter case: screening treats a name ENDING in a protected stem
    as an automatic INN fail, so these are the least worth screening."""
    clean = _norm(name)
    for stem in PROTECTED_INN_STEMS:
        if len(stem) >= 3 and clean.endswith(stem):
            return stem
    return None


# ----------------------------------------------------------------- ranking

def rank_candidates(
    entries: List[Dict[str, Any]],
    territory: Optional[TerritoryMap],
    burned_territories: Optional[Iterable[Dict[str, Any]]] = None,
    seen_openings: Optional[Dict[str, int]] = None,
    seen_suffixes: Optional[Dict[str, int]] = None,
) -> List[Tuple[Dict[str, Any], float, Dict[str, Any]]]:
    """Orders locally-eligible candidates for external verification.

    This is a SELECTION order, not a verdict. It decides which eligible
    candidates spend the batch's external-screening slots first; it never
    rejects, and it is entirely separate from the risk score, which is
    unchanged and still computed downstream by the existing screening code.

    Preference order, highest first:
      1. sparse IQVIA opening (fewest rows it will be compared against)
      2. no protected INN stem
      3. distance from territories already burned this run
      4. opening not already over-used in this batch/run
      5. ending not already over-used in this batch/run
    """
    burned = list(burned_territories or [])
    seen_openings = dict(seen_openings or {})
    seen_suffixes = dict(seen_suffixes or {})

    scored: List[Tuple[Dict[str, Any], float, Dict[str, Any]]] = []
    for entry in entries:
        name = entry.get("generated_name") or ""
        clean = _norm(name)
        why: Dict[str, Any] = {}
        score = 0.0

        if territory is not None and not territory.is_empty():
            band = territory.classify(name)
            why["territory"] = band
            why["iqvia_neighbours"] = territory.density_for(name)
            score += {"sparse": 40.0, "medium": 15.0, "crowded": 0.0}[band]
        else:
            why["territory"] = "unknown"

        stem = ends_with_protected_stem(name)
        if stem:
            why["inn_stem"] = stem
        else:
            score += 20.0
            if not inn_stem_hits(name):
                score += 5.0

        near_burned = 0
        for t in burned:
            kind, value = t.get("kind"), (t.get("value") or "")
            if not value:
                continue
            # Compare the matching END of each pattern: a burned prefix is
            # recognised by its opening characters, a burned suffix by its
            # closing ones. (Slicing both from the front made "-vion" test for
            # "vio" and never fire on a name ending "...vion".)
            if kind == "prefix" and clean.startswith(value[:3]):
                near_burned += 1
            elif kind == "suffix" and clean.endswith(value[-3:]):
                near_burned += 1
        if near_burned:
            why["near_burned"] = near_burned
        score += max(0.0, 15.0 - 5.0 * near_burned)

        opening = clean[:2]
        ending = clean[-3:] if len(clean) >= 4 else clean
        score += max(0.0, 10.0 - 3.0 * seen_openings.get(opening, 0))
        score += max(0.0, 10.0 - 3.0 * seen_suffixes.get(ending, 0))
        why["opening"] = opening
        why["ending"] = ending

        # Provisional in-batch spread: charge later candidates for reusing an
        # opening/ending an earlier, higher-ranked one already took.
        seen_openings[opening] = seen_openings.get(opening, 0) + 1
        seen_suffixes[ending] = seen_suffixes.get(ending, 0) + 1

        scored.append((entry, round(score, 2), why))

    scored.sort(key=lambda t: -t[1])
    return scored
