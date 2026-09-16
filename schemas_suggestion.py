import uuid
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, field_validator


def _not_blank(*fields: str):
    @field_validator(*fields)
    @classmethod
    def _check(cls, v: str, info) -> str:
        if not v or not v.strip():
            raise ValueError(f"{info.field_name} is mandatory")
        return v
    return _check


class ProductInformationIn(BaseModel):
    generic_name: str
    dosage_form: str
    dose: Optional[str] = ""
    division: Optional[str] = ""
    suggested_by: Optional[str] = ""
    date: Optional[str] = ""

    # Per the BRD's field-requirement table, only Generic Name and Dosage
    # Form are mandatory here — Dose and Date are optional.
    _validate_mandatory = _not_blank("generic_name", "dosage_form")


class MedicalInformationIn(BaseModel):
    ailment: str
    segment: str
    therapy: str
    promoting_indications: str

    _validate_mandatory = _not_blank("ailment", "segment", "therapy", "promoting_indications")


class ManufacturingInformationIn(BaseModel):
    manufacturer_location: Optional[str] = "NA"
    mfd_type: Optional[str] = ""
    in_license: Optional[str] = ""
    mfg_for_others: Optional[str] = ""
    parent_brand_owner: Optional[str] = ""


class CommercialInformationIn(BaseModel):
    marketer_name: Optional[str] = ""
    seller_name: Optional[str] = ""
    expected_launch_month: Optional[str] = ""
    expected_sale: Optional[str] = ""


class RegulatoryInformationIn(BaseModel):
    dcgi_combination_approved: Optional[str] = ""
    drug_schedule: Optional[str] = ""


class BrandInformationIn(BaseModel):
    # Per the BRD's field-requirement table, all three are optional.
    domestic_brand_names: Optional[str] = ""
    international_brand_names: Optional[str] = ""
    innovator_brands: Optional[str] = ""


class PatentInformationIn(BaseModel):
    patent_validity: Optional[str] = "Patent Not in India"
    launch_after_expiry: Optional[str] = "No"
    launch_during_validity: Optional[str] = ""


class NamingInformationIn(BaseModel):
    treatment: Optional[str] = ""
    emotion_connected: Optional[str] = ""
    naming_style: Optional[str] = ""
    product_benefit: Optional[str] = ""
    brand_coining_preferences: Optional[str] = ""
    description: Optional[str] = ""


class MoleculeHistoryInformationIn(BaseModel):
    inventor_name: Optional[str] = ""
    patient_name: Optional[str] = ""
    place_of_origin: Optional[str] = ""
    other_historical_association: Optional[str] = ""


class SuggestionCreateRequest(BaseModel):
    """Matches the grouped/structured shape the frontend's
    buildStructuredPayload() sends — the same shape used for /brands/generate's
    suggestion_form, so both endpoints share one contract for this data."""

    product_information: ProductInformationIn
    medical_information: MedicalInformationIn
    manufacturing_information: ManufacturingInformationIn
    commercial_information: CommercialInformationIn
    regulatory_information: RegulatoryInformationIn
    brand_information: BrandInformationIn
    patent_information: PatentInformationIn
    naming_information: Optional[NamingInformationIn] = None
    molecule_history_information: Optional[MoleculeHistoryInformationIn] = None
    description: Optional[str] = None

    # `id`: when the frontend sends the same payload it last successfully
    # saved (unchanged since then), it echoes back the case_id it got from
    # that save here so the backend can dedupe instead of creating a second
    # row for the same submission.
    id: Optional[str] = None
    # Accepted for parity with the frontend's request but not used by this
    # endpoint — `count` belongs to /brands/generate; user_id/user_email are
    # never trusted for attribution (the authenticated user is used instead).
    count: Optional[int] = None
    user_id: Optional[str] = None
    user_email: Optional[str] = None

    def flatten(self) -> dict:
        data = {
            **self.product_information.model_dump(),
            **self.medical_information.model_dump(),
            **self.manufacturing_information.model_dump(),
            **self.commercial_information.model_dump(),
            **self.regulatory_information.model_dump(),
            **self.brand_information.model_dump(),
            **self.patent_information.model_dump(),
        }
        if self.description:
            data["description"] = self.description
        if self.naming_information:
            data["naming_information"] = self.naming_information.model_dump()
            if not data.get("description") and self.naming_information.description:
                data["description"] = self.naming_information.description
        if self.molecule_history_information:
            data["molecule_history_information"] = self.molecule_history_information.model_dump()
        return data


class SuggestionFormOut(BaseModel):
    # Mirrors case_id — the frontend reads `response.id ?? response.case_id`
    # and treats them as the same identifier for now (see caseStore.ts), so
    # both fields carry the human-readable case reference, not the row's
    # internal UUID (exposed separately as record_id for completeness).
    id: str
    record_id: uuid.UUID
    case_id: str
    saved_at: datetime

    generic_name: str
    division: str = ""
    dosage_form: str
    suggested_by: str = ""
    dose: str
    date: str
    ailment: str
    segment: str
    therapy: str
    promoting_indications: str
    manufacturer_location: str = "NA"
    mfd_type: str = ""
    in_license: str = ""
    mfg_for_others: str = ""
    parent_brand_owner: str = ""
    marketer_name: str = ""
    seller_name: str = ""
    expected_launch_month: str = ""
    expected_sale: str = ""
    dcgi_combination_approved: str = ""
    drug_schedule: str = ""
    domestic_brand_names: str
    international_brand_names: str
    innovator_brands: str
    patent_validity: str = "Patent Not in India"
    launch_after_expiry: str = "No"
    launch_during_validity: str = ""
    description: Optional[str] = ""
    naming_information: Optional[dict] = None
    molecule_history_information: Optional[dict] = None
