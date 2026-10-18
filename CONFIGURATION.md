# Configuring a match

Edit **Configure Setup → JSON Configuration**, or edit `shared/default-config.json` to
change the shipped preset for future games. The browser and server read that same file.
Gameplay values belong in JSON rather than `.env`: each room needs its own rules, and
started games must keep the rules they were dealt with. Environment variables remain
for deployment, secrets and development fixtures.

## Format and balance identity

```json
"version": "2.0",
"ruleset": { "id": "default", "revision": null }
```

`version` identifies the JSON format. `ruleset.id` identifies the balance preset;
`ruleset.revision` identifies an approved balance release. **The current balance is a
draft: revision remains null.** Implementing format 2.0 does not release balance 1.
Changing metadata never fetches or replaces a game's saved values.

Both engines resolve missing current fields when loading a config and save complete
snapshots when a match starts. Arrays supplied by the author must contain complete
entries. Explicit `null`, unknown gameplay keys and unsupported formats are refused.
Saving setup while a match is running affects future starts only; it does not replace
that match's snapshot. Reload/rejoin uses the saved snapshot, not current defaults.
The online room's clock selection overrides `match.turnTimeLimit` at start, as before.

Format-1 imports upgrade automatically. `shared/legacy-rules-v1.json` freezes the old
implicit match rules and `shared/legacy-config-v1.json` freezes its fallback catalogue.
Explicit old `rules` values migrate to their current paths. Retired movement keys and
root extensions that format 1 ignored are dropped; old omissions retain their historic
normalization, including objective inference and scalar range falloff 0 when absent.
The editor explains the upgrade. A restored server snapshot upgrades in memory;
its next normal revision-guarded write persists the resolved config. No database
migration, blanket rewrite of old games or owner-service restart is needed.
**Never update the legacy files for a new balance edit.**

## Where to change things

| Section | Controls |
|---|---|
| `board`, `setup`, `units` | Geometry, placements, base stats, UP value, exact ATK/HEL rings, capture tiers and first-star bonuses |
| `abilities` | Catalogue effect IDs, costs, cooldowns, durations, uses, phase-use resets, stats, healing/damage, aura/control/splash radii, path costs, pair slots and pick delay |
| `match` | Opening, any number of numbered phases/overtime stages, phase rates/grants/multipliers, fixed CP awards, clock, objective and ending thresholds |
| `stageRules` | Independent attacks, normal healing, pool/unit/CP casts, doorways, three unit-action allowances and opening movement locks |
| `economy` | Starting points/UP, combat bounties, wounded refunds, wrap prices, halftime UP, score/deficit CP and overtime VP conversion |
| `scoring` | Capture-zone anchors or absolute centres, radii/weights, normal claim/neutralization reach, centre bonus and attrition |
| `combat` | Scalar falloff, positive-hit floors, counters including base/reserve permissions |
| `panels` | Home-row depth, crossing MOV cost and each panel's healing rate |
| `veterancy` | Starting stars, unlock ranks, award size/timing/zones, active kit zones and final heal |

The schema describes each field. [CONFIG_BLUEPRINT.md](CONFIG_BLUEPRINT.md) lists the
shipped match values for review. Units and ability effects keep their existing data-driven
contract: numerical values can change, while new behavior requires an implemented effect ID.

For example, change a phase's regular-point income independently:

```json
"pointsBeforeHalftime": 2,
"pointsPerTurn": 4,
"postmatchPointsPerTurn": 3,
"grant": 20,
"cpAward": 12
```

Schedule `turns` means a **full White-plus-Black turn**. `match.maxTurns` preserves the
old limit's meaning: **individual side turns (plies)**. Each phase's `halftimeAfter`
must be between 0 and its `turns`; 0 disables halftime. `postmatchTurns: 0` skips
postmatch. Tallies still freeze at the end of ordinary phase play; configured pending
losses resolve after that phase's postmatch, with king death taking priority.

To add/remove phases, edit `match.phases`. To add/remove overtime stages, edit
`match.overtime.stages`; every stage supplies its own battlefield/reserve/base limits.
When changing `match.opening.turns`, change all three `stageRules.opening.moves`
arrays to the same length. Phase references in early losses and numeric full-heal
settings must still name existing phases. `fullHealPhase: "last"` follows the last
numbered phase automatically. An overtime winner may be White, Black or a draw.

`match.winConditions.points.leadToWin` is keyed by the **leading side**. The shipped
White 50 / Black 25 permits overtime at exactly that lead; a strictly larger lead wins.
`earlyPhaseLosses` supports the existing `no-eligible-capture-occupant` and `vp-at-most`
predicates, each with an inclusive threshold; it is not a general rules language.

CP per banked phase is `cpAward + own VP × cpOwnScoreMultiplier + opponent VP ×
cpOpponentScoreMultiplier + max(0, opponent VP − own VP) × cpBehindGapMultiplier`.
Withdrawal UP is `max(minimum, value × valueMultiplier − fee − missing HP ×
missingHpMultiplier)`, recorded when leaving. `killPayZones` filters the combat
exchange's target zone; ability kills remain exempt. `deathZones` filters each
casualty's own zone, including battlefield attackers killed by panel counters.

Each scoring zone needs exactly one of a named `anchor` and absolute `center: [q,r]`.
Absolute centres must lie on the battlefield. Only base-tier zones specify an owner;
other zones use `"owner": ""`. Overlapping hexes take the greatest worth. The board
outlines centres and the actual second layer for the configured radius. Unit capture
permissions still come from `units.*.captureZones`.

Unit kits can be enabled in any configured subset of battlefield/reserve/base. This
changes kit activation, not ordinary attack/heal source rules. Start-of-owner-turn
auras still target battlefield units, and configured panel sources can supply them.
Turning off the kit's HP bonus lowers maximum HP only; enabling it adds the bonus to
current and maximum HP once. Moving between two enabled zones preserves wounded HP.
Ordinary healing amounts and ranges use the active kit rank, so disabling battlefield
kits retains the unit's base healing profile. Stars remain capped at 3; effective unit
stats at 99.

`economy.wrapPriceMultiplier: 0` permits free wraps during open windows;
`economy.walkHomeRefund.veterancy` contains optional Vet 1–3 overrides for
`valueMultiplier`, `fee` and `missingHpMultiplier`; the common `minimum` floor
still applies. New defaults waive the fee at Vet 1, waive wounds at Vet 2 and
pay 3× full value at Vet 3. `resetVeterancy: true` clears stars after pricing;
recorded reset events prevent old promotions/awards from returning on reload.
Existing configs that omit these optional fields retain their previous refunds
and stars when normalized again.

Onslaught's `offensive-power` passive has configurable `atk` and `hel`; ATK
applies to initiated strikes, HEL to existing profiles. Sprint's
`mobility-economy` passive uses `mov`, extra `baseMov`, `costReduction` and
`minimumCost` for all of its owner's ability casts. Discounts never change path
purchase or panel crossing prices. Its shipped defaults have no healing effect.
Repeated `sacrifice` effects refresh the recipient's temporary stats; permanent
promotion and full healing still occur on each cast. Selected Sacrifice's optional
`battlefieldActions` grants general battlefield unit-action slots on the casting
ply: shipped value 1, zero for none. These slots belong to unused units and cannot
reopen finished actors. Omission retains older nominated-extra-actor behavior;
normalization never inserts this field into an existing saved catalogue. A cast
claims its source category action before granting slots; it shares that claim with
its own movement/attack. Base, reserve and battlefield have independent current
actors. Switching actors within one category closes the prior unit until Undo.

`quick.freeOrder: true` permits partitioning/reordering one unit’s movement,
attack and unit cast. Omission/false retains the older post-attack movement rule.
`knight-charge.secondCounter: true` permits one final counter to an opponent’s
Charge second strike, subject to ordinary survival/counter eligibility. Omission/
false retains the single-counter exchange. Neither optional field is inserted
into frozen started-game configurations.

Cast's control-only `allowCommanders` flag is false in the shipped preset: any
unit marked `commander` is ineligible, including kings. Omission/true retains older
match eligibility. Normalization never inserts this optional flag into an existing
catalogue. The `{commanderRule}` description token reflects the configured rule.

Bastion's utility reference now names `strengthen`; Onslaught's names `convert`.
Frozen configurations retain their own path references. A non-unit universal
cast may grant configured `up` independently of its CP/point cost; Convert grants
50 UP. The cast records the amount in history, preserving it through Undo,
commit, replay and reload even if a later configuration changes the reward.
Solo resolves a prior UP reward before checking a subsequent panel crossing
price, so the same turn can use Convert to fund that crossing.

Recharge's optional `refundMultiplier` is a nonnegative integer, shipped as 1.
For each selected pair member already at 0 or 1 CD before the cast, grant that
multiple of the member's configured base regular-point cost; leave CD unchanged.
Higher cooldowns only decrease by `recharge`, stopping at 1. Sprint discounts
cast prices but never these payouts. Omission or zero preserves cooldown-only
Recharge in saved configurations; normalization does not insert the field.
One-turn pool descriptions show the payout and explain they cannot be refreshed.

`economy.walkHomeRefund.minimum: 0` permits a zero refund. A zero-priced crossing
still follows its stage gate, and a zero-refund homecoming still withdraws the unit.

Ability descriptions use numeric templates such as `+{atk} ATK`, `{cost} UP`,
`{radius} hex` and `{duration}`. `{sign:mov}` includes the sign, `{abs:mov}` the
magnitude, `{scope}` describes recipients and `{counterProfile}` formats counter
rings. Shipped descriptions and recognized old default descriptions reflect edited
values. A custom literal description remains the author's text.

## Additional balance controls

The shipped preset explicitly keeps `lifestealPercent: 100` on Leech,
`healPercent: 100` on Regenerate, and `minimumCooldown: 1` on Recharge. These
optional fields preserve those values when absent from an older saved catalogue.
Percentages are integers from 0 to 100. Leech rounds down the percentage of actual
HP damage separately for each normal strike; it captures the percentage in the
cast effect, and the latest active Leech determines it until expiry. Regenerate
rounds down its percentage of maximum HP on each own turn end, without reviving
a casualty. Zero disables that healing. Recharge reduces only cooldowns above its
floor, never increases one already below it, and pays its configured refund for
members already at or below the floor. A zero floor permits a complete refresh.

`economy.unitValues` holds optional per-unit overrides so related economic effects
can be balanced independently without duplicating every unit's base value:

```json
"unitValues": {
  "pawn": { "bounty": 2, "withdrawal": 8, "wrap": 0, "attrition": 5 }
}
```

These are base values before the existing global multipliers and refund formula.
Each omitted purpose uses that match's `units.<id>.value`; explicit zero is valid.
Keys must name configured units. The shipped map is empty, preserving the current
balance. Saved missing, empty and sparse maps stay unchanged when a later preset
adds overrides. They never inherit a later game's values.

CPU policy is separate in `shared/cpu-tuning.json`: `profiles` controls time, beam
width and search depth, `position`/`movement` control evaluation, `candidate`
controls ordering, `limits` controls shortlists, and `search` controls time sharing.
Existing `CPP_CPU_<DIFFICULTY>_SECONDS` and `_BEAM` overrides still win; `_DEPTH`
is also supported. The loader rejects missing/unknown keys and invalid numeric bounds; network/request safety
limits remain fixed. CPU workers load this file at startup, so edits take effect
on their next normal restart. The CPU's withdrawal ordering and beam shortlist
use the actual configured refund, including wounds, fees and per-unit overrides.
Changing CPU policy never changes a saved match's legality or balance snapshot.

Hand-calculated behavior examples use the frozen test-only
`shared/testing/balance-config.json`; do not regenerate it for routine balance
edits. Dedicated tests still validate the actual shipped preset. Adjust expected
behavior and the fixture deliberately when changing a rule, rather than deriving
expected answers from the implementation or weakening a test after a rebalance.

## What stays structural

The configuration exposes existing rules and effect numbers, rather than an ability
DSL. Hex movement, friendly pass-through, occupancy, two alternating sides, action
ordering, a reserve entry ending its action, and non-interleaving movement stay in code.
Unit actions follow move → unit UP ability → attack; each step is optional. A unit
ability ends movement, and attacking blocks later unit abilities. A configured
post-attack movement passive can reopen remaining movement after attacking. With
`freeOrder: true`, it permits partitioning/reordering movement, attack and unit cast
within their ordinary per-unit budgets. Pool and CP casts use their separate targeting rules.
Panel units cannot initiate ordinary attacks or heals. Mutual commander death is a
draw; timeout commits a saved staged turn; replay timing and visual design are separate.
R/Undo restores uncommitted pool/path choices and casts together with movement in
chronological order. Purchases restore their payment and first-pair unlock clock.
The fixed stat cap 99 and rank cap 3 remain code invariants. A configured permission
never bypasses action locks, targeting, ownership, costs or cooldowns.

## Changing the contract

Update the schema, shared defaults and both validators together. New domain validation
uses the same draft-07 schema through Python `jsonschema` and client `ajv`; cross-field
checks are mirrored in `game_rules.py` / `game-rules.ts`. Add shared malformed cases to
`config-parity.json` (`format2Refused` for current-format edits). Legacy cases retain
`legacy-config-v1.json` as their input. `game-rules-parity.json` contains an independently
calculated two-phase/two-overtime match used by both suites and rendered/socket flows.
Regenerate scoring fixtures only after intentional mirrored scoring-rule changes.
Resolved match sections are treated as immutable: replace them when changing a config.
Phase/overtime schedules are cached by section identity; new sections rebuild them.

Run both full suites, build, schema and migration checks; drive JSON editing plus solo
and multiplayer starts/reloads. Changes to setup/room template or styles also need
the layout sweep. `ajv` is an explicit CommonJS build allow-list entry because its
published validator package uses CommonJS; Python's dependency is pinned alongside it.
