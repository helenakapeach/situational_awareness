-- The toggle RPCs run as the caller, filter by user_id, and insert auth.uid()
-- explicitly. Grant only the missing column privileges. RLS still limits
-- reads to the caller's rows and enforces user_id = auth.uid() on inserts, so
-- callers cannot see other voters or vote as anyone else.
grant select (user_id) on table public.post_votes to authenticated;
grant select (user_id) on table public.reply_votes to authenticated;
grant insert (user_id) on table public.post_votes to authenticated;
grant insert (user_id) on table public.reply_votes to authenticated;

-- Reply voting should use the same member gate as posts, replies, and post
-- votes. Google authentication alone is not enough to participate.
alter policy "Google members can read own reply votes"
on public.reply_votes
to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (
    select 1
    from public.members
    where user_id = (select auth.uid())
  )
);

alter policy "Google members can vote on replies"
on public.reply_votes
to authenticated
with check (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (
    select 1
    from public.members
    where user_id = (select auth.uid())
  )
);

alter policy "Google members can remove own reply votes"
on public.reply_votes
to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (
    select 1
    from public.members
    where user_id = (select auth.uid())
  )
);
