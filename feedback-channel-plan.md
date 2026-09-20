# 反馈通道

登录后 topbar「反馈」→ 写一段话 → 进 `feedback` 表。团队在 dashboard 读。

表：`id, author_id, body, created_at`。客户端只能 insert，不能 SELECT。只存用户敲的文字。

```sql
select f.created_at, u.email, f.body
from public.feedback f
join auth.users u on u.id = f.author_id
order by f.created_at desc;
```
