from typing import Any

from fastapi import Request

from app.core.config import settings

# onelogin.saml2 (the python3-saml package) is imported lazily inside the
# functions below, not at module level. This module is reached from
# app/api/routes/auth.py, which the whole app imports unconditionally at
# startup — importing onelogin here would mean a not-yet-installed or
# not-yet-buildable python3-saml (it needs the native xmlsec1 library) crashes
# the entire backend, not just the optional SSO routes.


def get_saml_settings() -> dict:
    """Builds the python3-saml settings dict from app config."""
    return {
        "strict": True,
        "debug": False,
        "sp": {
            "entityId": settings.saml_sp_entity_id,
            "assertionConsumerService": {
                "url": settings.saml_sp_acs_url,
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
            },
            "NameIDFormat": settings.SAML_SP_NAME_ID_FORMAT,
            "x509cert": settings.SAML_SP_X509_CERT or "",
            "privateKey": settings.SAML_SP_PRIVATE_KEY or "",
        },
        "idp": {
            "entityId": settings.SAML_IDP_ENTITY_ID or "",
            "singleSignOnService": {
                "url": settings.SAML_IDP_SSO_URL or "",
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "x509cert": settings.SAML_IDP_X509_CERT or "",
        },
        "security": {
            "authnRequestsSigned": bool(settings.SAML_SP_PRIVATE_KEY),
            "wantAssertionsSigned": True,
            "wantMessagesSigned": False,
        },
    }


async def prepare_fastapi_request(request: Request) -> dict:
    form = {}
    if request.method == "POST":
        form_data = await request.form()
        form = dict(form_data)

    return {
        "https": "on" if request.url.scheme == "https" else "off",
        "http_host": request.url.hostname,
        "server_port": request.url.port or (443 if request.url.scheme == "https" else 80),
        "script_name": request.url.path,
        "get_data": dict(request.query_params),
        "post_data": form,
    }


async def init_saml_auth(request: Request) -> Any:
    from onelogin.saml2.auth import OneLogin_Saml2_Auth

    req = await prepare_fastapi_request(request)
    return OneLogin_Saml2_Auth(req, get_saml_settings())


def get_sp_metadata() -> str:
    from onelogin.saml2.settings import OneLogin_Saml2_Settings

    saml_settings = OneLogin_Saml2_Settings(get_saml_settings(), sp_validation_only=True)
    return saml_settings.get_sp_metadata()
