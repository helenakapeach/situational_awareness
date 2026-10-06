-- Return only the caller's own IDs in the current feed page. author_id
-- remains unreadable to clients, including for anonymous posts/replies.
create function public.own_content_ids(p_post_ids bigint[])
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
    and exists (select 1 from public.members m where m.user_id = auth.uid());
$$;

revoke all on function public.own_content_ids(bigint[]) from public, anon;
grant execute on function public.own_content_ids(bigint[]) to authenticated;
comment on function public.own_content_ids(bigint[]) is
  'Caller-owned IDs only, scoped to a feed page. No author identity is exposed.';
