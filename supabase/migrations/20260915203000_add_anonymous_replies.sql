-- Optional anonymous replies. Named replies still snapshot Google identity
-- from the JWT defaults. Anonymous replies keep author_id for moderation
-- but the trigger below replaces the display name and avatar so the Data
-- API cannot leak who wrote them.

alter table public.replies
  add column is_anonymous boolean not null default false;

comment on column public.replies.is_anonymous is
  'When true, display identity is stripped before insert. author_id stays for moderation and has no client SELECT grant.';

grant select (is_anonymous) on table public.replies to authenticated;
grant insert (is_anonymous) on table public.replies to authenticated;

create or replace function public.strip_anonymous_reply_identity()
returns trigger
language plpgsql
as $$
begin
  if new.is_anonymous then
    new.author_name := '匿名成员';
    new.author_avatar_url := null;
  end if;
  return new;
end;
$$;

revoke all on function public.strip_anonymous_reply_identity() from public, anon, authenticated;

create trigger replies_strip_anonymous_identity
before insert on public.replies
for each row
execute function public.strip_anonymous_reply_identity();

comment on table public.replies is
  'Replies. Named replies snapshot Google identity from the JWT; anonymous replies store author_id only for moderation.';
