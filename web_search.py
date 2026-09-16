"""Google Custom Search JSON API — used to check a candidate brand name
against Google's general web index (not scoped to any particular site).

Requires GOOGLE_API_KEY + GOOGLE_CSE_ID (a Programmable Search Engine set to
search the entire web). Returns [] when unconfigured or on any API error —
callers must treat that as "not checked", never as "confirmed clean" (an
empty result here carries no evidence either way).
"""
import re
import time
import logging
from typing import Any, Dict, List

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

GOOGLE_CSE_URL = "https://www.googleapis.com/customsearch/v1"
_TIMEOUT = httpx.Timeout(3.0, connect=1.5)
_RESULTS_PER_PAGE = 10
_DISABLED_UNTIL = 0.0


def google_search_available() -> bool:
    if not settings.GOOGLE_API_KEY or not settings.GOOGLE_CSE_ID:
        return False
    return time.time() > _DISABLED_UNTIL


_QUOTED_TERM = re.compile(r'"([^"]+)"')


def _is_material_correction(query: str, corrected: str) -> bool:
    """True when Google answered for a genuinely different term.

    The screening query wraps the candidate in quotes
    (`"Qymbrent" pharmaceutical OR medicine ...`), so only the quoted term is
    compared — a correction to the boilerplate around it is irrelevant.
    Case and punctuation differences are not material either; a different
    WORD is.
    """
    def _term(s: str) -> str:
        m = _QUOTED_TERM.search(s or "")
        raw = m.group(1) if m else (s or "").split()[0] if (s or "").strip() else ""
        return re.sub(r"[^a-z0-9]", "", raw.lower())

    q, c = _term(query), _term(corrected)
    return bool(q) and bool(c) and q != c


async def search_google(query: str, pages: int = 2) -> List[Dict[str, Any]]:
    """Fetch up to `pages` pages (10 results each) of Google Custom Search
    results for `query`. Returns a flat list of {title, link, snippet}."""
    global _DISABLED_UNTIL
    if not google_search_available():
        return []

    results: List[Dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            for page_index in range(pages):
                start = page_index * _RESULTS_PER_PAGE + 1
                response = await client.get(GOOGLE_CSE_URL, params={
                    "key": settings.GOOGLE_API_KEY,
                    "cx": settings.GOOGLE_CSE_ID,
                    "q": query,
                    "num": _RESULTS_PER_PAGE,
                    "start": start,
                })
                if response.status_code != 200:
                    if response.status_code in (401, 403, 429):
                        _DISABLED_UNTIL = time.time() + 600  # 10 min cooldown
                        logger.warning("Google CSE returned %s for query %r — cooling down for 10 minutes", response.status_code, query)
                    else:
                        logger.warning("Google CSE returned %s for query %r", response.status_code, query)
                    break
                data = response.json()
                # Google spell-correction guard.
                # When Google cannot find the queried term it answers for a
                # DIFFERENT word ("These are results for current" for a query
                # of "qymbrent") and reports that in `spelling.correctedQuery`.
                # Those results describe the corrected word, not the name we
                # asked about, so they are not evidence about our candidate.
                #
                # This matters because "did you mean" is itself a phonetic
                # similarity engine: the word Google substitutes is chosen for
                # SOUNDING like the query, so it then trivially clears the
                # phonetic bar downstream and rejects the very name that was
                # searched for. A coined name that exists nowhere is the exact
                # case that triggers a correction, so this fired on precisely
                # the candidates that were most likely to be clean.
                corrected = (data.get("spelling") or {}).get("correctedQuery")
                if corrected and _is_material_correction(query, corrected):
                    logger.info(
                        "[GOOGLE SPELL-CORRECTION] Query %r was answered as %r — "
                        "results describe a different term and are NOT counted as "
                        "conflict evidence for the queried name.",
                        query, corrected,
                    )
                    break
                items = data.get("items", [])
                for item in items:
                    results.append({
                        "title": item.get("title", ""),
                        "link": item.get("link", ""),
                        "snippet": item.get("snippet", ""),
                    })
                if len(items) < _RESULTS_PER_PAGE:
                    break
    except Exception as exc:
        logger.warning("Google CSE search noticed for query %r: %s", query, exc)
    return results

