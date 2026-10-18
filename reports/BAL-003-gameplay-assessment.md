# Gameplay assessment after Cast commander immunity — 18 October 2026

My judgment: the game has meaningful tactical depth and several viable plans, but
competitive balance and human enjoyment are not yet established. Removing king
Cast eliminates a particularly abrupt control/tally interaction. It does not
remove the remaining remote-scoring and late-economy concerns.

This is a heuristic assessment of the changed rule, informed by the earlier
[520-match review](BAL-002-gameplay-review.md) and 28 overtime continuations.
Those matches allowed king Cast. Their win rates and ability usage must not be
presented as measurements of this new preset. BAL-003's contract owns fresh
implementation checks; no new large tournament or human playtest is claimed.

## What the king restriction changes

A bishop can no longer transfer a king's Capture influence and then use Blitz to
lock out its owner's unit response before tally. This closes the specific royal
control line found in the earlier probes. The king still needs protection from
ordinary attacks, damage abilities and a controlled non-royal attacker.

Cast retains a substantial purpose: steal a powerful attacker, support unit or
eligible zone holder, gain its immediate extra action, and deny the opponent its
next turn with that unit. Taking a queen or rook can still swing a fight. Its
adjacency requirement, vulnerable delivery, UP price and cooldown create real
commitments; removing access to kings does not make the bishop or Cast obsolete.
Legacy saved matches preserve the rules with which they started.

## How I expect good play to work

- **Early:** use scarce category actions to secure eligible scoring occupation,
  build an income position and keep the king safe. Actions and positioning can
  matter more than purchasing another body. Cheap Bastion is easy to activate;
  Onslaught/Sprint require a larger commitment and need their offensive or
  mobility/economy benefits to justify it.
- **Middle:** trade for access and timing. Defend capture occupants, exploit range
  blind spots, preserve veteran actors and choose abilities that solve the next
  tactical problem. Healing, ATK/DEF changes and control have recognizable roles.
  Movement denial also has demonstrated uses; low bot selection is not evidence
  that Mire, Trap, Snare or Taunt are useless.
- **Late:** plan around tally and full-turn effects. Saving CP for protection or
  a decisive strike can be correct, but late VP swings deserve more attention
  than merely spending every resource. Walking home converts a veteran into UP
  while losing its stars, position and active kit: a strong economic option with
  a tactical cost, not a free income loop.
- **Overtime:** the incentives are asymmetric. Black can win by surviving the
  limit, so White must force progress and Black can prioritize king safety.
  That is a real strategic role difference; whether it feels fair requires
  balanced human matches, not quiet pass-to-expiry simulations.

## Unit and ability purposes

These are intended tactical roles inferred from the rules, not a new usage ranking.

| Unit | Where it offers a distinct choice |
|---|---|
| Pawn | Cheap capture presence; Checkmate rewards a deep foothold. Sacrifice trades a body and UP for a veteran, healed/buffed recipient and another battlefield action. |
| Archer | Standoff damage with a close-range blind spot; Withdraw supports hit-and-reposition, and Snare punishes pursuit. |
| Shieldman | Occupation and protection through durability, Counter and Taunt rather than normal initiating attacks. |
| Rook | Close fighting and attrition debuffs; Bash rewards adjacent enemy clustering. |
| Knight | Reach and enemy-screen penetration; Charge is strongest when a survivable counter actually occurs. |
| Bishop | Sustain and stealing a non-royal action/position. Delivery and protection matter more now than a direct royal-control threat. |
| Queen | Flexible damage, adjacent support and Leech sustain; valuable enough that losing or exposing her has a real cost. |
| King | Capture control and nearby support, with the ever-present risk of losing by regicide. His job is broader than hiding. |

Pool abilities solve individual tactical problems; CP area skills make geometry
matter and can affect either side. Ultimates remain the broadest swing effects.
Those systems have purposes even when a limited bot does not select them often.

## What still concerns me

1. **Remote casualties can dominate a tally.** Base deaths count against VP while
   CP area abilities can reach bases. Earlier legal Cleave/Strike probes swung
   Phase 3 by killing cheap exposed units; larger combinations killed bishops.
   King immunity does not change this. Formation, Fortress, earlier denial and
   objective leads provide counterplay, but the connection between remote bench
   losses and the final result may surprise players.
2. **Late CP still has limited outlets.** In quiet games the earlier economy
   produced more CP than remaining finite uses could consume. Contested games
   were far less wealthy. The rule change affects neither incomes nor costs;
   it is not evidence that the surplus is solved. UP also has strong veteran
   retirement payouts, while deployment/actions constrain how useful it is.
3. **Many units compete for few actions.** Independent base/reserve/battlefield
   budgets create sequencing choices, but also leave much of a large army idle.
   This can support careful positioning or feel restrictive. The UI should make
   spent actors, available category actions and valid targets easy to understand.
4. **The final postmatch offers a narrow rescue window.** Phase 3 healing restores
   veteran kings and normal attacks are unavailable. Ability kills can overturn
   a pending result in principle; the earlier damage probes made a comeback
   against a healthy king unlikely. Do not imply every losing position is
   recoverable simply because the postmatch remains playable.
5. **The CPU is not a balance oracle.** The earlier shipped CPU comparisons and
   limited search exposed tactical weaknesses. Stronger search, better candidate
   coverage and adversarial scenario tests would improve the analysis more than
   simply generating more games with the same blind spots. Fresh verification
   also exposed an intermittent CPU retreat assertion: the complete backend
   suite passed on rerun, but an isolated four-run check passed three times and
   failed once. This quality/timing concern remains open; a passing retry does
   not resolve it.

## Enjoyment and dominant strategies

The likely appeal is combined-arms tactics: objectives, range, action order,
unit identity, counters and timed abilities interact. The likely friction is
understanding those interactions, especially reserve/base effects, attrition,
control and why an apparently rich player cannot take another action.

I have no evidence of a universal automatic winning opening. The earlier fixed
scripts failed against responsive opponents; that cannot prove no exploit exists.
Nor does removing king Cast establish a new balanced metagame. My next evaluation
priority would be paired human games and targeted adversarial tests of remote VP
bursts, defensive stalling and resource saturation under this exact preset.
No further mechanics or balance values were changed on my judgment.

## Can this assistant become an expert?

Yes, practical domain expertise can improve through an accurate rules/playbook
file, annotated replays, corrected position analyses and repeatable tactical
benchmarks connected to the real engine. Keep held-out positions and paired-seat
opponents to check whether advice improves; do not grade expertise by confidence
or the number of games run. Read current match config so balance edits are visible.

That is persistent project knowledge and evaluated tool-assisted reasoning, not
an in-chat update to this assistant's model weights. Training a separate playable
agent is another project. Search and self-play evaluation are useful before
considering model fine-tuning; neither training nor a large simulation count alone
guarantees expert play after arbitrary rules changes.

OpenAI documents [skills evaluated with recorded outcomes](https://developers.openai.com/blog/eval-skills)
and [supervised fine-tuning as a separate training workflow](https://developers.openai.com/api/docs/guides/supervised-fine-tuning).
No model training, new AI opponent, cloud purchase or gameplay-expertise benchmark
was implemented in this task.
