-- Member profiles, self-reported roles, and cohort labels.
-- Named posts and replies keep a copy of the display identity so the feed
-- does not join profiles (and therefore cannot see user_id). Updating a
-- profile rewrites that copy. Anonymous rows never receive it.

create table public.cohorts (
  id bigint generated always as identity primary key,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  constraint cohorts_name_trimmed check (
    name = btrim(name)
    and name !~ '[[:cntrl:]]'
    and char_length(name) between 1 and 40
  ),
  constraint cohorts_name_unique unique (name)
);

comment on table public.cohorts is
  'Admin-maintained class list. Members pick from active rows; they cannot invent a name.';

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  public_id uuid not null default gen_random_uuid(),
  display_name text not null,
  tagline text,
  bio text,
  avatar_url text,
  avatar_pending text,
  linkedin_url text,
  linkedin_public boolean not null default false,
  contact_email text,
  email_public boolean not null default false,
  wechat_id text,
  wechat_public boolean not null default false,
  role text,
  cohort_id bigint references public.cohorts (id) on delete restrict,
  graduation_year smallint,
  role_verified boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint profiles_public_id_unique unique (public_id),
  constraint profiles_display_name_length check (
    display_name = btrim(display_name)
    and display_name !~ '[[:cntrl:]]'
    and char_length(display_name) between 1 and 30
  ),
  constraint profiles_tagline_length check (
    tagline is null
    or (
      tagline = btrim(tagline)
      and tagline !~ '[[:cntrl:]]'
      and char_length(tagline) between 1 and 60
    )
  ),
  constraint profiles_bio_length check (
    bio is null or (bio = btrim(bio) and char_length(bio) between 1 and 500)
  ),
  constraint profiles_avatar_url_shape check (
    avatar_url is null
    or (
      char_length(avatar_url) <= 2048
      and (
        avatar_url ~ '^https://'
        or avatar_url ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
      )
    )
  ),
  constraint profiles_avatar_pending_shape check (
    avatar_pending is null
    or avatar_pending ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
  ),
  constraint profiles_linkedin_url_shape check (
    linkedin_url is null
    or linkedin_url ~ '^https://(www\.)?linkedin\.com/in/[A-Za-z0-9_%-]{3,100}/?$'
  ),
  constraint profiles_contact_email_shape check (
    contact_email is null
    or (
      char_length(contact_email) <= 120
      and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  constraint profiles_wechat_id_shape check (
    wechat_id is null or wechat_id ~ '^[A-Za-z][A-Za-z0-9_-]{5,19}$'
  ),
  constraint profiles_role_shape check (
    role is null or role in ('committee', 'mentor', 'student', 'other')
  ),
  constraint profiles_graduation_year_range check (
    graduation_year is null or graduation_year between 2016 and 2027
  ),
  constraint profiles_graduation_year_only_for_students check (
    role = 'student' or graduation_year is null
  ),
  constraint profiles_cohort_only_for_students check (
    role = 'student' or cohort_id is null
  ),
  constraint profiles_linkedin_public_needs_value check (
    not linkedin_public or linkedin_url is not null
  ),
  constraint profiles_email_public_needs_value check (
    not email_public or contact_email is not null
  ),
  constraint profiles_wechat_public_needs_value check (
    not wechat_public or wechat_id is not null
  )
);

comment on table public.profiles is
  'One row per member. Clients never select this table; public_id is the only id a profile card may use. user_id has no API grant.';
comment on column public.profiles.avatar_url is
  'Either an https Google avatar or a random avatars-bucket object name. Never a user id.';
comment on column public.profiles.avatar_pending is
  'Object name reserved for an in-progress upload. Promoted to avatar_url only after the object exists.';
comment on column public.profiles.role_verified is
  'Set only by an admin. Cleared automatically when the member changes role or cohort.';
comment on column public.profiles.contact_email is
  'A contact address the member typed. It is not the Google login email.';
comment on column public.profiles.graduation_year is
  'Self-reported graduation year for students only, 2016 through 2027. Shown on the profile card, not on anonymous content.';

alter table public.profiles enable row level security;
alter table public.cohorts enable row level security;
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.cohorts from anon, authenticated;
grant select (id, name, sort_order) on table public.cohorts to authenticated;

create policy "Active members can read active cohorts"
on public.cohorts
for select
to authenticated
using (is_active and (select app_private.active_member()));

insert into public.cohorts (name, sort_order)
values
  ('创业', 1),
  ('职业组进阶班', 2),
  ('职业组成长版', 3);

alter table public.posts
  add column author_public_id uuid,
  add column author_role text,
  add column author_cohort_name text,
  add column author_role_verified boolean not null default false;

alter table public.replies
  add column author_public_id uuid,
  add column author_role text,
  add column author_cohort_name text,
  add column author_role_verified boolean not null default false;

alter table public.posts
  add constraint posts_author_role_shape check (
    author_role is null or author_role in ('committee', 'mentor', 'student', 'other')
  ),
  add constraint posts_anonymous_hides_profile check (
    not is_anonymous
    or (
      author_public_id is null
      and author_role is null
      and author_cohort_name is null
      and author_role_verified = false
    )
  );

alter table public.replies
  add constraint replies_author_role_shape check (
    author_role is null or author_role in ('committee', 'mentor', 'student', 'other')
  ),
  add constraint replies_anonymous_hides_profile check (
    not is_anonymous
    or (
      author_public_id is null
      and author_role is null
      and author_cohort_name is null
      and author_role_verified = false
    )
  );

comment on column public.posts.author_public_id is
  'Profile card id copied onto named posts. Forced null while the post is anonymous.';
comment on column public.replies.author_public_id is
  'Profile card id copied onto named replies. Forced null while the reply is anonymous.';

grant select (author_public_id, author_role, author_cohort_name, author_role_verified)
on table public.posts to authenticated;
grant select (author_public_id, author_role, author_cohort_name, author_role_verified)
on table public.replies to authenticated;

-- User edits still cannot rewrite attribution. A profile sync running inside
-- this transaction may, and only via a setting the Data API cannot set.
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
  new.is_anonymous := old.is_anonymous;
  new.created_at := old.created_at;

  if current_setting('app.profile_sync', true) is distinct from 'on' then
    new.author_name := old.author_name;
    new.author_avatar_url := old.author_avatar_url;
    new.author_public_id := old.author_public_id;
    new.author_role := old.author_role;
    new.author_cohort_name := old.author_cohort_name;
    new.author_role_verified := old.author_role_verified;
  end if;

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
  new.is_anonymous := old.is_anonymous;
  new.created_at := old.created_at;

  if current_setting('app.profile_sync', true) is distinct from 'on' then
    new.author_name := old.author_name;
    new.author_avatar_url := old.author_avatar_url;
    new.author_public_id := old.author_public_id;
    new.author_role := old.author_role;
    new.author_cohort_name := old.author_cohort_name;
    new.author_role_verified := old.author_role_verified;
  end if;

  return new;
end;
$$;

-- Stamp the author's current profile onto named rows, and wipe it from
-- anonymous ones, so an insert cannot smuggle a profile id onto an
-- anonymous post or reply.
create or replace function public.apply_author_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_cohort text;
begin
  if new.is_anonymous then
    new.author_name := '匿名成员';
    new.author_avatar_url := null;
    new.author_public_id := null;
    new.author_role := null;
    new.author_cohort_name := null;
    new.author_role_verified := false;
    return new;
  end if;

  select * into v_profile
  from public.profiles
  where user_id = new.author_id;

  if not found then
    raise exception '请先完善个人资料。';
  end if;

  select name into v_cohort
  from public.cohorts
  where id = v_profile.cohort_id;

  new.author_name := v_profile.display_name;
  new.author_avatar_url := v_profile.avatar_url;
  new.author_public_id := v_profile.public_id;
  new.author_role := v_profile.role;
  new.author_cohort_name := v_cohort;
  new.author_role_verified := v_profile.role_verified;
  return new;
end;
$$;

revoke all on function public.apply_author_identity() from public, anon, authenticated;

drop trigger if exists posts_strip_anonymous_identity on public.posts;
drop trigger if exists replies_strip_anonymous_identity on public.replies;
drop function if exists public.strip_anonymous_post_identity();
drop function if exists public.strip_anonymous_reply_identity();

create trigger posts_apply_author_identity
before insert on public.posts
for each row
execute function public.apply_author_identity();

create trigger replies_apply_author_identity
before insert on public.replies
for each row
execute function public.apply_author_identity();

create or replace function app_private.sync_profile_to_content()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cohort text;
begin
  if tg_op = 'UPDATE'
     and new.display_name is not distinct from old.display_name
     and new.avatar_url is not distinct from old.avatar_url
     and new.public_id is not distinct from old.public_id
     and new.role is not distinct from old.role
     and new.cohort_id is not distinct from old.cohort_id
     and new.role_verified is not distinct from old.role_verified then
    return new;
  end if;

  select name into v_cohort from public.cohorts where id = new.cohort_id;
  perform set_config('app.profile_sync', 'on', true);

  update public.posts
  set
    author_name = new.display_name,
    author_avatar_url = new.avatar_url,
    author_public_id = new.public_id,
    author_role = new.role,
    author_cohort_name = v_cohort,
    author_role_verified = new.role_verified
  where author_id = new.user_id
    and is_anonymous = false;

  update public.replies
  set
    author_name = new.display_name,
    author_avatar_url = new.avatar_url,
    author_public_id = new.public_id,
    author_role = new.role,
    author_cohort_name = v_cohort,
    author_role_verified = new.role_verified
  where author_id = new.user_id
    and is_anonymous = false;

  return new;
end;
$$;

revoke all on function app_private.sync_profile_to_content() from public, anon, authenticated;

create trigger profiles_sync_named_content
after insert or update on public.profiles
for each row
execute function app_private.sync_profile_to_content();

create or replace function app_private.sync_cohort_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.name is not distinct from old.name then
    return new;
  end if;

  perform set_config('app.profile_sync', 'on', true);

  update public.posts
  set author_cohort_name = new.name
  where not is_anonymous
    and author_id in (select user_id from public.profiles where cohort_id = new.id);

  update public.replies
  set author_cohort_name = new.name
  where not is_anonymous
    and author_id in (select user_id from public.profiles where cohort_id = new.id);

  return new;
end;
$$;

revoke all on function app_private.sync_cohort_name() from public, anon, authenticated;

create trigger cohorts_sync_name
after update on public.cohorts
for each row
execute function app_private.sync_cohort_name();

create or replace function app_private.ensure_profile(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta jsonb;
  v_name text;
  v_avatar text;
begin
  if p_user_id is null or exists (select 1 from public.profiles where user_id = p_user_id) then
    return;
  end if;

  select raw_user_meta_data into v_meta from auth.users where id = p_user_id;
  v_name := btrim(regexp_replace(left(coalesce(
    nullif(btrim(v_meta ->> 'full_name'), ''),
    nullif(btrim(v_meta ->> 'name'), ''),
    'Google 用户'
  ), 30), '[[:cntrl:]]', '', 'g'));
  if char_length(v_name) = 0 then
    v_name := 'Google 用户';
  end if;

  v_avatar := nullif(btrim(v_meta ->> 'avatar_url'), '');
  if v_avatar is null or v_avatar !~ '^https://' or char_length(v_avatar) > 2048 then
    v_avatar := null;
  end if;

  insert into public.profiles (user_id, display_name, avatar_url)
  values (p_user_id, v_name, v_avatar)
  on conflict (user_id) do nothing;
end;
$$;

revoke all on function app_private.ensure_profile(uuid) from public, anon, authenticated;

-- Backfill existing members. The profiles insert trigger rewrites their
-- named posts and replies, so no separate content update is needed.
select app_private.ensure_profile(user_id) from public.members;

create or replace function app_private.profile_json(p public.profiles, p_include_private boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cohort text;
  v_card jsonb;
begin
  select name into v_cohort from public.cohorts where id = p.cohort_id;

  v_card := jsonb_build_object(
    'public_id', p.public_id,
    'display_name', p.display_name,
    'tagline', p.tagline,
    'bio', p.bio,
    'avatar_url', p.avatar_url,
    'role', p.role,
    'cohort_id', case when p_include_private then p.cohort_id else null end,
    'cohort_name', v_cohort,
    'role_verified', p.role_verified,
    'graduation_year', p.graduation_year,
    'is_self', p.user_id = auth.uid()
  );

  if p_include_private then
    v_card := v_card || jsonb_build_object(
      'linkedin_url', p.linkedin_url,
      'linkedin_public', p.linkedin_public,
      'contact_email', p.contact_email,
      'email_public', p.email_public,
      'wechat_id', p.wechat_id,
      'wechat_public', p.wechat_public
    );
  else
    if p.linkedin_public and p.linkedin_url is not null then
      v_card := v_card || jsonb_build_object('linkedin_url', p.linkedin_url);
    end if;
    if p.email_public and p.contact_email is not null then
      v_card := v_card || jsonb_build_object('contact_email', p.contact_email);
    end if;
    if p.wechat_public and p.wechat_id is not null then
      v_card := v_card || jsonb_build_object('wechat_id', p.wechat_id);
    end if;
  end if;

  return v_card;
end;
$$;

revoke all on function app_private.profile_json(public.profiles, boolean) from public, anon, authenticated;

create or replace function app_private.get_own_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if not app_private.active_member() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where user_id = auth.uid();
  if not found then
    raise exception '请先完善个人资料。';
  end if;

  return app_private.profile_json(v_profile, true);
end;
$$;

create or replace function public.get_own_profile()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select app_private.get_own_profile();
$$;

create or replace function app_private.get_profile(p_public_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if not app_private.active_member() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if p_public_id is null then
    return null;
  end if;

  select p.* into v_profile
  from public.profiles p
  join public.members m on m.user_id = p.user_id
  where p.public_id = p_public_id
    and not m.is_disabled;

  if not found then
    return null;
  end if;

  return app_private.profile_json(v_profile, false);
end;
$$;

create or replace function public.get_profile(p_public_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select app_private.get_profile(p_public_id);
$$;

create or replace function app_private.update_own_profile(p_profile jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.profiles%rowtype;
  v_name text := btrim(p_profile ->> 'display_name');
  v_tagline text := nullif(btrim(p_profile ->> 'tagline'), '');
  v_bio text := nullif(btrim(p_profile ->> 'bio'), '');
  v_linkedin text := nullif(btrim(p_profile ->> 'linkedin_url'), '');
  v_email text := nullif(lower(btrim(p_profile ->> 'contact_email')), '');
  v_wechat text := nullif(btrim(p_profile ->> 'wechat_id'), '');
  v_role text := nullif(btrim(p_profile ->> 'role'), '');
  v_cohort bigint;
  v_year integer;
begin
  if not app_private.active_member() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_old from public.profiles where user_id = auth.uid() for update;
  if not found then
    raise exception '请先完善个人资料。';
  end if;

  if v_name = '' or v_name ~ '[[:cntrl:]]' or char_length(v_name) > 30 then
    raise exception '昵称需要 1 到 30 个字，且不能换行。';
  end if;
  if v_tagline is not null and (v_tagline ~ '[[:cntrl:]]' or char_length(v_tagline) > 60) then
    raise exception '一句话介绍不能超过 60 个字，且不能换行。';
  end if;
  if v_bio is not null and char_length(v_bio) > 500 then
    raise exception '自我介绍不能超过 500 个字。';
  end if;
  if v_linkedin is not null and v_linkedin !~ '^https://(www\.)?linkedin\.com/in/[A-Za-z0-9_%-]{3,100}/?$' then
    raise exception 'LinkedIn 请填写 https://www.linkedin.com/in/… 形式的链接。';
  end if;
  if v_email is not null and (char_length(v_email) > 120 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception '公开邮箱的格式不对。';
  end if;
  if v_wechat is not null and v_wechat !~ '^[A-Za-z][A-Za-z0-9_-]{5,19}$' then
    raise exception '微信号需以字母开头，6 到 20 位，只能包含字母、数字、下划线或连字符。';
  end if;
  if v_role is not null and v_role not in ('committee', 'mentor', 'student', 'other') then
    raise exception '请选择领航执委会、领航导师、领航学员或其他成员。';
  end if;
  if v_role = 'student' then
    v_cohort := nullif(p_profile ->> 'cohort_id', '')::bigint;
    v_year := nullif(p_profile ->> 'graduation_year', '')::integer;
  end if;
  if v_year is not null and v_year not between 2016 and 2027 then
    raise exception '毕业年份请选择 2016 到 2027。';
  end if;
  -- Keeping a cohort that has since been retired is allowed; picking one is not.
  if v_cohort is distinct from v_old.cohort_id
     and v_cohort is not null
     and not exists (select 1 from public.cohorts where id = v_cohort and is_active) then
    raise exception '请选择一个有效的班级。';
  end if;

  update public.profiles
  set
    display_name = v_name,
    tagline = v_tagline,
    bio = v_bio,
    linkedin_url = v_linkedin,
    linkedin_public = v_linkedin is not null and coalesce((p_profile ->> 'linkedin_public')::boolean, false),
    contact_email = v_email,
    email_public = v_email is not null and coalesce((p_profile ->> 'email_public')::boolean, false),
    wechat_id = v_wechat,
    wechat_public = v_wechat is not null and coalesce((p_profile ->> 'wechat_public')::boolean, false),
    role = v_role,
    cohort_id = v_cohort,
    graduation_year = v_year,
    role_verified = role_verified
      and v_role is not distinct from v_old.role
      and v_cohort is not distinct from v_old.cohort_id,
    updated_at = now()
  where user_id = auth.uid()
  returning * into v_old;

  return app_private.profile_json(v_old, true);
end;
$$;

create or replace function public.update_own_profile(p_profile jsonb)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select app_private.update_own_profile(p_profile);
$$;

create or replace function app_private.delete_avatar_object(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_name is null
     or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$' then
    return;
  end if;

  delete from storage.objects
  where bucket_id = 'avatars'
    and name = p_name;
end;
$$;

revoke all on function app_private.delete_avatar_object(text) from public, anon, authenticated;

create or replace function app_private.reserve_avatar_upload()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text := gen_random_uuid()::text || '.webp';
  v_pending text;
begin
  if not app_private.active_member() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select avatar_pending into v_pending
  from public.profiles
  where user_id = auth.uid()
  for update;

  if not found then
    raise exception '请先完善个人资料。';
  end if;

  perform app_private.delete_avatar_object(v_pending);

  update public.profiles
  set avatar_pending = v_path, updated_at = now()
  where user_id = auth.uid();

  return v_path;
end;
$$;

create or replace function public.reserve_avatar_upload()
returns text
language sql
security definer
set search_path = public
as $$
  select app_private.reserve_avatar_upload();
$$;

create or replace function app_private.confirm_avatar_upload()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if not app_private.active_member() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_profile
  from public.profiles
  where user_id = auth.uid()
  for update;

  if not found or v_profile.avatar_pending is null then
    raise exception '请先选择头像。';
  end if;

  if not exists (
    select 1 from storage.objects
    where bucket_id = 'avatars' and name = v_profile.avatar_pending
  ) then
    raise exception '头像还没有上传成功。';
  end if;

  perform app_private.delete_avatar_object(v_profile.avatar_url);

  update public.profiles
  set
    avatar_url = avatar_pending,
    avatar_pending = null,
    updated_at = now()
  where user_id = auth.uid()
  returning * into v_profile;

  return app_private.profile_json(v_profile, true);
end;
$$;

create or replace function public.confirm_avatar_upload()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select app_private.confirm_avatar_upload();
$$;

create or replace function app_private.clear_avatar()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_google text := nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'avatar_url'), '');
begin
  if not app_private.active_member() then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if v_google is null or v_google !~ '^https://' or char_length(v_google) > 2048 then
    v_google := null;
  end if;

  select * into v_profile from public.profiles where user_id = auth.uid() for update;
  if not found then
    raise exception '请先完善个人资料。';
  end if;

  perform app_private.delete_avatar_object(v_profile.avatar_url);
  perform app_private.delete_avatar_object(v_profile.avatar_pending);

  update public.profiles
  set avatar_url = v_google, avatar_pending = null, updated_at = now()
  where user_id = auth.uid()
  returning * into v_profile;

  return app_private.profile_json(v_profile, true);
end;
$$;

create or replace function public.clear_avatar()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select app_private.clear_avatar();
$$;

create or replace function app_private.admin_set_role_verified(p_user_id uuid, p_verified boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if not app_private.admin_member() then
    raise exception 'admin_required' using errcode = '42501';
  end if;

  select role into v_role from public.profiles where user_id = p_user_id for update;
  if not found then
    raise exception '用户不存在。';
  end if;
  if p_verified and v_role is null then
    raise exception '对方还没有选择角色。';
  end if;

  update public.profiles
  set role_verified = p_verified, updated_at = now()
  where user_id = p_user_id;
end;
$$;

create or replace function public.admin_set_role_verified(p_user_id uuid, p_verified boolean)
returns void
language sql
security definer
set search_path = public
as $$
  select app_private.admin_set_role_verified(p_user_id, p_verified);
$$;

-- Extend the member list with the self-reported role. Contact fields stay off it.
create or replace function app_private.admin_members()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app_private.admin_member() then
    raise exception 'admin_required' using errcode = '42501';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', m.user_id,
      'name', u.raw_user_meta_data ->> 'name',
      'display_name', p.display_name,
      'email', u.email,
      'joined_at', m.joined_at,
      'is_disabled', m.is_disabled,
      'is_admin', m.is_admin,
      'role', p.role,
      'cohort_name', c.name,
      'role_verified', coalesce(p.role_verified, false)
    ) order by m.joined_at desc), '[]'::jsonb)
    from public.members m
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.user_id = m.user_id
    left join public.cohorts c on c.id = p.cohort_id
  );
end;
$$;

create or replace function public.redeem_invite_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_code text := upper(btrim(p_code));
  v_row public.invite_codes%rowtype;
  v_rows_inserted integer;
begin
  if v_user_id is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if exists (select 1 from public.members where user_id = v_user_id) then
    perform app_private.ensure_profile(v_user_id);
    return not (select is_disabled from public.members where user_id = v_user_id);
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

  insert into public.members (user_id, invite_code)
  values (v_user_id, v_code)
  on conflict (user_id) do nothing;

  get diagnostics v_rows_inserted = row_count;

  if v_rows_inserted > 0 then
    update public.invite_codes
    set used_count = used_count + 1
    where code = v_code;
  end if;

  perform app_private.ensure_profile(v_user_id);
  return true;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/webp']::text[])
on conflict (id) do update
set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "avatars are publicly readable"
on storage.objects
for select
to public
using (bucket_id = 'avatars');

-- storage policies run as the invoker, and profiles has no SELECT grant,
-- so the reserved name has to be read through a definer function.
create or replace function app_private.current_avatar_pending()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select avatar_pending from public.profiles where user_id = auth.uid();
$$;

revoke all on function app_private.current_avatar_pending() from public, anon;
grant execute on function app_private.current_avatar_pending() to authenticated;

create policy "members upload a reserved avatar"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and (select app_private.active_member())
  and name = (select app_private.current_avatar_pending())
);

revoke all on function
  app_private.get_own_profile(),
  app_private.get_profile(uuid),
  app_private.update_own_profile(jsonb),
  app_private.reserve_avatar_upload(),
  app_private.confirm_avatar_upload(),
  app_private.clear_avatar(),
  app_private.admin_set_role_verified(uuid, boolean),
  public.get_own_profile(),
  public.get_profile(uuid),
  public.update_own_profile(jsonb),
  public.reserve_avatar_upload(),
  public.confirm_avatar_upload(),
  public.clear_avatar(),
  public.admin_set_role_verified(uuid, boolean)
from public, anon;

grant execute on function
  app_private.get_own_profile(),
  app_private.get_profile(uuid),
  app_private.update_own_profile(jsonb),
  app_private.reserve_avatar_upload(),
  app_private.confirm_avatar_upload(),
  app_private.clear_avatar(),
  app_private.admin_set_role_verified(uuid, boolean),
  public.get_own_profile(),
  public.get_profile(uuid),
  public.update_own_profile(jsonb),
  public.reserve_avatar_upload(),
  public.confirm_avatar_upload(),
  public.clear_avatar(),
  public.admin_set_role_verified(uuid, boolean)
to authenticated;
