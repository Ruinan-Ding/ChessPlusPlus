# Translate informal development requests

Read only for informal, aesthetic, comparison-based or ambiguous requests. The
lead performs this translation inside the existing Scrum flow; no extra agent,
command, framework or user-written spec is required.

1. Preserve the user's wording or a faithful short quote and requested outcome.
   Inspect affected source and existing contracts. For “like X”, inspect the
   supplied reference; ask for unavailable essential reference details rather
   than pretending to have seen them.
2. Extract observable changes; label each as explicit, an existing constraint,
   a reversible assumption, or an unresolved question. Preserve exclusions and
   previous decisions. “Better”, “polished” and “balanced” alone do not authorize
   invented features, personal claims, mechanics or numerical targets.
3. State scope and non-goals, then a few Given/When/Then examples with stable IDs
   mapped to requirements. Include the success path and meaningful boundary/
   failure cases. Use existing repo thresholds and test tools where applicable.
4. Ask one concise bundled question for consequential unknowns; do not ask the
   user to learn SDD. Keep dependent work pending and continue independent work.
   Routine reversible implementation assumptions can proceed when stated.
5. Write/update the one inline or file contract, select relevant checks and
   proceed through BDD → TDD → review. Mention the intended outcome/assumptions
   briefly in the normal progress update. Do not add a spec-approval ceremony.

Example: “Make this feel cleaner and easier on phones.”

- Intent: improve the existing screen's readability and use on phones.
- Assumption: keep current content and actions; reuse the design and access rules.
- R1/A1: Given the repo's required phone viewport, when viewing the affected
  screen, then text/actions remain reachable without clipped text or horizontal
  overflow → browser geometry and keyboard check. Do not invent a new breakpoint
  or accessibility guarantee from that sentence alone.
- A cosmetic spacing choice can proceed. A proposed removal of content or change
  to game rewards is a separate decision, not a translation of “cleaner”.

For a later “actually, keep that button”, revise the same contract's scope and
examples, preserve its requirement IDs where meaning is unchanged, and reassess
only the affected implementation/checks. Unclear product rules remain questions;
conflicting accepted rules are surfaced rather than overwritten.
