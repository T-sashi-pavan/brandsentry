"""Granular RBAC & Feature Entitlements engine.

Every module below is either fully described by `enabled` (module-level
visibility — e.g. a sidebar route or the topbar cart icon) or, for modules
with finer-grained controls, also carries an `actions` list naming which of
that module's AVAILABLE_MODULES sub-items are granted. A sub-item may be a
tab/section (e.g. "ai_tokens_tab"), an export/report toggle, or a button
(e.g. "action_approve") — AVAILABLE_MODULES doesn't distinguish those kinds
structurally, so `actions` covers all of them uniformly.

Storage: `User.custom_permissions` is NULL for the common case (inherit the
assigned role's template below); an admin edit populates it with a complete
per-module dict that overrides the role template module-by-module.
"""
from copy import deepcopy
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# Schema — every module and its available sub-items (sections/actions/tabs)
# ---------------------------------------------------------------------------

AVAILABLE_MODULES: Dict[str, list] = {
    "topbar": ["review_cart", "notifications_bell"],
    "dashboard": ["view", "ai_tokens_tab", "export_reports"],
    "generator": ["view", "generate_names", "add_to_cart"],
    "brand_analysis": ["view", "run_analysis", "export_pdf"],
    "compare": ["view", "run_compare", "export_excel"],
    # H-04: action_request_revision gates PUT /legal/reviews/{id}/request-revision
    # the same way action_approve/action_reject already gate approve/reject —
    # previously the only one of the three verbs with no permission check.
    "trademark_review": ["view", "action_approve", "action_reject", "action_request_revision", "chat_drawer"],
    "reports": ["view", "export_mis", "view_financials"],
    "data_sources": ["view", "sync_sources", "configure_apis"],
    "audit_trail": ["view", "export_logs"],
    "settings": ["view", "modify_thresholds"],
    "user_management": ["view", "manage_users"],
}


def _module(enabled: bool, actions: Optional[list] = None) -> Dict[str, Any]:
    return {"enabled": enabled, "actions": list(actions or [])}


def _full(module: str) -> Dict[str, Any]:
    return _module(True, AVAILABLE_MODULES[module])


def _off(module: str) -> Dict[str, Any]:
    return _module(False, [])


def _view_only(module: str) -> Dict[str, Any]:
    return _module(True, ["view"])


# ---------------------------------------------------------------------------
# Role default templates
# ---------------------------------------------------------------------------
# super_admin is included for UI display parity (the User Management matrix
# shows it fully checked) even though enforcement never actually consults
# this template for super_admin — see get_effective_permissions below, which
# short-circuits to "everything enabled" before ever looking at this dict.

ROLE_DEFAULT_PERMISSIONS: Dict[str, Dict[str, Any]] = {
    "super_admin": {module: _full(module) for module in AVAILABLE_MODULES},

    # Full operations, threshold configs, all reports, review operations —
    # everything except managing other users' accounts (Super Admin only,
    # matching the existing "Super Admin Privileges Required" gate on the
    # User Management page).
    "admin": {
        "topbar": _full("topbar"),
        "dashboard": _full("dashboard"),
        "generator": _full("generator"),
        "brand_analysis": _full("brand_analysis"),
        "compare": _full("compare"),
        "trademark_review": _full("trademark_review"),
        "reports": _full("reports"),
        "data_sources": _full("data_sources"),
        "audit_trail": _full("audit_trail"),
        "settings": _full("settings"),
        "user_management": _off("user_management"),
    },

    # Marketing view of Dashboard, full Generator/Analysis/Compare, Review
    # read-only with Chat, Marketing MIS reports.
    "brand_market_admin": {
        "topbar": _full("topbar"),
        "dashboard": _view_only("dashboard"),
        "generator": _full("generator"),
        "brand_analysis": _full("brand_analysis"),
        "compare": _full("compare"),
        "trademark_review": _module(True, ["view", "chat_drawer"]),
        "reports": _module(True, ["view", "export_mis"]),
        "data_sources": _off("data_sources"),
        "audit_trail": _view_only("audit_trail"),
        "settings": _view_only("settings"),
        "user_management": _off("user_management"),
    },

    # Generator/Analysis/Compare, Cart submission only; no Dashboard or MIS.
    "brand_market_user": {
        "topbar": _module(True, ["review_cart", "notifications_bell"]),
        "dashboard": _off("dashboard"),
        "generator": _full("generator"),
        "brand_analysis": _full("brand_analysis"),
        "compare": _full("compare"),
        "trademark_review": _view_only("trademark_review"),
        "reports": _off("reports"),
        "data_sources": _off("data_sources"),
        "audit_trail": _view_only("audit_trail"),
        "settings": _view_only("settings"),
        "user_management": _off("user_management"),
    },

    # IP Dashboard, full Trademark Review operations, Clearance MIS, IP Data
    # Source sync.
    "trademark_admin": {
        "topbar": _module(True, ["notifications_bell"]),
        "dashboard": _view_only("dashboard"),
        "generator": _view_only("generator"),
        "brand_analysis": _view_only("brand_analysis"),
        "compare": _view_only("compare"),
        "trademark_review": _full("trademark_review"),
        "reports": _module(True, ["view", "export_mis"]),
        "data_sources": _module(True, ["view", "sync_sources"]),
        "audit_trail": _view_only("audit_trail"),
        "settings": _view_only("settings"),
        "user_management": _off("user_management"),
    },

    # Full Trademark Review operations, read-only generator checks, Cart
    # hidden.
    "trademark_user": {
        "topbar": _module(True, ["notifications_bell"]),
        "dashboard": _off("dashboard"),
        "generator": _view_only("generator"),
        "brand_analysis": _view_only("brand_analysis"),
        "compare": _view_only("compare"),
        "trademark_review": _full("trademark_review"),
        "reports": _off("reports"),
        "data_sources": _off("data_sources"),
        "audit_trail": _view_only("audit_trail"),
        "settings": _view_only("settings"),
        "user_management": _off("user_management"),
    },
}

# Legacy/unassigned role strings still present in existing data
# (`business_team`, `trademark_team`) fall back to the closest new-scheme
# equivalent so pre-existing users don't lose access on upgrade.
_ROLE_ALIASES = {
    "business_team": "brand_market_user",
    "trademark_team": "trademark_user",
}

_EMPTY_TEMPLATE: Dict[str, Any] = {module: _off(module) for module in AVAILABLE_MODULES}


# ---------------------------------------------------------------------------
# Live role-permission cache — ROLE_DEFAULT_PERMISSIONS above are the
# hardcoded factory defaults (seed values + fallback); a Super Admin can edit
# a role's template from the "Role Permissions" tab in User Management,
# which persists to the `role_permissions` table AND updates this in-process
# cache immediately via set_role_permissions, so every subsequent
# get_effective_permissions call reflects the edit without needing a
# restart. Single-process deployment (see backend/Dockerfile — plain
# `uvicorn`, no --workers), so a plain module-level dict is safe here; a
# multi-worker/multi-replica deployment would need a shared cache instead.
# ---------------------------------------------------------------------------

_role_permissions_cache: Dict[str, Dict[str, Any]] = {
    role: deepcopy(template) for role, template in ROLE_DEFAULT_PERMISSIONS.items() if role != "super_admin"
}


def load_role_permissions_cache(db) -> None:
    """Populates the live cache from the `role_permissions` table at app
    startup, seeding that table from the hardcoded factory defaults for any
    editable role that has no row yet (first boot, or a newly-added role)."""
    from app.models.role_permissions import RolePermissions

    existing = {row.role: row.permissions for row in db.query(RolePermissions).all()}
    for role, factory_default in ROLE_DEFAULT_PERMISSIONS.items():
        if role == "super_admin":
            continue
        if role in existing and isinstance(existing[role], dict):
            _role_permissions_cache[role] = existing[role]
        else:
            db.add(RolePermissions(role=role, permissions=deepcopy(factory_default)))
    db.commit()


def set_role_permissions(db, role: str, permissions: Dict[str, Any]) -> Dict[str, Any]:
    """Persists an edited template for `role` and updates the live cache.
    Raises ValueError for super_admin (immutable) or an unknown role."""
    from app.models.role_permissions import RolePermissions

    if role == "super_admin":
        raise ValueError("Super Admin permissions are immutable and cannot be edited.")
    if role not in ROLE_DEFAULT_PERMISSIONS:
        raise ValueError(f"Unknown role: {role}")

    # A module the caller didn't mention keeps its current value rather than
    # being silently disabled — the UI always sends every module, but a
    # partial payload (a script, an older client, a mistake) must not be
    # able to wipe out modules it never touched.
    current = _role_permissions_cache.get(role) or get_role_defaults(role)
    sanitized = {}
    for module in AVAILABLE_MODULES:
        if isinstance(permissions.get(module), dict):
            value = permissions[module]
            sanitized[module] = {
                "enabled": bool(value.get("enabled", False)),
                "actions": [a for a in value.get("actions", []) if a in AVAILABLE_MODULES[module]],
            }
        else:
            sanitized[module] = deepcopy(current.get(module, {"enabled": False, "actions": []}))

    row = db.query(RolePermissions).filter(RolePermissions.role == role).first()
    if row:
        row.permissions = sanitized
    else:
        db.add(RolePermissions(role=role, permissions=sanitized))
    db.commit()

    _role_permissions_cache[role] = sanitized
    return sanitized


def get_all_role_permissions() -> Dict[str, Dict[str, Any]]:
    """Every role's *current* (possibly edited) template, Super Admin's
    always-full template included — this is what the User Management UI's
    role-picker and "Role Permissions" tab should read, not the hardcoded
    ROLE_DEFAULT_PERMISSIONS constant, so an edit is reflected everywhere."""
    return {
        "super_admin": {module: _full(module) for module in AVAILABLE_MODULES},
        **{role: deepcopy(template) for role, template in _role_permissions_cache.items()},
    }


def get_role_defaults(role: Optional[str]) -> Dict[str, Any]:
    """The current permission template for a role string (factory default,
    or an edited one from the Role Permissions tab), tolerating unknown/
    legacy values by falling back to the lowest-privilege template rather
    than raising — an unrecognized role should never accidentally grant
    access."""
    resolved = _ROLE_ALIASES.get(role or "", role)
    template = _role_permissions_cache.get(resolved)
    if template is None:
        return deepcopy(_EMPTY_TEMPLATE)
    return deepcopy(template)


def get_effective_permissions(user) -> Dict[str, Any]:
    """The permission set that actually governs `user`: unconditional full
    access for Super Admin (immutable — see module docstring), else the
    role's default template with any `custom_permissions` overrides applied
    module-by-module."""
    if getattr(user, "is_superuser", False) or getattr(user, "role", None) == "super_admin":
        return {module: _full(module) for module in AVAILABLE_MODULES}

    effective = get_role_defaults(getattr(user, "role", None))
    overrides = getattr(user, "custom_permissions", None)
    if overrides:
        for module, value in overrides.items():
            if module in AVAILABLE_MODULES and isinstance(value, dict):
                effective[module] = {
                    "enabled": bool(value.get("enabled", False)),
                    "actions": [a for a in value.get("actions", []) if a in AVAILABLE_MODULES[module]],
                }
    return effective


def has_permission(user, module: str, action: Optional[str] = None) -> bool:
    """Same predicate `require_permission` enforces server-side, exposed as
    a plain function for call sites that want a bool instead of raising."""
    if getattr(user, "is_superuser", False) or getattr(user, "role", None) == "super_admin":
        return True
    perms = get_effective_permissions(user)
    mod_perms = perms.get(module, {})
    if not mod_perms.get("enabled", False):
        return False
    if action and action not in mod_perms.get("actions", []):
        return False
    return True
