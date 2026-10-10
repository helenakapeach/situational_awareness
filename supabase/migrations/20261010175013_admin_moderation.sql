-- Roles are stored in the database, never in user-editable metadata.
alter table public.members add column is_admin boolean not null default false,
  add column is_disabled boolean not null default false;
create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;

create function app_private.active_member() returns boolean
language sql stable security definer set search_path = '' as $$
 select auth.uid() is not null and exists (select 1 from public.members
 where user_id=auth.uid() and not is_disabled)
 and coalesce(auth.jwt()->'app_metadata'->>'provider','')='google';
$$;
create function app_private.admin_member() returns boolean
language sql stable security definer set search_path = '' as $$
 select app_private.active_member() and exists (select 1 from public.members
 where user_id=auth.uid() and is_admin and not is_disabled);
$$;
revoke all on function app_private.active_member(),app_private.admin_member() from public;
grant execute on function app_private.active_member(),app_private.admin_member() to authenticated;
create policy "Active membership required" on public.posts as restrictive for all to authenticated using ((select app_private.active_member())) with check ((select app_private.active_member()));
create policy "Active membership required" on public.replies as restrictive for all to authenticated using ((select app_private.active_member())) with check ((select app_private.active_member()));
create policy "Active membership required" on public.post_votes as restrictive for all to authenticated using ((select app_private.active_member())) with check ((select app_private.active_member()));
create policy "Active membership required" on public.reply_votes as restrictive for all to authenticated using ((select app_private.active_member())) with check ((select app_private.active_member()));
create policy "Active membership required" on public.feedback as restrictive for all to authenticated using ((select app_private.active_member())) with check ((select app_private.active_member()));

create function app_private.member_access() returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('is_member',not is_disabled,'is_admin',is_admin and not is_disabled,'is_disabled',is_disabled)
 from public.members where user_id=auth.uid();
$$;
create function public.member_access() returns jsonb language sql stable set search_path='' as $$
 select app_private.member_access();
$$;
create function app_private.admin_members() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not app_private.admin_member() then raise exception 'admin_required' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',u.raw_user_meta_data->>'name','email',u.email,'joined_at',m.joined_at,'is_disabled',m.is_disabled,'is_admin',m.is_admin) order by m.joined_at desc),'[]'::jsonb)
 from public.members m join auth.users u on u.id=m.user_id);
end;
$$;
create function public.admin_members() returns jsonb language sql stable set search_path='' as $$
 select app_private.admin_members();
$$;
create function app_private.admin_set_disabled(p_user_id uuid,p_disabled boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not app_private.admin_member() then raise exception 'admin_required' using errcode='42501'; end if;
 -- Administrators cannot be disabled through the moderation UI.
 update public.members set is_disabled=p_disabled where user_id=p_user_id and not is_admin;
 if not found then raise exception '用户不存在，或该账号是管理员。'; end if;
end;
$$;
create function public.admin_set_disabled(p_user_id uuid,p_disabled boolean) returns void
language sql set search_path='' as $$ select app_private.admin_set_disabled(p_user_id,p_disabled); $$;
create function app_private.admin_delete_content(p_id bigint,p_kind text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not app_private.admin_member() then raise exception 'admin_required' using errcode='42501'; end if;
 if p_kind='post' then delete from public.posts where id=p_id;
 elsif p_kind='reply' then delete from public.replies where id=p_id;
 else raise exception 'invalid_content_kind'; end if;
 if not found then raise exception '内容已经不存在。'; end if;
end;
$$;
create function public.admin_delete_content(p_id bigint,p_kind text) returns void
language sql set search_path='' as $$ select app_private.admin_delete_content(p_id,p_kind); $$;
revoke all on function app_private.member_access(),app_private.admin_members(),app_private.admin_set_disabled(uuid,boolean),app_private.admin_delete_content(bigint,text),public.member_access(),public.admin_members(),public.admin_set_disabled(uuid,boolean),public.admin_delete_content(bigint,text) from public;
grant execute on function app_private.member_access(),app_private.admin_members(),app_private.admin_set_disabled(uuid,boolean),app_private.admin_delete_content(bigint,text),public.member_access(),public.admin_members(),public.admin_set_disabled(uuid,boolean),public.admin_delete_content(bigint,text) to authenticated;
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

  -- Already a member: treat re-submission as a harmless success.
  if exists (select 1 from public.members where user_id = v_user_id) then
    return not (select is_disabled from public.members where user_id=v_user_id);
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

  -- A concurrent call for this user already won the race and inserted
  -- the membership row first; treat this call as a no-op success
  -- rather than also charging the invite code a use.
  if v_rows_inserted = 0 then
    return true;
  end if;

  update public.invite_codes
  set used_count = used_count + 1
  where code = v_code;

  return true;
end;
$$;

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
     or not app_private.active_member() then
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

create or replace function public.own_content_ids(p_post_ids bigint[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts', coalesce((
      select jsonb_agg(p.id) from public.posts p
      where p.id = any(p_post_ids) and p.author_id = auth.uid()
    ), '[]'::jsonb),
    'replies', coalesce((
      select jsonb_agg(r.id) from public.replies r
      where r.post_id = any(p_post_ids) and r.author_id = auth.uid()
    ), '[]'::jsonb)
  )
  where auth.uid() is not null
    and coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'google'
    and app_private.active_member();
$$;

