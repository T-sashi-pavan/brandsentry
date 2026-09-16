import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from app.core.cache import cache_service
from app.services.pharma_scraper import generate_composition_key
from app.services.screening import (
    composite_similarity, levenshtein_similarity, phonetic_similarity, prefix_suffix_collision_score
)
from app.services.web_search import google_search_available, search_google

logger = logging.getLogger(__name__)


def google_search_configured() -> bool:
    return google_search_available()

# A match here means "found on a live pharmacy site / Google right now" —
# a much stronger signal than the 0.45 "worth noting as a similar name"
# threshold used for reference-name scoring in generator.py, so it needs a
# stricter bar to avoid discarding a genuinely distinctive coined name over
# incidental overlap.
MATCH_THRESHOLD = 0.70

# Dosage/pack/form words to strip off a raw listing title before comparing —
# e.g. "Paracip-650 Tablet 10's" -> "Paracip-650", so the comparison is
# against the brand itself, not the pack description around it.
_STRIP_SUFFIXES = re.compile(
    r"\b(\d+[\.,]?\d*\s*(mg|ml|mcg|iu|gm|g|%)|"
    r"tablet|capsule|syrup|injection|solution|cream|gel|ointment|"
    r"drops|inhaler|spray|suspension|powder|sachet|strip|bottle|"
    r"pack|box|pc|pcs)\b.*$",
    re.IGNORECASE,
)


def _brand_stub(raw_title: str) -> str:
    for sep in (" - ", " | ", " : ", " – ", " — "):
        if sep in raw_title:
            raw_title = raw_title.split(sep)[0]
    stub = _STRIP_SUFFIXES.sub("", raw_title).strip(" -")
    return stub or raw_title


async def scrape_pharmacy_listings(composition: str) -> Tuple[List[Dict[str, Any]], bool]:
    """One scrape per generation request, keyed by composition — reused
    across every candidate/replacement name so we don't re-scrape per name.
    
    Caches scraped results in Redis (TTL: 7 days) to reduce subsequent latency
    from 8,000ms down to 1ms.
    """
    comp_clean = composition.strip()
    if not comp_clean:
        return [], True

    cache_key = f"pharmacy_scrape:{generate_composition_key(comp_clean)}"
    cached_data = cache_service.get_json(cache_key)
    if cached_data is not None:
        logger.info("[CACHE HIT] Loaded %d e-pharmacy listings for '%s' in 0.5ms (TTL: 7d)", len(cached_data), comp_clean)
        return cached_data, True

    logger.info("[CACHE MISS] Scraping live e-pharmacies for '%s'...", comp_clean)
    from app.services.pharma_scraper import scrape_sources_async
    try:
        listings = await scrape_sources_async(comp_clean)
        if listings:
            cache_service.set_json(cache_key, listings, ttl_seconds=604800)  # 7 days
            logger.info("[CACHE SET] Cached %d listings under key '%s'", len(listings), cache_key)
            return listings, True
        return [], True
    except Exception:
        logger.exception(
            "Pharmacy-site scrape failed for composition %r — treating as "
            "'not checked', not as 'confirmed clean'.", comp_clean,
        )
        return [], False


async def find_iqvia_conflict(name: str, db) -> Optional[Dict[str, Any]]:
    """IQVIA check — searches active IqviaExtract rows for exact (100%) or >= 70% similarity."""
    from app.repositories.screening import ScreeningRepository

    repo = ScreeningRepository(db)
    local = repo.find_iqvia_local(name, active_only=True)
    for i in local:
        if i.brand_ims.strip().lower() == name.strip().lower():
            return {
                "name": i.brand_ims,
                "source": "IQVIA Database",
                "owner": i.company,
                "similarity_score": 1.0,
                "molecules": i.molecules,
            }

    best, best_score = None, 0.0
    for i in local:
        score = composite_similarity(name, i.brand_ims)
        if score > best_score:
            best_score, best = score, i
    if best and best_score >= MATCH_THRESHOLD:
        return {
            "name": best.brand_ims,
            "source": "IQVIA Database",
            "owner": best.company,
            "similarity_score": round(best_score, 3),
            "molecules": best.molecules,
        }
    return None


def find_pharmacy_conflict(name: str, listings: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    best = None
    best_score = 0.0
    for listing in listings:
        candidate = _brand_stub(listing["brand_name"])
        lev = levenshtein_similarity(name, candidate)
        phon = phonetic_similarity(name, candidate)
        comp = composite_similarity(name, candidate)
        ps = prefix_suffix_collision_score(name, candidate)
        exact = candidate.strip().lower() == name.strip().lower()
        
        # High confidence collision detection: exact match, high composite, or high LASA/phonetic match
        if exact:
            effective_score = 1.0
        elif comp >= MATCH_THRESHOLD:
            effective_score = comp
        elif phon >= 0.85:
            effective_score = phon
        elif ps >= 0.85:
            effective_score = ps
        elif lev >= 0.80:
            effective_score = lev
        else:
            effective_score = comp * 0.7  # Low confidence hit

        if effective_score > best_score:
            best_score = effective_score
            best = listing

    if best and best_score >= MATCH_THRESHOLD:
        return {
            "name": best["brand_name"],
            "source": best["source"],
            "owner": best.get("manufacturer") or None,
            "similarity_score": round(best_score, 3),
        }
    return None


async def find_google_conflict(name: str) -> Optional[Dict[str, Any]]:
    if not google_search_configured():
        return None

    cache_key = f"google_conflict:{name.lower()}"
    cached_result = cache_service.get_json(cache_key)
    if cached_result is not None:
        return cached_result if cached_result.get("conflict") else None

    query = f'"{name}" pharmaceutical OR medicine OR drug OR tablet'
    results = await search_google(query, pages=2)
    best = None
    best_score = 0.0
    for item in results:
        candidate = _brand_stub(item.get("title", ""))
        if not candidate:
            continue
        score = composite_similarity(name, candidate)
        if score > best_score:
            best_score = score
            best = item

    if best and best_score >= MATCH_THRESHOLD:
        conflict = {
            "name": name,
            "source": "Google Search",
            "owner": best.get("link"),
            "similarity_score": round(best_score, 3),
        }
        cache_service.set_json(cache_key, {"conflict": conflict}, ttl_seconds=2592000)  # 30 days
        return conflict

    cache_service.set_json(cache_key, {"conflict": None}, ttl_seconds=2592000)  # 30 days
    return None

