import csv
import io
import re
import uuid
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.rate_limit import rate_limit, get_client_ip
from app.models.user import User
from app.repositories.brand import BrandRepository
from app.repositories.screening import ScreeningRepository
from app.repositories.audit import AuditRepository
from app.schemas.brand import GenerateNamesRequest, GeneratedNameSchema
from app.schemas.screening import (
    BrandSearchResponse, CompareRequest, CompareResultSchema, IntelligenceData, ScreeningRequest,
)
from app.services.brand_screening import BrandScreeningService
from app.services.compare import CompareService
from app.services.generator import GeneratorService

router = APIRouter(prefix="/brands", tags=["Brand Generation"])

# parse_compare_names() reads the whole upload into memory before parsing —
# an unbounded upload there is a memory-exhaustion vector.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


@router.post(
    "/generate",
    response_model=list[GeneratedNameSchema],
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit(max_requests=10, window_seconds=60))],
)
async def generate_brand_names(
    request: GenerateNamesRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not request.suggestion_form and not (request.molecule or "").strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide either a suggestion_form case or a molecule to generate names for",
        )

    service = GeneratorService(db)
    results = await service.generate_names(request, user_id=current_user.id, count=request.count)

    # Audit log entry
    case_label = request.case_id or (request.suggestion_form.case_id if request.suggestion_form else None) or request.molecule or "General Case"
    AuditRepository(db).create(
        action="GENERATE_BRAND_NAMES",
        user_id=current_user.id,
        resource_type="brand_generation",
        resource_id=case_label,
        details=f"Generated {len(results)} AI brand names for case: {case_label}",
        metadata={"count": len(results), "case_id": case_label},
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return results


@router.post(
    "/generate/stream",
    dependencies=[Depends(rate_limit(max_requests=10, window_seconds=60))],
)
async def generate_brand_names_stream(
    request: GenerateNamesRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Streams real-time Server-Sent Events (SSE) synchronized with the execution
    of Stages 1 to 5 for AI Name Generation."""
    if not request.suggestion_form and not (request.molecule or "").strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide either a suggestion_form case or a molecule to generate names for",
        )

    service = GeneratorService(db)
    return StreamingResponse(
        service.generate_names_stream(request, user_id=current_user.id, count=request.count),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


_MAX_COMPARE_NAMES = 20


def _norm_col(name: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', name.lower().strip()).strip('_')


@router.post(
    "/parse-names",
    dependencies=[Depends(rate_limit(max_requests=30, window_seconds=60))],
)
async def parse_compare_names(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Compare Names' Upload Excel path. Template: a single column named
    'brand_names' (case-insensitive), one candidate name per row. Rejects
    outright (rather than silently truncating) a file with more than
    _MAX_COMPARE_NAMES names — the whole point of surfacing this as a real
    validation error is so the user knows to split the file, instead of
    quietly comparing only the first 20 with no explanation."""
    filename = file.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uploaded file is empty")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File exceeds maximum allowed size (50MB)")

    names: list[str] = []
    if ext in ("xlsx", "xls"):
        try:
            import openpyxl
        except ImportError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "openpyxl not installed on the server")
        try:
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
        except Exception:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Could not read this file. Is it a valid .xlsx workbook?")
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "File is empty")
        headers = [_norm_col(str(h or "")) for h in rows[0]]
        if "brand_names" not in headers:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Expected a column named \"brand_names\". This file's columns are: "
                + (", ".join(h for h in headers if h) or "(none found)"),
            )
        col_idx = headers.index("brand_names")
        for row in rows[1:]:
            if col_idx >= len(row):
                continue
            v = row[col_idx]
            if v is not None and str(v).strip():
                names.append(str(v).strip())
    elif ext == "csv":
        text = file_bytes.decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        norm_fieldnames = {_norm_col(f): f for f in (reader.fieldnames or [])}
        if "brand_names" not in norm_fieldnames:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Expected a column named \"brand_names\". This file's columns are: "
                + (", ".join(reader.fieldnames or []) or "(none found)"),
            )
        real_key = norm_fieldnames["brand_names"]
        for row in reader:
            v = row.get(real_key)
            if v and v.strip():
                names.append(v.strip())
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "File must be .xlsx or .csv")

    if not names:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No names found in the \"brand_names\" column")

    seen: set[str] = set()
    deduped: list[str] = []
    for n in names:
        key = n.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(n)

    if len(deduped) > _MAX_COMPARE_NAMES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"This file has {len(deduped)} names in the \"brand_names\" column — Compare Names supports "
            f"at most {_MAX_COMPARE_NAMES} at a time. Please split it into smaller files.",
        )

    return {"names": deduped, "count": len(deduped)}


@router.get("/case-names")
def get_case_names(
    case_id: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every brand name legitimately associated with this case — generated
    for it in AI Name Generator, or screened for it in Brand Analysis.
    Returns Low and Medium risk candidate names."""
    clean_id = case_id.strip()
    generated = BrandRepository(db).get_generated_names(case_id=clean_id, limit=1000)
    screened = ScreeningRepository(db).list_by_case_id(clean_id)

    names_dict = {}

    # 1. Process all AI generated names for this case
    for g in generated:
        name = g.generated_name.strip()
        if not name:
            continue
        key = name.lower()
        score = float(g.risk_score) if g.risk_score is not None else 0.0
        rec = g.recommendation_status or "recommended"
        risk_lvl = "HIGH" if (score >= 65.0 or rec == "high_risk") else "MEDIUM" if (score >= 30.0 or rec == "review_required") else "LOW"
        names_dict[key] = {
            "name": name,
            "source": "generator_history",
            "risk_score": score,
            "risk_level": risk_lvl,
            "recommendation": rec,
        }

    # 2. Process all Brand Analysis screened names for this case
    for s in screened:
        name = s.brand_name.strip()
        if not name:
            continue
        key = name.lower()
        res = s.screening_result
        score = float(res.overall_risk_score) if (res and res.overall_risk_score is not None) else 0.0
        raw_cls = getattr(res, "risk_classification", None)
        risk_lvl = raw_cls if raw_cls in ("LOW", "MEDIUM", "HIGH") else ("HIGH" if score >= 65.0 else "MEDIUM" if score >= 30.0 else "LOW")
        rec = getattr(res, "ai_recommendation", "PROCEED") or "PROCEED"
        names_dict[key] = {
            "name": name,
            "source": "screening_history",
            "risk_score": score,
            "risk_level": risk_lvl,
            "recommendation": rec,
        }

    sorted_sources = sorted(names_dict.values(), key=lambda x: x["name"].lower())
    sorted_names = [s["name"] for s in sorted_sources]
    return {"names": sorted_names, "sources": sorted_sources}


@router.get("/generated", response_model=list[GeneratedNameSchema])
def get_generated_names(
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return BrandRepository(db).get_generated_names(user_id=current_user.id, limit=limit)


@router.post(
    "/screen",
    response_model=BrandSearchResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit(max_requests=20, window_seconds=60))],
)
async def screen_brand(
    request: ScreeningRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Brand Analysis: screens a single candidate name against WHO INN +
    IQVIA registries, Google web search, and a live e-pharmacy scrape."""
    name = request.brand_name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="brand_name must be at least 2 characters")
    if len(name) > 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="brand_name cannot exceed 100 characters")

    service = BrandScreeningService(db)
    search = await service.screen_brand(name, user_id=current_user.id, case_id=request.case_id, case_data=request.case_data)

    # Audit log entry
    risk_cls = getattr(getattr(search, "screening_result", None), "risk_classification", "LOW") or "LOW"
    AuditRepository(db).create(
        action="BRAND_SCREENING",
        user_id=current_user.id,
        resource_type="brand_screening",
        resource_id=name,
        details=f"Completed brand screening analysis for \"{name}\" (Risk: {risk_cls})",
        metadata={"brand_name": name, "risk": risk_cls, "case_id": request.case_id},
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return search


@router.post("/compare", response_model=CompareResultSchema, status_code=status.HTTP_200_OK)
async def compare_brand_name(
    request: CompareRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Compare Names: serves a Brand Screening or AI Name Generator history
    record for this name directly from the DB when one exists within the
    last 90 days; otherwise runs the same full WHO INN -> IQVIA -> Google ->
    e-pharmacy screening pipeline as /brands/screen and persists a new
    result. Does not change /brands/screen's own always-fresh behavior —
    this is a Compare-specific shortcut only."""
    name = request.brand_name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="brand_name must be at least 2 characters")
    if len(name) > 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="brand_name cannot exceed 100 characters")

    service = CompareService(db)
    result = await service.compare_one(name, user_id=current_user.id, case_id=request.case_id, case_data=request.case_data)


    # Audit log entry
    sr = result.get("screening_result") if isinstance(result, dict) else getattr(result, "screening_result", None)
    risk_cls = (sr.get("risk_classification") if isinstance(sr, dict) else getattr(sr, "risk_classification", "LOW")) or "LOW"
    AuditRepository(db).create(
        action="BRAND_SCREENING",
        user_id=current_user.id,
        resource_type="brand_compare",
        resource_id=name,
        details=f"Compared candidate brand name \"{name}\" (Risk: {risk_cls})",
        metadata={"brand_name": name, "risk": risk_cls, "case_id": request.case_id},
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return result


@router.get("/search/{search_id}", response_model=BrandSearchResponse)
def get_brand_search(
    search_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    search = ScreeningRepository(db).get_by_search_id(search_id)
    if not search:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Brand search not found")
    return search


@router.get(
    "/intelligence/{brand_name}",
    response_model=IntelligenceData,
    dependencies=[Depends(rate_limit(max_requests=30, window_seconds=60))],
)
async def get_brand_intelligence(
    brand_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Market-intelligence view for a brand name — reuses the same evidence
    gathered by a recent /brands/screen call for this name when available
    (10-minute cache) rather than re-running the e-pharmacy scrape."""
    name = brand_name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="brand_name must be at least 2 characters")
    if len(name) > 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="brand_name cannot exceed 100 characters")

    service = BrandScreeningService(db)
    return await service.get_intelligence(name)
