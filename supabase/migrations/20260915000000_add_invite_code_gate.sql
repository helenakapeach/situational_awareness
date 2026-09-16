-- Invite-code admission gate for the discussion MMMVP.
-- A Google-authenticated user can sign in, but the posts/replies RLS
-- policies below now also require a row in `members` — created only by
-- redeeming a valid, still-active invite code through
-- redeem_invite_code(). invite_codes itself is never exposed to the
-- Data API, so codes cannot be listed or enumerated by clients.

create table public.invite_codes (
  code text primary key,
  created_by uuid references auth.users (id) on delete set null,
  is_active boolean not null default true,
  max_uses integer,
  used_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint invite_codes_max_uses_positive check (max_uses is null or max_uses > 0),
  constraint invite_codes_used_count_non_negative check (used_count >= 0)
);

create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  invite_code text not null references public.invite_codes (code),
  joined_at timestamptz not null default now()
);

create index members_invite_code_idx on public.members (invite_code);

alter table public.invite_codes enable row level security;
alter table public.members enable row level security;

-- No direct table access to invite_codes for anon/authenticated: the only
-- way to consume a code is the security-definer function below.
revoke all on table public.invite_codes from anon, authenticated;

revoke all on table public.members from anon, authenticated;
grant select (user_id, joined_at) on table public.members to authenticated;

create policy "Members can read their own membership row"
on public.members
for select
to authenticated
using ((select auth.uid()) = user_id);

-- Known gap, acceptable for this MVP slice: redeem_invite_code() has no
-- rate limiting, so a bad actor could hammer it to brute-force a short
-- code. Not in scope to fix here.
create or replace function public.redeem_invite_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_code text := btrim(p_code);
  v_row public.invite_codes%rowtype;
begin
  if v_user_id is null then
    return false;
  end if;

  -- Already a member: treat re-submission as a harmless success.
  if exists (select 1 from public.members where user_id = v_user_id) then
    return true;
  end if;

  if v_code = '' then
    return false;
  end if;

  select * into v_row
  from public.invite_codes
  where code = v_code
  for update;

  if not found or not v_row.is_active then
    return false;
  end if;

  if v_row.max_uses is not null and v_row.used_count >= v_row.max_uses then
    return false;
  end if;

  update public.invite_codes
  set used_count = used_count + 1
  where code = v_code;

  insert into public.members (user_id, invite_code)
  values (v_user_id, v_code);

  return true;
end;
$$;

revoke all on function public.redeem_invite_code(text) from public;
grant execute on function public.redeem_invite_code(text) to authenticated;

-- Tighten the existing discussion-board policies: Google auth is still
-- required, and now a redeemed invite code (membership) is too.
drop policy "Google members can read posts" on public.posts;
create policy "Google members can read posts"
on public.posts
for select
to authenticated
using (
  (select auth.uid()) is not null
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

drop policy "Google members can create anonymous posts" on public.posts;
create policy "Google members can create anonymous posts"
on public.posts
for insert
to authenticated
with check (
  (select auth.uid()) = author_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

drop policy "Google members can read replies" on public.replies;
create policy "Google members can read replies"
on public.replies
for select
to authenticated
using (
  (select auth.uid()) is not null
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

drop policy "Google members can create named replies" on public.replies;
create policy "Google members can create named replies"
on public.replies
for insert
to authenticated
with check (
  (select auth.uid()) = author_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

comment on table public.invite_codes is
  'Invite codes gating access to the discussion board. Never exposed to the Data API directly — only through redeem_invite_code().';
comment on table public.members is
  'Users who have redeemed a valid invite code. Presence in this table is the admission gate checked by posts/replies RLS.';
comment on function public.redeem_invite_code(text) is
  'Atomically validates and consumes an invite code, then admits the caller into members. No rate limiting yet (known gap for this MVP slice).';
