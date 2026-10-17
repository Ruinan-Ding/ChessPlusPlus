# Claude plugin support

Keep `/scrum` as the single SAFe/vibe→SDD→BDD→TDD process. Plugins support a
specific step; the human retains product, investment and publication authority.
Read only the relevant section. The existing nine profiles remain the delivery team.

## Installed project capabilities

| Plugin ID | Default | Use |
|---|---|---|
| `ponytail@ponytail` | Enabled | Existing full-mode simplicity guidance for code/design; disclose unavailable native invocation. |
| `ralph-loop@claude-plugins-official` | Enabled, no active loop | Explicitly requested bounded iteration on one testable contract. |
| `frontend-design@claude-plugins-official` | Enabled | New/redesigned game UI within accepted behavior, readability, accessibility and layout rules. |
| `typescript-lsp@claude-plugins-official` | Enabled | Targeted client symbol/reference/diagnostic lookup; requires TypeScript language server and TypeScript. |
| `pyright-lsp@claude-plugins-official` | Enabled | Targeted Python lookup/diagnostics; requires `pyright-langserver`. Keep server interpreter/contracts aligned with the installed runtime. |
| `security-guidance@claude-plugins-official` | Enabled, pattern warnings | Local edit reminders. Project env keeps `ENABLE_CODE_SECURITY_REVIEW=0`, `ENABLE_PATTERN_RULES=1`; automatic model Stop/commit reviews stay off. |
| `pr-review-toolkit@claude-plugins-official` | Installed, disabled | Focused independent review/simplification; six descriptions otherwise add context. |
| `playwright@claude-plugins-official` | Installed, disabled | Browser interaction/screenshots when documented tooling needs support; native Windows Chrome, task-owned browser/server. |
| `context7@claude-plugins-official` | Installed, disabled | Package/version-specific documentation lookup; connection/authentication is separate. |
| `commit-commands@claude-plugins-official` | Installed, disabled | Retained publication helper; shipped commands use `git` directly, so follow this repo's `git.exe` procedure for authorized publication. |
| `hookify@claude-plugins-official` | Installed, disabled | Explicitly requested local rules, with working `python3` in the host. No rules were created or enabled. |
| `linear@claude-plugins-official` | Installed, disabled | Optional SAFe/backlog integration only after account connection and an actual need. No account or write operation is configured. |

The toolkit already includes a simplifier; avoid duplicate review/feature/spec
orchestrators. Language diagnostics do not replace behavioral tests, engine parity,
real sockets, replay compatibility or rendered layout checks. Preserve owner
ports 4200/8000, database and services. Local Django commands retain DJANGO_DEBUG=true.
Game/config changes use config-sync and actual owner rules.

## Select support

Routine work uses the existing quality capability within runtime delegation policy.
For a focused optional capability, enable its table ID locally from the repo shell:

```text
claude plugin enable <plugin-id> --scope local
```

Replace the placeholder with the actual ID, then `/reload-plugins` in the active
Claude session or start a fresh session. Keep only the needed capability enabled.
For review use `/pr-review-toolkit:review-pr tests`, `errors`, `types`, `comments`,
`code` or `simplify` for the actual concern; avoid default `all` and parallel fan-out.
Supply IDs, changed/new files, ownership and raw evidence, not the whole transcript.
Plugin model/agent defaults obey runtime policy. Keep one writer per file and rerun
affected checks after simplification. Disclose unavailable independent review.

Prefer existing CLI/browser checks; reserve Playwright MCP for interaction that
justifies its context cost. Preserve the full documented layout sweep and real
socket/replay checks when required. First activation may download helper/browser
dependencies. The Context7 readiness probe returned authentication-required (401);
use Claude's `/mcp` sign-in after local enablement. Queries name the package/version
and one topic. Linear
connection alone does not authorize issue creation, team messages or status writes.
Hookify must preserve accepted owner constraints; don't add speculative rules.
Optional support must not stall useful work: fall back to documented tools and
report a missing connection/capability. Disable locally afterward and reload:

```text
claude plugin disable <plugin-id> --scope local
```

## Bounded Ralph

Installation starts no loop. Ordinary requests, vague goals, PI planning and
`resume` use Scrum intake. Start Ralph only for owner-requested iterative execution
with observable acceptance and checks in one canonical contract. Resolve material
product questions first; continue safe independent work meanwhile.

Every invocation includes a positive `--max-iterations`: workflow default 4 when no
limit is supplied; honor a smaller limit and record an explicitly requested larger
one. Use the same contract and one truthful completion promise, not copied process
history. Example (replace the path with the actual contract):

```text
/ralph-loop:ralph-loop "Work only on specs/STORY-example.md under /scrum. Follow its acceptance and required checks. Update its evidence. Cancel on blocked decisions, repeated failure without progress, or user stop. Emit <promise>STORY_DONE</promise> only when acceptance and required checks pass. No publication." --max-iterations 4 --completion-promise "STORY_DONE"
```

Each iteration reads continuation/delta, runs relevant checks and keeps full logs
outside source. No nested loops, repeated planning or reopening completed scope.
Cancel through `/ralph-loop:cancel-ralph` on blocked decisions, exhausted budget,
repeated non-progress or user stop; record the gap without a false success promise.
The cap limits iterations, not tokens. Do not overwrite/cancel another session's
loop. Local loop state/rules are ignored by Git; upstream's raw default is unlimited.

## Install or recover

Tracked settings record marketplace sources and defaults; each Windows/WSL Claude
profile still needs its own installation. From this repo, use the native `claude`
(or `claude.exe` when administering Windows from WSL). For each relevant table ID:

```text
claude plugin install <plugin-id> --scope project
claude plugin disable <optional-plugin-id> --scope project
claude plugin list
```

Install enables plugins: restore the table's optional defaults afterward. If a
marketplace is missing, use `claude plugin marketplace add` with
`anthropics/claude-plugins-official` or `DietrichGebert/ponytail`. Keep user/local
overrides; inspect precedence when troubleshooting. Install helper binaries in
user tooling rather than product dependencies. The shared setup uses TypeScript
language server 5.3.0 for Node 20+ compatibility and Pyright 1.1.414; reuse installed
TypeScript. Ralph needs Bash, jq and Perl. Windows uses Git Bash and jq on PATH;
its shell path belongs in Windows user settings, not shared Linux settings.
Security needs Python and may bootstrap its helper environment despite disabled
model review. Hookify's native Windows hooks require working `python3`, which is
separate from security's interpreter shim. Don't patch cached plugins for policy.

Use `claude plugin details <id>` for projected context cost, `/context` for the
current session and actual usage/billing for savings. Inventory/fixture checks
prove installation/helper behavior; optional MCP connectivity, enabled Hookify
rules, automatic routing and billed savings need separate evidence.

Sources: [plugin scopes/cost](https://code.claude.com/docs/en/discover-plugins),
[Ralph](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop),
[security](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance),
[Windows](https://code.claude.com/docs/en/setup),
[Playwright](https://github.com/microsoft/playwright-mcp),
[Context7](https://github.com/upstash/context7). Installed sources were inspected
17 Oct 2026; verify changed versions before relying on their behavior.
