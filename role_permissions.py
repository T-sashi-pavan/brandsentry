from datetime import datetime, timezone
from sqlalchemy import Column, DateTime, JSON, String
from app.core.database import Base


class RolePermissions(Base):
    """Persisted override of a role's default permission template (RBAC).

    One row per editable role (super_admin is immutable and never stored
    here — see app.core.permissions). Seeded from the hardcoded
    ROLE_DEFAULT_PERMISSIONS on first startup; edits from the "Role
    Permissions" tab in User Management upsert this table and update the
    in-process cache in app.core.permissions immediately.
    """
    __tablename__ = "role_permissions"

    role = Column(String(50), primary_key=True)
    permissions = Column(JSON, nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
