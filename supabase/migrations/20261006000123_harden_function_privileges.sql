-- Keep invite redemption callable only after authentication. Existing hosted
-- projects may retain direct default EXECUTE grants to anon even after PUBLIC
-- is revoked, so revoke both explicitly.
revoke all on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated;

-- These trigger functions only use objects in public (plus pg_catalog
-- built-ins). Pin the path so callers cannot influence name resolution.
alter function public.strip_anonymous_reply_identity() set search_path = public;
alter function public.protect_reply_update() set search_path = public;
alter function public.protect_post_update() set search_path = public;
