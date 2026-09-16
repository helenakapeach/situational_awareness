-- Reply upvotes: one vote per Google member, togglable.
-- Counts are denormalized onto replies so the feed query stays a simple select.

alter table public.replies
  add column upvote_count integer not null default 0;

alter table public.replies
  add constraint replies_upvote_count_non_negative check (upvote_count >= 0);

create table public.reply_votes (
  reply_id bigint not null references public.replies (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reply_id, user_id)
);

create or replace function public.sync_reply_upvote_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.replies
    set upvote_count = upvote_count + 1
    where id = new.reply_id;
    return new;
  end if;

  update public.replies
  set upvote_count = greatest(upvote_count - 1, 0)
  where id = old.reply_id;
  return old;
end;
$$;

create trigger reply_votes_sync_count
after insert or delete on public.reply_votes
for each row execute function public.sync_reply_upvote_count();

revoke all on function public.sync_reply_upvote_count() from public, anon, authenticated;

alter table public.reply_votes enable row level security;

revoke all on table public.reply_votes from anon, authenticated;

grant select (upvote_count) on table public.replies to authenticated;
grant select (reply_id) on table public.reply_votes to authenticated;
grant insert (reply_id) on table public.reply_votes to authenticated;
grant delete on table public.reply_votes to authenticated;

create policy "Google members can read own reply votes"
on public.reply_votes
for select
to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
);

create policy "Google members can vote on replies"
on public.reply_votes
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
);

create policy "Google members can remove own reply votes"
on public.reply_votes
for delete
to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
);

comment on table public.reply_votes is
  'One upvote per user per reply. user_id is hidden from client SELECT grants.';
comment on column public.replies.upvote_count is
  'Maintained by trigger from reply_votes. Clients may read but not write this column.';
