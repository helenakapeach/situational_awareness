# 让别人部署这份产品

网站分成两块，**互不自动同步**：

| 块 | 在哪 | 怎么更新 |
|---|---|---|
| 网页 | GitHub Pages | 一 push 到 `main`，GitHub Actions 会测试、构建、发布 |
| 数据库 | Supabase | **必须人手**跑 `db push`。代码进 `main` 不会改数据库 |

以后发版只要记住一句：**有新的 `supabase/migrations/*.sql` 时，先 `db push`，再让新网页上线。** 反了的话，网页会去查数据库里还不存在的字段或函数，讨论列表整页加载失败。

---

## 零、需要哪些权限

- GitHub 仓库写权限（能 push `main`，能改 Settings）
- 一个 [Supabase](https://supabase.com) 项目的 Owner / 能跑 SQL 和改 Authentication 的角色
- 一个 [Google Cloud](https://console.cloud.google.com/) 项目，能创建 OAuth 客户端
- 本机 Node **20 或更新**（GitHub Actions 用的是 24）

---

## 一、第一次从零搭

### 1. 拿到代码并确认能跑

```bash
git clone <仓库地址>
cd situational_awareness   # 或你的本地目录名
npm ci
npm test
```

不配 Supabase 也可以先看界面：

```bash
npm run dev
```

打开 `http://localhost:5173/?demo=1`。这是浏览器本地演示，数据只在这台电脑，邀请码是 `DEMO2026`。

### 2. 建 Supabase 项目并推入全部表结构

1. 在 supabase.com 新建项目，记下 **Project ID**（也叫 project ref，URL 里 `https://xxxx.supabase.co` 的那串 `xxxx`）。
2. 把仓库链到这个项目，并把 `supabase/migrations/` 里**所有**脚本按文件名顺序执行一遍：

   ```bash
   npx supabase@2.117.0 login
   npx supabase@2.117.0 link --project-ref YOUR_PROJECT_REF
   npx supabase@2.117.0 db push
   ```

   `db push` 成功才算数据库就绪。缺哪一条 migration，对应功能就会在网页上失败（例如没有 `reply_is_mine` / `post_is_mine` 时，feed 会整页挂掉）。

### 3. 打开 Google 登录，关掉邮箱注册

在 Supabase：**Authentication → Providers**

- 打开 **Google**
- 关掉 **Email** 注册（产品只允许 Google）

Google 那边：**Google Auth Platform → 创建「Web application」OAuth 客户端**。填：

| 项 | 本地开发 | 正式站（当前仓库） |
|---|---|---|
| Authorized JavaScript origins | `http://localhost:5173` | `https://helenakapeach.github.io` |
| Authorized redirect URIs | `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback` | 同左，还是 Supabase 的 callback，**不是** GitHub Pages 地址 |

把客户端 ID / Secret 填回 Supabase 的 Google provider。

Supabase **Authentication → URL Configuration**：

- Site URL（开发时）：`http://localhost:5173`
- Redirect URLs 再加正式站：`https://helenakapeach.github.io/situational_awareness/`

如果以后换了 Pages 地址或自定义域名，origins 和 Redirect URLs 都要一起改。

### 4. 本地接上真数据库（可选）

```bash
cp .env.example .env
```

只填这两项（在 Supabase **Project Settings → API**）：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`（publishable / anon，**浏览器能看到的那种**）

**不要**把 `service_role` 或任何 secret 写进 `VITE_` 变量，构建后会进网页。

```bash
npm run dev
```

用 Google 登录。第一次会要邀请码，见下面第 6 步。

### 5. 打开 GitHub Pages

仓库 **Settings → Pages**：Source 选 **GitHub Actions**。

**Settings → Secrets and variables → Actions → Variables** 加（不是 Secrets）：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

和本地 `.env` 同一对。缺这两项时，线上站会自动变成演示模式，不会碰到真数据库。

之后每次 `main` 有新 commit，`.github/workflows/deploy-pages.yml` 会：`npm ci` → `npm test` → `npm run build` → 发布 `dist`。

当前正式地址：https://helenakapeach.github.io/situational_awareness/

`vite.config.js` 里 `base: './'`，所以换到别的子路径一般不用改构建配置，但 Google / Supabase 的域名白名单要改。

### 6. 建邀请码

没有管理后台。在 Supabase **SQL editor** 里执行（码必须大写，小写会直接被约束拒绝）：

```sql
insert into public.invite_codes (code) values ('YOUR-CODE');
-- 可选：限制使用次数
-- insert into public.invite_codes (code, max_uses) values ('YOUR-CODE', 50);
```

查看或停用：

```sql
select code, is_active, used_count, max_uses from public.invite_codes;
update public.invite_codes set is_active = false where code = 'YOUR-CODE';
```

### 7. 验收

用一个不在演示模式的正式站（Variables 已配好）：

1. Google 能登录
2. 第一次用邀请码能进；同一账号再登录不用再兑
3. 发帖是匿名的，回复默认真名、可勾选匿名
4. 能给别人的回复点赞，高赞会排到上面
5. **自己的**回复出现「编辑」「删除」（匿名回复也一样，只有作者看得到按钮）
6. 没登录只能看到登录页，看不到帖子

读用户反馈（客户端不能读，只能在 SQL editor）：

```sql
select f.created_at, u.email, f.body
from public.feedback f
join auth.users u on u.id = f.author_id
order by f.created_at desc;
```

---

## 二、已经上线之后，以后怎么发版

1. 看这次改动有没有新增 `supabase/migrations/` 下的 `.sql` 文件。
2. **有的话，先对线上项目推数据库，再推 `main`：**

   ```bash
   git pull
   npx supabase@2.117.0 db push
   git push origin main
   ```

   同一台已 `link` 过的电脑上，这两步紧挨着做。Pages 构建要一两分钟，`db push` 应在网页发布完成前跑完。

3. **没有新 sql**，只改了 HTML/CSS/JS/文案：直接 `git push origin main` 即可。

4. 如果代码已经进了 `main`、数据库还没 push：立刻补跑 `db push`。在 Pages 发布完成前补上，用户可能无感；发布完才补，feed 会报错直到数据库跟上。

### 怎么判断「有没有新 migration」

```bash
git log --oneline origin/main -- supabase/migrations/
```

或看 PR / commit 里是否出现新的 `supabase/migrations/20*.sql`。每一份都要进过 `db push`。已经执行过的脚本 Supabase 会记下来，重复 `db push` 不会重跑旧文件。

---

## 三、不要做的事

- 不要把 `service_role` key 放进 GitHub Variables 或 `.env` 的 `VITE_` 里。
- 不要假设「push 代码 = 数据库也更新了」。
- 不要跳过 `npm test`。Pages 工作流失败时页面不会更新，但本地 push 前跑一次能早发现。
- 不要用邮箱密码注册；产品只接 Google。
- 不要在 SQL 里插入小写邀请码。

---

## 四、常见故障

| 现象 | 多半是 |
|---|---|
| 线上是演示横幅，登录不走 Google | GitHub Actions Variables 没配，或名字拼错 |
| 登录后一直要邀请码 / 没权限 | 没 `db push`、没有 `members` 表，或还没插邀请码 |
| 讨论列表一进来就失败 | 网页比数据库新，缺 migration（现在最常见的是缺 `reply_is_mine` 或 `post_is_mine`） |
| Google 登录弹窗报 redirect mismatch | JavaScript origin 或 Redirect URL 没包含当前站点 |
| 本地 `file://` 打开是乱码或不能登录 | 要用 `npm run dev`，不要直接打开 HTML |
