-- Fix: the client always upper-cases invite codes before sending them
-- (see src/lib.js normalizeInviteCode), but redeem_invite_code() only
-- trimmed, never upper-cased. An admin-entered code stored in any case
-- other than upper would then never match what the client sends.
-- Make the function match the client's normalization, and enforce
-- upper-case storage going forward so the two can't drift again.

alter table public.invite_codes
  add constraint invite_codes_code_uppercase check (code = upper(code));

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
begin
  if v_user_id is null then
    return false;
  end if;

  -- Already a member: treat re-submission as a harmless success.
  if exists (select 1 from public.members where user_id = v_user_id) then
    return true;
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

  update public.invite_codes
  set used_count = used_count + 1
  where code = v_code;

  insert into public.members (user_id, invite_code)
  values (v_user_id, v_code);

  return true;
end;
$$;
