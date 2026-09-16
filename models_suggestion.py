import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, ForeignKey, JSON, String, Text, Uuid
from app.core.database import Base


class BrandSuggestionForm(Base):
    __tablename__ = "brand_suggestion_forms"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id = Column(String(30), unique=True, nullable=False, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)

    # Product Information
    generic_name = Column(String(255), nullable=False)
    division = Column(String(100), nullable=True)
    dosage_form = Column(String(100), nullable=False)
    suggested_by = Column(String(255), nullable=True)
    dose = Column(String(100), nullable=False)
    date = Column(String(20), nullable=False)
    # Medical Information
    ailment = Column(Text, nullable=False)
    segment = Column(String(255), nullable=False)
    therapy = Column(String(255), nullable=False)
    promoting_indications = Column(Text, nullable=False)
    # Manufacturing Information
    manufacturer_location = Column(String(255), nullable=True, default="NA")
    mfd_type = Column(String(50), nullable=True)
    in_license = Column(String(10), nullable=True)
    mfg_for_others = Column(Text, nullable=True)
    parent_brand_owner = Column(String(50), nullable=True)
    # Commercial Information
    marketer_name = Column(String(255), nullable=True)
    seller_name = Column(String(255), nullable=True)
    expected_launch_month = Column(String(20), nullable=True)
    expected_sale = Column(String(100), nullable=True)
    # Regulatory Information
    dcgi_combination_approved = Column(String(20), nullable=True)
    drug_schedule = Column(String(50), nullable=True)
    # Brand Information
    domestic_brand_names = Column(Text, nullable=False)
    international_brand_names = Column(Text, nullable=False)
    innovator_brands = Column(Text, nullable=False)
    # Patent Information
    patent_validity = Column(String(255), nullable=False, default="Patent Not in India")
    launch_after_expiry = Column(String(100), nullable=False, default="No")
    launch_during_validity = Column(Text, nullable=True)
    description = Column(Text, nullable=True)
    naming_information = Column(JSON, nullable=True)
    # Inventor name, patient name, place of origin, other historical
    # association — feeds the "Molecule / Product History" coining principle
    # when selected in the Naming Style dropdown (see app/services/ai.py).
    molecule_history_information = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
