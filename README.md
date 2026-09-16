# Situational Awareness — discussion MMMVP

The smallest launchable product is intentionally only this:

1. Sign in with Google.
2. Publish an anonymous text post.
3. Reply with the Google account's display name, or anonymously if the box is checked.

There are no DMs, invitations, profiles, likes, search, categories, notifications, images, realtime updates, or admin UI. Admin moderation happens directly in the Supabase dashboard.

## Local UI demo

The app automatically uses a clearly labelled browser-only demo when Supabase variables are absent.

```bash
npm install
npm run dev
```

Open `http://localhost:5173/?demo=1`. Demo data stays in that browser's `localStorage` and never reaches Supabase.

## Connect Supabase

Use Node 20 or newer and Supabase CLI 2.117.0.

1. Create or choose a Supabase project.
2. Link the repo and apply the committed migration:

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

## Verification

```bash
npm test
npm run build
```

The migration uses both grants and RLS. Unauthenticated users have no table or sequence privileges. Authenticated users must have Google's provider in immutable `app_metadata`. Post `author_id` is retained for moderation but has no client SELECT grant, so it is absent from both the UI and browser-accessible Data API responses.

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
