import uuid
from datetime import datetime, timezone
from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, Text, Uuid
from app.core.database import Base


class WhoInnRegistry(Base):
    """Tier-1 local cache of WHO International Nonproprietary Names."""
    __tablename__ = "who_inn_registry"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    inn_name = Column(String(255), nullable=False, index=True)
    normalized_name = Column(String(255), nullable=False, index=True)
    who_publication_reference = Column(String(255), nullable=True)
    chembl_id = Column(String(50), nullable=True)
    molecule_type = Column(String(100), nullable=True)
    as_of_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class IqviaExtract(Base):
    """Tier-1 licensed IQVIA market-data extract containing the 13 required
    columns from IQVIA market data extracts.
    """
    __tablename__ = "iqvia_extract"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    brand_ims = Column(String(255), nullable=False, index=True)
    brand_name = Column(String(255), nullable=True, index=True)
    normalized_name = Column(String(255), nullable=False, index=True)
    molecules = Column(Text, nullable=True, index=True)
    atc_iv = Column(String(100), nullable=True)
    company = Column(String(255), nullable=True, index=True)
    manufacturer = Column(String(300), nullable=True)
    product_launch = Column(String(20), nullable=True)
    val_mat_current = Column(Float, nullable=True)
    val_mat_prev = Column(Float, nullable=True)
    val_gr_pct = Column(Float, nullable=True)
    un_mat_current = Column(Float, nullable=True)
    un_mat_prev = Column(Float, nullable=True)
    un_gr_pct = Column(Float, nullable=True)
    no_of_mol = Column(Integer, nullable=True)
    plain_comb = Column(String(50), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    license_confirmed = Column(Boolean, nullable=True, default=True)
    as_of_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class RegisteredNotInUse(Base):
    """Tier-1 "Registered-but-Not-in-Use" trademark repository (SDD §6.1) —
    names formally registered/applied for at the Trade Marks Registry but not
    an actively marketed product. A live product wouldn't show up here (see
    IqviaExtract / e-pharmacy tiers for that); this table exists specifically
    to catch names that look "free" in the market but are still a real legal
    conflict on paper.

    Populated by bulk-uploading the registrar's own export (e.g. the
    "Un-used TradeMarks List" workbook) via
    POST /reference-data/registered-not-in-use/upload — see
    app/services/tabular_import.py. Storage only for now: not yet wired into
    the Brand Analysis screening pipeline.
    """
    __tablename__ = "registered_not_in_use"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    brand_name = Column(String(255), nullable=False, index=True)
    normalized_name = Column(String(255), nullable=False, index=True)
    trademark_class = Column(Integer, nullable=True)
    application_number = Column(String(50), nullable=True, index=True)
    application_date = Column(DateTime, nullable=True)
    status = Column(String(100), nullable=True)
    valid_till = Column(DateTime, nullable=True)
    remarks = Column(Text, nullable=True)
    as_of_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class InternationalMarketBrand(Base):
    """Tier-1 "International Markets" repository (SDD §6.1) — brand names
    already in use for a given molecule in overseas markets, relevant when a
    domestically "clear" name would still collide with an existing
    international brand for that same active ingredient.

    Populated by bulk-uploading an overseas brand-name search export (e.g.
    the "Overseas Brand-Names Searched" workbook) via
    POST /reference-data/international-market/upload — see
    app/services/tabular_import.py. Storage only for now: not yet wired into
    the Brand Analysis screening pipeline. `country` is nullable because the
    source export doesn't break results out by country.
    """
    __tablename__ = "international_market_brands"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    brand_name = Column(String(255), nullable=False, index=True)
    normalized_name = Column(String(255), nullable=False, index=True)
    active_ingredient = Column(String(300), nullable=True, index=True)
    country = Column(String(100), nullable=True)
    as_of_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
