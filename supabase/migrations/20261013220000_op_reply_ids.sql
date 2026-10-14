-- Which replies in this page were written by the post's author.
-- Only when the reply and the post share anonymity: revealing "楼主" across
-- a named/anonymous mismatch would connect a hidden identity to a public one.
-- The function returns ids, never author ids.
create function public.op_reply_ids(p_post_ids bigint[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_agg(r.id)
    from public.replies r
    join public.posts p on p.id = r.post_id
    where r.post_id = any(p_post_ids)
      and r.author_id = p.author_id
      and r.is_anonymous = p.is_anonymous
  ), '[]'::jsonb)
  where auth.uid() is not null
    and coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'google'
    and app_private.active_member();
$$;

revoke all on function public.op_reply_ids(bigint[]) from public, anon;
grant execute on function public.op_reply_ids(bigint[]) to authenticated;
comment on function public.op_reply_ids(bigint[]) is
  'Reply ids by the post author when anonymity matches. No author identity is exposed.';
