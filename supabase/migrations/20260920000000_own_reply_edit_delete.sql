-- Authors can edit the body of their own replies, or delete them.
-- author_id stays unreadable from the Data API; the client only gets a
-- boolean computed field so the UI can show 编辑 / 删除 without leaking
-- who wrote anyone else's reply (including the author's own anonymous ones
-- to other people).

alter table public.replies
  add column updated_at timestamptz;

comment on column public.replies.updated_at is
  'Set when body changes. Null means the reply has never been edited.';

grant select (updated_at) on table public.replies to authenticated;
grant update (body) on table public.replies to authenticated;
grant delete on table public.replies to authenticated;

-- Freeze identity, votes and timestamps on update so a wider UPDATE grant
-- later cannot rewrite who wrote the reply or inflate upvote_count.
create or replace function public.protect_reply_update()
returns trigger
language plpgsql
as $$
begin
  if new.body is distinct from old.body then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;

  new.id := old.id;
  new.post_id := old.post_id;
  new.author_id := old.author_id;
  new.author_name := old.author_name;
  new.author_avatar_url := old.author_avatar_url;
  new.is_anonymous := old.is_anonymous;
  new.upvote_count := old.upvote_count;
  new.created_at := old.created_at;
  return new;
end;
$$;

revoke all on function public.protect_reply_update() from public, anon, authenticated;

create trigger replies_protect_update
before update on public.replies
for each row
execute function public.protect_reply_update();

create policy "Google members can update own replies"
on public.replies
for update
to authenticated
using (
  (select auth.uid()) = author_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
)
with check (
  (select auth.uid()) = author_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

create policy "Google members can delete own replies"
on public.replies
for delete
to authenticated
using (
  (select auth.uid()) = author_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
  and exists (select 1 from public.members where user_id = (select auth.uid()))
);

-- Scalar computed field for PostgREST: select is_mine:reply_is_mine.
-- SECURITY DEFINER so the comparison can read author_id, which has no
-- client SELECT grant. The function returns only a boolean.
create or replace function public.reply_is_mine(r public.replies)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select r.author_id = (select auth.uid());
$$;

revoke all on function public.reply_is_mine(public.replies) from public, anon;
grant execute on function public.reply_is_mine(public.replies) to authenticated;

comment on function public.reply_is_mine(public.replies) is
  'True when the caller wrote this reply. Does not expose author_id.';
