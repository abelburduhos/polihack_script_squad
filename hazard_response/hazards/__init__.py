from .base import (
    HazardType,
    AlertRule,
    HazardAlert,
    Comparator,
    register_hazard,
    get_hazard,
    list_hazards,
)
from . import flood, fire  # noqa: F401 — importing registers the hazard types

__all__ = [
    "HazardType",
    "AlertRule",
    "HazardAlert",
    "Comparator",
    "register_hazard",
    "get_hazard",
    "list_hazards",
]
