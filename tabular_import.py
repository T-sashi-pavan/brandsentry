"""Deterministic parsers for the two Excel-based Tier-1 reference imports:

  - "Registered but Not in Use" — the Trade Marks Registry's own export of
    registered-but-unused marks (e.g. "Un-used TradeMarks List 2026.xlsx").
    Matched against the real workbook used to build this: it ships with two
    sheets that use *different* column sets for the same data (one has a
    "Discontinued brand" free-text column and an unlabeled Y/N column, the
    other has "Description"/"E-commerce URL" instead) — headers are matched
    by name, not position, and both sheets are read.
  - "International Market Brands" — an overseas brand-name search export
    (e.g. "OVERSEAS BRAND-NAMES_SEARCHED.xlsx"): a flat 3-column sheet
    (Sr No., Mark, Molecule) with no country breakdown.

Both are template-specific (matched to the real files this importer
was built against), just tolerant of header order/casing/aliases within
that template.
"""
import io
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import openpyxl


def normalize_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip()).lower()


def _normalize_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _build_column_index(header_row: Tuple[Any, ...], aliases: Dict[str, List[str]]) -> Dict[str, int]:
    col_index: Dict[str, int] = {}
    for idx, raw_header in enumerate(header_row):
        key = _normalize_header(raw_header)
        if not key:
            continue
        for field, alias_list in aliases.items():
            if field in col_index:
                continue
            if key in alias_list:
                col_index[field] = idx
    return col_index


def _cell(row: Tuple[Any, ...], col_index: Dict[str, int], field: str) -> Any:
    idx = col_index.get(field)
    if idx is None or idx >= len(row):
        return None
    return row[idx]


# ---------------------------------------------------------------------------
# Registered but Not in Use
# ---------------------------------------------------------------------------

_REG_NOT_IN_USE_ALIASES: Dict[str, List[str]] = {
    "brand_name": ["trademarkname", "trademark", "unusedtrademarkname"],
    "trademark_class": ["class", "tmclass", "trademarkclass"],
    "application_number": ["applno", "applicationno", "applicationnumber"],
    "application_date": ["appldate", "applicationdate"],
    "status": ["tmrstatus", "tmstatus"],
    "valid_till": ["validtill", "validuntil", "expiry", "expirydate"],
    "remarks": ["discontinuedbrand", "description", "remarks", "notes"],
}


def parse_registered_not_in_use_xlsx(file_bytes: bytes) -> List[Dict[str, Any]]:
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
    deduped: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}

    for sheet in wb.worksheets:
        rows_iter = sheet.iter_rows(min_row=1, values_only=True)
        header_row = next(rows_iter, None)
        if not header_row:
            continue
        col_index = _build_column_index(header_row, _REG_NOT_IN_USE_ALIASES)
        
        # Strict validation: MUST contain trademark name and at least one TM specific field
        if "brand_name" not in col_index or (
            "trademark_class" not in col_index and "application_number" not in col_index and "status" not in col_index
        ):
            continue

        for row in rows_iter:
            brand_name_raw = _cell(row, col_index, "brand_name")
            if not brand_name_raw or not str(brand_name_raw).strip():
                continue
            brand_name = str(brand_name_raw).strip()

            class_raw = _cell(row, col_index, "trademark_class")
            trademark_class = None
            if class_raw is not None:
                try:
                    trademark_class = int(class_raw)
                except (TypeError, ValueError):
                    pass

            application_number = _cell(row, col_index, "application_number")
            application_number = str(application_number).strip() if application_number is not None else None

            app_date_raw = _cell(row, col_index, "application_date")
            application_date = app_date_raw if isinstance(app_date_raw, datetime) else None

            valid_till_raw = _cell(row, col_index, "valid_till")
            valid_till = valid_till_raw if isinstance(valid_till_raw, datetime) else None

            status_raw = _cell(row, col_index, "status")
            status = str(status_raw).strip() if status_raw is not None else None

            # Keep unparsed remarks
            remarks_parts = []
            remarks_raw = _cell(row, col_index, "remarks")
            if remarks_raw is not None and str(remarks_raw).strip():
                remarks_parts.append(str(remarks_raw).strip())
            if valid_till_raw is not None and valid_till is None:
                remarks_parts.append(f"Valid till (unparsed): {valid_till_raw}")

            key = (normalize_name(brand_name), application_number)
            deduped[key] = {
                "brand_name": brand_name,
                "normalized_name": normalize_name(brand_name),
                "trademark_class": trademark_class,
                "application_number": application_number,
                "application_date": application_date,
                "status": status,
                "valid_till": valid_till,
                "remarks": " | ".join(remarks_parts) or None,
            }

    if not deduped:
        raise ValueError(
            "This workbook does not match the 'Registered but Not in Use' template. "
            "(Expected columns: 'TradeMark Name', 'Class', 'Appl No', 'TMR STATUS')."
        )
    return list(deduped.values())


# ---------------------------------------------------------------------------
# International Market Brands
# ---------------------------------------------------------------------------

_INTL_MARKET_ALIASES: Dict[str, List[str]] = {
    "brand_name": ["mark", "internationalbrandname", "overseasbrandname"],
    "active_ingredient": ["molecule", "activeingredient", "genericname", "generic"],
    "country": ["country", "market"],
}


def parse_international_market_xlsx(file_bytes: bytes) -> List[Dict[str, Any]]:
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
    deduped: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}

    for sheet in wb.worksheets:
        rows_iter = sheet.iter_rows(min_row=1, values_only=True)
        header_row = next(rows_iter, None)
        if not header_row:
            continue
        col_index = _build_column_index(header_row, _INTL_MARKET_ALIASES)
        
        # Strict validation: MUST contain Mark AND Molecule
        if "brand_name" not in col_index or "active_ingredient" not in col_index:
            continue

        for row in rows_iter:
            brand_name_raw = _cell(row, col_index, "brand_name")
            if not brand_name_raw or not str(brand_name_raw).strip():
                continue
            brand_name = str(brand_name_raw).strip()

            ingredient_raw = _cell(row, col_index, "active_ingredient")
            active_ingredient = str(ingredient_raw).strip() if ingredient_raw is not None else None

            country_raw = _cell(row, col_index, "country")
            country = str(country_raw).strip() if country_raw is not None else None

            key = (normalize_name(brand_name), active_ingredient)
            deduped[key] = {
                "brand_name": brand_name,
                "normalized_name": normalize_name(brand_name),
                "active_ingredient": active_ingredient,
                "country": country,
            }

    if not deduped:
        raise ValueError(
            "This workbook does not match the 'International Market Brands' template. "
            "(Expected columns: 'Mark', 'Molecule')."
        )
    return list(deduped.values())


# ---------------------------------------------------------------------------
# IQVIA Market Database Extract (XLSX & XLSB)
# ---------------------------------------------------------------------------

_IQVIA_ALIASES: Dict[str, List[str]] = {
    "brand_ims": ["brandims", "brand_ims", "brand", "brandname", "mark", "brand_name"],
    "molecules": ["molecules", "molecule", "activeingredient", "generic", "genericname", "composition"],
    "atc_iv": ["atciv", "atc_iv", "atc4", "atc", "atccode"],
    "company": ["company", "manufacturer", "mfr", "marketer", "corporation", "owner"],
    "product_launch": ["productlaunch", "product_launch", "launchdate", "launch", "launchmonth"],
    "val_mat_current": ["valmatjun26", "valmatcurrent", "val_mat_jun_26", "val_mat_current", "valmat26", "val_mat", "valmat"],
    "val_mat_prev": ["valmatjun25", "valmatprev", "val_mat_jun_25", "val_mat_prev", "valmat25"],
    "val_gr_pct": ["valgrpct", "val_gr_pct", "valgrowthpct", "valgrowth", "valgr", "valgrowth%"],
    "un_mat_current": ["unmatjun26", "unmatcurrent", "un_mat_jun_26", "un_mat_current", "unmat26", "un_mat", "unitsmatcurrent", "unmat"],
    "un_mat_prev": ["unmatjun25", "unmatprev", "un_mat_jun_25", "un_mat_prev", "unmat25", "unitsmatprev"],
    "un_gr_pct": ["ungrpct", "un_gr_pct", "ungrowthpct", "ungrowth", "ungr", "ungrowth%"],
    "no_of_mol": ["noofmol", "no_of_mol", "moleculescount", "numberofmolecules", "numofmolecules", "molcount"],
    "plain_comb": ["plaincomb", "plain_comb", "plaincombination", "combination", "combtype"],
}


def _parse_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().replace(",", "")
    if not s or s.lower() in ("nan", "null", "none", "-", "n/a", ""):
        return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _parse_int(val: Any) -> Optional[int]:
    if val is None:
        return None
    if isinstance(val, int):
        return val
    if isinstance(val, float):
        return int(val)
    s = str(val).strip().replace(",", "")
    if not s or s.lower() in ("nan", "null", "none", "-", "n/a", ""):
        return None
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return None


def _process_iqvia_row(row: Tuple[Any, ...], col_index: Dict[str, int]) -> Optional[Dict[str, Any]]:
    brand_raw = _cell(row, col_index, "brand_ims")
    if not brand_raw or not str(brand_raw).strip():
        return None

    brand_ims = str(brand_raw).strip()
    norm_name = re.sub(r"[^a-z0-9]", "", brand_ims.lower())
    if not norm_name:
        return None

    molecules_raw = _cell(row, col_index, "molecules")
    molecules = str(molecules_raw).strip() if molecules_raw is not None and str(molecules_raw).strip() else None

    atc_raw = _cell(row, col_index, "atc_iv")
    atc_iv = str(atc_raw).strip() if atc_raw is not None and str(atc_raw).strip() else None

    company_raw = _cell(row, col_index, "company")
    company = str(company_raw).strip() if company_raw is not None and str(company_raw).strip() else None

    launch_raw = _cell(row, col_index, "product_launch")
    product_launch = str(launch_raw).strip() if launch_raw is not None and str(launch_raw).strip() else None

    val_mat_current = _parse_float(_cell(row, col_index, "val_mat_current"))
    val_mat_prev = _parse_float(_cell(row, col_index, "val_mat_prev"))
    val_gr_pct = _parse_float(_cell(row, col_index, "val_gr_pct"))
    if val_gr_pct is None and val_mat_current is not None and val_mat_prev is not None and val_mat_prev != 0:
        val_gr_pct = round(((val_mat_current - val_mat_prev) / val_mat_prev) * 100, 2)

    un_mat_current = _parse_float(_cell(row, col_index, "un_mat_current"))
    un_mat_prev = _parse_float(_cell(row, col_index, "un_mat_prev"))
    un_gr_pct = _parse_float(_cell(row, col_index, "un_gr_pct"))
    if un_gr_pct is None and un_mat_current is not None and un_mat_prev is not None and un_mat_prev != 0:
        un_gr_pct = round(((un_mat_current - un_mat_prev) / un_mat_prev) * 100, 2)

    no_of_mol = _parse_int(_cell(row, col_index, "no_of_mol"))
    plain_raw = _cell(row, col_index, "plain_comb")
    plain_comb = str(plain_raw).strip() if plain_raw is not None and str(plain_raw).strip() else None

    return {
        "brand_ims": brand_ims,
        "brand_name": brand_ims,
        "normalized_name": norm_name,
        "molecules": molecules,
        "atc_iv": atc_iv,
        "company": company,
        "manufacturer": company,
        "product_launch": product_launch,
        "val_mat_current": val_mat_current,
        "val_mat_prev": val_mat_prev,
        "val_gr_pct": val_gr_pct,
        "un_mat_current": un_mat_current,
        "un_mat_prev": un_mat_prev,
        "un_gr_pct": un_gr_pct,
        "no_of_mol": no_of_mol,
        "plain_comb": plain_comb,
        "is_active": True,
        "license_confirmed": True,
    }


def parse_iqvia_file(file_bytes: bytes, filename: str = "") -> List[Dict[str, Any]]:
    """Parses both .xlsx and .xlsb IQVIA files and returns list of record dicts."""
    is_xlsb = (filename or "").lower().endswith(".xlsb")
    # Quick header check for xlsb vs zip
    if not is_xlsb and len(file_bytes) >= 8 and not file_bytes.startswith(b"PK"):
        is_xlsb = True

    deduped: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}

    if is_xlsb:
        try:
            import pyxlsb
            with pyxlsb.open_workbook(io.BytesIO(file_bytes)) as wb:
                # Prioritize 'Pivot' sheet (the aggregated IQVIA brand summary), then other sheets
                sheet_names = list(wb.sheets)
                pivot_sheet = next((s for s in sheet_names if s.lower() == "pivot"), None)
                sheets_to_try = [pivot_sheet] if pivot_sheet else sheet_names

                for sheet_name in sheets_to_try:
                    with wb.get_sheet(sheet_name) as sheet:
                        header_row = None
                        for raw_row in sheet.rows():
                            row_vals = tuple(c.v for c in raw_row)
                            if not header_row:
                                col_index = _build_column_index(row_vals, _IQVIA_ALIASES)
                                if "brand_ims" in col_index:
                                    header_row = row_vals
                                continue
                            
                            rec = _process_iqvia_row(row_vals, col_index)
                            if rec:
                                key = (rec["normalized_name"], rec.get("company"))
                                deduped[key] = rec
                    if deduped and pivot_sheet:
                        break
        except Exception as e:
            raise ValueError(f"Failed to parse XLSB workbook: {e}")
    else:
        try:
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
            sheet_names = wb.sheetnames
            pivot_sheet = next((s for s in sheet_names if s.lower() == "pivot"), None)
            sheets_to_try = [wb[pivot_sheet]] if pivot_sheet else wb.worksheets

            for sheet in sheets_to_try:
                rows_iter = sheet.iter_rows(min_row=1, values_only=True)
                header_row = next(rows_iter, None)
                if not header_row:
                    continue
                col_index = _build_column_index(header_row, _IQVIA_ALIASES)
                if "brand_ims" not in col_index:
                    continue

                for row in rows_iter:
                    rec = _process_iqvia_row(row, col_index)
                    if rec:
                        key = (rec["normalized_name"], rec.get("company"))
                        deduped[key] = rec
                if deduped and pivot_sheet:
                    break
        except Exception as e:
            raise ValueError(f"Failed to parse XLSX workbook: {e}")

    if not deduped:
        raise ValueError(
            "This workbook does not match the IQVIA template. "
            "(Expected at least 'BRAND_IMS' column, along with MOLECULES, COMPANY, etc.)."
        )
    return list(deduped.values())
