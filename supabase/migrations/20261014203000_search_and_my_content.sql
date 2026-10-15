-- Search runs as the caller, so the posts RLS (active Google member) still
-- decides what can be found. Plain substring match: user input never becomes
-- a LIKE pattern.
create function public.search_posts(p_query text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select jsonb_agg(hit.id order by hit.created_at desc)
    from (
      select p.id, p.created_at
      from public.posts p
      where strpos(lower(p.title), lower(btrim(p_query))) > 0
         or strpos(lower(p.body), lower(btrim(p_query))) > 0
      order by p.created_at desc
      limit 50
    ) hit
  ), '[]'::jsonb)
  where char_length(btrim(coalesce(p_query, ''))) between 1 and 100;
$$;

revoke all on function public.search_posts(text) from public, anon;
grant execute on function public.search_posts(text) to authenticated;
comment on function public.search_posts(text) is
  'Newest 50 post ids whose title or body contains the query. Subject to posts RLS.';

-- The caller's own posts and replies, including anonymous ones. author_id has
-- no client grant, so this needs definer rights; it only ever filters on
-- auth.uid() and never returns author ids.
create function public.my_content()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'title', p.title,
        'created_at', p.created_at,
        'is_anonymous', p.is_anonymous
      ) order by p.created_at desc)
      from (
        select id, title, created_at, is_anonymous
        from public.posts
        where author_id = auth.uid()
        order by created_at desc
        limit 100
      ) p
    ), '[]'::jsonb),
    'replies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'post_id', r.post_id,
        'body', r.body,
        'created_at', r.created_at,
        'is_anonymous', r.is_anonymous,
        'post_title', p.title
      ) order by r.created_at desc)
      from (
        select id, post_id, body, created_at, is_anonymous
        from public.replies
        where author_id = auth.uid()
        order by created_at desc
        limit 100
      ) r
      join public.posts p on p.id = r.post_id
    ), '[]'::jsonb)
  )
  where auth.uid() is not null
    and coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'google'
    and app_private.active_member();
$$;

revoke all on function public.my_content() from public, anon;
grant execute on function public.my_content() to authenticated;
comment on function public.my_content() is
  'The caller''s own recent posts and replies, anonymous ones included. No author identity is exposed.';
