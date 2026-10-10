-- Supabase's public-schema defaults explicitly grant EXECUTE to anon.
-- Private implementations already reject unauthenticated access; also close wrappers.
revoke all on function public.member_access(), public.admin_members(), public.admin_set_disabled(uuid,boolean), public.admin_delete_content(bigint,text) from anon;
