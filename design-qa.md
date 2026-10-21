# Profile WYSIWYG redesign QA

Status: **passed** on branch `codex/profile-wysiwyg`.

## Reference and viewport

- Selected design reference: `/Users/alin7/.codex/generated_images/01a15f64-4965-7b42-a955-5c3fab30d3b7/exec-13dbdf51-0b3c-412c-93fd-bc093546178a.png` (1487 × 1058 px).
- Desktop browser viewport: 1488 × 1058 px.
- Mobile browser viewport: 390 × 844 px.
- QA used the existing Vite app and a browser-local demo profile. No fixtures or shared identity data were changed.

## Final evidence

Screenshots were preserved in `/Users/alin7/.codex/visualizations/2026/10/21/01a15f64-4965-7b42-a955-5c3fab30d3b7/profile-qa/`.

- [Owner profile, desktop](</Users/alin7/.codex/visualizations/2026/10/21/01a15f64-4965-7b42-a955-5c3fab30d3b7/profile-qa/profile-owner-final.png>) — 1473 × 1047 px.
- [Inline editor, desktop](</Users/alin7/.codex/visualizations/2026/10/21/01a15f64-4965-7b42-a955-5c3fab30d3b7/profile-qa/profile-edit-final.png>) — 1473 × 1047 px.
- [Owner profile, mobile](</Users/alin7/.codex/visualizations/2026/10/21/01a15f64-4965-7b42-a955-5c3fab30d3b7/profile-qa/profile-mobile-fixed.png>) — 375 × 812 px.
- [Inline editor, mobile](</Users/alin7/.codex/visualizations/2026/10/21/01a15f64-4965-7b42-a955-5c3fab30d3b7/profile-qa/profile-mobile-edit.png>) — 375 × 812 px.

## Comparison and interaction findings

The initial implementation replaced the hero with a long vertical form, omitted private contact rows from the owner view, and showed discussions immediately below the profile. The final version keeps the hero, About section, and contact rows in place while editing, adds local profile/discussion tabs, and shows private contact values and their visibility to the owner. The member preview omits private contacts, discussion content, admin tools, and logout controls.

Follow-up QA caught and fixed an avatar/identity alignment shift between view and edit, an unsaved LinkedIn URL rendered as plain text, and a mobile hero edit action that narrowed the tagline. The final mobile layout uses matching avatar columns in both states and puts the owner edit action on its own row. Draft preview is explicitly marked unsaved.

Final checks covered draft preview and return-to-edit retention, cancel restoring saved content, save success, private WeChat and owner-only content filtering in preview, discussion-tab behavior, and LinkedIn link rendering. Desktop and mobile layouts were inspected in light and dark themes. Existing typography, warm theme tokens, and app icons were retained; the demo profile's initials avatar was kept instead of introducing a fabricated photo. Browser error logs were empty.

No P0, P1, or P2 UI findings remain. The browser pass used the demo backend; live authentication, avatar upload/reset, and admin actions were not exercised. No backend API, endpoint, table, or query was added or changed.

## Validation

- `npm run build` — passed.
- `npm test` — passed, 61 tests.
