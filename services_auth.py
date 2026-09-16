from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Tuple
from sqlalchemy.orm import Session
from app.core.config import settings
from app.core.security import create_access_token, create_refresh_token
from app.models.user import User
from app.repositories.user import UserRepository

# Entra ID emits these well-known claim URIs in the SAML assertion attributes.
_SSO_EMAIL_ATTR_CANDIDATES = (
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "email",
    "mail",
)
_SSO_NAME_ATTR_CANDIDATES = (
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "http://schemas.microsoft.com/identity/claims/displayname",
    "name",
)
_SSO_ROLE_ATTR_CANDIDATES = (
    "group_level",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
    "roles",
    "role",
    "groups",
)


def _first_sso_attr(attributes: dict, candidates: tuple) -> Optional[str]:
    for key in candidates:
        values = attributes.get(key)
        if values:
            return values[0]
    return None


def _map_sso_role(raw_value: Optional[str]) -> Optional[Tuple[str, bool]]:
    """Maps an SSO group/role claim to one of this app's 6 canonical roles
    (app.core.permissions.ROLE_DEFAULT_PERMISSIONS) via an EXACT-match
    allowlist (H-11) — a prior version used `"admin" in value`, which would
    grant superuser to any group merely containing the substring "admin"
    (e.g. "domain_administrator", "admin_readonly")."""
    if not raw_value:
        return None
    value = raw_value.strip().lower()
    if value in {"super_admin", "superadmin", "platform_admin"}:
        return "super_admin", True
    if value in {"admin", "administrator"}:
        return "admin", False
    if value in {"brand_market_admin", "brand_marketing_admin"}:
        return "brand_market_admin", False
    if value in {"brand_market_user", "brand_marketing_user", "business_team", "marketing"}:
        return "brand_market_user", False
    if value in {"trademark_admin", "legal_admin"}:
        return "trademark_admin", False
    if value in {"trademark_user", "trademark_team", "legal_team", "legal"}:
        return "trademark_user", False
    return None


class InactiveUserError(Exception):
    def __init__(self, user: User):
        self.user = user
        super().__init__(f"User {user.email} is inactive")


class AuthService:
    def __init__(self, db: Session):
        self.repo = UserRepository(db)

    def _issue_tokens(self, user: User) -> dict:
        """Shared by login() and the /auth/refresh flow (L-08) — both must
        embed the same pwd_ver claim so app.api.deps.get_current_user's
        password-change invalidation applies equally to a refreshed token."""
        pwd_ver = user.hashed_password[:12]
        access_token = create_access_token(
            data={
                "sub": str(user.id),
                "email": user.email,
                "pwd_ver": pwd_ver,
                "iat": int(datetime.now(timezone.utc).timestamp()),
            },
            expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
        )
        refresh_token = create_refresh_token(
            data={"sub": str(user.id), "email": user.email, "pwd_ver": pwd_ver},
            expires_delta=timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        )
        return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer", "user": user}

    def login(self, email: str, password: str) -> Optional[dict]:
        user = self.repo.authenticate(email, password)
        if not user:
            return None
        if not user.is_active:
            raise InactiveUserError(user)
        return self._issue_tokens(user)

    def refresh(self, user: User) -> dict:
        """Re-issues both tokens for an already-validated user (the caller —
        POST /auth/refresh — is responsible for validating the incoming
        refresh token and its jti before calling this)."""
        return self._issue_tokens(user)

    def login_from_saml(self, auth: Any) -> dict:
        """Processes an already-validated SAML response (the caller —
        POST /auth/sso/acs — is responsible for auth.process_response() and
        checking auth.get_errors()/is_authenticated() first) and either logs
        in or just-in-time provisions the corresponding user."""
        attributes = auth.get_attributes() or {}
        name_id = auth.get_nameid()
        email = _first_sso_attr(attributes, _SSO_EMAIL_ATTR_CANDIDATES) or name_id
        full_name = _first_sso_attr(attributes, _SSO_NAME_ATTR_CANDIDATES)
        if not email:
            raise ValueError("SAML assertion did not contain an email/NameID claim")

        role_candidates = _SSO_ROLE_ATTR_CANDIDATES
        if settings.SAML_ROLE_ATTRIBUTE:
            role_candidates = (settings.SAML_ROLE_ATTRIBUTE, *_SSO_ROLE_ATTR_CANDIDATES)
        role_hint = _map_sso_role(_first_sso_attr(attributes, role_candidates))

        user = self.repo.get_or_create_from_sso(email=email, full_name=full_name, role_hint=role_hint)
        if not user.is_active:
            raise InactiveUserError(user)
        return self._issue_tokens(user)

    def get_user_by_id(self, user_id) -> Optional[User]:
        return self.repo.get_by_id(user_id)
