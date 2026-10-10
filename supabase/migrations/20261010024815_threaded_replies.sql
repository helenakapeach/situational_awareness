-- Existing replies stay top-level. Parent links never expose private author IDs.
alter table public.replies add column parent_reply_id bigint;
alter table public.replies add constraint replies_id_post_unique unique (id, post_id);
alter table public.replies add constraint replies_parent_same_post
  foreign key (parent_reply_id, post_id) references public.replies (id, post_id)
  on delete set null (parent_reply_id);
alter table public.replies add constraint replies_parent_not_self
  check (parent_reply_id is null or parent_reply_id <> id);
create index replies_parent_reply_idx on public.replies (parent_reply_id)
  where parent_reply_id is not null;
-- Clients may choose a parent on INSERT only. Existing ownership RLS still applies.
grant select (parent_reply_id) on public.replies to authenticated, anon;
grant insert (parent_reply_id) on public.replies to authenticated;
comment on column public.replies.parent_reply_id is
  'Exact comment being answered in the same post; deleting it promotes direct children to top-level.';
