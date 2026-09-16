from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import (
    load_settings_from_secrets_manager,
    settings,
    validate_required_settings,
)
from app.core.logging_config import configure_logging

# Ordering here is load-bearing, not stylistic — everything below must run
# before the routes/database imports further down:
#   1. configure_logging() first — anything that logs at import time (e.g.
#      app.services.ai's module-level AIService() instantiation warns if no
#      LLM key is configured) would otherwise have that first message
#      silently dropped by Python's unconfigured default logging setup.
#   2. Then load_settings_from_secrets_manager() — must land BEFORE
#      app.core.database and app.services.ai are ever imported: both read
#      settings (DATABASE_URL, SPIL_AI_BRANDSENTRY_* etc.) at IMPORT TIME to
#      build a module-level engine/client, so an override arriving any later
#      (e.g. from inside the FastAPI startup event below, which runs after
#      this whole import chain completes) would be too late to matter.
#   3. Then validate_required_settings() — SECRET_KEY has no safe default
#      (see config.py), so this fails startup loudly if neither a real env
#      var nor the Secrets Manager call above actually supplied it, rather
#      than letting the app boot with a missing JWT secret.
configure_logging(settings.LOG_LEVEL)
load_settings_from_secrets_manager()
validate_required_settings()

import logging  # noqa: E402

from app.api.routes import (  # noqa: E402
    admin,
    audit,
    auth,
    brands,
    cart,
    dashboard,
    legal,
    notifications,
    reference_data,
    reports,
    settings as platform_settings,
    suggest_brands,
    suggestion,
)
from app.core.database import create_tables, SessionLocal  # noqa: E402
from app.core.permissions import load_role_permissions_cache  # noqa: E402

logger = logging.getLogger(__name__)

# M-24: interactive API docs enumerate every endpoint/schema and allow direct
# invocation — fine in development, not something to expose unauthenticated
# in a deployed environment.
_is_dev_env = settings.APP_ENV == "development"

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    description="BrandSentry Platform API",
    docs_url="/docs" if _is_dev_env else None,
    redoc_url="/redoc" if _is_dev_env else None,
)

_allowed_origins = {
    origin.strip()
    for origin in settings.FRONTEND_URL.split(",")
    if origin.strip()
}
_allowed_origins.update({"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"})

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_allowed_origins),
    # Cookie-based auth (the access_token HttpOnly cookie set on login) only
    # works cross-origin with allow_credentials=True; methods/headers are
    # restricted to what the app actually uses instead of a blanket "*" (L-27).
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "Accept", "Origin"],
)

app.include_router(auth.router)
app.include_router(suggestion.router)
app.include_router(suggest_brands.router)
app.include_router(brands.router)
app.include_router(reference_data.router)
app.include_router(legal.router)
app.include_router(cart.router)
app.include_router(admin.router)
app.include_router(audit.router)
app.include_router(platform_settings.router)
app.include_router(dashboard.router)
app.include_router(notifications.router)
app.include_router(reports.router)


@app.on_event("startup")
def startup():
    create_tables()
    db = SessionLocal()
    try:
        load_role_permissions_cache(db)
    except Exception:
        logger.exception("Failed to load role_permissions cache — falling back to hardcoded ROLE_DEFAULT_PERMISSIONS")
    finally:
        db.close()
    logger.info("%s v%s started (log level %s)", settings.APP_NAME, settings.VERSION, settings.LOG_LEVEL)


@app.on_event("shutdown")
async def shutdown():
    # The e-pharmacy scraper now keeps one long-lived Chromium for the process
    # instead of launching one per candidate; close it on the way out so the
    # driver subprocess does not outlive the app.
    try:
        from app.services.search_providers.scraping import shutdown_browser
        await shutdown_browser()
    except Exception:
        logger.warning("Failed to shut down the shared browser cleanly", exc_info=True)


@app.get("/health")
def health():
    return {"status": "healthy", "version": settings.VERSION}
