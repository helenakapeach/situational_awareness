-- Member-submitted product feedback. Insert-only for the Data API.
-- author_id is retained for follow-up but has no client SELECT grant,
-- matching posts.author_id. The table stores only the text the member typed.

create table public.feedback (
  id bigint generated always as identity primary key,
  author_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint feedback_body_length check (
    body = btrim(body)
    and char_length(body) between 1 and 2000
  )
);

create index feedback_created_at_id_idx on public.feedback (created_at desc, id desc);
create index feedback_author_id_idx on public.feedback (author_id);

alter table public.feedback enable row level security;

revoke all on table public.feedback from anon, authenticated;
revoke all on sequence public.feedback_id_seq from anon, authenticated;

grant insert (body) on table public.feedback to authenticated;
grant usage, select on sequence public.feedback_id_seq to authenticated;

create policy "Google members can submit feedback"
on public.feedback
for insert
to authenticated
with check (
  (select auth.uid()) = author_id
  and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', '') = 'google'
);

comment on table public.feedback is
  'Product feedback from signed-in members. Insert-only; author_id is hidden from the Data API.';
