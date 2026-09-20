-- Post upvotes: "this is a good question." One vote per Google member, togglable.
-- Counts are denormalized onto posts so the feed query stays a simple select.
-- author_id stays unreadable; voting your own anonymous post cannot leak identity.

alter table public.posts
  add column upvote_count integer not null default 0;

alter table public.posts
  add constraint posts_upvote_count_non_negative check (upvote_count >= 0);

create table public.post_votes (
  post_id bigint not null references public.posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create or replace function public.sync_post_upvote_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts
    set upvote_count = upvote_count + 1
    where id = new.post_id;
    return new;
  end if;

  update public.posts
  set upvote_count = greatest(upvote_count - 1, 0)
  where id = old.post_id;
  return old;
end;
$$;

create trigger post_votes_sync_count
after insert or delete on public.post_votes
for each row execute function public.sync_post_upvote_count();

revoke all on function public.sync_post_upvote_count() from public, anon, authenticated;

alter table public.post_votes enable row level security;

revoke all on table public.post_votes from anon, authenticated;

grant select (upvote_count) on table public.posts to authenticated;
grant select (post_id) on table public.post_votes to authenticated;
grant insert (post_id) on table public.post_votes to authenticated;
grant delete on table public.post_votes to authenticated;

create policy "Google members can read own post votes"
on public.post_votes
for select
to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

create policy "Google members can vote on posts"
on public.post_votes
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

create policy "Google members can remove own post votes"
on public.post_votes
for delete
to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

create or replace function public.toggle_post_vote(p_post_id bigint)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  removed boolean;
begin
  delete from public.post_votes
  where post_id = p_post_id and user_id = auth.uid()
  returning true into removed;

  if removed then
    return false;
  end if;

  insert into public.post_votes (post_id, user_id)
  values (p_post_id, auth.uid())
  on conflict (post_id, user_id) do nothing;

  return true;
end;
$$;

revoke all on function public.toggle_post_vote(bigint) from public, anon;
grant execute on function public.toggle_post_vote(bigint) to authenticated;

comment on table public.post_votes is
  'One upvote per user per post, meaning the question is worth answering. user_id is hidden from client SELECT grants.';
comment on column public.posts.upvote_count is
  'Maintained by trigger from post_votes. Clients may read but not write this column.';
comment on function public.toggle_post_vote(bigint) is
  'Toggles the caller''s vote on a post in one round trip. Runs as invoker so the existing post_votes RLS policies still apply.';
