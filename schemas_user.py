import uuid
from datetime import datetime
from typing import Any, Dict, Optional
from pydantic import BaseModel, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: uuid.UUID
    email: EmailStr
    full_name: str
    role: str
    department: Optional[str] = None
    is_active: bool
    is_superuser: bool
    created_at: datetime
    custom_permissions: Optional[Dict[str, Any]] = None
    # Not a DB column — computed per-request (role defaults merged with
    # custom_permissions) and attached to the ORM instance by the route
    # before serialization. See app.core.permissions.get_effective_permissions.
    effective_permissions: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class UserAdminResponse(BaseModel):
    id: uuid.UUID
    email: EmailStr
    full_name: str
    role: str
    department: Optional[str] = None
    is_active: bool
    is_superuser: bool
    created_at: datetime
    updated_at: Optional[datetime] = None
    custom_permissions: Optional[Dict[str, Any]] = None
    effective_permissions: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


class CreateUserAdminRequest(BaseModel):
    email: EmailStr
    full_name: str
    password: str
    role: str = "business_team"
    department: Optional[str] = None
    is_superuser: bool = False
    custom_permissions: Optional[Dict[str, Any]] = None


class UpdateUserAdminRequest(BaseModel):
    full_name: Optional[str] = None
    role: Optional[str] = None
    department: Optional[str] = None
    is_active: Optional[bool] = None
    is_superuser: Optional[bool] = None
    custom_permissions: Optional[Dict[str, Any]] = None
    # Explicit reset flag — UpdateUserAdminRequest excludes None fields before
    # passing to UserRepository.update_user (see admin.py), so there's no way
    # to distinguish "don't touch custom_permissions" from "clear it back to
    # role defaults" via the field itself; this flag disambiguates that.
    reset_permissions: bool = False


class UpdateProfileRequest(BaseModel):
    full_name: Optional[str] = None
    department: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class AdminResetPasswordRequest(BaseModel):
    # L-07: NIST SP 800-63B minimum for memorized secrets (was 8).
    new_password: str = Field(..., min_length=12, description="New password for the user, minimum 12 characters")
