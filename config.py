import json
import logging
import os
import tempfile
import typing
from typing import Optional
from urllib.parse import quote_plus
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

# Key mappings from AWS Secrets Manager keys (however the secret JSON happens
# to spell them — hyphens, the platform team's SPIL-AI-* naming, etc.) to this
# class's field names. Anything not listed here just has its hyphens swapped
# for underscores (e.g. "BEDROCK_EMBEDDING_MODEL_ID" needs no entry). See
# load_settings_from_secrets_manager() below.
_SECRET_KEY_ALIASES = {
    "SPIL-AI-BRANDSENTRY_API_KEY": "SPIL_AI_BRANDSENTRY_API_KEY",
    "SPIL-AI-BRANDSENTRY_MODEL_ID": "SPIL_AI_BRANDSENTRY_MODEL_ID",
    "SPIL-AI-BRANDSENTRY-MODEL-ID": "SPIL_AI_BRANDSENTRY_MODEL_ID",
    "SPIL-AI-BS-GCS-API-KEY": "GOOGLE_API_KEY",
    "SPIL_AI_BS_GCS_API_KEY": "GOOGLE_API_KEY",
    "SPIL-AI-BS-GCS-ENGINE-ID": "GOOGLE_CSE_ID",
    "SPIL_AI_BS_GCS_ENGINE_ID": "GOOGLE_CSE_ID",
    "BEDROCK-EMBEDDING-MODEL-ID": "BEDROCK_EMBEDDING_MODEL_ID",
    "AWS-REGION": "AWS_REGION",
    "AWS-ACCESS-KEY-ID": "AWS_ACCESS_KEY_ID",
    "AWS-SECRET-ACCESS-KEY": "AWS_SECRET_ACCESS_KEY",
    "AWS-SESSION-TOKEN": "AWS_SESSION_TOKEN",
}


class Settings(BaseSettings):
    APP_NAME: str = "BrandSentry Platform API"
    VERSION: str = "1.0.0"
    DEBUG: bool = False

    # Gates dev-only surface area (currently: /docs and /redoc — see
    # M-24 in main.py). Anything other than "development" is treated as
    # production-like; set explicitly via env var/Secrets Manager in a real
    # deployment rather than relying on this default.
    APP_ENV: str = "development"

    # Root log level for the whole app — DEBUG/INFO/WARNING/ERROR/CRITICAL.
    # This is the one knob to turn up when debugging an issue in staging/prod
    # (set it to DEBUG there temporarily) without redeploying code. Applied by
    # app/core/logging_config.py at startup. Default INFO: quiet enough for
    # normal operation, but still shows every generate/login/case-create
    # outcome — turn up to DEBUG for step-by-step pipeline detail, down to
    # WARNING or ERROR to silence routine activity in a noisy environment.
    LOG_LEVEL: str = "INFO"

    # PostgreSQL (RDS) only — per SDD §4. No sqlite fallback: this must be
    # supplied by AWS Secrets Manager (either a DATABASE_URL key directly, or
    # DB_HOST/DB_USER/DB_PASSWORD/DB_NAME components — see
    # load_settings_from_secrets_manager() below) or a real environment
    # variable. Optional[...] = None here (not a bare `str`) purely so
    # pydantic-settings doesn't raise at Settings() construction time before
    # Secrets Manager gets a chance to supply it — see
    # _REQUIRED_AFTER_AWS_LOAD / validate_required_settings() below, which is
    # what actually enforces "must end up set, no silent local fallback".
    DATABASE_URL: Optional[str] = None

    # No default — this is a required value. Optional[...] = None here (not
    # a bare `str`) purely so pydantic-settings doesn't raise at Settings()
    # construction time before AWS Secrets Manager ever gets a chance to
    # supply it — see validate_required_settings() below, which enforces
    # "must actually end up set, from a real env var OR Secrets Manager" instead.
    SECRET_KEY: Optional[str] = None
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    # L-08: refresh token lifetime — long enough to avoid re-login friction,
    # rotated (old jti revoked) on every use in POST /auth/refresh.
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Comma-separated list of allowed origins for the frontend dev/prod hosts.
    FRONTEND_URL: str = "http://websiteip:5173"

    # This backend's own externally-reachable base URL — used to build the
    # default SAML SP entity ID / ACS URL below (and the SSO redirect target)
    # when the more specific SAML_SP_* fields aren't set.
    BACKEND_URL: Optional[str] = None

    # --- SAML 2.0 SSO (Microsoft Entra ID) — all optional; SSO stays
    # disabled (see sso_enabled below) until the IdP-side fields are set.
    SAML_SP_ENTITY_ID: Optional[str] = None
    SAML_SP_ACS_URL: Optional[str] = None
    SAML_SP_NAME_ID_FORMAT: str = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
    SAML_SP_X509_CERT: Optional[str] = None
    SAML_SP_PRIVATE_KEY: Optional[str] = None
    SAML_IDP_ENTITY_ID: Optional[str] = None
    SAML_IDP_SSO_URL: Optional[str] = None
    SAML_IDP_X509_CERT: Optional[str] = None
    # Which SAML assertion attribute carries the caller's group/role — tried
    # before the well-known Entra ID claim URIs in services/auth.py.
    SAML_ROLE_ATTRIBUTE: Optional[str] = None

    # LLM provider for brand-name generation: Claude, via Amazon Bedrock.
    # app/services/ai.py builds a single AsyncAnthropicBedrock client,
    # authenticated and modeled EXCLUSIVELY from AWS Secrets Manager keys —
    # no credential, region, or model id is ever hardcoded in code:
    #   - SPIL_AI_BRANDSENTRY_API_KEY is passed as the Bedrock bearer token
    #     (`api_key=`). Previously held an OpenAI key; only the value in
    #     Secrets Manager changes to move this from OpenAI to Claude.
    #   - SPIL_AI_BRANDSENTRY_MODEL_ID selects the Bedrock Claude model id.
    # Confined to app/services/ai.py so callers never see the provider's
    # request/response shape.
    SPIL_AI_BRANDSENTRY_API_KEY: Optional[str] = None
    SPIL_AI_BRANDSENTRY_MODEL_ID: Optional[str] = None

    # No hardcoded default — sourced from a real AWS_REGION env var or AWS
    # Secrets Manager. If left unset, the AWS/Anthropic SDKs fall back to
    # their own default region resolution (env var, shared config, or the
    # EC2/ECS instance's region).
    AWS_REGION: Optional[str] = None

    # SigV4 credentials for the separate Titan Embeddings client below only
    # (app/services/ai.py's boto3 bedrock-runtime client) — NOT used for the
    # Claude chat client above, which is authenticated solely via
    # SPIL_AI_BRANDSENTRY_API_KEY. On EC2 these can stay unset — the
    # instance's IAM role covers it; local-dev-only fallback for a shared
    # AWS CLI profile with no instance role available.
    AWS_ACCESS_KEY_ID: Optional[str] = None
    AWS_SECRET_ACCESS_KEY: Optional[str] = None
    AWS_SESSION_TOKEN: Optional[str] = None

    # Amazon Titan Text Embeddings on Bedrock — backs the "Semantic
    # Similarity" dimension in Brand Analysis (app/services/
    # brand_screening.py's cosine-similarity check). Claude has no
    # embeddings endpoint on any platform, including Bedrock, so this is a
    # separate model/client from the Claude chat client above; same AWS
    # region, and the AWS_* SigV4 credentials above when set. Sourced only
    # from AWS Secrets Manager — no model id hardcoded here.
    BEDROCK_EMBEDDING_MODEL_ID: Optional[str] = None

    # Engine (cx) + a GCP project with billing enabled. Generation still runs
    # without these set — the web-presence check is skipped (and flagged as
    # "not checked", never treated as "clean") rather than blocking
    # generation entirely.
    GOOGLE_API_KEY: Optional[str] = None
    GOOGLE_CSE_ID: Optional[str] = None

    # Pure Python DiskCache Directory (zero external servers needed).
    # L-09: an absolute path on a persistent volume, not a path relative to
    # the working directory (which may not survive a container restart).
    CACHE_DIR: str = os.getenv("CACHE_DIR", os.path.join(tempfile.gettempdir(), "brandsentry_cache"))

    # Default on/off state for each Brand Analysis data source, read once at
    # process start. An admin can flip these live from the Data Sources
    # screen afterward (PUT /reference-data/data-sources/{id}) — that live
    # toggle is stored in the platform_settings DB table, seeded from these
    # env defaults the first time it's read, and takes over from there. These
    # env vars only matter again if that DB row is ever cleared.
    WHO_INN_ENABLED: bool = True
    IQVIA_ENABLED: bool = True
    EPHARMACY_SCRAPE_ENABLED: bool = True
    GOOGLE_SEARCH_ENABLED: bool = True

    # AWS Secrets Manager — the source of truth for every setting on this
    # class once populated (the field defaults/real env vars below become
    # fallback only; only keys actually present in the secret are
    # overridden, anything omitted just keeps its env-var/default value).
    # Name or ARN of a single JSON secret whose keys are this class's
    # field names (or one of the platform team's SPIL-AI-*/AWS-* aliases —
    # see _SECRET_KEY_ALIASES above), e.g.:
    #   {"SECRET_KEY": "...", "DATABASE_URL": "...",
    #    "SPIL-AI-BRANDSENTRY_API_KEY": "...", "SPIL-AI-BRANDSENTRY_MODEL_ID": "..."}
    # Falls back to the AWS_SECRETS_MANAGER_SECRET_NAME / SECRET_NAME /
    # SECRETS_NAME environment variable if unset (the common ECS task-
    # definition convention). See load_settings_from_secrets_manager below.
    AWS_SECRETS_MANAGER_SECRET_NAME: Optional[str] = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    @property
    def saml_sp_entity_id(self) -> str:
        return self.SAML_SP_ENTITY_ID or f"{(self.BACKEND_URL or '').rstrip('/')}/auth/sso/metadata"

    @property
    def saml_sp_acs_url(self) -> str:
        return self.SAML_SP_ACS_URL or f"{(self.BACKEND_URL or '').rstrip('/')}/auth/sso/acs"

    @property
    def sso_enabled(self) -> bool:
        # Deliberately checked against the IdP-side fields only — those are
        # the ones an admin must actually go configure; the SP-side fields
        # above all have working defaults derived from BACKEND_URL.
        return bool(self.SAML_IDP_ENTITY_ID and self.SAML_IDP_SSO_URL and self.SAML_IDP_X509_CERT)


settings = Settings()

# Fields that have no safe default and MUST end up set by the time the app
# starts serving requests — from a real environment variable, or from AWS
# Secrets Manager. Declared Optional on the Settings class above (see comment
# there) purely so construction doesn't fail before that Secrets Manager call
# gets a chance to run; validate_required_settings() is what actually
# enforces this, called from main.py right after it.
# DATABASE_URL included: only RDS (via Secrets Manager) is a supported
# database — a missing value must fail startup loudly, never fall back to a
# local sqlite file.
_REQUIRED_AFTER_AWS_LOAD = ("SECRET_KEY", "DATABASE_URL")


def validate_required_settings() -> None:
    """Raises loudly if any _REQUIRED_AFTER_AWS_LOAD field is still unset
    after real environment variables + AWS Secrets Manager have both had a
    chance to supply a real value. Deliberately NOT a graceful fallback like
    every other optional integration in this app — SECRET_KEY signs every JWT
    issued, so silently starting with it missing is a security hole, not a
    degraded-but-safe feature, so this fails startup instead."""
    missing = [f for f in _REQUIRED_AFTER_AWS_LOAD if not getattr(settings, f)]
    if missing:
        raise RuntimeError(
            f"Required setting(s) {missing} are not set. Provide them as a real "
            "environment variable, or via AWS Secrets Manager (see app/core/config.py)."
        )

    # M-26 defense-in-depth: even though there's no hardcoded fallback value
    # above, still refuse an obviously-weak or placeholder key that made it
    # in via a real env var/secret.
    secret_key = settings.SECRET_KEY or ""
    if len(secret_key) < 32 or "dev-secret" in secret_key.lower() or "changeme" in secret_key.lower():
        raise RuntimeError(
            "SECRET_KEY must be a real, non-placeholder value at least 32 characters long."
        )

    # M-27 defense-in-depth: catch a non-Postgres DATABASE_URL (e.g. an
    # accidental sqlite:/// value) at startup rather than failing later with
    # an obscure error on the first DB call.
    db_url = settings.DATABASE_URL or ""
    if not db_url.startswith(("postgresql://", "postgresql+psycopg2://", "postgresql+asyncpg://")):
        raise RuntimeError(
            "DATABASE_URL must be a PostgreSQL connection string (postgresql:// / "
            "postgresql+psycopg2:// / postgresql+asyncpg://) sourced from AWS Secrets Manager."
        )

    # M-09 defense-in-depth: the SAML ACS handler already guards against an
    # empty FRONTEND_URL at request time (redirecting to a relative
    # "/sso/callback" path resolves to the backend domain, which has no SSO
    # callback handler, silently breaking the SSO flow). Failing loudly here
    # at startup — when SSO is actually configured — surfaces the
    # misconfiguration immediately instead of only on the next login attempt.
    if settings.sso_enabled and not settings.FRONTEND_URL:
        raise RuntimeError(
            "FRONTEND_URL must be set when SSO is enabled (SAML_IDP_ENTITY_ID / "
            "SAML_IDP_SSO_URL / SAML_IDP_X509_CERT are configured)."
        )


def _coerce_secret_value(field_name: str, raw_value: str):
    """Secrets Manager values are always strings once pulled out of the JSON
    blob — coerce back to whatever type this Settings field actually declares
    (bool/int/str) so e.g. WHO_INN_ENABLED or ACCESS_TOKEN_EXPIRE_MINUTES
    don't end up as the string "true"/"60" instead of a real bool/int."""
    annotation = Settings.model_fields[field_name].annotation
    types_in_annotation = typing.get_args(annotation) or (annotation,)
    if bool in types_in_annotation:
        return raw_value.strip().lower() in ("1", "true", "yes", "on")
    if int in types_in_annotation:
        return int(raw_value)
    return raw_value


def load_settings_from_secrets_manager() -> None:
    """Overrides Settings fields with values from a single JSON secret in AWS
    Secrets Manager — called explicitly from main.py, BEFORE any other
    application import (NOT inside the FastAPI startup event, and NOT at the
    top of this module either). Two separate ordering constraints, both
    already noted at the top of main.py:
      1. Must run AFTER configure_logging() — this module's logger calls
         would otherwise be silently dropped by Python's unconfigured
         default logging setup.
      2. Must run BEFORE app.core.database and app.services.ai are ever
         imported — both read settings (DATABASE_URL, SPIL_AI_BRANDSENTRY_*
         etc.) at IMPORT TIME to build a module-level engine/client. A field
         overridden here after either module has already been imported
         (e.g. from inside startup(), which runs after main.py's full
         import chain completes) would arrive too late to matter.

    Real environment variables / field defaults remain the fallback for
    anything the secret doesn't contain, or if this fetch fails outright (no
    secret name configured, bad JSON, no AWS credentials yet, network, wrong
    secret name/ARN) — never fatal.

    AWS credentials are resolved purely through boto3's own default chain
    (env vars, ~/.aws/credentials, or an IAM role) — never read from
    pydantic Settings and never hardcoded here.
    """
    secret_name = (
        settings.AWS_SECRETS_MANAGER_SECRET_NAME
        or os.environ.get("AWS_SECRETS_MANAGER_SECRET_NAME")
        or os.environ.get("SECRET_NAME")
        or os.environ.get("SECRETS_NAME")
    )
    if not secret_name:
        logger.info("[SECRETS MANAGER] No secret name configured — skipping; settings stay env-var-sourced.")
        return

    try:
        import boto3
        from botocore.config import Config as BotoConfig
        from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError
    except Exception:
        logger.exception("[SECRETS MANAGER] boto3 unusable — settings stay env-var-sourced.")
        return

    try:
        client = boto3.client(
            "secretsmanager",
            region_name=settings.AWS_REGION or None,
            config=BotoConfig(connect_timeout=5, read_timeout=10, retries={"max_attempts": 3}),
        )
        response = client.get_secret_value(SecretId=secret_name)
    except (ClientError, BotoCoreError, NoCredentialsError) as exc:
        # Image-scan finding: don't log the secret name/ARN or region — they
        # land in stdout/CloudWatch, which is otherwise-avoidable exposure of
        # infrastructure identifiers. Keep the message generic.
        logger.warning(
            "[SECRETS MANAGER] Could not fetch configured secret: %s — settings stay env-var-sourced.", exc,
        )
        return

    secret_str = response.get("SecretString")
    try:
        if secret_str:
            raw_secrets = json.loads(secret_str)
        else:
            raw_secrets = json.loads(response.get("SecretBinary", b"{}").decode("utf-8"))
    except (json.JSONDecodeError, TypeError, UnicodeDecodeError) as exc:
        logger.warning(
            "[SECRETS MANAGER] Configured secret is not valid JSON (%s) — settings stay env-var-sourced.", exc,
        )
        return
    if not raw_secrets:
        return

    loaded = 0
    for key, value in raw_secrets.items():
        if value is None:
            continue
        field_name = _SECRET_KEY_ALIASES.get(key, key.replace("-", "_"))
        if field_name not in Settings.model_fields:
            continue
        setattr(settings, field_name, _coerce_secret_value(field_name, str(value).strip()))
        loaded += 1

    # Construct DATABASE_URL from individual DB components, for secrets laid
    # out the way RDS-integrated Secrets Manager secrets usually are (separate
    # username/password/host/port/dbname fields) rather than one full
    # connection string — only if DATABASE_URL itself wasn't already supplied
    # directly above.
    if "DATABASE_URL" not in raw_secrets:
        db_user = raw_secrets.get("DB_USER") or raw_secrets.get("username")
        db_pass = raw_secrets.get("DB_PASSWORD") or raw_secrets.get("password")
        db_host = raw_secrets.get("DB_HOST") or raw_secrets.get("host")
        db_port = raw_secrets.get("DB_PORT") or raw_secrets.get("port") or "5432"
        db_name = raw_secrets.get("DB_NAME") or raw_secrets.get("dbname") or "postgres"
        if db_host and db_user and db_pass is not None:
            encoded_pass = quote_plus(str(db_pass))
            settings.DATABASE_URL = (
                f"postgresql+psycopg2://{db_user}:{encoded_pass}@{db_host}:{db_port}/{db_name}"
            )
            loaded += 1
            logger.debug("[SECRETS MANAGER] Constructed DATABASE_URL from DB_HOST/DB_USER/DB_PASSWORD components")

    logger.info("[SECRETS MANAGER] Loaded %d setting(s) from the configured secret.", loaded)
