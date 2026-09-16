from pydantic import BaseModel, Field
from typing import Optional, Any, Dict
from datetime import datetime
import uuid


class AuditLogSchema(BaseModel):
    id: uuid.UUID
    user_id: Optional[uuid.UUID] = None
    action: str
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    details: Optional[str] = None
    log_metadata: Optional[Dict[str, Any]] = None
    ip_address: Optional[str] = None
    status: str
    created_at: datetime

    user_name: Optional[str] = None
    user_email: Optional[str] = None

    class Config:
        from_attributes = True


class AuditLogListResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[AuditLogSchema]


class AuditStatsResponse(BaseModel):
    total: int = 0
    logins: int = 0
    exports: int = 0
    screenings: int = 0
    generations: int = 0


class LogExportRequest(BaseModel):
    brand_name: Optional[str] = ""
    export_format: Optional[str] = "pdf"
    case_id: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_-]{1,30}$")
