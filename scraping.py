"""Optimized high-performance browser-automation scraper for Indian e-pharmacies
(1mg, PharmEasy, Apollo Pharmacy, Netmeds).

Reaches the pharmacy sites directly with a headless browser (see
app/services/pharma_scraper.py, which dispatches to this module). Tries a
fast direct-HTTP path against each site's own public search endpoints first,
and only falls back to full Playwright browser automation when that doesn't
turn up enough matches.

Key Optimizations:
1. Container-Tuned Headless Browser: Chromium runs with flags optimized for Docker
   (--disable-dev-shm-usage, --disable-gpu, --no-sandbox, --disable-blink-features).
2. Direct DOM Hydration: Avoids blocking critical scripts/fonts that cause Next.js/React
   hangs on modern pharmacy portals.
3. Fast Multi-Portal Locator Extraction: Robust resilient selectors capturing
   medicine names, manufacturers, and dosage forms across 1mg, PharmEasy, Apollo, Netmeds.
4. Concurrency Throttling (Semaphore): Limits active browser tabs to 4 concurrent
   workers to maintain flat ~20% CPU on small server/container instances.
5. Fail-Safe Conflict Integrity: Accurately extracts brand names and manufacturers
   without dropping or falsely clearing conflicts.
"""
import asyncio
import json
import logging
import re
import urllib.parse
from typing import Any, Dict, List, Optional
import httpx

logger = logging.getLogger(__name__)


class EPharmacyVerificationError(RuntimeError):
    """The e-pharmacy tier could not actually verify the name.

    Raised when the browser tier was REQUIRED (one or more target portals were
    not covered by the fast direct-HTTP path) but the browser never started —
    e.g. Playwright's driver subprocess cannot launch under Windows +
    `uvicorn --reload`, which forces a WindowsSelectorEventLoop and makes
    asyncio.create_subprocess_exec raise NotImplementedError.

    This exists so a browser-startup failure can never be mistaken for
    "scraped successfully, found no matches". Callers already treat an
    exception from the scrape as "not checked" rather than "confirmed clean"
    (see market_check.scrape_pharmacy_listings), so raising this routes the
    failure down the correct, pre-existing path — an unverified e-pharmacy
    stage, which is NOT cached as a completed check.
    """

# Navigation and extraction timeouts
_NAV_TIMEOUT_MS = 15000
_MAX_CONCURRENT_TABS = 4

# ---------------------------------------------------------------------------
# Shared Chromium instance
# ---------------------------------------------------------------------------
# Chromium was previously launched AND destroyed once per candidate name, so a
# run screening N candidates paid N cold process starts. The browser carries no
# per-candidate state — isolation lives in the per-scrape `new_context()` below,
# which is unchanged — so one long-lived browser serves every scrape.
#
# Failure semantics are deliberately identical to the per-call version: if the
# driver subprocess or Chromium cannot start (e.g. the Windows + `uvicorn
# --reload` NotImplementedError), _get_shared_browser raises, the caller's
# `browser_started` stays False, and the existing EPharmacyVerificationError
# path still reports the portals as UNCHECKED. A startup failure can never
# become an implicit pass.
_BROWSER_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
]

_shared_playwright = None
_shared_browser = None
_browser_lock: Optional[asyncio.Lock] = None
BROWSER_LAUNCHES = 0   # diagnostics only


def _get_browser_lock() -> asyncio.Lock:
    global _browser_lock
    if _browser_lock is None:
        _browser_lock = asyncio.Lock()
    return _browser_lock


async def _get_shared_browser():
    """Returns a live shared Chromium, launching it on first use.

    Raises on startup failure — callers must treat that as "not verified"."""
    global _shared_playwright, _shared_browser, BROWSER_LAUNCHES
    async with _get_browser_lock():
        if _shared_browser is not None:
            try:
                if _shared_browser.is_connected():
                    return _shared_browser
            except Exception:
                pass
            # Crashed or disconnected — drop it and relaunch.
            logger.warning("[BROWSER] Shared Chromium was disconnected; relaunching")
            _shared_browser = None

        from playwright.async_api import async_playwright

        if _shared_playwright is None:
            _shared_playwright = await async_playwright().start()
        _shared_browser = await _shared_playwright.chromium.launch(
            headless=True, args=_BROWSER_ARGS,
        )
        BROWSER_LAUNCHES += 1
        logger.info("[BROWSER] Shared Chromium launched (launch #%d this process)", BROWSER_LAUNCHES)
        return _shared_browser


async def shutdown_browser() -> None:
    """Closes the shared browser. Safe to call when nothing was ever launched."""
    global _shared_playwright, _shared_browser
    async with _get_browser_lock():
        if _shared_browser is not None:
            try:
                await _shared_browser.close()
            except Exception:
                logger.debug("[BROWSER] close() during shutdown raised", exc_info=True)
            _shared_browser = None
        if _shared_playwright is not None:
            try:
                await _shared_playwright.stop()
            except Exception:
                logger.debug("[BROWSER] stop() during shutdown raised", exc_info=True)
            _shared_playwright = None
    logger.info("[BROWSER] Shared Chromium shut down")


def clean_brand_name(name: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", name.upper())


def generate_composition_key(composition: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", composition.upper())


_STRIP_SUFFIXES = re.compile(
    r"\b(\d+[\.,]?\d*\s*(mg|ml|mcg|iu|gm|g|%)|"
    r"tablet|tablets|capsule|capsules|syrup|injection|injections|solution|cream|gel|ointment|"
    r"drops|inhaler|spray|suspension|powder|sachet|sachets|strip|bottle|bottles|"
    r"pack|box|pc|pcs|dt|sr|er|cr|xl|of \d+)\b.*$",
    re.IGNORECASE,
)

_IGNORE_EXACT = {
    "sort by:", "sort by", "relevance", "discount", "sponsored", "filters", "filter",
    "search results", "generic alternate", "buy 2, +2% off", "brand", "category",
    "benefits", "hair concern", "health condition", "age group", "product form",
    "delivery address", "select address", "search medicines", "login", "buy medicines",
}


def clean_brand_stub(raw_title: str) -> str:
    if not raw_title:
        return ""
    t = raw_title.strip()
    if t.lower() in _IGNORE_EXACT or t.startswith("₹") or t.startswith("★") or "search results for" in t.lower():
        return ""
    for prefix in ("Netmeds | ", "Netmeds |", "Buy ", "Order "):
        if t.startswith(prefix):
            t = t[len(prefix):].strip()
    for sep in (" - ", " | ", " : ", " – ", " — "):
        if sep in t:
            t = t.split(sep)[0]
    stub = _STRIP_SUFFIXES.sub("", t).strip(" -'\",./")
    if not stub or stub.lower() in _IGNORE_EXACT or len(stub) < 2:
        return ""
    if re.match(r"^\d+\s*(gm|g|ml|mg|tablet|tablets|capsule|capsules)?$", stub, re.I):
        return ""
    return stub


async def _extract_apollo(page) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    _apollo_ignore = {
        "login", "filters", "product type", "brand", "category", "product form",
        "country of origin", "price", "age group", "health condition", "find doctors",
        "lab tests", "circle membership", "health records", "credit card", "buy insurance",
        "apollo products", "personal care", "baby care", "skin care", "oral care",
        "mens grooming", "sexual wellness", "diapers & wipes", "delivery address",
        "select address", "search medicines", "buy medicines", "need help", "customer care",
        "ratings", "frequently asked", "terms & conditions",
    }
    try:
        elements = await page.locator("div.Q_ h3, h3[class*='vR'], div[class*='ProductCard'] h3, div[class*='ProductCard'] h2, a[href*='/medicine/'] h3, a[href*='/otc/'] h3").all_text_contents()
        for text in elements:
            stub = clean_brand_stub(text)
            if stub and stub.lower() not in seen and not stub.startswith("₹") and len(stub) >= 2:
                if stub.lower() in _apollo_ignore:
                    continue
                seen.add(stub.lower())
                out.append({"brand_name": stub, "raw_name": text.strip(), "manufacturer": "Unknown", "source": "Apollo Pharmacy"})
    except Exception:
        pass

    if len(out) < 5:
        try:
            all_text = await page.locator("body").inner_text()
            lines = [l.strip() for l in all_text.split("\n") if len(l.strip()) > 2]
            for l in lines:
                l_lower = l.lower()
                if any(em in l_lower for em in _apollo_ignore):
                    continue
                if "add to cart" in l_lower or l_lower.endswith("off") or "ratings" in l_lower:
                    continue
                # Must look like a medicine product: contains dosage form
                if not any(d in l_lower for d in ("tablet", "capsule", "syrup", "suspension", "strip", "mg", "ml", "gel", "drops", "ointment", "cream", "dt", "plus")):
                    continue
                stub = clean_brand_stub(l)
                if stub and stub.lower() not in seen and stub.lower() not in _apollo_ignore and len(stub) >= 2:
                    seen.add(stub.lower())
                    out.append({"brand_name": stub, "raw_name": l, "manufacturer": "Unknown", "source": "Apollo Pharmacy"})
                    if len(out) >= 15:
                        break
        except Exception:
            pass
    return out


async def _extract_1mg(page) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    try:
        elements = await page.locator("[class*='pro-title'], [class*='product-title'], [class*='product-description'], [class*='ProductTitle'], [class*='Card'] h2, [class*='Card'] h3, [class*='product-box'] h2, [class*='product-box'] h3").all_text_contents()
        for text in elements:
            stub = clean_brand_stub(text)
            if stub and stub.lower() not in seen and len(stub) >= 2:
                if stub.lower() in ("brands", "product form", "prescription required", "uses", "country of origin", "generic drugs (salts)"):
                    continue
                seen.add(stub.lower())
                out.append({"brand_name": stub, "raw_name": text.strip(), "manufacturer": "Unknown", "source": "1mg"})
    except Exception:
        pass

    if not out:
        try:
            all_text = await page.locator("body").inner_text()
            lines = [l.strip() for l in all_text.split("\n") if len(l.strip()) > 2]
            capturing = False
            for l in lines:
                if "search results for" in l.lower() or "all products" in l.lower():
                    capturing = True
                    continue
                if capturing:
                    if any(x in l.lower() for x in ["need help", "ratings & reviews", "frequently bought"]):
                        break
                    if any(u in l.lower() for u in ["tablet", "syrup", "capsule", "injection", "drops", "gel", "suspension", "mg"]):
                        stub = clean_brand_stub(l)
                        if stub and stub.lower() not in seen and len(stub) >= 2:
                            seen.add(stub.lower())
                            out.append({"brand_name": stub, "raw_name": l, "manufacturer": "Unknown", "source": "1mg"})
                            if len(out) >= 15:
                                break
        except Exception:
            pass
    return out


async def _extract_pharmeasy(page) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    try:
        cards = page.locator("div[class*='ProductCard_medicineUnitContainer'], div[class*='ProductCard_productContainer']")
        count = min(await cards.count(), 20)
        for i in range(count):
            card = cards.nth(i)
            name_loc = card.locator("h1, h2, h3, div[class*='ProductCard_name']").first
            if await name_loc.count() == 0:
                continue
            raw_name = (await name_loc.text_content() or "").strip()
            stub = clean_brand_stub(raw_name)
            if not stub or stub.lower() in seen:
                continue
            seen.add(stub.lower())
            manufacturer = "Unknown"
            mfg_loc = card.locator("div[class*='ProductCard_brandName'], span[class*='ProductCard_brandName']").first
            if await mfg_loc.count() > 0:
                mfg_text = (await mfg_loc.text_content() or "").strip()
                if mfg_text.startswith("By "):
                    manufacturer = mfg_text[3:].strip()
                elif mfg_text:
                    manufacturer = mfg_text
            out.append({"brand_name": stub, "raw_name": raw_name, "manufacturer": manufacturer, "source": "PharmEasy"})
    except Exception:
        pass
    return out


async def _extract_netmeds(page) -> List[Dict[str, Any]]:
    out = []
    seen = set()
    try:
        elements = await page.locator("h3[class*='jm-body'], h3[class*='head-lineheight'], a[href*='/prescriptions/'] h3, a[href*='/product/'] h3, a.product-item h3, div.product-card h3, div[class*='product-item'] h3, span.clsgetname, div.info, div.info h3, .clsgetname").all_text_contents()
        for text in elements:
            stub = clean_brand_stub(text)
            if stub and stub.lower() not in seen and "prescription" not in text.lower() and len(stub) >= 2:
                seen.add(stub.lower())
                out.append({"brand_name": stub, "raw_name": text.strip(), "manufacturer": "Unknown", "source": "Netmeds"})
    except Exception:
        pass

    if not out:
        try:
            all_text = await page.locator("body").inner_text()
            lines = [l.strip() for l in all_text.split("\n") if len(l.strip()) > 2]
            for l in lines:
                if any(u in l.lower() for u in ["tablet", "syrup", "capsule", "suspension", "strip", "mg", "ml"]):
                    stub = clean_brand_stub(l)
                    if stub and stub.lower() not in seen and len(stub) >= 2:
                        seen.add(stub.lower())
                        out.append({"brand_name": stub, "raw_name": l, "manufacturer": "Unknown", "source": "Netmeds"})
                        if len(out) >= 15:
                            break
        except Exception:
            pass
    return out


async def _scrape_one_site_optimized(
    browser, url: str, site_name: str, extractor, user_agent: str, semaphore: asyncio.Semaphore, wait_until: str = "domcontentloaded", post_wait: int = 1500,
) -> List[Dict[str, Any]]:
    from playwright_stealth import Stealth

    async with semaphore:
        context = await browser.new_context(
            user_agent=user_agent,
            viewport={"width": 1280, "height": 720},
            bypass_csp=True,
        )
        try:
            page = await context.new_page()
            await Stealth().apply_stealth_async(page)

            # Block heavy media and images to optimize extraction speed
            async def _block_unwanted_resources(route):
                req = route.request
                if req.resource_type in ("image", "media", "video", "font", "imageset", "beacon", "csp_report"):
                    await route.abort()
                else:
                    await route.continue_()

            await page.route("**/*", _block_unwanted_resources)

            try:
                await page.goto(url, wait_until=wait_until, timeout=_NAV_TIMEOUT_MS)
            except Exception as nav_err:
                logger.debug("[%s] Page navigation notice: %s", site_name, nav_err)

            try:
                await page.wait_for_timeout(post_wait)
            except Exception:
                pass

            extracted = await extractor(page)
            logger.info("[%s] Captured %d medicine entries for live query", site_name, len(extracted))
            return extracted
        except Exception as e:
            logger.warning("[%s] Scrape warning for %s: %s", site_name, url, e)
            return []
        finally:
            await context.close()


async def _fetch_pharmeasy_http(client: httpx.AsyncClient, query: str) -> List[Dict[str, Any]]:
    try:
        url = f"https://pharmeasy.in/api/search/search/?q={urllib.parse.quote(query)}"
        resp = await client.get(url, timeout=3.5)
        if resp.status_code == 200:
            data = resp.json()
            products = data.get("data", {}).get("products", [])
            out = []
            for p in products[:15]:
                name = (p.get("name") or "").strip()
                mfr = (p.get("manufacturer") or "Unknown").strip()
                stub = clean_brand_stub(name)
                if stub and len(stub) >= 2:
                    out.append({"brand_name": stub, "raw_name": name, "manufacturer": mfr, "source": "PharmEasy"})
            return out
    except Exception as e:
        logger.debug("[PharmEasy HTTP] Fast fetch notice: %s", e)
    return []


async def _fetch_apollo_http(client: httpx.AsyncClient, query: str) -> List[Dict[str, Any]]:
    try:
        headers = {
            "Authorization": "Oeu324WMvfKOj5KMJh2Lkf00eW1",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        }
        payload = {
            "query": query.lower().strip(),
            "page": 1,
            "productsPerPage": 24,
            "selSortBy": "relevance",
            "filters": [],
            "pincode": "",
        }
        resp = await client.post(
            "https://apigateway.apollo247.in/search-service/v4/fullSearch",
            json=payload, headers=headers, timeout=4.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            products = data.get("data", {}).get("productDetails", {}).get("products", [])
            out = []
            for p in products[:20]:
                name = (p.get("name") or "").strip()
                brand = (p.get("brand") or "").strip() or clean_brand_stub(name)
                mfr = (p.get("manufacturer") or "Unknown").strip()
                if brand and len(brand) >= 2:
                    out.append({"brand_name": brand, "raw_name": name, "manufacturer": mfr, "source": "Apollo Pharmacy"})
            return out
    except Exception as e:
        logger.debug("[Apollo HTTP] Fast fetch notice: %s", e)
    return []


async def _fetch_netmeds_http(client: httpx.AsyncClient, query: str) -> List[Dict[str, Any]]:
    try:
        url = f"https://www.netmeds.com/products?q={urllib.parse.quote(query)}"
        resp = await client.get(url, headers={"Referer": "https://www.netmeds.com/"}, timeout=9.0)

        if resp.status_code == 200:
            out = []
            idx = resp.text.find('__INITIAL_STATE__=')
            if idx != -1:
                try:
                    raw = resp.text[idx + len('__INITIAL_STATE__='):]
                    data, _ = json.JSONDecoder().raw_decode(raw)
                    items = data.get('productListingPage', {}).get('productlists', {}).get('items', [])
                    for it in items[:20]:
                        name = (it.get('name') or '').strip()
                        attrs = it.get('attributes', {})
                        mfr = attrs.get('manufacturername') or attrs.get('marketername') or 'Unknown'
                        stub = clean_brand_stub(name)
                        if stub and len(stub) >= 2 and "prescription" not in name.lower():
                            out.append({"brand_name": stub, "raw_name": name, "manufacturer": mfr, "source": "Netmeds"})
                except Exception as parse_err:
                    logger.debug("[Netmeds JSON decode] %s", parse_err)
            if not out:
                matches = re.findall(r'<a[^>]{1,300}?title=[\'"]([^\'"]{1,300})[\'"][^>]{0,300}?href=[\'"][^\'"]{0,300}product', resp.text)
                for m in matches[:15]:
                    name = m.strip()
                    stub = clean_brand_stub(name)
                    if stub and len(stub) >= 2 and "prescription" not in name.lower():
                        out.append({"brand_name": stub, "raw_name": name, "manufacturer": "Unknown", "source": "Netmeds"})
            return out
    except Exception as e:
        logger.debug("[Netmeds HTTP] Fast fetch notice: %s", e)
    return []



async def _scrape_sources_impl(composition: str) -> List[Dict[str, Any]]:
    comp_clean = composition.strip()
    if not comp_clean:
        return []

    comp_key = generate_composition_key(comp_clean)
    brands_dict: Dict[str, dict] = {}
    found_sources = set()

    # 1. Fast HTTP REST extraction layer
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json, text/html, */*",
        "Accept-Language": "en-US,en;q=0.9",
    }

    http_batches = []
    try:
        async with httpx.AsyncClient(headers=headers, timeout=10.0, follow_redirects=True) as client:

            tasks = [
                _fetch_pharmeasy_http(client, comp_clean),
                _fetch_apollo_http(client, comp_clean),
                _fetch_netmeds_http(client, comp_clean),
            ]
            http_batches = await asyncio.gather(*tasks, return_exceptions=True)

    except Exception as e:
        logger.debug("HTTP pharmacy extraction notice: %s", e)

    for batch in http_batches:
        if isinstance(batch, list):
            for item in batch:
                brand = item.get("brand_name", "")
                if not brand or len(brand) < 2:
                    continue
                src = item["source"]
                found_sources.add(src)
                if brand not in brands_dict:
                    brands_dict[brand] = {
                        "raw_name": item.get("raw_name") or brand,
                        "manufacturer": item.get("manufacturer") or "Unknown",
                        "sources": {src},
                    }
                else:
                    brands_dict[brand]["sources"].add(src)
                    if brands_dict[brand]["manufacturer"] == "Unknown" and item.get("manufacturer") != "Unknown":
                        brands_dict[brand]["manufacturer"] = item["manufacturer"]

    # 2. Playwright browser automation for missing target sources or low counts
    all_target_sources = {"1mg", "PharmEasy", "Apollo Pharmacy", "Netmeds"}
    missing_sources = all_target_sources - found_sources

    # If any portal is missing, or total matches < 5, run Playwright across missing sites
    browser_tier_required = bool(missing_sources or len(brands_dict) < 5)
    browser_started = False
    browser_start_error: Optional[BaseException] = None

    if browser_tier_required:
        try:
            encoded_query = urllib.parse.quote(comp_clean)
            all_candidate_sites = [
                ("1mg", f"https://www.1mg.com/search/all?name={encoded_query}", _extract_1mg, "domcontentloaded", 2000),
                ("Netmeds", f"https://www.netmeds.com/products?q={encoded_query}", _extract_netmeds, "domcontentloaded", 3500),
                ("PharmEasy", f"https://pharmeasy.in/search/all?name={encoded_query}", _extract_pharmeasy, "domcontentloaded", 1500),
                ("Apollo Pharmacy", f"https://www.apollopharmacy.in/search-medicines/{encoded_query}", _extract_apollo, "domcontentloaded", 2500),
            ]
            # Prioritize scraping sites that haven't delivered enough results yet
            sites_to_scrape = [
                s for s in all_candidate_sites
                if s[0] in missing_sources or sum(1 for d in brands_dict.values() if s[0] in d["sources"]) < 3
            ] or all_candidate_sites

            semaphore = asyncio.Semaphore(_MAX_CONCURRENT_TABS)
            user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

            browser = await _get_shared_browser()
            # Past this point the driver subprocess and Chromium are both
            # up: any later failure is a per-site scrape problem, not a
            # browser-startup problem, and is tolerated per-site below.
            browser_started = True

            async def _safe_scrape(name, url, extractor, wait_until, post_wait):
                try:
                    return await asyncio.wait_for(
                        _scrape_one_site_optimized(browser, url, name, extractor, user_agent, semaphore, wait_until, post_wait),
                        timeout=16.0,
                    )
                except Exception as e:
                    logger.warning("[%s] Browser scrape notice: %s", name, e)
                    return []

            # The browser is shared and intentionally NOT closed here; each
            # scrape's own context is still closed in _scrape_one_site_optimized,
            # so per-scrape isolation (cookies, storage, session state) is
            # unchanged. Process-level teardown is shutdown_browser().
            browser_batches = await asyncio.gather(*(
                _safe_scrape(name, url, extractor, wu, pw)
                for name, url, extractor, wu, pw in sites_to_scrape
            ))

            for batch in browser_batches:
                for item in batch:
                    brand = item.get("brand_name", "")
                    if not brand or len(brand) < 2:
                        continue
                    src = item["source"]
                    found_sources.add(src)
                    if brand not in brands_dict:
                        brands_dict[brand] = {
                            "raw_name": item.get("raw_name") or brand,
                            "manufacturer": item.get("manufacturer") or "Unknown",
                            "sources": {src},
                        }
                    else:
                        brands_dict[brand]["sources"].add(src)
                        if brands_dict[brand]["manufacturer"] == "Unknown" and item.get("manufacturer") != "Unknown":
                            brands_dict[brand]["manufacturer"] = item["manufacturer"]
        except Exception as e:
            if not browser_started:
                # The browser never came up — the portals this tier was meant
                # to cover were NOT checked. Recorded here and converted into
                # an explicit verification failure below; must not be
                # downgraded to "found nothing".
                browser_start_error = e
                if isinstance(e, NotImplementedError):
                    logger.error(
                        "[E-PHARMACY BROWSER STARTUP FAILED] Playwright could not start its "
                        "driver subprocess: NotImplementedError from asyncio.create_subprocess_exec. "
                        "This is the known Windows + `uvicorn --reload` incompatibility — --reload "
                        "sets use_subprocess=True, which makes uvicorn install "
                        "WindowsSelectorEventLoopPolicy, and the Windows selector loop does not "
                        "implement subprocess support. Run without --reload (or use a worker/thread "
                        "with a ProactorEventLoop) to restore browser verification.",
                    )
                else:
                    logger.error("[E-PHARMACY BROWSER STARTUP FAILED] %s: %s", type(e).__name__, e)
            else:
                # Browser was up; this is a post-startup scrape problem. The
                # per-site handler already tolerates individual site failures,
                # so anything reaching here is non-fatal to verification.
                logger.warning("Browser automation notice (post-startup): %s", e)

    # Correctness gate: if the browser tier was required to cover portals the
    # fast HTTP path did not reach, and the browser never started, then those
    # portals are simply UNCHECKED. Returning the HTTP-only brands_dict here
    # would present an unverified name as cleanly scraped, so fail loudly
    # instead — callers map an exception to "not checked", never to "clean".
    if browser_start_error is not None and missing_sources:
        raise EPharmacyVerificationError(
            f"E-pharmacy verification incomplete for {composition!r}: browser tier failed to "
            f"start ({type(browser_start_error).__name__}) and portal(s) "
            f"{', '.join(sorted(missing_sources))} were not covered by the direct-HTTP fallback."
        ) from browser_start_error

    results = [
        {
            "brand_name": brand,
            "brand_name_clean": clean_brand_name(brand),
            "composition_scraped": composition,
            "manufacturer": details["manufacturer"],
            "composition_key": comp_key,
            "source": ", ".join(sorted(details["sources"])),
            "sources_list": sorted(list(details["sources"])),
        }
        for brand, details in brands_dict.items()
    ]

    # Name the tier that actually produced the evidence, so a fallback-only
    # result is never read back as a full browser verification.
    if not browser_tier_required:
        tier = "source=direct-http (browser tier not required)"
    elif browser_started:
        tier = "source=playwright"
    else:
        tier = "source=direct-http FALLBACK ONLY (browser tier failed to start)"

    logger.info(
        "OPTIMIZED E-PHARMACY SCRAPE COMPLETED [%s]: %d brand matches across %d platforms (%s) for query '%s'",
        tier, len(results), len(found_sources), ", ".join(sorted(found_sources)) or "none", composition,
    )
    return results


async def scrape_sources_async(composition: str) -> List[Dict[str, Any]]:
    """Runs high-performance async multi-portal scraper."""
    return await _scrape_sources_impl(composition)
