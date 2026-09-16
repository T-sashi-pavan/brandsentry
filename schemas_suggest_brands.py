from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime
import uuid

# ── Target Request Schema ───────────────────────────────────────────────────

class ProductInformation(BaseModel):
    generic_name: str
    dosage_form: str
    dose: str
    division: Optional[str] = None
    suggested_by: Optional[str] = None
    date: Optional[str] = None

class MedicalInformation(BaseModel):
    ailment: str
    segment: str
    therapy: str
    promoting_indications: str

class ManufacturingInformation(BaseModel):
    manufacturer_location: Optional[str] = "NA"
    mfd_type: Optional[str] = None
    in_license: Optional[str] = None
    mfg_for_others: Optional[str] = None
    parent_brand_owner: Optional[str] = None

class CommercialInformation(BaseModel):
    marketer_name: Optional[str] = None
    seller_name: Optional[str] = None
    expected_launch_month: Optional[str] = None
    expected_sale: Optional[str] = None

class RegulatoryInformation(BaseModel):
    dcgi_combination_approved: Optional[str] = None
    drug_schedule: Optional[str] = None

class BrandInformation(BaseModel):
    domestic_brand_names: str
    international_brand_names: str
    innovator_brands: str

class PatentInformation(BaseModel):
    patent_validity: str
    launch_after_expiry: str
    launch_during_validity: Optional[str] = None

class SuggestBrandsRequest(BaseModel):
    product_information: ProductInformation
    medical_information: MedicalInformation
    manufacturing_information: Optional[ManufacturingInformation] = None
    commercial_information: Optional[CommercialInformation] = None
    regulatory_information: Optional[RegulatoryInformation] = None
    brand_information: BrandInformation
    patent_information: PatentInformation


# ── Target Response Schema ──────────────────────────────────────────────────

class SuggestedBrandItem(BaseModel):
    id: uuid.UUID
    suggested_name: str
    confidence_score: float
    recommendation_category: str  # HIGH, MEDIUM, LOW
    overall_assessment: str
    similarity_results: Dict[str, Any]
    rationale: Dict[str, Any]
    references: List[Dict[str, Any]]

class SuggestBrandsResponse(BaseModel):
    request_id: uuid.UUID
    status: str
    total_suggested: int
    suggestions: List[SuggestedBrandItem]
    created_at: datetime
