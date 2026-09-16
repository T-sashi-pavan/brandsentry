import logging
import time
import uuid
from jose import jwt as jose_jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from app.api.deps import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core.permissions import get_effective_permissions
from app.core.rate_limit import rate_limit, get_client_ip
from app.core.saml import get_sp_metadata, init_saml_auth
from app.core.security import decode_token, revoke_token
from app.models.user import User
from app.schemas.user import (
    LoginRequest,
    TokenResponse,
    UserResponse,
    UpdateProfileRequest,
    ChangePasswordRequest,
)
from app.services.auth import AuthService, InactiveUserError
from app.repositories.user import UserRepository
from app.repositories.audit import AuditRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Authentication"])


from sqlalchemy.exc import OperationalError, DatabaseError


def _is_request_secure(request: Request) -> bool:
    """Only mark cookies as Secure when the connection is actually HTTPS or
    behind an HTTPS-terminating proxy. Setting Secure=True over plain HTTP
    causes browsers to silently discard the cookie, which otherwise causes an
    immediate logged-out-after-login loop."""
    proto = request.headers.get("x-forwarded-proto", "").lower()
    return proto == "https" or request.url.scheme == "https"


def _set_auth_cookies(response: Response, result: dict, secure: bool) -> None:
    response.set_cookie(
        key="access_token",
        value=result["access_token"],
        httponly=True,
        secure=secure,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        samesite="lax",
    )
    # L-08: a second, longer-lived cookie so the frontend can silently renew
    # the access token via POST /auth/refresh instead of forcing a full
    # re-login every ACCESS_TOKEN_EXPIRE_MINUTES.
    response.set_cookie(
        key="refresh_token",
        value=result["refresh_token"],
        httponly=True,
        secure=secure,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        samesite="lax",
        path="/auth",
    )


@router.post(
    "/login",
    response_model=TokenResponse,
    dependencies=[Depends(rate_limit(max_requests=10, window_seconds=60, by_ip=True))],
)
def login(request: LoginRequest, http_request: Request, response: Response, db: Session = Depends(get_db)):
    client_ip = get_client_ip(http_request)
    try:
        result = AuthService(db).login(request.email, request.password)
    except InactiveUserError as e:
        logger.warning("Blocked login to deactivated account: %s", request.email)
        AuditRepository(db).create(
            action="LOGIN_BLOCKED_INACTIVE",
            user_id=e.user.id,
            resource_type="user",
            resource_id=str(e.user.id),
            details=f"Attempted login to deactivated account: {request.email}",
            ip_address=client_ip,
            status="failure",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account has been deactivated. Please contact your platform administrator.",
        )
    except (OperationalError, DatabaseError) as e:
        logger.error("AWS RDS Database connection error during login: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AWS RDS Database is currently inactive or unreachable. Please ensure the RDS instance is active in AWS Console.",
        )
    except Exception as e:
        logger.error("Unexpected error during login: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Login service error: {str(e)}",
        )

    if not result:
        logger.warning("Failed login attempt for %s", request.email)
        AuditRepository(db).create(
            action="LOGIN_FAILED",
            details=f"Failed login attempt for {request.email}",
            ip_address=client_ip,
            status="failure",
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )

    # H-01: the cookie (not localStorage) is now the frontend's sole means of
    # authenticating — see frontend/src/api/client.ts / AuthContext.tsx.
    _set_auth_cookies(response, result, _is_request_secure(http_request))

    logger.info("Login: %s", request.email)
    user_id = result["user"].id if hasattr(result["user"], "id") else None
    AuditRepository(db).create(
        action="LOGIN",
        user_id=user_id,
        details=f"User {request.email} logged in successfully",
        ip_address=client_ip,
        status="success",
    )
    result["user"].effective_permissions = get_effective_permissions(result["user"])
    return result


@router.post("/refresh", response_model=TokenResponse)
def refresh_token_endpoint(http_request: Request, response: Response, db: Session = Depends(get_db)):
    """L-08: silently renews the session from the long-lived refresh_token
    cookie so a user isn't logged out every ACCESS_TOKEN_EXPIRE_MINUTES.
    Rotates the refresh token on every use (old jti revoked, a fresh one
    issued) so a leaked-but-unused refresh token has a shrinking window of
    usefulness."""
    raw_refresh = http_request.cookies.get("refresh_token")
    if not raw_refresh:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token present")

    payload = decode_token(raw_refresh)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    try:
        user_id = uuid.UUID(payload.get("sub"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token payload")

    user = UserRepository(db).get_by_id(user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    # Same password-change invalidation semantics as app.api.deps.get_current_user.
    if payload.get("pwd_ver") and payload["pwd_ver"] != user.hashed_password[:12]:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session invalidated due to password change. Please log in again.",
        )

    old_jti = payload.get("jti")
    if old_jti:
        remaining = max(int(payload.get("exp", 0) - time.time()), 0)
        revoke_token(old_jti, ttl_seconds=remaining or 60)

    result = AuthService(db).refresh(user)
    _set_auth_cookies(response, result, _is_request_secure(http_request))
    result["user"].effective_permissions = get_effective_permissions(result["user"])
    return result


@router.post("/logout")
def logout(http_request: Request, response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # H-02: logout now actually revokes the token server-side (not just
    # clearing the client-side cookie) so a copied/leaked token stops
    # working immediately instead of remaining valid until it expires.
    for cookie_name in ("access_token", "refresh_token"):
        raw = http_request.cookies.get(cookie_name)
        if not raw:
            continue
        try:
            unverified = jose_jwt.get_unverified_claims(raw)
            jti = unverified.get("jti")
            exp = unverified.get("exp")
            if jti:
                remaining = max(int(exp - time.time()), 0) if exp else 60
                revoke_token(jti, ttl_seconds=remaining)
        except Exception:
            logger.warning("Could not parse %s during logout for revocation", cookie_name, exc_info=True)

    response.delete_cookie(key="access_token")
    response.delete_cookie(key="refresh_token", path="/auth")
    logger.info("Logout: %s", current_user.email)
    AuditRepository(db).create(
        action="LOGOUT",
        user_id=current_user.id,
        details=f"User {current_user.email} logged out",
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return {"message": "Logged out successfully"}


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    current_user.effective_permissions = get_effective_permissions(current_user)
    return current_user


@router.patch(
    "/profile",
    response_model=UserResponse,
    dependencies=[Depends(rate_limit(max_requests=30, window_seconds=60))],
)
def update_profile(
    request: UpdateProfileRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = UserRepository(db)
    data = {k: v for k, v in request.model_dump().items() if v is not None}
    updated = repo.update_user(current_user.id, **data)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    AuditRepository(db).create(
        action="PROFILE_UPDATE",
        user_id=current_user.id,
        details=f"Updated profile for {current_user.email}",
        metadata=data,
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return updated


@router.post(
    "/change-password",
    dependencies=[Depends(rate_limit(max_requests=10, window_seconds=60, by_ip=True))],
)
def change_password(
    request: ChangePasswordRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # L-07: NIST SP 800-63B recommends a 12-character minimum for memorized
    # secrets in an enterprise application (was 8).
    if len(request.new_password) < 12:
        raise HTTPException(status_code=400, detail="New password must be at least 12 characters")
    repo = UserRepository(db)
    ok = repo.change_password(current_user.id, request.current_password, request.new_password)
    if not ok:
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    AuditRepository(db).create(
        action="PASSWORD_CHANGE",
        user_id=current_user.id,
        details=f"Changed password for {current_user.email}",
        ip_address=get_client_ip(http_request),
        status="success",
    )
    return {"message": "Password updated successfully"}


# ── SAML SSO (Microsoft Entra ID) ───────────────────────────────────────────

@router.get("/sso/status")
def sso_status():
    """Whether SAML SSO is fully configured (every IdP-side field set)."""
    return {"enabled": settings.sso_enabled}


@router.get("/sso/login")
async def sso_login(http_request: Request):
    if not settings.sso_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SSO is not configured")
    auth = await init_saml_auth(http_request)
    return RedirectResponse(auth.login())


@router.post("/sso/acs")
async def sso_acs(http_request: Request, db: Session = Depends(get_db)):
    """Assertion Consumer Service: the IdP POSTs the SAML response here after
    the user authenticates at the IdP."""
    if not settings.sso_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SSO is not configured")

    client_ip = get_client_ip(http_request)
    auth = await init_saml_auth(http_request)
    auth.process_response()

    errors = auth.get_errors()
    if errors:
        # H-10: the detailed reason (can expose SAML/certificate config
        # details) is logged server-side only — the client gets a generic
        # message so the SSO integration can't be fingerprinted from errors.
        logger.error("SAML authentication failed: %s - %s", errors, auth.get_last_error_reason())
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SAML authentication failed")
    if not auth.is_authenticated():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="SAML authentication failed")

    try:
        result = AuthService(db).login_from_saml(auth)
    except InactiveUserError as e:
        logger.warning("Blocked SSO login to deactivated account: %s", e.user.email)
        AuditRepository(db).create(
            action="LOGIN_BLOCKED_INACTIVE",
            user_id=e.user.id,
            resource_type="user",
            resource_id=str(e.user.id),
            details=f"Attempted SSO login to deactivated account: {e.user.email}",
            ip_address=client_ip,
            status="failure",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account has been deactivated. Please contact your platform administrator.",
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))

    logger.info("SSO login: %s", result["user"].email)
    AuditRepository(db).create(
        action="SSO_LOGIN",
        user_id=result["user"].id,
        details=f"SSO login successful for {result['user'].email}",
        ip_address=client_ip,
        status="success",
    )

    frontend_base = settings.FRONTEND_URL.split(",")[0].strip() if settings.FRONTEND_URL else ""
    if not frontend_base:
        # M-09: fail loudly instead of redirecting to a relative path, which
        # would resolve against this backend's own domain, not the frontend's.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="FRONTEND_URL must be configured for SSO callback",
        )

    redirect = RedirectResponse(f"{frontend_base}/sso/callback", status_code=status.HTTP_302_FOUND)
    _set_auth_cookies(redirect, result, _is_request_secure(http_request))
    return redirect


@router.get("/sso/metadata")
def sso_metadata():
    """SP metadata XML — upload this to the Entra ID Enterprise App registration."""
    return Response(content=get_sp_metadata(), media_type="application/xml")
