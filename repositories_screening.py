import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload
from app.models.reference_data import (
    InternationalMarketBrand, IqviaExtract, RegisteredNotInUse, WhoInnRegistry,
)
from app.models.screening import BrandSearch, ScreeningConflict, ScreeningResult, SimilarBrandName


class ScreeningRepository:
    """Persistence for brand-analysis screening runs, plus read access to the
    Tier-1 WHO INN / IQVIA local reference tables. Both reference tables are
    empty until their respective import pipelines exist (see model
    docstrings) — an empty result must be treated as "not loaded yet", never
    as a clearance signal."""

    def __init__(self, db: Session):
        self.db = db

    def create_search(
        self, brand_name: str, user_id: Optional[uuid.UUID], case_id: Optional[str] = None,
    ) -> BrandSearch:
        search = BrandSearch(brand_name=brand_name, user_id=user_id, status="completed", case_id=case_id)
        self.db.add(search)
        self.db.commit()
        self.db.refresh(search)
        return search

    def list_by_case_id(self, case_id: str) -> List[BrandSearch]:
        clean = (case_id or "").strip()
        return (
            self.db.query(BrandSearch)
            .options(
                joinedload(BrandSearch.screening_result).joinedload(ScreeningResult.similar_names),
                joinedload(BrandSearch.screening_result).joinedload(ScreeningResult.conflicts),
            )
            .filter(func.lower(func.trim(BrandSearch.case_id)) == clean.lower())
            .order_by(BrandSearch.created_at.desc())
            .all()
        )

    def save_result(
        self,
        brand_search_id: uuid.UUID,
        result: dict,
        similar_names: List[dict],
        conflicts: List[dict],
    ) -> ScreeningResult:
        known_cols = {c.name for c in ScreeningResult.__table__.columns}
        filtered_result = {k: v for k, v in result.items() if k in known_cols}
        screening_result = ScreeningResult(brand_search_id=brand_search_id, **filtered_result)
        self.db.add(screening_result)
        self.db.flush()  # assign screening_result.id before children reference it

        for sn in similar_names:
            sim_data = {
                "name": sn.get("name") or "",
                "similarity_type": sn.get("similarity_type") or "Spelling",
                "similarity_score": float(sn.get("similarity_score", 0.0)),
                "source": sn.get("source") or "Screening",
                "risk_level": sn.get("risk_level") or "LOW",
                "therapeutic_area": sn.get("therapeutic_area"),
                "manufacturer": sn.get("manufacturer"),
                "country": sn.get("country"),
            }
            self.db.add(SimilarBrandName(screening_result_id=screening_result.id, **sim_data))
        for c in conflicts:
            conflict_data = {
                "conflicting_name": c.get("conflicting_name") or c.get("name") or "",
                "conflict_type": c.get("conflict_type") or "Conflict",
                "source": c.get("source") or "Screening",
                "severity": c.get("severity") or "LOW",
                "details": c.get("details"),
                "registration_number": c.get("registration_number"),
                "owner": c.get("owner"),
                "status": c.get("status"),
            }
            self.db.add(ScreeningConflict(screening_result_id=screening_result.id, **conflict_data))

        self.db.commit()
        self.db.refresh(screening_result)
        return screening_result

    def get_by_search_id(self, search_id: uuid.UUID) -> Optional[BrandSearch]:
        return (
            self.db.query(BrandSearch)
            .options(
                joinedload(BrandSearch.screening_result).joinedload(ScreeningResult.similar_names),
                joinedload(BrandSearch.screening_result).joinedload(ScreeningResult.conflicts),
            )
            .filter(BrandSearch.id == search_id)
            .first()
        )

    def get_latest_by_name(self, brand_name: str, max_age_days: Optional[int] = None) -> Optional[BrandSearch]:
        """Most recent completed screening for this exact name (case-insensitive),
        used by Compare's DB-first history check. Inner-joins ScreeningResult so a
        BrandSearch row left orphaned by a failed save_result() (status stuck at
        "completed" with no result) is never returned as a usable hit.

        `created_at` is written via `datetime.now(timezone.utc)` into a plain
        DateTime column (no timezone=True) — both SQLite and Postgres drop the
        tzinfo on write but keep the UTC wall-clock value, so a UTC cutoff
        computed with `datetime.now(timezone.utc)` compares correctly against it
        (the aware offset is dropped by the driver/dialect on bind, leaving the
        same UTC wall-clock value either side would produce naive).
        """
        query = (
            self.db.query(BrandSearch)
            .join(ScreeningResult, ScreeningResult.brand_search_id == BrandSearch.id)
            .options(
                joinedload(BrandSearch.screening_result).joinedload(ScreeningResult.similar_names),
                joinedload(BrandSearch.screening_result).joinedload(ScreeningResult.conflicts),
            )
            .filter(func.lower(BrandSearch.brand_name) == brand_name.lower())
        )
        if max_age_days is not None:
            cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
            query = query.filter(BrandSearch.created_at >= cutoff)
        return query.order_by(BrandSearch.created_at.desc()).first()

    def find_who_inn_local(self, name: str) -> List[WhoInnRegistry]:
        clean = (name or "").strip().lower()
        if not clean:
            return []
        needle = f"%{clean}%"
        # 1. Exact or Substring Match
        results = (
            self.db.query(WhoInnRegistry)
            .filter(
                (func.lower(WhoInnRegistry.normalized_name).like(needle)) |
                (func.lower(WhoInnRegistry.inn_name).like(needle))
            )
            .limit(2500)
            .all()
        )
        seen_ids = {r.id for r in results}

        # 2. Phonetic Root & Prefix Matches (first 4 chars + common phonetic substitutions)
        p = clean[:min(4, len(clean))]
        prefixes = {p}
        prefixes.add(p.replace('y', 'i'))
        prefixes.add(p.replace('i', 'y'))
        if p.startswith('ce'): prefixes.add('se' + p[2:])
        elif p.startswith('se'): prefixes.add('ce' + p[2:])
        if p.startswith('ci'): prefixes.add('si' + p[2:])
        elif p.startswith('si'): prefixes.add('ci' + p[2:])
        if p.startswith('ph'): prefixes.add('f' + p[2:])
        elif p.startswith('f'): prefixes.add('ph' + p[1:])
        if p.startswith('z'): prefixes.add('s' + p[1:])
        elif p.startswith('s'): prefixes.add('z' + p[1:])

        for prefix in prefixes:
            if len(prefix) >= 3:
                prefix_results = (
                    self.db.query(WhoInnRegistry)
                    .filter(func.lower(WhoInnRegistry.normalized_name).like(f"{prefix}%"))
                    .limit(50)
                    .all()
                )
                for r in prefix_results:
                    if r.id not in seen_ids:
                        results.append(r)
                        seen_ids.add(r.id)
        return results

    def find_iqvia_local(self, name: str, active_only: bool = True) -> List[IqviaExtract]:
        clean = (name or "").strip().lower()
        if not clean:
            return []
        needle = f"%{clean}%"
        norm_clean = re.sub(r"[^a-z0-9]", "", clean)
        norm_needle = f"%{norm_clean}%" if norm_clean else needle

        base_query = self.db.query(IqviaExtract)
        if active_only:
            base_query = base_query.filter(IqviaExtract.is_active.is_(True))

        results = (
            base_query
            .filter(
                (func.lower(IqviaExtract.normalized_name).like(norm_needle)) |
                (func.lower(IqviaExtract.brand_ims).like(needle)) |
                (func.lower(IqviaExtract.molecules).like(needle))
            )
            .limit(2500)
            .all()
        )
        seen_ids = {r.id for r in results}

        p = norm_clean[:min(4, len(norm_clean))] if norm_clean else clean[:min(4, len(clean))]
        prefixes = {p}
        prefixes.add(p.replace('y', 'i'))
        prefixes.add(p.replace('i', 'y'))
        if p.startswith('ce'): prefixes.add('se' + p[2:])
        elif p.startswith('se'): prefixes.add('ce' + p[2:])
        if p.startswith('ci'): prefixes.add('si' + p[2:])
        elif p.startswith('si'): prefixes.add('ci' + p[2:])
        if p.startswith('ph'): prefixes.add('f' + p[2:])
        elif p.startswith('f'): prefixes.add('ph' + p[1:])
        if p.startswith('z'): prefixes.add('s' + p[1:])
        elif p.startswith('s'): prefixes.add('z' + p[1:])

        for prefix in prefixes:
            if len(prefix) >= 3:
                prefix_query = self.db.query(IqviaExtract)
                if active_only:
                    prefix_query = prefix_query.filter(IqviaExtract.is_active.is_(True))
                prefix_results = (
                    prefix_query
                    .filter(func.lower(IqviaExtract.normalized_name).like(f"{prefix}%"))
                    .limit(50)
                    .all()
                )
                for r in prefix_results:
                    if r.id not in seen_ids:
                        results.append(r)
                        seen_ids.add(r.id)
        return results

    IQVIA_PREFIX_LEN = 4

    def iqvia_prefix_density(self, active_only: bool = True) -> Dict[str, int]:
        """How many active IQVIA rows sit under each opening key.

        ONE aggregate query, executed once per generation run — never per
        candidate. Purely a generation-steering input: no screening decision,
        threshold or verdict reads it.

        The key is deliberately the SAME expression `find_iqvia_local` uses to
        retrieve its comparison rows — `lower(normalized_name) LIKE '<first 4
        chars>%'` over active rows (see IQVIA_PREFIX_LEN). That matters: the
        density of a candidate's opening is precisely how many rows that
        candidate will be compared against, and therefore how likely it is
        that something clears the similarity bar. Computing density on any
        other key would describe a retrieval that does not happen.
        """
        key = func.lower(func.substr(IqviaExtract.normalized_name, 1, self.IQVIA_PREFIX_LEN))
        query = self.db.query(key.label("prefix"), func.count().label("n"))
        if active_only:
            query = query.filter(IqviaExtract.is_active.is_(True))
        rows = query.group_by(key).all()
        return {r.prefix: int(r.n) for r in rows if r.prefix}

    def who_inn_prefix_density(self) -> Dict[str, int]:
        """Same idea for the WHO INN registry, whose gate uses the same
        `find_who_inn_local` prefix retrieval."""
        key = func.lower(func.substr(WhoInnRegistry.normalized_name, 1, self.IQVIA_PREFIX_LEN))
        rows = self.db.query(key.label("prefix"), func.count().label("n")).group_by(key).all()
        return {r.prefix: int(r.n) for r in rows if r.prefix}

    def has_active_iqvia_rows(self) -> bool:
        return self.db.query(IqviaExtract.id).filter(IqviaExtract.is_active.is_(True)).first() is not None

    def iqvia_row_count(self, active_only: bool = False) -> int:
        query = self.db.query(IqviaExtract)
        if active_only:
            query = query.filter(IqviaExtract.is_active.is_(True))
        return query.count()

    def replace_all_iqvia(self, rows: List[dict]) -> int:
        """Fully replaces IQVIA master data with parsed rows in batched transactions."""
        self.db.query(IqviaExtract).delete()
        batch_size = 5000
        for i in range(0, len(rows), batch_size):
            chunk = rows[i:i + batch_size]
            self.db.bulk_insert_mappings(IqviaExtract, chunk)
            self.db.flush()
        self.db.commit()
        return len(rows)

    def append_iqvia(self, rows: List[dict]) -> tuple[int, int]:
        """Adds IQVIA rows without touching existing records, skipping any
        whose normalized_name already exists. Returns (added, skipped)."""
        existing = {r[0] for r in self.db.query(IqviaExtract.normalized_name).all()}
        new_rows = [r for r in rows if r["normalized_name"] not in existing]
        batch_size = 5000
        for i in range(0, len(new_rows), batch_size):
            chunk = new_rows[i:i + batch_size]
            self.db.bulk_insert_mappings(IqviaExtract, chunk)
            self.db.flush()
        self.db.commit()
        return len(new_rows), len(rows) - len(new_rows)

    def bulk_delete_iqvia(self, ids: Optional[List[uuid.UUID]] = None, clear_all: bool = False) -> int:
        if clear_all:
            deleted = self.db.query(IqviaExtract).delete()
        elif ids:
            deleted = self.db.query(IqviaExtract).filter(IqviaExtract.id.in_(ids)).delete(synchronize_session=False)
        else:
            deleted = 0
        self.db.commit()
        return deleted

    def get_iqvia_records_paginated(
        self,
        q: Optional[str] = None,
        is_active: Optional[bool] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> tuple[List[IqviaExtract], int]:
        query = self.db.query(IqviaExtract)
        if q and q.strip():
            needle = f"%{q.strip()}%"
            norm_needle = f"%{re.sub(r'[^a-z0-9]', '', q.strip().lower())}%"
            query = query.filter(
                (IqviaExtract.brand_ims.ilike(needle)) |
                (IqviaExtract.normalized_name.ilike(norm_needle)) |
                (IqviaExtract.molecules.ilike(needle)) |
                (IqviaExtract.company.ilike(needle))
            )
        if is_active is not None:
            query = query.filter(IqviaExtract.is_active.is_(is_active))

        total = query.count()
        items = (
            query
            .order_by(IqviaExtract.brand_ims.asc())
            .offset((max(page, 1) - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return items, total

    def who_inn_row_count(self) -> int:
        return self.db.query(WhoInnRegistry).count()

    def replace_all_who_inn(self, rows: List[dict]) -> int:
        """Fully replaces the WHO INN table's contents with `rows` in one
        transaction — matches the SDD's "refreshed on a cycle" model for
        this Tier-1 reference table rather than an incremental upsert, since
        the source PDF is a full list snapshot each time, not a diff."""
        self.db.query(WhoInnRegistry).delete()
        for row in rows:
            self.db.add(WhoInnRegistry(**row))
        self.db.commit()
        return len(rows)

    def append_who_inn(self, rows: List[dict]) -> tuple[int, int]:
        """Adds `rows` without touching existing records, skipping any whose
        normalized_name already exists. Returns (added, skipped)."""
        existing = {r[0] for r in self.db.query(WhoInnRegistry.normalized_name).all()}
        new_rows = [r for r in rows if r["normalized_name"] not in existing]
        for row in new_rows:
            self.db.add(WhoInnRegistry(**row))
        self.db.commit()
        return len(new_rows), len(rows) - len(new_rows)

    def get_who_inn_records_paginated(
        self, q: Optional[str] = None, page: int = 1, page_size: int = 50,
    ) -> tuple[List[WhoInnRegistry], int]:
        query = self.db.query(WhoInnRegistry)
        if q and q.strip():
            search_pattern = f"%{q.strip()}%"
            query = query.filter(
                (WhoInnRegistry.inn_name.ilike(search_pattern)) |
                (WhoInnRegistry.who_publication_reference.ilike(search_pattern))
            )
        total = query.count()
        items = (
            query.order_by(WhoInnRegistry.inn_name.asc())
            .offset((max(page, 1) - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return items, total

    def registered_not_in_use_row_count(self) -> int:
        return self.db.query(RegisteredNotInUse).count()

    def international_market_row_count(self) -> int:
        return self.db.query(InternationalMarketBrand).count()

    def replace_all_registered_not_in_use(self, rows: List[dict]) -> int:
        self.db.query(RegisteredNotInUse).delete()
        for row in rows:
            self.db.add(RegisteredNotInUse(**row))
        self.db.commit()
        return len(rows)

    def append_registered_not_in_use(self, rows: List[dict]) -> tuple[int, int]:
        existing = {r[0] for r in self.db.query(RegisteredNotInUse.normalized_name).all()}
        new_rows = [r for r in rows if r["normalized_name"] not in existing]
        for row in new_rows:
            self.db.add(RegisteredNotInUse(**row))
        self.db.commit()
        return len(new_rows), len(rows) - len(new_rows)

    def get_registered_not_in_use_records_paginated(
        self, q: Optional[str] = None, page: int = 1, page_size: int = 50,
    ) -> tuple[List[RegisteredNotInUse], int]:
        query = self.db.query(RegisteredNotInUse)
        if q and q.strip():
            search_pattern = f"%{q.strip()}%"
            query = query.filter(
                (RegisteredNotInUse.brand_name.ilike(search_pattern)) |
                (RegisteredNotInUse.application_number.ilike(search_pattern)) |
                (RegisteredNotInUse.status.ilike(search_pattern)) |
                (RegisteredNotInUse.remarks.ilike(search_pattern))
            )
        total = query.count()
        items = (
            query.order_by(RegisteredNotInUse.created_at.desc())
            .offset((max(page, 1) - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return items, total

    def replace_all_international_market(self, rows: List[dict]) -> int:
        self.db.query(InternationalMarketBrand).delete()
        for row in rows:
            self.db.add(InternationalMarketBrand(**row))
        self.db.commit()
        return len(rows)

    def append_international_market(self, rows: List[dict]) -> tuple[int, int]:
        existing = {r[0] for r in self.db.query(InternationalMarketBrand.normalized_name).all()}
        new_rows = [r for r in rows if r["normalized_name"] not in existing]
        for row in new_rows:
            self.db.add(InternationalMarketBrand(**row))
        self.db.commit()
        return len(new_rows), len(rows) - len(new_rows)

    def get_international_market_records_paginated(
        self, q: Optional[str] = None, page: int = 1, page_size: int = 50,
    ) -> tuple[List[InternationalMarketBrand], int]:
        query = self.db.query(InternationalMarketBrand)
        if q and q.strip():
            search_pattern = f"%{q.strip()}%"
            query = query.filter(
                (InternationalMarketBrand.brand_name.ilike(search_pattern)) |
                (InternationalMarketBrand.active_ingredient.ilike(search_pattern)) |
                (InternationalMarketBrand.country.ilike(search_pattern))
            )
        total = query.count()
        items = (
            query.order_by(InternationalMarketBrand.created_at.desc())
            .offset((max(page, 1) - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return items, total

    def get_registry_candidate_pool(self) -> List[Dict[str, str]]:
        """Every {name, normalized_name, source} row from RegisteredNotInUse
        and InternationalMarketBrand, deduped case-insensitively across both
        tables. First use of either table inside the generation pipeline —
        previously they were only read for row counts (see above). Consumed
        by GeneratorService as a candidate pool the AI Name Generator may
        select genuine matches from, not as a similarity/collision source."""
        reg_rows = self.db.query(RegisteredNotInUse.brand_name, RegisteredNotInUse.normalized_name).all()
        intl_rows = self.db.query(InternationalMarketBrand.brand_name, InternationalMarketBrand.normalized_name).all()

        pool: List[Dict[str, str]] = []
        seen: set = set()
        for brand_name, normalized_name, source in (
            [(b, n, "Registered Not In Use") for b, n in reg_rows]
            + [(b, n, "International Market Brand") for b, n in intl_rows]
        ):
            key = (normalized_name or "").strip()
            if not key or key in seen:
                continue
            seen.add(key)
            pool.append({"name": brand_name, "normalized_name": key, "source": source})
        return pool
