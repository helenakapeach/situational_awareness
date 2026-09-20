# Project instructions

## Git operations

Routine git operations (init, add, commit, push, pull, branch, checkout, creating/switching branches) do not require asking for confirmation before running — proceed directly.

Destructive operations (force push, `git reset --hard`, `git clean -f`, deleting branches, rewriting published history) still require an explicit ask from the user each time, per standing safety practice — this blanket approval does not cover those.

## Visual design / color system

`design-tokens.css` (and its documentation page `brand-style-sample.html`) is the single source of truth for color in this project, established by Junjie in [PR #1](https://github.com/helenakapeach/situational_awareness/pull/1). Do not invent new palettes or one-off hex values in new UI work — read those two files first and reuse the existing tokens (`--bg`, `--surface`, `--border`, `--text*`, `--brand*`, `--insight*`, `--verified*`, and the risk/brick tokens).

Key rules baked into that system, so they don't get silently violated by later changes:
- Only four hues exist outside neutrals: brand (ink navy, the only interactive color), insight/amber (accumulation, "加精"/highlighted content — icons and fills only, never text), verified/jade (confirmed identity — small icon + text only, never a solid block), and brick/red (genuine risk only).
- Unverified status is the default, common state, not an exception — it must NOT be marked with a warning color. Only the verified state gets a (restrained) color treatment.
- ~95% of the UI should stay neutral; reach for a semantic color only when it matches that color's specific meaning above, never for decoration.
