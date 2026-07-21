"""Internal contracts mirror.

Mirrors `packages/shared/src/{errors,states}.ts`. The TypeScript source is the
single source of truth; Python mirrors are only consumed inside this package.

Closed ADR 0002 finding #8: cross-language contract drift risk. After this
mirror exists, the Web side can read TS constants and the engine side reads
these Python constants; both must stay in sync with `docs/contracts/*`.
"""

from ai_engine.contracts import errors, states

__all__ = ["errors", "states"]