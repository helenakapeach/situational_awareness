-- Two fixes to redeem_invite_code(), found in review of the invite-code
-- gate PR:
--
-- 1. The "already a member" check ran before the row lock, so two
--    concurrent calls for the same user (a double-submit, or a client
--    retry after a dropped response) could both pass it and race on
--    the insert into `members`, raising an unhandled unique_violation
--    instead of the promised idempotent `true`. Fixed with
--    `on conflict (user_id) do nothing`, checking whether a row was
--    actually inserted before charging the invite code a use — so a
--    raced-out call is a clean no-op rather than an error, and never
--    double-consumes a redemption.
--
-- 2. A missing session (auth.uid() is null) and an invalid/exhausted
--    code both returned `false`, so the client couldn't tell "you need
--    to sign in again" from "wrong code". Missing session now raises
--    instead, so the frontend can show a distinct message.

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
