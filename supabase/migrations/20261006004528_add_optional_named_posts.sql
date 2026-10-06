-- Posts remain anonymous by default, but authors can opt to show the display
-- name and avatar from their current Google profile. author_id remains hidden
-- from the Data API in both cases.

alter table public.posts
  add column author_name text,
  add column author_avatar_url text,
  add column is_anonymous boolean not null default true;

-- Every historical post was created under the anonymous-only product, so keep
-- that identity exactly as it was.
update public.posts
set author_name = '匿名成员',
    author_avatar_url = null;

alter table public.posts
  alter column author_name set default left(
    coalesce(
      nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
      nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'name'), ''),
      'Google 用户'
    ),
    80
  ),
  alter column author_name set not null,
  alter column author_avatar_url set default left(
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'avatar_url'), ''),
    2048
  ),
  add constraint posts_author_name_length
    check (char_length(author_name) between 1 and 80),
  add constraint posts_avatar_url_length
    check (author_avatar_url is null or char_length(author_avatar_url) <= 2048);

grant select (author_name, author_avatar_url, is_anonymous)
on table public.posts to authenticated;
grant insert (is_anonymous)
on table public.posts to authenticated;

-- Anonymous posts must not retain display identity even if a future client
-- accidentally sends it. The private author_id is kept for moderation and
-- ownership checks, but authenticated clients still cannot select it.
create or replace function public.strip_anonymous_post_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_anonymous then
    new.author_name := '匿名成员';
    new.author_avatar_url := null;
  end if;
  return new;
end;
$$;

revoke all on function public.strip_anonymous_post_identity()
from public, anon, authenticated;

create trigger posts_strip_anonymous_identity
before insert on public.posts
for each row
execute function public.strip_anonymous_post_identity();

alter policy "Google members can create anonymous posts"
on public.posts
rename to "Google members can create posts";

-- A post's attribution choice is fixed at publication time. Continue to allow
-- authors to edit only title/body, and leave upvote_count available to the
-- internal vote sync trigger fixed in the preceding migration.
create or replace function public.protect_post_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.title is distinct from old.title or new.body is distinct from old.body then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;

  new.id := old.id;
  new.author_id := old.author_id;
  new.author_name := old.author_name;
  new.author_avatar_url := old.author_avatar_url;
  new.is_anonymous := old.is_anonymous;
  new.created_at := old.created_at;
  return new;
end;
$$;

revoke all on function public.protect_post_update()
from public, anon, authenticated;

comment on column public.posts.is_anonymous is
  'True by default. When false, author_name and author_avatar_url snapshot the Google display identity at publication time.';
comment on table public.posts is
  'Discussion posts. author_id is always private; display identity is exposed only when the author opts out of anonymity.';
