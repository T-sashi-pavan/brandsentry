"""Deterministic parser for the Trade Marks Registry (India) "List of
International Non Proprietary Names (INN)" PDF — a fixed two-column table
template (brand/nonproprietary name, WHO publication reference) repeated
across every page, with a header row only on page 1.

This is NOT a general-purpose PDF-to-text extraction — it assumes the exact
template referenced when this importer was built (INN.pdf at the repo
root). If the source document's layout ever changes, this parser needs to
change with it; it deliberately does not try to guess at other layouts.
"""
import io
import logging
import re
from typing import Any, Dict, List

import pdfplumber

logger = logging.getLogger(__name__)

_HEADER_NAME_CELL = "non-propriet"  # matches "Non-Proprietiory Names" / "Non-Proprietary Names"


def parse_who_inn_pdf(file_bytes: bytes) -> List[Dict[str, Any]]:
    """Returns a list of {"inn_name": str, "who_publication_reference": str}.

    Raises ValueError if the PDF has no extractable table on any page —
    that means it doesn't match the expected template, and the caller
    should reject the upload rather than silently importing nothing.
    """
    rows: List[Dict[str, Any]] = []

    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        if not pdf.pages:
            raise ValueError("PDF has no pages")

        for page in pdf.pages:
            tables = page.extract_tables()
            if not tables:
                continue
            for table in tables:
                for row in table:
                    if not row or len(row) < 2:
                        continue
                    name_cell = (row[0] or "").strip()
                    ref_cell = (row[1] or "").strip()
                    if not name_cell:
                        continue
                    if name_cell.lower().startswith(_HEADER_NAME_CELL):
                        continue  # header row, repeated defensively on any page
                    # Same INN name can legitimately appear more than once
                    # (re-published, corrected, etc. across WHO lists over the
                    # decades) — every row is kept, none collapsed or deduped.
                    rows.append({
                        "inn_name": name_cell,
                        "who_publication_reference": ref_cell or None,
                    })

    if not rows:
        raise ValueError(
            "No name/reference rows extracted from this PDF. It doesn't match "
            "the expected WHO INN list template (two-column table: name, "
            "WHO publication reference)."
        )
    return rows


def normalize_inn_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()).lower()
