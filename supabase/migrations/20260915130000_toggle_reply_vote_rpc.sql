-- Atomic toggle for reply votes: does the read-then-write as one server-side
-- round trip instead of a client-side select followed by an insert or delete,
-- and folds the two race directions (concurrent toggle, concurrent add) into
-- a single transaction instead of catching a duplicate-key error client-side.

create or replace function public.toggle_reply_vote(p_reply_id bigint)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  removed boolean;
begin
  delete from public.reply_votes
  where reply_id = p_reply_id and user_id = auth.uid()
  returning true into removed;

  if removed then
    return false;
  end if;

  insert into public.reply_votes (reply_id, user_id)
  values (p_reply_id, auth.uid())
  on conflict (reply_id, user_id) do nothing;

  return true;
end;
$$;

revoke all on function public.toggle_reply_vote(bigint) from public, anon;
grant execute on function public.toggle_reply_vote(bigint) to authenticated;

comment on function public.toggle_reply_vote(bigint) is
  'Toggles the caller''s vote on a reply in one round trip. Runs as invoker so the existing reply_votes RLS policies still apply.';
