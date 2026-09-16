import functools
import math
import re
from typing import Any, Dict, List, Optional, Tuple

import phonetics
from fuzzywuzzy import fuzz
import Levenshtein


@functools.lru_cache(maxsize=2048)
def _cached_metaphone(s: str) -> str:
    try:
        return phonetics.metaphone(s) or ""
    except Exception:
        return ""


@functools.lru_cache(maxsize=2048)
def _cached_soundex(s: str) -> str:
    try:
        return phonetics.soundex(s) or ""
    except Exception:
        return ""


def levenshtein_similarity(s1: str, s2: str) -> float:
    return Levenshtein.ratio(s1.lower(), s2.lower())


def fuzzy_similarity(s1: str, s2: str) -> float:
    return fuzz.ratio(s1.lower(), s2.lower()) / 100.0


def phonetic_similarity(s1: str, s2: str) -> float:
    try:
        code1 = _cached_metaphone(s1)
        code2 = _cached_metaphone(s2)
        if not code1 or not code2:
            return 0.0
        if code1 == code2:
            return 1.0
        return Levenshtein.ratio(code1, code2)
    except Exception:
        return 0.0


def soundalike_score(s1: str, s2: str) -> float:
    try:
        sx1 = _cached_soundex(s1)
        sx2 = _cached_soundex(s2)
        if sx1 and sx2 and sx1 == sx2:
            return 1.0
        phon = phonetic_similarity(s1, s2)
        if sx1 and sx2:
            return max(phon, Levenshtein.ratio(sx1, sx2))
        return phon
    except Exception:
        return phonetic_similarity(s1, s2)


# Visual character shape substitution mapping for pharmaceutical Look-Alike (LASA) detection
_VISUAL_SHAPE_MAP = str.maketrans({
    '0': 'o', 'O': 'o', 'c': 'o', 'e': 'o', 'a': 'o', 'Q': 'o',
    '1': 'l', 'I': 'l', 'i': 'l', 'j': 'l', 't': 'l', '|': 'l',
    'u': 'v', 'U': 'v', 'w': 'v', 'W': 'v', 'y': 'v', 'Y': 'v',
    'm': 'n', 'M': 'n', 'r': 'n', 'h': 'n', 'H': 'n',
    'p': 'b', 'P': 'b', 'q': 'b', 'd': 'b', 'D': 'b', 'g': 'b', 'B': 'b',
    'k': 'x', 'K': 'x', 'z': 's', 'Z': 's',
})


def _trigrams(s: str) -> set:
    padded = f"^{s.lower().strip()}$"
    return {padded[i:i+3] for i in range(len(padded) - 2)} if len(padded) >= 3 else {padded}


def lookalike_score(s1: str, s2: str) -> float:
    """Calculates pharmaceutical Look-Alike (Visual) similarity based on:
    1. Optical character shape similarity (visual glyph confusion matrix)
    2. Character trigram Dice coefficient
    """
    w1, w2 = s1.lower().strip(), s2.lower().strip()
    if not w1 or not w2:
        return 0.0
    if w1 == w2:
        return 1.0

    # 1. Trigram visual overlap
    t1, t2 = _trigrams(w1), _trigrams(w2)
    intersection = len(t1 & t2)
    dice_trigram = (2.0 * intersection) / (len(t1) + len(t2)) if (len(t1) + len(t2)) > 0 else 0.0

    # 2. Visual shape mapped distance (normalizes confusable glyphs like l/1/i, o/0/c, rn/m)
    v1 = w1.replace("rn", "n").replace("cl", "b").replace("vv", "v").translate(_VISUAL_SHAPE_MAP)
    v2 = w2.replace("rn", "n").replace("cl", "b").replace("vv", "v").translate(_VISUAL_SHAPE_MAP)
    shape_ratio = Levenshtein.ratio(v1, v2)

    return round(shape_ratio * 0.60 + dice_trigram * 0.40, 3)


def prefix_similarity(s1: str, s2: str) -> float:
    """Evaluates pharmaceutical prefix similarity (first 3-4 characters + phonetic prefix)."""
    w1, w2 = s1.lower().strip(), s2.lower().strip()
    if not w1 or not w2:
        return 0.0
    p1, p2 = w1[:min(4, len(w1))], w2[:min(4, len(w2))]
    lev_p = Levenshtein.ratio(p1, p2)
    m1, m2 = _cached_metaphone(p1), _cached_metaphone(p2)
    phon_p = Levenshtein.jaro_winkler(m1, m2) if (m1 and m2) else 0.0
    if m1 and m2 and m1 == m2:
        phon_p = 1.0
    return max(lev_p, phon_p)


def suffix_similarity(s1: str, s2: str) -> float:
    """Evaluates pharmaceutical suffix similarity (last 3-4 characters + phonetic suffix)."""
    w1, w2 = s1.lower().strip(), s2.lower().strip()
    if not w1 or not w2:
        return 0.0
    suf1, suf2 = w1[-min(4, len(w1)):], w2[-min(4, len(w2)):]
    lev_s = Levenshtein.ratio(suf1, suf2)
    m1, m2 = _cached_metaphone(suf1), _cached_metaphone(suf2)
    phon_s = Levenshtein.jaro_winkler(m1, m2) if (m1 and m2) else 0.0
    if m1 and m2 and m1 == m2:
        phon_s = 1.0
    return max(lev_s, phon_s)


def prefix_suffix_collision_score(s1: str, s2: str) -> float:
    """Computes combined prefix and suffix pharmaceutical Look-Alike / Sound-Alike (LASA) collision score."""
    lev = levenshtein_similarity(s1, s2)
    if lev < 0.50:
        return lev * 0.5
    
    l1, l2 = len(s1.strip()), len(s2.strip())
    len_ratio = min(l1, l2) / max(l1, l2) if max(l1, l2) > 0 else 1.0
    if len_ratio < 0.60:
        return lev * 0.6

    p_sim = prefix_similarity(s1, s2)
    s_sim = suffix_similarity(s1, s2)
    if p_sim >= 0.85 and s_sim >= 0.60 and lev >= 0.60:
        return max(p_sim * 0.6 + s_sim * 0.4, 0.85)
    return p_sim * 0.5 + s_sim * 0.5


def composite_similarity(s1: str, s2: str) -> float:
    """Blended spelling, phonetic, prefix, and suffix similarity used to rank conflict candidates."""
    lev = levenshtein_similarity(s1, s2)
    fuz = fuzzy_similarity(s1, s2)
    phon = phonetic_similarity(s1, s2)
    ps_score = prefix_suffix_collision_score(s1, s2)
    base = lev * 0.30 + fuz * 0.30 + phon * 0.25 + ps_score * 0.15
    if (ps_score >= 0.85 and phon >= 0.70) or phon >= 0.90:
        return max(base, max(phon, ps_score))
    return base


PHONETIC_TYPE_THRESHOLD = 0.45
SPELLING_TYPE_THRESHOLD = 0.45
LOOKALIKE_TYPE_THRESHOLD = 0.45
SEMANTIC_TYPE_THRESHOLD = 0.45


def classify_similarity_types(
    lev: float, fuz: float, phon: float, look: float,
    semantic: Optional[float] = None,
) -> List[str]:
    types: List[str] = []
    if phon >= PHONETIC_TYPE_THRESHOLD:
        types.append("Phonetic")
    if max(lev, fuz) >= SPELLING_TYPE_THRESHOLD:
        types.append("Spelling")
    if look >= LOOKALIKE_TYPE_THRESHOLD:
        types.append("Visual")
    if semantic is not None and semantic >= SEMANTIC_TYPE_THRESHOLD:
        types.append("Conceptual")
    return types


# IQVIA-specific thresholds (per the mentor-updated IQVIA rejection logic —
# see BrandScreeningService._iqvia_stage_conflict). Kept alongside
# grade_name_similarity() since both express the same "universal grading"
# approach: independently-scored parameters, no blended composite.
IQVIA_SIMILARITY_REJECT_THRESHOLD = 0.85
IQVIA_GROWTH_REJECT_THRESHOLD = 50.0  # VAL_GR_PCT / UN_GR_PCT are real percentages, not 0-1 ratios


def grade_name_similarity(name_a: str, name_b: str) -> Dict[str, float]:
    """Universal per-parameter similarity grading — Spelling / Phonetic /
    Visual, each computed independently (0.0-1.0), with no blended composite.

    Used identically by every stage's gate (WHO, IQVIA, e-pharmacy, Google,
    and the AI Generator's own deterministic pre-screen) instead of each call
    site blending its own ad hoc weighted average — so a name pair grades the
    same regardless of which stage is asking, and a stage's decision is just
    "does any parameter I care about clear my threshold", the way a
    trademark examiner actually reasons (a name can be rejected on spelling
    alone, or phonetics alone — a strong hit on one parameter isn't diluted by
    averaging it against a clean score on another).

    Conceptual/meaning similarity is deliberately NOT included here — a real
    conceptual score requires a live embedding call per candidate (see
    BrandScreeningService._semantic_scores), which is only worth paying for
    where it's actually wired up (the IQVIA gate, and the final holistic
    Brand Analysis score) — callers that need it fetch it separately.
    """
    return {
        "spelling": round(max(levenshtein_similarity(name_a, name_b), fuzzy_similarity(name_a, name_b)), 4),
        "phonetic": round(phonetic_similarity(name_a, name_b), 4),
        "visual": round(lookalike_score(name_a, name_b), 4),
    }


def classify_similarity_type(s1: str, s2: str) -> str:
    lev = levenshtein_similarity(s1, s2)
    fuz = fuzzy_similarity(s1, s2)
    phon = phonetic_similarity(s1, s2)
    look = lookalike_score(s1, s2)
    types = classify_similarity_types(lev, fuz, phon, look)
    return types[0] if types else "Spelling"


def cosine_similarity(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a <= 0.0 or norm_b <= 0.0:
        return 0.0
    return max(0.0, min(1.0, dot / (norm_a * norm_b)))


def safe_phonetic_code(name: str) -> str:
    try:
        return phonetics.metaphone(name)
    except Exception:
        return name.upper()


_KEYBOARD_SEQUENCES = (
    "qwertyuiop", "poiuytrewq",
    "asdfghjkl", "lkjhgfdsa",
    "zxcvbnm", "mnbvcxz",
    "qazwsxedc", "cdxswzaq",
    "wsxedcrfv", "vfrcdxsw",
    "edcrfvtgb", "bgtfvrde",
    "rfvtgbyhn", "nhybgtfr",
    "tgbyhnujm", "mjunhybg",
    "yhnujmikol", "lokimjunhy",
)


def validate_linguistic_structure(name: str) -> Tuple[bool, Optional[str]]:
    """Validates whether a brand name meets basic pharmaceutical nomenclature
    and phonotactic pronounceability rules (FDA PDUFA / CDSCO guidelines).

    Rejects:
    1. Zero vowels / semi-vowels (e.g. 'hjkjhjkj', 'bcdfgh', 'qwrtyp')
    2. Keyboard row mashes and consecutive keyboard runs (e.g. 'asdfghjkl', 'qwertyuiop', 'zxcvbnm', 'lkjhgfdsa')
    3. Severe consonant clusters (>= 4 consecutive consonants without a vowel or 'y')
    4. Severe vowel clusters (>= 4 consecutive vowels)
    5. Extremely low vowel density (< 18% in strings of length >= 4)
    6. Low character entropy / repetitive spam (e.g. 'aaaa', 'ababab', 'zzzz')

    CHARACTER LENGTH IS NOT A REJECTION CRITERION. A candidate is never
    rejected merely for being short or long — the previous `< 3` and `> 30`
    character gates were removed deliberately. Length remains a *generation
    preference* expressed in the LLM prompt (see ai.py's structural-diversity
    guidance), never a screening verdict: a long candidate continues through
    deterministic screening, WHO INN, IQVIA, e-pharmacy and Google exactly like
    any other, and is rejected only if it actually collides with something.

    Every rule that remains below is about pronounceability/phonotactics, not
    size. Where one incidentally references a length (e.g. vowel density is only
    meaningful once there are at least 4 characters) that is a guard on the
    metric's validity, not a length rejection.

    Returns:
        (is_valid: bool, rejection_reason: Optional[str])
    """
    raw = name.strip()

    # 0a. Reject if pure numerals with no alphabetic structure
    if raw.isdigit():
        return False, f"'{name}' contains only numerals with no alphabetic structure."

    clean = re.sub(r"[^a-zA-Z]", "", raw).lower()
    if not clean:
        return False, f"'{name}' contains no alphabetic characters."

    # 0b. Reject superficial number attachments to prohibited clinical, organ, or promotional roots (e.g. '1protect', 'kidney1', '1cure')
    if re.search(r"\d", raw):
        _disguised_roots = (
            "protect", "protec", "guard", "defend", "prevent", "cure", "cura", "safe", "care", "heal",
            "kidney", "kidn", "heart", "cardio", "vaso", "pulm", "hepa", "neuro", "liver", "lung", "ren", "nephr"
        )
        for root in _disguised_roots:
            if clean.startswith(root) or clean == root:
                return False, f"'{name}' attaches numbers to a prohibited clinical, organ, or promotional root ('{root}'), which is invalid under trademark and regulatory screening."

    # 1. Keyboard sequence mash check (4+ consecutive characters matching keyboard rows/diagonals)
    for seq in _KEYBOARD_SEQUENCES:
        for i in range(len(seq) - 3):
            sub = seq[i:i+4]
            if sub in clean:
                return False, f"'{name}' contains a keyboard-row mash sequence ('{sub}'), indicating an unpronounceable nonsense string rather than a coined pharmaceutical word."

    vowels = set("aeiouy")
    pure_vowels = set("aeiou")
    vowel_count = sum(1 for ch in clean if ch in vowels)

    # 2. Total lack of vowels/semi-vowels
    if vowel_count == 0:
        return False, f"'{name}' contains zero vowels or semi-vowels, making it unpronounceable and invalid under FDA/CDSCO guidelines."

    # 3. Vowel density check (e.g. 1 vowel in 9 consonants is below 18%)
    density = vowel_count / len(clean)
    if density < 0.18 and len(clean) >= 4:
        return False, f"'{name}' has an extremely low vowel density ({int(density*100)}%), violating standard phonetic pronounceability rules."

    # 4. Consecutive consonants cluster check (>= 4 consecutive consonants without a vowel/y)
    consonant_cluster = 0
    max_consonants = 0
    for ch in clean:
        if ch not in vowels:
            consonant_cluster += 1
            max_consonants = max(max_consonants, consonant_cluster)
        else:
            consonant_cluster = 0

    if max_consonants >= 4:
        return False, f"'{name}' contains a cluster of {max_consonants} consecutive consonants, making it unpronounceable in clinical practice."

    # 5. Consecutive vowels cluster check (>= 4 consecutive pure vowels a,e,i,o,u)
    # Note: 'y' adjacent to vowels acts as an intervocalic glide/consonant (e.g. 'aya', 'oye', 'fynvayaa'),
    # not a vowel hiatus, so only consecutive pure vowels are counted.
    vowel_cluster = 0
    max_vowels = 0
    for ch in clean:
        if ch in pure_vowels:
            vowel_cluster += 1
            max_vowels = max(max_vowels, vowel_cluster)
        else:
            vowel_cluster = 0

    if max_vowels >= 4:
        return False, f"'{name}' contains an invalid cluster of {max_vowels} consecutive vowels, violating standard brand phonotactics."

    # 6. Monotonous repeating character spam (>= 3 same character in a row e.g. 'aaa')
    if re.search(r"(.)\1{2,}", clean):
        return False, f"'{name}' contains repeated identical characters, violating brand distinctiveness and pronounceability guidelines."

    # 7. Low character entropy (e.g. length >= 5 with <= 2 unique letters like 'ababab')
    if len(clean) >= 5 and len(set(clean)) <= 2:
        return False, f"'{name}' lacks sufficient character variety ({len(set(clean))} unique characters), indicating an invalid repetitive string."

    # 8. Phonotactic onset & coda validity (filters random keyboard mashes like 'fjasiuyhsj' while allowing legitimate coinages)
    _IMPOSSIBLE_ONSETS = (
        "fj", "fk", "fp", "fm", "fn", "fq", "fv", "fw", "fz",
        "bk", "bg", "bp", "bv", "bz",
        "cx", "cj",
        "dx", "dt", "dp", "dk", "dg", "dj",
        "gx", "gj", "gk", "gt",
        "hx", "hj", "hk", "hp", "hq", "hr", "hs", "ht", "hv", "hw", "hz",
        "jx", "jb", "jc", "jd", "jf", "jg", "jh", "jk", "jl", "jm", "jn", "jp", "jq", "jr", "js", "jt", "jv", "jw", "jz",
        "kx", "kb", "kc", "kd", "kf", "kg", "kj", "kp", "kq", "kt", "kv", "kz",
        "lx", "lj",
        "mx", "mj",
        "nx", "nj",
        "px", "pj", "pk", "pv",
        "qx", "qj", "qb", "qc", "qd", "qf", "qg", "qh", "qk", "ql", "qm", "qn", "qp", "qr", "qs", "qt", "qv", "qw", "qz",
        "rx", "rj",
        "sx", "sj",
        "tx", "tj", "tk", "tp",
        "vx", "vj", "vk", "vp", "vt",
        "wx", "wj",
        "zx", "zj", "zk", "zp", "zt",
    )
    if clean.startswith(_IMPOSSIBLE_ONSETS):
        prefix = clean[:2]
        return False, f"'{name}' begins with an invalid phonetic onset ('{prefix}'), violating standard brand phonotactics."

    _IMPOSSIBLE_CODAS = (
        "sj", "hsj", "hj", "fj", "vj", "q", "fk", "gk", "pk", "zk", "bk", "dk",
    )
    for coda in _IMPOSSIBLE_CODAS:
        if clean.endswith(coda):
            return False, f"'{name}' ends with an unpronounceable consonant sequence ('{coda}'), violating standard brand phonotactics."

    return True, None


def score_to_grade(score: float, thresholds: Optional[Dict[str, Dict[str, int]]] = None) -> str:
    """Converts a similarity score (0.0-1.0 or 0-100) into a grade (A, B, C, D)
    based on configured thresholds."""
    th = thresholds or {
        "A": {"min": 0, "max": 30},
        "B": {"min": 31, "max": 50},
        "C": {"min": 51, "max": 70},
        "D": {"min": 71, "max": 100},
    }
    pct = round(score * 100.0 if score <= 1.0 else score)
    if pct <= th.get("A", {}).get("max", 30):
        return "A"
    elif pct <= th.get("B", {}).get("max", 50):
        return "B"
    elif pct <= th.get("C", {}).get("max", 70):
        return "C"
    else:
        return "D"


def evaluate_combination_risk(
    p_grade: str,
    s_grade: str,
    c_grade: str,
    v_grade: str,
    custom_rules: Optional[Dict[str, str]] = None,
) -> Tuple[str, str]:
    """Determines risk classification ("LOW", "MEDIUM", "HIGH") and AI recommendation
    ("PROCEED", "LEGAL_REVIEW", "REJECT") based on the 4-parameter combination code P-S-C-V.

    Standard Rules:
    - Phonetic (P), Conceptual (C), Visual (V):
      A, B -> Low, C -> Medium, D -> High
    - Spelling (S):
      A -> Low, B, C -> Medium, D -> High

    Overall Combination Result:
    - If ANY parameter is High (P=D, S=D, C=D, V=D) -> HIGH / REJECT
    - Else if AT LEAST ONE parameter is Medium (S in [B,C], P=C, C=C, V=C) -> MEDIUM / LEGAL_REVIEW
    - Else (all Low: S=A and P,C,V in [A,B]) -> LOW / PROCEED
    """
    code = f"{p_grade}{s_grade}{c_grade}{v_grade}".upper()

    # 1. Custom rule override if present
    if custom_rules and code in custom_rules:
        custom_risk = custom_rules[code].upper()
        if custom_risk == "HIGH":
            return "HIGH", "REJECT"
        elif custom_risk == "MEDIUM":
            return "MEDIUM", "LEGAL_REVIEW"
        elif custom_risk == "LOW":
            return "LOW", "PROCEED"

    # 2. Standard Evaluation
    p_is_high = p_grade == "D"
    s_is_high = s_grade == "D"
    c_is_high = c_grade == "D"
    v_is_high = v_grade == "D"

    if p_is_high or s_is_high or c_is_high or v_is_high:
        return "HIGH", "REJECT"

    p_is_med = p_grade == "C"
    s_is_med = s_grade in ("B", "C")
    c_is_med = c_grade == "C"
    v_is_med = v_grade == "C"

    if p_is_med or s_is_med or c_is_med or v_is_med:
        return "MEDIUM", "LEGAL_REVIEW"

    return "LOW", "PROCEED"


def calculate_mentor_risk_score(
    phonetic_score: float,
    spelling_score: float,
    visual_score: float,
    conceptual_score: float,
    is_exact_match: bool = False,
    is_who_inn_knockout: bool = False,
    is_linguistic_knockout: bool = False,
    grade_thresholds: Optional[Dict[str, Dict[str, int]]] = None,
    combination_rules: Optional[Dict[str, str]] = None,
    weights: Optional[Dict[str, float]] = None,
) -> Tuple[float, str, str, Dict[str, Any], str]:
    """Calculates risk using the 4-Parameter Grade & Combination Matrix System:
    Phonetic (P) - Spelling (S) - Conceptual (C) - Visual (V).

    Returns:
        (overall_risk_score, risk_classification, ai_recommendation, grades_dict, combination_code)
    """
    p_pct = round(phonetic_score * 100.0 if phonetic_score <= 1.0 else phonetic_score, 1)
    s_pct = round(spelling_score * 100.0 if spelling_score <= 1.0 else spelling_score, 1)
    c_pct = round(conceptual_score * 100.0 if conceptual_score <= 1.0 else conceptual_score, 1)
    v_pct = round(visual_score * 100.0 if visual_score <= 1.0 else visual_score, 1)

    p_grade = score_to_grade(p_pct, grade_thresholds)
    s_grade = score_to_grade(s_pct, grade_thresholds)
    c_grade = score_to_grade(c_pct, grade_thresholds)
    v_grade = score_to_grade(v_pct, grade_thresholds)

    combination = f"{p_grade}{s_grade}{c_grade}{v_grade}"

    if is_linguistic_knockout or is_exact_match or is_who_inn_knockout:
        risk_classification = "HIGH"
        ai_recommendation = "REJECT"
        overall_score = 100.0
    elif phonetic_score >= 0.90 or spelling_score >= 0.90:
        risk_classification = "HIGH"
        ai_recommendation = "REJECT"
        overall_score = round(max(85.0, max(p_pct, s_pct)), 1)
    else:
        risk_classification, ai_recommendation = evaluate_combination_risk(
            p_grade, s_grade, c_grade, v_grade, combination_rules
        )
        if risk_classification == "HIGH":
            overall_score = round(max(75.0, max(p_pct, s_pct, c_pct, v_pct)), 1)
        elif risk_classification == "MEDIUM":
            overall_score = round(max(35.0, min(65.0, max(p_pct, s_pct, c_pct, v_pct))), 1)
        else:
            overall_score = round(min(29.0, max(p_pct, s_pct, c_pct, v_pct)), 1)

    grades_dict = {
        "phonetic": {"score": p_pct, "grade": p_grade},
        "spelling": {"score": s_pct, "grade": s_grade},
        "conceptual": {"score": c_pct, "grade": c_grade},
        "visual": {"score": v_pct, "grade": v_grade},
        "combination": combination,
        "risk_classification": risk_classification,
    }

    return overall_score, risk_classification, ai_recommendation, grades_dict, combination


# ---------------------------------------------------------------------------
# Pharmaceutical 5-Rule Knockout & Validation Evaluator
# ---------------------------------------------------------------------------

_WHO_INN_STEMS = [
    "gliflozin", "gliptin", "prazole", "sartan", "statin", "tide", "vir", "mab",
    "olol", "tinib", "cillin", "pril", "stat", "zole", "navir", "grel", "kiren",
    "cept", "dronate", "parib", "coxib", "dipine", "floxacin", "mycin", "parin",
    "sone", "terol", "triptan", "vaptan", "xaban", "afil", "alol", "anib", "ast",
    "azenil", "azep", "bactam", "bufen", "calci", "cain", "carnit", "cimet", "cog",
    "conazole", "cort", "crinat", "cyclin", "dopa", "ergo", "estr", "fibat", "formin",
    "fos", "fungin", "gab", "gest", "giline", "glitazone", "imod", "irudin",
    "kacin", "leuk", "lutamide", "lukast", "meline", "mustine", "nidazole", "nixin",
    "orphan", "perone", "peta", "pidem", "piprazole", "pirox", "plest", "plic",
    "poetin", "pramine", "pressin", "profen", "prost", "quidil", "rabine", "relin",
    "renone", "retin", "ribine", "rinone", "rubicin", "salan", "semide", "serod",
    "stigmine", "tadine", "taxel", "tegrast", "tel", "terone", "tocin", "toin",
    "trakin", "trexate", "tricin", "troban", "triptyline", "trope", "vudine", "zolac",
]

_DISEASE_ORGAN_ROOTS = [
    "cardio", "coron", "vascul", "neuro", "cerebr", "renal", "nephro", "hepa",
    "pulmo", "pneum", "gastro", "enter", "pept", "derm", "cutan", "osteo", "arthr",
    "diabet", "glyc", "insul", "cancer", "onco", "tumor", "pain", "alges", "sleep",
    "somn", "asthma", "bronch", "hypertens", "press", "ulcer", "anxio", "depress",
    "fever", "pyret", "inflam", "aller", "ocular", "ophthal", "retin", "spinal",
    "muscul", "myo", "rhino", "laryng", "otico", "gynec", "uro", "urin", "thyro",
]

_CHEMICAL_COMPOUND_ROOTS = [
    "chloro", "methyl", "ethyl", "propyl", "butyl", "amino", "hydroxy", "sodium",
    "oxide", "cyclo", "fluoro", "nitro", "sulf", "phosph", "ester", "ether",
    "ketone", "aldehyde", "amide", "chloride", "potassium", "calcium", "acetate",
    "maleate", "fumarate", "tartrate", "citrate", "bromide", "iodide", "phosphate",
    "sulfate", "succinate", "benzoate", "mesylate", "tosylate", "hydrochloride",
]

# Used to strip salt/chemical suffix tokens (e.g. "hydrochloride", "sodium",
# "maleate") out of a brand name's constituent words before comparing its
# "core" molecule name against a case's generic name — see
# evaluate_pharma_knockout_checks below.
_SALT_OR_CHEMICAL_SUFFIX_WORDS = set(_CHEMICAL_COMPOUND_ROOTS)


def evaluate_pharma_knockout_checks(
    brand_name: str,
    conflicts: List[Dict[str, Any]],
    similar_names: Optional[List[Dict[str, Any]]] = None,
    case_context: Optional[Dict[str, Any]] = None,
    is_who_inn_fail: bool = False,
    is_linguistic_fail: bool = False,
) -> List[Dict[str, Any]]:
    """Evaluates the 5 mandatory pharmaceutical knockout & validation rules:
    1. Molecule or INN stems
    2. Disease, ailment, or organ names
    3. Chemical or compound names
    4. Existing brand names
    5. Existing brand names with significant prefix or suffix similarities
    """
    clean_name = brand_name.lower().strip()
    sim_names = similar_names or []

    # Tokenize candidate brand name into constituent words
    cand_raw_words = [w.strip() for w in re.split(r'[\s,;/+&-]+', clean_name) if w.strip()]
    cand_active_words = [
        w for w in cand_raw_words
        if w.lower() not in _SALT_OR_CHEMICAL_SUFFIX_WORDS and len(w) >= 3
    ]
    cand_base_norm = re.sub(r'[^a-z0-9]', '', "".join(cand_active_words))
    clean_norm = re.sub(r'[^a-z0-9]', '', clean_name)

    # 1. Molecule or INN stems
    inn_hits = []
    has_inn_stem_suffix = False
    for stem in _WHO_INN_STEMS:
        if len(stem) >= 3:
            # Check candidate full string and constituent words for WHO INN stems
            for cw in cand_raw_words:
                if cw.endswith(stem):
                    has_inn_stem_suffix = True
                    if f"-{stem}" not in inn_hits:
                        inn_hits.append(f"-{stem}")
                elif cw.startswith(stem) or (len(stem) >= 5 and stem in cw):
                    if f"-{stem}" not in inn_hits:
                        inn_hits.append(f"-{stem}")

    # Check if active generic name from case or context has collision
    generic_in_case = ""
    if case_context:
        generic_in_case = (
            case_context.get("generic_name")
            or case_context.get("molecule")
            or case_context.get("case_name")
            or ""
        ).lower().strip()
        if " - " in generic_in_case:
            generic_in_case = generic_in_case.split(" - ")[0].strip()
        if "(" in generic_in_case:
            generic_in_case = generic_in_case.split("(")[0].strip()

    is_exact_molecule_match = False
    exact_mol_match_label = ""

    if generic_in_case and len(generic_in_case) >= 3:
        case_raw_words = [w.strip() for w in re.split(r'[\s,;/+&-]+', generic_in_case) if w.strip()]
        case_active_words = [
            w for w in case_raw_words
            if w.lower() not in _SALT_OR_CHEMICAL_SUFFIX_WORDS and len(w) >= 3
        ]
        case_base_norm = re.sub(r'[^a-z0-9]', '', "".join(case_active_words))
        gen_norm = re.sub(r'[^a-z0-9]', '', generic_in_case)

        # 1. Full generic name match (e.g. "Acoramidis Hydrochloride" == "Acoramidis Hydrochloride")
        if clean_norm and clean_norm == gen_norm:
            is_exact_molecule_match = True
            exact_mol_match_label = generic_in_case.title()
        # 2. Active molecule match (e.g. "Acoramidis" == "Acoramidis" whether single word or multi-word with salt)
        elif cand_base_norm and case_base_norm and cand_base_norm == case_base_norm:
            is_exact_molecule_match = True
            exact_mol_match_label = " ".join(case_active_words).title() or generic_in_case.title()
        # 3. Candidate active molecule equals full generic, or full candidate equals case active molecule
        elif cand_base_norm and clean_norm == case_base_norm:
            is_exact_molecule_match = True
            exact_mol_match_label = " ".join(case_active_words).title()
        elif case_base_norm and gen_norm == cand_base_norm:
            is_exact_molecule_match = True
            exact_mol_match_label = " ".join(cand_active_words).title()
        # 4. Any constituent active molecule sub-word of length >= 4 matches
        elif any(cw == gw for cw in cand_active_words for gw in case_active_words if len(cw) >= 4):
            is_exact_molecule_match = True
            matched_words = [cw for cw in cand_active_words if cw in case_active_words]
            exact_mol_match_label = " ".join(matched_words).title()
        # 5. Candidate contains the active case molecule or vice-versa
        elif case_base_norm and len(case_base_norm) >= 4 and case_base_norm in clean_norm:
            is_exact_molecule_match = True
            exact_mol_match_label = " ".join(case_active_words).title() or generic_in_case.title()
        elif cand_base_norm and len(cand_base_norm) >= 4 and cand_base_norm in gen_norm:
            is_exact_molecule_match = True
            exact_mol_match_label = " ".join(cand_active_words).title()

        if is_exact_molecule_match:
            inn_hits.insert(0, f"exact active molecule match ({exact_mol_match_label})")
        else:
            gen_stem = generic_in_case.split()[0][:5]
            if len(gen_stem) >= 4 and gen_stem in clean_name and f"active ingredient stem ({gen_stem})" not in inn_hits:
                inn_hits.append(f"active ingredient stem ({gen_stem})")

    has_who_inn_conf = is_who_inn_fail or any(
        c.get("conflict_type") in ("INN_KNOCKOUT", "WHO_INN_CONFLICT") or "who" in (c.get("source") or "").lower()
        for c in conflicts
    )

    if is_exact_molecule_match or has_who_inn_conf or len(inn_hits) > 0:
        inn_status = "fail" if (is_exact_molecule_match or has_who_inn_conf or has_inn_stem_suffix) else "warn"
        inn_detail = f"Protected stem collision detected: {', '.join(inn_hits) if inn_hits else 'Registered WHO INN conflict'}"
    else:
        inn_status = "pass"
        inn_detail = "No collision with protected WHO INN stems or active drug substance stems"

    # 2. Disease, ailment, or organ names
    disease_hits = []
    for root in _DISEASE_ORGAN_ROOTS:
        if root in clean_name:
            disease_hits.append(root)

    if disease_hits:
        dis_status = "fail" if any(clean_name.startswith(r) for r in disease_hits) else "warn"
        dis_detail = f"Anatomical/pathological descriptor detected: {', '.join(disease_hits)}"
    else:
        dis_status = "pass"
        dis_detail = "Free of deceptive or descriptive disease, ailment, or organ terminology"

    # 3. Chemical or compound names
    chem_hits = []
    for root in _CHEMICAL_COMPOUND_ROOTS:
        if root in clean_name:
            chem_hits.append(root)

    if chem_hits:
        chem_status = "fail" if any(clean_name.startswith(r) or clean_name.endswith(r) for r in chem_hits) else "warn"
        chem_detail = f"Chemical / IUPAC / salt nomenclature detected: {', '.join(chem_hits)}"
    else:
        chem_status = "pass"
        chem_detail = "No chemical compound prefixes, radical groups, or salt compound designations"

    # 4. Existing brand names
    exact_match = any(
        c.get("conflict_type") in ("EXACT_MATCH", "EXACT_MARKET_MATCH") or c.get("similarity_score", 0.0) >= 0.98
        for c in conflicts
    )
    high_brand_conf = any(
        c.get("severity") == "HIGH" or c.get("similarity_score", 0.0) >= 0.70
        for c in conflicts
    )
    med_brand_conf = any(
        c.get("severity") == "MEDIUM" or c.get("similarity_score", 0.0) >= 0.50
        for c in conflicts
    ) or len(sim_names) >= 3

    if exact_match:
        brand_status = "fail"
        brand_detail = "Exact match to registered trademark or active commercial pharmaceutical brand"
    elif high_brand_conf:
        brand_status = "fail"
        brand_detail = "High similarity collision with existing commercial pharma brand in registry/market"
    elif med_brand_conf:
        brand_status = "warn"
        brand_detail = "Moderate similarity overlap with active pharmaceutical brand in market"
    else:
        brand_status = "pass"
        brand_detail = "No high-risk collisions with registered trademarks or commercial brands"

    # 5. Existing brand names with significant prefix or suffix similarities
    high_ps = False
    med_ps = False
    ps_colliding_names = []
    for c in (conflicts + sim_names):
        c_name = c.get("conflicting_name") or c.get("name") or ""
        if c_name and c_name.lower().strip() != clean_name:
            ps_score = prefix_suffix_collision_score(clean_name, c_name)
            p_score = prefix_similarity(clean_name, c_name)
            s_score = suffix_similarity(clean_name, c_name)
            if ps_score >= 0.80 or (p_score >= 0.85 and s_score >= 0.60):
                high_ps = True
                ps_colliding_names.append(f"{c_name} ({round(ps_score*100)}% prefix/suffix)")
            elif ps_score >= 0.60 or p_score >= 0.80 or s_score >= 0.80:
                med_ps = True
                ps_colliding_names.append(f"{c_name} ({round(ps_score*100)}% prefix/suffix)")

    if high_ps:
        ps_status = "fail"
        ps_detail = f"Significant prefix/suffix collision with commercial brands: {', '.join(ps_colliding_names[:2])}"
    elif med_ps:
        ps_status = "warn"
        ps_detail = f"Moderate prefix or suffix resemblance with: {', '.join(ps_colliding_names[:2])}"
    else:
        ps_status = "pass"
        ps_detail = "Distinctive leading prefix and trailing suffix with no critical commercial collision"

    return [
        {
            "id": "molecule_inn_stems",
            "label": "Molecule or INN stems",
            "rule": "Evaluates conflicts with protected WHO INN stems or active drug substance stems",
            "status": inn_status,
            "detail": inn_detail,
            "isKnockout": True,
        },
        {
            "id": "disease_organ_names",
            "label": "Disease, ailment, or organ names",
            "rule": "Prevents deceptive or descriptive use of disease, ailment, anatomical, or organ terms",
            "status": dis_status,
            "detail": dis_detail,
            "isKnockout": True,
        },
        {
            "id": "chemical_compound_names",
            "label": "Chemical or compound names",
            "rule": "Checks for infringement or misleading use of IUPAC chemical prefixes, radical groups, or salt compound designations",
            "status": chem_status,
            "detail": chem_detail,
            "isKnockout": True,
        },
        {
            "id": "existing_brand_names",
            "label": "Existing brand names",
            "rule": "Exact or high-collision existing trademarks/market brands in pharma registers & e-pharmacy databases",
            "status": brand_status,
            "detail": brand_detail,
            "isKnockout": True,
        },
        {
            "id": "prefix_suffix_similarities",
            "label": "Existing brand names with significant prefix or suffix similarities",
            "rule": "Leading prefix or trailing suffix collision with high-market-share commercial pharmaceutical brands",
            "status": ps_status,
            "detail": ps_detail,
            "isKnockout": True,
        },
    ]


