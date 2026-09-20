-- Authors can edit title/body of their own posts, or delete them.
-- author_id stays unreadable from the Data API; the client only gets a
-- boolean computed field so the UI can show 编辑 / 删除 without leaking
-- who wrote an anonymous post.
--
-- Delete goes through a SECURITY DEFINER function so ON DELETE CASCADE
-- can remove other people's replies and votes. A client DELETE would be
-- blocked by those tables' "own row only" RLS policies.

alter table public.posts
  add column updated_at timestamptz;

comment on column public.posts.updated_at is
  'Set when title or body changes. Null means the post has never been edited.';

grant select (updated_at) on table public.posts to authenticated;
grant update (title, body) on table public.posts to authenticated;

create or replace function public.protect_post_update()
returns trigger
language plpgsql
as $$
begin
  if new.title is distinct from old.title or new.body is distinct from old.body then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;

  new.id := old.id;
  new.author_id := old.author_id;
  new.upvote_count := old.upvote_count;
  new.created_at := old.created_at;
  return new;
end;
$$;

revoke all on function public.protect_post_update() from public, anon, authenticated;

create trigger posts_protect_update
before update on public.posts
for each row
execute function public.protect_post_update();

create policy "Google members can update own posts"
on public.posts
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

create or replace function public.delete_own_post(p_post_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_id bigint;
begin
  if coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') <> 'google'
     or not exists (select 1 from public.members where user_id = (select auth.uid())) then
    raise exception '这条讨论已经不存在，或不是你的。';
  end if;

  delete from public.posts
  where id = p_post_id
    and author_id = (select auth.uid())
  returning id into deleted_id;

  if deleted_id is null then
    raise exception '这条讨论已经不存在，或不是你的。';
  end if;
end;
$$;

revoke all on function public.delete_own_post(bigint) from public, anon;
grant execute on function public.delete_own_post(bigint) to authenticated;

comment on function public.delete_own_post(bigint) is
  'Deletes the caller''s own post. Runs as definer so cascading replies and votes are not blocked by their RLS policies.';

create or replace function public.post_is_mine(p public.posts)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p.author_id = (select auth.uid());
$$;

revoke all on function public.post_is_mine(public.posts) from public, anon;
grant execute on function public.post_is_mine(public.posts) to authenticated;

comment on function public.post_is_mine(public.posts) is
  'True when the caller wrote this post. Does not expose author_id.';
