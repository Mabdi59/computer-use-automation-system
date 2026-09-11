# Architecture

The implementation keeps the core contract small: discovery and replay operate against a `SurfaceAdapter`, while the artifact stays browser-agnostic. Playwright is the first adapter because it gives a real browser, frames, dialogs, screenshots, and deterministic control with a compact API. It is deliberately not embedded into the artifact itself; the artifact stores typed steps, locator bundles, checkpoints, and outcome contracts so another adapter could later map the same contract to desktop accessibility APIs or coordinate-based automation.

# Artifact schema

The artifact is a typed Zod schema with an explicit `schemaVersion`, revision, approval state, risk classification, inputs, outputs, preconditions, ordered steps, locator bundles, recovery handlers, redaction metadata, defaults, overrides, and an integrity checksum. Locator bundles are accessibility-first: role/name and label strategies come before visible text and structural CSS fallbacks. That is more reviewable and more stable than brittle positional or generated CSS selectors, especially in a legacy UI with iframes and table layouts.

# Determinism & error handling

Replay loads and validates the artifact, verifies its checksum, validates inputs, and executes the recorded steps without any LLM calls. Drift is detected through checkpoint assertions, expected page-state checks, and locator-resolution failures. Business outcomes are treated separately from technical failures: for example, `MEMBER_NOT_FOUND` is a valid business result, while validation errors, permission denials, expired sessions, dialogs, target misses, and checkpoint failures are technical or policy failures with explicit categories.

# Heterogeneity & multi-tenant

The artifact records vendor/application identity, compatible versions, tenant-neutral defaults, and optional tenant overrides. That allows one base capability to be shared across vendor/application variants and specialized where URLs or compatibility labels differ. The chosen locator bundle format also supports heterogeneous future adapters because the recorded intent is not tied to Playwright-specific handles.

# Escalation & handoff

Handoff is modeled with run-control states and intervention requests that preserve the same run ID, evidence timeline, screenshot, and sanitized observation. Automation pauses without closing the browser, context, page, cookies, or session. In real headed mode, the human uses the exact live browser window already opened by Playwright, while the operator console is only responsible for claiming and resolving control. In CI and tests, a simulated operator acts through the same Playwright context to prove same-session pause/resume behavior.

# Safety

Policy is evaluated before every discovery and replay action. The allowlist restricts protocol, host, port, and routes; sensitive-field entry is blocked by default; and irreversible confirmation requires human approval. This is why the open-sub-account flow stops at review in the example capability, and why the separate approval-oriented flow triggers handoff before the final confirmation point.

# Cuts

The project intentionally focuses on one complete vertical slice instead of wide product breadth. I left out richer model planning, artifact editing workflows, persistent run storage, multi-browser support, richer operator auth, desktop automation adapters, and more advanced visual targeting. With more time, the next additions would be stronger locator telemetry, richer audit capture for human control, more generic artifact generation from discovery runs, and a broader library of capabilities beyond member balance lookup and review-only sub-account opening.
