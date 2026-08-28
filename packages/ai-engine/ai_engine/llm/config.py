"""Canonical LLM routing and credential resolution.

Business code selects a purpose (``research`` or ``utility``).  This module
resolves the purpose to a vendor/model route and keeps wire-protocol details
out of the business configuration.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

LlmPurpose = Literal["research", "utility"]
LlmTier = Literal["light", "heavy"]

_DEFAULT_MODELS = {
    "research": "minimax:MiniMax-M3",
    "utility": "minimax:MiniMax-M3",
}
_DEFAULT_FALLBACK = "deepseek:deepseek-v4-flash"
_DEFAULT_BASE_URLS = {
    "minimax": "https://api.minimaxi.com/v1",
    "deepseek": "https://api.deepseek.com/v1",
}


@dataclass(frozen=True, slots=True)
class LlmRoute:
    vendor: str
    protocol: str
    model: str
    base_url: str | None
    api_key: str
    spec: str

    @property
    def wire_spec(self) -> str:
        """The provider:model form expected by GPT Researcher."""
        return f"{self.protocol}:{self.model}"

    @property
    def endpoint_key(self) -> str:
        return f"{self.protocol}:{self.base_url or 'default'}"


def _env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def parse_spec(spec: str) -> tuple[str, str]:
    vendor, separator, model = spec.partition(":")
    vendor = vendor.strip().lower()
    model = model.strip()
    if not separator or not vendor or not model:
        raise ValueError(f"invalid LLM spec {spec!r}; expected vendor:model")
    if vendor not in {"minimax", "deepseek", "openai", "anthropic"}:
        raise ValueError(
            f"unsupported LLM provider {vendor!r}; expected "
            "minimax, deepseek, openai, or anthropic"
        )
    return vendor, model


def _purpose_spec(purpose: LlmPurpose) -> str:
    special = {
        "research": ("RESEARCH_LLM", "PRIMARY_LLM", "SMART_LLM"),
        "utility": ("UTILITY_LLM", "SMART_LLM", "BRIEF_LLM"),
    }[purpose]
    return _env(*special) or _DEFAULT_MODELS[purpose]


def fallback_spec() -> str:
    return _env("FALLBACK_LLM", "LLM_FALLBACK_LLM") or _DEFAULT_FALLBACK


def _profile(vendor: str, model: str) -> str:
    normalized = vendor.lower()
    if normalized in {"openai", "anthropic"}:
        return normalized
    return normalized


def _credential_value(profile: str, suffix: str) -> str:
    upper = profile.upper()
    lower = profile.lower()
    return _env(f"{upper}_{suffix}", f"{lower}_{suffix.lower()}")


def resolve_route(
    purpose: LlmPurpose,
    *,
    spec: str | None = None,
    tier: LlmTier = "light",
) -> LlmRoute:
    raw_spec = spec.strip() if spec and spec.strip() else _purpose_spec(purpose)
    vendor, model = parse_spec(raw_spec)
    profile = _profile(vendor, model)

    protocol = _env(f"{profile.upper()}_PROTOCOL")
    if not protocol:
        protocol = vendor if vendor in {"openai", "anthropic"} else "openai"
    if protocol not in {"openai", "anthropic"}:
        raise ValueError(
            f"unsupported LLM protocol {protocol!r}; expected openai or anthropic"
        )

    key_suffix = "API_KEY_HEAVY" if tier == "heavy" else "API_KEY"
    url_suffix = "BASE_URL_HEAVY" if tier == "heavy" else "BASE_URL"
    api_key = _credential_value(profile, key_suffix)
    if not api_key and tier == "heavy":
        api_key = _credential_value(profile, "API_KEY")
    if not api_key and profile not in {"openai", "anthropic"}:
        api_key = _credential_value(protocol, key_suffix) or _credential_value(
            protocol, "API_KEY"
        )

    base_url: str | None = _credential_value(profile, url_suffix) or None
    if not base_url and tier == "heavy":
        base_url = _credential_value(profile, "BASE_URL") or None
    if not base_url and profile not in {"openai", "anthropic"}:
        base_url = (
            _credential_value(protocol, url_suffix)
            or _credential_value(protocol, "BASE_URL")
            or None
        )
    if not base_url:
        base_url = _DEFAULT_BASE_URLS.get(profile)

    return LlmRoute(
        vendor=profile,
        protocol=protocol,
        model=model,
        base_url=base_url or None,
        api_key=api_key,
        spec=raw_spec,
    )


def resolve_primary_and_fallback(
    purpose: LlmPurpose,
    *,
    explicit: str | None = None,
    tier: LlmTier = "light",
) -> tuple[LlmRoute, LlmRoute | None]:
    primary = resolve_route(purpose, spec=explicit, tier=tier)
    fallback_raw = fallback_spec()
    fallback = (
        resolve_route(purpose, spec=fallback_raw, tier=tier)
        if fallback_raw != primary.spec
        else None
    )
    return primary, fallback


def resolve_spec(
    purpose: LlmPurpose,
    *,
    explicit: str | None = None,
    tier: LlmTier = "light",
) -> str:
    return resolve_route(purpose, spec=explicit, tier=tier).spec


def resolve_wire_spec(
    purpose: LlmPurpose,
    *,
    explicit: str | None = None,
    tier: LlmTier = "light",
) -> str:
    return resolve_route(purpose, spec=explicit, tier=tier).wire_spec


def config_snapshot() -> dict[str, object]:
    """Return a secret-free routing snapshot suitable for startup logs."""
    result: dict[str, object] = {}
    for purpose in ("research", "utility"):
        primary, fallback = resolve_primary_and_fallback(
            purpose if purpose in {"research", "utility"} else "utility"
        )
        result[purpose] = {
            "primary": {
                "vendor": primary.vendor,
                "protocol": primary.protocol,
                "model": primary.model,
                "base_url": primary.base_url,
                "credential_configured": bool(primary.api_key),
            },
            "fallback": (
                {
                    "vendor": fallback.vendor,
                    "protocol": fallback.protocol,
                    "model": fallback.model,
                    "base_url": fallback.base_url,
                    "credential_configured": bool(fallback.api_key),
                }
                if fallback
                else None
            ),
        }
    return result


def resolved_route_lines() -> list[str]:
    """Human-readable, secret-free startup diagnostics."""
    lines: list[str] = []
    purposes: tuple[LlmPurpose, LlmPurpose] = ("research", "utility")
    for purpose in purposes:
        primary, fallback = resolve_primary_and_fallback(purpose)
        lines.append(
            f"{purpose}: primary {primary.vendor}/{primary.protocol}/"
            f"{primary.model} endpoint={primary.base_url or 'default'} "
            f"credential_configured={bool(primary.api_key)}"
        )
        if fallback:
            lines.append(
                f"{purpose}: fallback {fallback.vendor}/{fallback.protocol}/"
                f"{fallback.model} endpoint={fallback.base_url or 'default'} "
                f"credential_configured={bool(fallback.api_key)}"
            )
    return lines
