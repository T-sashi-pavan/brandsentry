from datetime import timezone
from typing import Callable, Optional
import uuid
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.permissions import get_effective_permissions, has_permission
from app.core.security import decode_token
from app.models.user import User
from app.repositories.user import UserRepository

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    token: Optional[str] = None

    # 1. Check Authorization Bearer header
    if credentials and credentials.credentials:
        token = credentials.credentials
    # 2. Fallback to HttpOnly cookie
    elif "access_token" in request.cookies:
        token = request.cookies.get("access_token")

    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    payload = decode_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    try:
        parsed_id = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    user = UserRepository(db).get_by_id(parsed_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    # Invalidate session if password was changed after token generation
    token_pwd_ver = payload.get("pwd_ver")
    if token_pwd_ver:
        if token_pwd_ver != user.hashed_password[:12]:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Session invalidated due to password change. Please log in again.",
            )
    else:
        token_iat = payload.get("iat")
        if token_iat and user.updated_at:
            updated_ts = (
                user.updated_at.replace(tzinfo=timezone.utc).timestamp()
                if user.updated_at.tzinfo is None
                else user.updated_at.timestamp()
            )
            if token_iat < (updated_ts - 1):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Session invalidated due to password change. Please log in again.",
                )

    return user


def require_superuser(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_superuser and current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )
    return current_user


def require_data_source_access(current_user: User = Depends(get_current_user)) -> User:
    """Shared by reference_data.py's write/upload routes (L-25) — factored
    out of a local `_require_superuser()` helper that duplicated this same
    check. Deliberately NOT the same predicate as require_superuser: a role
    holding the `data_sources` module permission (e.g. trademark_admin's
    documented "IP Data Source sync" entitlement) must keep that access —
    narrowing this to superuser/admin-only would be a real regression, not
    just a dedup."""
    if current_user.is_superuser or current_user.role in ("super_admin", "admin"):
        return current_user
    if has_permission(current_user, "data_sources"):
        return current_user
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")


def require_permission(module: str, action: Optional[str] = None) -> Callable[[User], User]:
    """FastAPI dependency factory gating a route on the granular RBAC system
    (app.core.permissions). Super Admin always passes, immutably — see that
    module's docstring. Usage: `Depends(require_permission("data_sources", "sync_sources"))`."""
    def dependency(current_user: User = Depends(get_current_user)) -> User:
        if current_user.is_superuser or current_user.role == "super_admin":
            return current_user
        perms = get_effective_permissions(current_user)
        mod_perms = perms.get(module, {})
        if not mod_perms.get("enabled", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Access denied to module: {module}")
        if action and action not in mod_perms.get("actions", []):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Unauthorized action: {action} in {module}")
        return current_user
    return dependency
