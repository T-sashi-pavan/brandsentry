from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime

from app.core.database import get_db
from app.schemas.audit import AuditLogListResponse, AuditLogSchema, AuditStatsResponse, LogExportRequest
from app.repositories.audit import AuditRepository
from app.api.deps import get_current_user
from app.models.user import User
import uuid

router = APIRouter(prefix="/audit", tags=["Audit Trail"])


@router.get("/stats", response_model=AuditStatsResponse)
def get_audit_stats(
    user_id: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = AuditRepository(db)
    effective_user_filter = None
    if user_id and user_id != "all":
        try:
            effective_user_filter = uuid.UUID(user_id)
        except ValueError:
            pass

    dt_from = None
    if date_from:
        try:
            dt_from = datetime.fromisoformat(date_from)
        except ValueError:
            pass

    dt_to = None
    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to)
        except ValueError:
            pass

    stats = repo.get_stats(
        user_id=effective_user_filter,
        action=action if action and action != "all" else None,
        resource_type=resource_type if resource_type and resource_type != "all" else None,
        search=search,
        date_from=dt_from,
        date_to=dt_to,
    )
    return AuditStatsResponse(**stats)


@router.post("/log-export")
def log_export(
    request: LogExportRequest,
    req: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = AuditRepository(db)
    client_ip = req.client.host if req.client else "127.0.0.1"
    fmt = (request.export_format or "pdf").upper()
    brand_text = f'"{request.brand_name}"' if request.brand_name else "report"
    details = f"Exported screening report for {brand_text} ({fmt})"
    
    repo.create(
        action="EXPORT",
        user_id=current_user.id,
        resource_type="report",
        resource_id=request.brand_name or request.case_id,
        details=details,
        metadata={"brand_name": request.brand_name, "format": fmt, "case_id": request.case_id},
        ip_address=client_ip,
        status="success",
    )
    return {"message": "logged"}


@router.get("/logs", response_model=AuditLogListResponse)
def get_audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = AuditRepository(db)
    
    effective_user_filter = None
    if user_id and user_id != "all":
        try:
            effective_user_filter = uuid.UUID(user_id)
        except ValueError:
            pass
            pass

    dt_from = None
    if date_from:
        try:
            dt_from = datetime.fromisoformat(date_from)
        except ValueError:
            pass

    dt_to = None
    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to)
        except ValueError:
            pass

    items, total = repo.get_logs(
        page=page,
        page_size=page_size,
        user_id=effective_user_filter,
        action=action if action and action != "all" else None,
        resource_type=resource_type if resource_type and resource_type != "all" else None,
        search=search,
        date_from=dt_from,
        date_to=dt_to,
    )

    enriched = []
    for item in items:
        log_dict = {
            "id": item.id,
            "user_id": item.user_id,
            "action": item.action,
            "resource_type": item.resource_type,
            "resource_id": item.resource_id,
            "details": item.details,
            "log_metadata": item.log_metadata,
            "ip_address": item.ip_address,
            "status": item.status,
            "created_at": item.created_at,
            "user_name": item.user.full_name if item.user else None,
            "user_email": item.user.email if item.user else None,
        }
        enriched.append(AuditLogSchema(**log_dict))

    return AuditLogListResponse(total=total, page=page, page_size=page_size, items=enriched)
