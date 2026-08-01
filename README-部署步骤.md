# 浅咲导航：数据库创建完成后的部署步骤

这套项目包含：

- 导航首页 `/`
- 管理后台 `/admin/`
- Cloudflare Worker API `/api/*`
- Cloudflare D1 数据库
- 管理员登录与会话
- 连续输错 3 次封禁 IP 30 分钟
- IP 白名单
- 分组和网址增删改查、拖动排序
- 外观设置
- JSON 备份与恢复
- Chrome / Edge 新标签页扩展

下面假设项目目录是：

```powershell
C:\_GitHub\chisa-nav
```

---

## 第 9 步：把完整项目文件放入当前目录

1. 先关闭正在运行的 `npx wrangler dev`。
2. 备份当前项目，避免误覆盖：

```powershell
cd C:\_GitHub
Copy-Item .\chisa-nav .\chisa-nav-backup -Recurse
```

3. 解压下载的项目 ZIP。
4. 将 ZIP 内的所有文件复制到：

```text
C:\_GitHub\chisa-nav\
```

5. 遇到同名文件时选择“替换目标中的文件”。

复制完成后，应看到：

```text
chisa-nav
├─ src
│  ├─ index.ts
│  └─ cloudflare.d.ts
├─ public
│  ├─ index.html
│  ├─ admin\index.html
│  ├─ css
│  └─ js
├─ extension
├─ scripts
├─ schema.sql
├─ wrangler.jsonc
├─ package.json
└─ tsconfig.json
```

---

## 第 10 步：填写 D1 数据库 ID

打开：

```text
C:\_GitHub\chisa-nav\wrangler.jsonc
```

找到：

```jsonc
"database_id": "把这里替换成你的真实数据库ID"
```

查询数据库 ID：

```powershell
cd C:\_GitHub\chisa-nav
npx wrangler d1 list
```

找到名称为 `chisa-nav-db` 的数据库，将它的 UUID 填进去，例如：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "chisa-nav-db",
    "database_id": "12345678-abcd-1234-abcd-1234567890ab"
  }
]
```

保存文件：`Ctrl + S`。

不要填写数据库名称，也不要保留中文占位文字。

---

## 第 11 步：安装项目依赖

在 PowerShell 中运行：

```powershell
cd C:\_GitHub\chisa-nav
npm install
```

然后检查：

```powershell
npx wrangler --version
```

`npm install` 出现 `vulnerabilities` 警告时先不用运行 `npm audit fix --force`，不影响当前部署。

---

## 第 12 步：创建本地密钥文件

项目已提供自动生成脚本。运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1
```

脚本会：

1. 在项目根目录创建 `.dev.vars`
2. 自动生成 `SESSION_SECRET`
3. 自动生成 `BOOTSTRAP_TOKEN`
4. 在 PowerShell 显示首次初始化令牌

请把显示的 `BOOTSTRAP_TOKEN` 暂时保存到记事本，创建管理员时要使用。

也可以手动创建：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

连续运行两次，然后创建 `.dev.vars`：

```env
SESSION_SECRET=第一次生成的随机字符串
BOOTSTRAP_TOKEN=第二次生成的随机字符串
```

`.dev.vars` 已加入 `.gitignore`，不要上传到 GitHub。

---

## 第 13 步：再次确认本地数据库表

即使之前已经创建过，也可以安全地重新运行，因为 SQL 使用了 `IF NOT EXISTS` 和 `INSERT OR IGNORE`：

```powershell
npx wrangler d1 execute chisa-nav-db --local --file=.\schema.sql
```

查看表：

```powershell
npx wrangler d1 execute chisa-nav-db --local --command="SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;"
```

至少应看到：

```text
admins
audit_logs
groups
ip_whitelist
links
login_attempts
sessions
settings
```

---

## 第 14 步：启动本地网站

运行：

```powershell
npm run dev
```

不要关闭这个 PowerShell 窗口。

终端一般会显示：

```text
Ready on http://localhost:8787
```

打开：

```text
http://localhost:8787/
```

再打开后台：

```text
http://localhost:8787/admin/
```

注意地址最后的 `/` 建议保留。

---

## 第 15 步：创建本地管理员

第一次进入后台会显示“创建首个管理员”。填写：

```text
管理员用户名：你自定义，例如 admin
管理员密码：至少 8 位，同时包含字母和数字
初始化令牌：setup-local.ps1 显示的 BOOTSTRAP_TOKEN
```

点击“创建管理员”。

创建成功后，页面会切换回登录状态。使用刚才的用户名和密码登录。

本地管理员只保存在本地 D1 中，不会自动同步到线上 D1。

---

## 第 16 步：本地测试后台功能

按这个顺序测试：

1. 进入“分组管理”
2. 新增一个分组，例如“AI 工具”
3. 进入“网址管理”
4. 新增网址：

```text
名称：ChatGPT
地址：https://chatgpt.com/
说明：AI 助手
分组：AI 工具
新标签页打开：开启
首页显示：开启
```

5. 打开首页或刷新首页
6. 确认新卡片出现
7. 编辑网址并保存
8. 拖动网址调整顺序
9. 在“外观设置”修改标题和问候名称
10. 在“备份恢复”下载一份 JSON 备份

本地测试没有问题后再部署线上。

---

## 第 17 步：确认线上 D1 已创建表

本地和线上数据库互相独立。运行：

```powershell
npx wrangler d1 execute chisa-nav-db --remote --file=.\schema.sql
```

如果询问确认，输入：

```text
y
```

再检查线上表：

```powershell
npx wrangler d1 execute chisa-nav-db --remote --command="SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;"
```

---

## 第 18 步：第一次部署 Worker

运行：

```powershell
npx wrangler deploy
```

成功后会出现类似：

```text
https://chisa-nav.你的子域.workers.dev
```

先保存这个地址。

第一次部署时还没有线上 Secret，因此先不要在线上创建管理员。

---

## 第 19 步：设置线上 SESSION_SECRET

先生成一个新的生产密钥：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

复制输出，然后运行：

```powershell
npx wrangler secret put SESSION_SECRET
```

终端等待输入时，粘贴刚才的随机字符串并回车。

输入内容不会显示在终端，这是正常现象。

---

## 第 20 步：设置线上 BOOTSTRAP_TOKEN

生成初始化令牌：

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

保存输出，然后运行：

```powershell
npx wrangler secret put BOOTSTRAP_TOKEN
```

粘贴令牌并回车。

这个令牌只用于在线上创建第一个管理员。

---

## 第 21 步：创建线上管理员

打开：

```text
https://chisa-nav.你的子域.workers.dev/admin/
```

填写：

```text
用户名：可与本地相同
密码：可与本地相同
初始化令牌：刚设置到 Cloudflare 的 BOOTSTRAP_TOKEN
```

创建成功后重新登录。

线上管理员与本地管理员是两份独立数据，需要各创建一次。

---

## 第 22 步：删除线上初始化令牌

确认线上管理员可以正常登录后，运行：

```powershell
npx wrangler secret delete BOOTSTRAP_TOKEN
```

输入 `y` 确认。

管理员已经存在时，初始化接口本身也会拒绝再次创建；删除令牌可以进一步减少不必要的敏感配置。

不要删除 `SESSION_SECRET`。删除或更换它会让现有登录会话全部失效。

---

## 第 23 步：绑定 nav.chisa.wiki

进入 Cloudflare 控制台：

```text
Workers & Pages
→ chisa-nav
→ Settings
→ Domains & Routes
→ Add
→ Custom Domain
```

输入：

```text
nav.chisa.wiki
```

确认添加。

如果 DNS 中已经存在同名的 A、AAAA 或 CNAME 记录，先删除冲突记录，再添加自定义域名。

等待证书生效后打开：

```text
https://nav.chisa.wiki/
https://nav.chisa.wiki/admin/
```

---

## 第 24 步：安装 Chrome / Edge 新标签页扩展

扩展目录在：

```text
C:\_GitHub\chisa-nav\extension
```

项目中的 `newtab.js` 已填写：

```javascript
window.location.replace("https://nav.chisa.wiki/");
```

### Chrome

打开：

```text
chrome://extensions/
```

1. 打开右上角“开发者模式”
2. 点击“加载已解压的扩展程序”
3. 选择 `C:\_GitHub\chisa-nav\extension`
4. 新建标签页测试

### Edge

打开：

```text
edge://extensions/
```

1. 打开“开发人员模式”
2. 点击“加载解压缩的扩展”
3. 选择 `extension` 文件夹

如果最终使用的不是 `nav.chisa.wiki`，修改：

```text
extension\newtab.js
```

然后在扩展管理页面点击“重新加载”。

---

## 第 25 步：以后修改和更新

修改前端或 Worker 代码后，本地预览：

```powershell
npm run dev
```

确认无误后部署：

```powershell
npm run deploy
```

只修改后台里的网址、分组和外观时，不需要重新部署，保存后数据直接写入 D1，刷新首页即可。

---

## 常见问题

### 1. 首页显示“导航内容加载失败”

检查：

```powershell
npx wrangler d1 list
```

然后确认 `wrangler.jsonc` 的 `database_id` 正确，并确认数据库已执行 `schema.sql`。

### 2. 后台显示“尚未配置 BOOTSTRAP_TOKEN”

本地环境检查：

```text
C:\_GitHub\chisa-nav\.dev.vars
```

线上环境重新设置：

```powershell
npx wrangler secret put BOOTSTRAP_TOKEN
```

### 3. 创建管理员成功，但登录后又回到登录页

先确认使用的是：

```text
http://localhost:8787/admin/
```

不要同时混用 `localhost` 和 `127.0.0.1`，因为它们属于不同 Cookie 域。

线上必须使用 HTTPS。

### 4. 本地新增的网址线上看不到

这是正常现象。本地 D1 和线上 D1 是两套数据库。

本地数据不会自动同步到线上。可以：

1. 在本地后台导出 JSON
2. 登录线上后台
3. 在“备份恢复”中导入 JSON

### 5. 输错密码三次后把自己封了

等待 30 分钟，或者用数据库命令清除本地封禁：

```powershell
npx wrangler d1 execute chisa-nav-db --local --command="DELETE FROM login_attempts;"
```

清除线上封禁：

```powershell
npx wrangler d1 execute chisa-nav-db --remote --command="DELETE FROM login_attempts;"
```

也可以提前在后台“安全设置”里把自己的公网 IP 加入白名单。

### 6. 如何查看本地 D1 数据

启动 `wrangler dev` 后打开：

```text
http://localhost:8787/cdn-cgi/explorer
```

也可以继续使用 `wrangler d1 execute --local --command=...` 查询。
