"""Runs e-pharmacy discovery (1mg / PharmEasy / Apollo Pharmacy / Netmeds) via
live web scraping.

Same public interface as every prior version of this module
(clean_brand_name, generate_composition_key, scrape_sources_async), so every
caller (app.services.market_check, and transitively brand_screening.py /
generator.py) works unmodified.
"""
from typing import Any, Dict, List

from app.services.search_providers import scraping
from app.services.search_providers.scraping import clean_brand_name, generate_composition_key  # noqa: F401


async def scrape_sources_async(composition: str) -> List[Dict[str, Any]]:
    return await scraping.scrape_sources_async(composition)
