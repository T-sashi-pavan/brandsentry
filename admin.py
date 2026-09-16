"""
Admin endpoints for data management and user management.
All endpoints require is_superuser=True or admin role.
"""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
import uuid

from pydantic import BaseModel

from app.core.database import get_db
from app.core.permissions import AVAILABLE_MODULES, get_all_role_permissions, get_effective_permissions, set_role_permissions
from app.core.rate_limit import get_client_ip
from app.api.deps import require_permission
from app.models.user import User
from app.repositories.user import UserRepository
from app.repositories.audit import AuditRepository
from app.schemas.user import UserAdminResponse, CreateUserAdminRequest, UpdateUserAdminRequest, AdminResetPasswordRequest


class UpdateRolePermissionsRequest(BaseModel):
    permissions: dict

router = APIRouter(prefix="/admin", tags=["Admin"])

# ── User Management ────────────────────────────────────────────────────────────
# Restricted to Super Admin by the default "admin" role template (see
# app.core.permissions) — matches the existing frontend gate on this page.

def _with_effective_permissions(user: User) -> User:
    user.effective_permissions = get_effective_permissions(user)
    return user


@router.get("/permissions/schema")
def get_permissions_schema(
    current_user: User = Depends(require_permission("user_management", "view")),
):
    """Read-only introspection for the User Management permission matrix UI:
    every module's available sub-items, plus each role's *current* template
    (factory default, or edited via the Role Permissions tab) — so the
    frontend never hand-duplicates app.core.permissions, and always reflects
    the latest role-level edits."""
    return {
        "available_modules": AVAILABLE_MODULES,
        "role_defaults": get_all_role_permissions(),
    }


@router.put("/role-permissions/{role}")
def update_role_permissions(
    role: str,
    request: UpdateRolePermissionsRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user_management", "manage_users")),
):
    """Edits the default permission template for every user assigned
    `role` (distinct from a single user's custom_permissions override).
    Super Admin's template is immutable and rejected here."""
    client_ip = get_client_ip(http_request)
    try:
        sanitized = set_role_permissions(db, role, request.permissions)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    AuditRepository(db).create(
        action="ROLE_PERMISSIONS_UPDATED",
        user_id=current_user.id,
        resource_type="role_permissions",
        resource_id=role,
        details=f"Updated default permissions for role: {role}",
        metadata={"role": role},
        ip_address=client_ip,
        status="success",
    )
    return {"role": role, "permissions": sanitized}


@router.get("/users", response_model=list[UserAdminResponse])
def list_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user_management", "view")),
):
    return [_with_effective_permissions(u) for u in UserRepository(db).get_all_users()]


@router.post("/users", response_model=UserAdminResponse)
def create_user(
    request: CreateUserAdminRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user_management", "manage_users")),
):
    client_ip = get_client_ip(http_request)
    repo = UserRepository(db)
    if repo.get_by_email(request.email):
        raise HTTPException(status_code=400, detail="Email already registered")
    user = repo.create(
        email=request.email,
        full_name=request.full_name,
        password=request.password,
        role=request.role,
        department=request.department,
        is_superuser=request.is_superuser,
    )
    if request.custom_permissions is not None:
        user = repo.update_user(user.id, custom_permissions=request.custom_permissions)
    AuditRepository(db).create(
        action="USER_CREATED",
        user_id=current_user.id,
        resource_type="user",
        resource_id=str(user.id),
        details=f"Created user {user.email} (Role: {user.role})",
        metadata={"email": user.email, "role": user.role, "department": user.department},
        ip_address=client_ip,
        status="success",
    )
    return _with_effective_permissions(user)


@router.patch("/users/{user_id}", response_model=UserAdminResponse)
def update_user(
    user_id: uuid.UUID,
    request: UpdateUserAdminRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user_management", "manage_users")),
):
    client_ip = get_client_ip(http_request)
    repo = UserRepository(db)
    target = repo.get_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    old_role = target.role
    old_superuser = target.is_superuser

    data = {k: v for k, v in request.model_dump().items() if k != "reset_permissions" and v is not None}
    user = repo.update_user(user_id, **data)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Explicit flag because update_user's generic setter skips None values,
    # so it can't itself null custom_permissions back to role-default inheritance.
    if request.reset_permissions:
        user = repo.clear_custom_permissions(user_id)

    # L-18: a specific ROLE_CHANGED audit entry (with old/new values) when
    # privilege fields change, instead of burying that in a generic
    # USER_UPDATED entry indistinguishable from e.g. a department edit.
    if "role" in data or "is_superuser" in data:
        AuditRepository(db).create(
            action="ROLE_CHANGED",
            user_id=current_user.id,
            resource_type="user",
            resource_id=str(user.id),
            details=f"Privilege change for {user.email}: role ({old_role} -> {user.role}), superuser ({old_superuser} -> {user.is_superuser})",
            metadata={
                "old_role": old_role, "new_role": user.role,
                "old_superuser": old_superuser, "new_superuser": user.is_superuser,
            },
            ip_address=client_ip,
            status="success",
        )
    else:
        AuditRepository(db).create(
            action="USER_UPDATED",
            user_id=current_user.id,
            resource_type="user",
            resource_id=str(user.id),
            details=f"Updated user {user.email}",
            metadata={k: v for k, v in data.items() if k != "custom_permissions"},
            ip_address=client_ip,
            status="success",
        )
    return _with_effective_permissions(user)


@router.post("/users/{user_id}/reset-password")
def reset_user_password(
    user_id: uuid.UUID,
    request: AdminResetPasswordRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user_management", "manage_users")),
):
    client_ip = get_client_ip(http_request)
    repo = UserRepository(db)
    target = repo.get_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    updated = repo.admin_reset_password(user_id, request.new_password)
    if not updated:
        raise HTTPException(status_code=400, detail="Failed to reset password")

    AuditRepository(db).create(
        action="USER_PASSWORD_RESET",
        user_id=current_user.id,
        resource_type="user",
        resource_id=str(user_id),
        details=f"Admin reset password for user {target.email}",
        metadata={"target_user_id": str(user_id), "target_email": target.email},
        ip_address=client_ip,
        status="success",
    )
    return {"message": f"Password reset successfully for {target.full_name or target.email}", "user_id": str(user_id)}


@router.delete("/users/{user_id}")
def deactivate_user(
    user_id: uuid.UUID,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user_management", "manage_users")),
):
    client_ip = get_client_ip(http_request)
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")
    repo = UserRepository(db)
    user = repo.update_user(user_id, is_active=False)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    AuditRepository(db).create(
        action="USER_DEACTIVATED",
        user_id=current_user.id,
        resource_type="user",
        resource_id=str(user.id),
        details=f"Deactivated user {user.email}",
        ip_address=client_ip,
        status="success",
    )
    return {"message": "User deactivated"}


@router.delete("/users/{user_id}/permanent")
def delete_user(
    user_id: uuid.UUID,
    http_request: Request,
    confirm_email: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user_management", "manage_users")),
):
    """Permanently remove a user (distinct from deactivation)."""
    client_ip = get_client_ip(http_request)
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    repo = UserRepository(db)
    target = repo.get_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if not confirm_email or confirm_email.strip().lower() != target.email.lower():
        raise HTTPException(status_code=400, detail=f"Permanent deletion requires email confirmation. Pass confirm_email='{target.email}'.")
    target_email = target.email
    deleted = repo.delete_user(user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")
    AuditRepository(db).create(
        action="USER_DELETED",
        user_id=current_user.id,
        resource_type="user",
        resource_id=str(user_id),
        details=f"Permanently deleted user {target_email}",
        ip_address=client_ip,
        status="success",
    )
    return {"message": "User deleted"}
