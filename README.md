# Situational Awareness — discussion MMMVP

The smallest launchable product is intentionally only this:

1. Sign in with Google.
2. Redeem an invite code once, the first time.
3. Publish a text post — anonymous by default, or under your profile name if you uncheck 匿名发帖. You can edit or delete your own posts afterwards.
4. Reply under your profile name, or anonymously if the box is checked. Replies can answer a specific earlier reply (one level of indent with a short 回复 mention). A reply by the post's author gets a 楼主 mark only when it has the same anonymity as the post, so an anonymous follow-up stays anonymous and a named reply on an anonymous post is not linked back. You can edit or delete your own replies afterwards. Unsent reply and edit drafts are kept in this browser until you send them or sign out.
5. Upvote a post as a good question, and upvote a reply; top-level replies sort by vote count, conversations under them read oldest to newest. The 赞过 tab lists what you've liked.

Anonymous posts and replies show a per-item animal name and avatar, kept distinct within a thread so two anonymous people never look like one; they never link to a profile.

Members also have a profile, edited in the 我 panel: avatar, nickname, tagline, bio, a self-reported role (领航执委会 / 领航导师 / 领航学员 + cohort and graduation year / 其他成员), and LinkedIn / email / WeChat, each private unless switched on. Clicking a name on named content opens a read-only profile card. Each discussion has its own URL (`?post=ID`); the share icon copies title + link, and the link survives the Google sign-in round-trip.

The bell in the top bar counts new replies on discussions you posted in or replied to. It's computed in the browser from the loaded feed and a per-user "last seen" timestamp in `localStorage` — there is no notifications table, no email, and it doesn't sync across devices.

Admins (see below) get a section in 我 to list members, disable or re-enable accounts, mark roles as verified, and delete any post or reply. Invite codes are still created only in SQL. There are no DMs, categories, images, realtime updates, or email. Logged-in members can send a short feedback note from the top bar, search every post by title or body from the top-bar search box (`search_posts()`, newest 50 matches), and switch between light and dark. The 我 panel also lists your own posts and replies, anonymous ones included, through `my_content()`; nobody else can see that list.

## Local UI demo

The app automatically uses a clearly labelled browser-only demo when Supabase variables are absent.

```bash
npm install
npm run dev
```

Open `http://localhost:5173/?demo=1`. Demo data stays in that browser's `localStorage` and never reaches Supabase. The demo invite code is `DEMO2026`. Posts can be marked 好问题; replies can be upvoted, and the thread reorders by vote count, then by time. The seeded reply from the demo user can be edited or deleted, and the 我 panel edits a demo profile. Demo users are never admins, so the moderation section can't be previewed there.

## Connect Supabase

Use Node 20 or newer and Supabase CLI 2.117.0.

1. Create or choose a Supabase project.
2. Link the repo and apply the committed migrations:

   ```bash
   npx supabase@2.117.0 link --project-ref YOUR_PROJECT_REF
   npx supabase@2.117.0 db push
   ```

3. In Supabase Authentication, enable Google and disable email signups.
4. In Google Auth Platform, create a **Web application** OAuth client. Add:
   - Authorized JavaScript origin: `http://localhost:5173`
   - Authorized redirect URI: `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
5. In Supabase Authentication URL Configuration, use `http://localhost:5173` as the Site URL while testing and add the final deployed URL to Redirect URLs.
6. Copy `.env.example` to `.env` and add the project URL plus **publishable** key. Never put a secret or `service_role` key in a `VITE_` variable.
7. Restart `npm run dev` and use the Google button.

### Making someone an admin

There's no UI for granting admin. After the person has signed in and redeemed a code, run in the SQL editor:

```sql
update public.members set is_admin = true
where user_id = (select id from auth.users where email = 'admin@example.com');
```

Admins can't be disabled from the moderation UI; to revoke, set `is_admin = false` the same way.

### Creating an invite code

The admin section doesn't manage invite codes. In the Supabase SQL editor, run:

```sql
insert into public.invite_codes (code) values ('YOUR-CODE');
-- optional: cap how many people can redeem it
-- insert into public.invite_codes (code, max_uses) values ('YOUR-CODE', 50);
```

Both the client and `redeem_invite_code()` upper-case whatever is typed before checking it, and `invite_codes.code` has a check constraint requiring upper case, so a lower/mixed-case insert is rejected outright rather than silently never matching.

To check how a code is doing or shut one off, still in the Supabase SQL editor:

```sql
-- See remaining uses (null max_uses means unlimited)
select code, is_active, used_count, max_uses from public.invite_codes;

-- Stop a code from being redeemed further, without deleting its history
update public.invite_codes set is_active = false where code = 'YOUR-CODE';
```

There's no bulk/random generator built in — each code is a literal string you choose and insert by hand.

## Verification

```bash
npm test
npm run build
```

The migrations use both grants and RLS. Unauthenticated users have no table or sequence privileges. Authenticated users must have Google's provider in immutable `app_metadata` **and** a row in `members`, created only by redeeming a valid, still-active invite code through the `redeem_invite_code()` function. `invite_codes` itself has no client grants at all, so codes can't be listed or enumerated through the Data API. Post and reply `author_id` are retained for moderation but have no client SELECT grant, so they are absent from both the UI and browser-accessible Data API responses. The client learns which loaded items are the caller's own through the `own_content_ids()` RPC, which returns only IDs, so authors can edit or delete their own content (including anonymous content) without anyone else seeing who wrote it. Post deletion runs as `delete_own_post()` so cascading replies and votes are not blocked by those tables' RLS. A member with `is_disabled = true` fails a restrictive RLS policy on every content table immediately, without waiting for their session to expire.

Profiles have no direct table grants: members read their own through `get_own_profile()`, write through `update_own_profile()`, and read others through `get_profile(public_id)`, which returns only contact fields the owner switched on. Profiles are addressed by a random `public_id`, never the user ID. Named content stores the author's `public_id`, name, avatar and role, refreshed by trigger when the profile changes; on anonymous content a trigger forces all of those to null. Avatars live in the public `avatars` Storage bucket (created by the migration) under random file names. Feedback is insert-only; read it in the SQL editor with `select f.created_at, u.email, f.body from public.feedback f join auth.users u on u.id = f.author_id order by f.created_at desc`.

## Publish with GitHub Pages

Hand this to whoever is shipping: **[DEPLOY.md](./DEPLOY.md)** (Chinese). Ordered checklist: create the Supabase project, `db push`, Google OAuth, Pages variables, invite code, and later releases.

Pages builds from `main` via `.github/workflows/deploy-pages.yml`. It does **not** run SQL. If `supabase/migrations/` gained a file, run `npx supabase@2.117.0 db push` **before** (or immediately as) you push `main`. Reverse that and the feed can fail until the database catches up.

Production URL: https://helenakapeach.github.io/situational_awareness/. If `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are missing from the repo's Actions **Variables**, the live site stays in browser-only demo mode.

## Python / MongoDB backend

A parallel uv + FastAPI + Pydantic + MongoDB test stack lives in [`app/`](./app/README.md). Ordinary visits always use Supabase; only `?backend=mongo` selects the sandbox API. Each API startup replaces its disposable Mongo data with a read-only Supabase snapshot. Sandbox actions write only Mongo; Supabase continues to own production data and Google Auth. The existing Pages deployment workflow is unchanged. See the app README for setup and rollout details.
