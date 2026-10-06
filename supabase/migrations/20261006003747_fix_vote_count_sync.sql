-- Both edit-protection triggers were restoring upvote_count to its old
-- value. That unintentionally cancelled the counter updates made by the vote
-- sync triggers, so vote rows persisted while every displayed count stayed 0.
--
-- Keep immutable identity/timestamp fields protected here. upvote_count is
-- still protected from clients by column-level privileges: authenticated only
-- has UPDATE(title, body) on posts and UPDATE(body) on replies. The internal
-- SECURITY DEFINER sync triggers can therefore update the counter normally.

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
  new.created_at := old.created_at;
  return new;
end;
$$;

create or replace function public.protect_reply_update()
returns trigger
language plpgsql
set search_path = public
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
  new.created_at := old.created_at;
  return new;
end;
$$;

-- Reassert the least-privilege boundary this fix relies on.
revoke update (upvote_count) on table public.posts from anon, authenticated;
revoke update (upvote_count) on table public.replies from anon, authenticated;

-- Repair counters for votes that were already saved while the protection
-- triggers were swallowing counter changes.
update public.posts p
set upvote_count = (
  select count(*)::integer
  from public.post_votes v
  where v.post_id = p.id
)
where p.upvote_count is distinct from (
  select count(*)::integer
  from public.post_votes v
  where v.post_id = p.id
);

update public.replies r
set upvote_count = (
  select count(*)::integer
  from public.reply_votes v
  where v.reply_id = r.id
)
where r.upvote_count is distinct from (
  select count(*)::integer
  from public.reply_votes v
  where v.reply_id = r.id
);
