# Situational Awareness — discussion MMMVP

The smallest launchable product is intentionally only this:

1. Sign in with Google.
2. Redeem an invite code once, the first time.
3. Publish an anonymous text post.
4. Reply with the Google account's display name, or anonymously if the box is checked.
5. Upvote a reply; replies in a thread sort by vote count.

There are no DMs, profiles, search, categories, notifications, images, realtime updates, or admin UI. Admin moderation, including creating invite codes, happens directly in the Supabase dashboard. Logged-in members can send a short feedback note from the top bar.

## Local UI demo

The app automatically uses a clearly labelled browser-only demo when Supabase variables are absent.

```bash
npm install
npm run dev
```

Open `http://localhost:5173/?demo=1`. Demo data stays in that browser's `localStorage` and never reaches Supabase. The demo invite code is `DEMO2026`. Replies can be upvoted; the thread reorders by vote count, then by time.

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

### Creating an invite code

There is no admin UI yet. In the Supabase SQL editor, run:

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

The migrations use both grants and RLS. Unauthenticated users have no table or sequence privileges. Authenticated users must have Google's provider in immutable `app_metadata` **and** a row in `members`, created only by redeeming a valid, still-active invite code through the `redeem_invite_code()` function. `invite_codes` itself has no client grants at all, so codes can't be listed or enumerated through the Data API. Post `author_id` is retained for moderation but has no client SELECT grant, so it is absent from both the UI and browser-accessible Data API responses. Feedback is insert-only; read it in the SQL editor with `select f.created_at, u.email, f.body from public.feedback f join auth.users u on u.id = f.author_id order by f.created_at desc`.

## Publish with GitHub Pages

The committed workflow tests, builds, and publishes `dist` whenever `main` changes.

1. In the repository, open **Settings → Pages** and select **GitHub Actions** as the source.
2. Open **Settings → Secrets and variables → Actions → Variables** and add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
3. Merge the implementation branch into `main`, or run the workflow manually.

The expected production URL is `https://helenakapeach.github.io/situational_awareness/`. If the two repository variables are missing, the deployed site intentionally opens in browser-only demo mode instead of contacting a backend.

## Production redirect checklist

For GitHub Pages, add `https://helenakapeach.github.io` as an authorized JavaScript origin in Google Auth Platform and add `https://helenakapeach.github.io/situational_awareness/` to Supabase's redirect allow list. The Google callback URI remains the Supabase `/auth/v1/callback` URL.
