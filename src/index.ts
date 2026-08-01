interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  BOOTSTRAP_TOKEN?: string;
}

type JsonRecord = Record<string, unknown>;

type SessionInfo = {
  adminId: number;
  username: string;
  tokenHash: string;
};

const SESSION_COOKIE = "chisa_nav_session";
const SESSION_DAYS = 7;
const LOGIN_FAILURE_LIMIT = 3;
const BLOCK_MINUTES = 30;
const MAX_JSON_BYTES = 1_000_000;
const encoder = new TextEncoder();

const settingKeys = new Set([
  "site_title",
  "site_subtitle",
  "greeting_name",
  "default_search_engine",
  "default_theme",
  "background_url",
  "card_opacity",
  "card_blur",
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname.startsWith("/api/admin/")) {
        await cleanupExpiredSessions(env.DB);
      }
      return await routeApi(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ ok: false, error: error.message }, error.status);
      }
      console.error(error);
      return json({ ok: false, error: "服务器内部错误" }, 500);
    }
  },
};

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (method === "GET" && path === "/api/navigation") {
    return getNavigation(env.DB);
  }

  if (method === "GET" && path === "/api/suggest") {
    return getSearchSuggestions(url);
  }

  if (method === "GET" && path === "/api/admin/setup-status") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM admins").first<{ count: number }>();
    return json({ ok: true, needsSetup: Number(row?.count ?? 0) === 0 });
  }

  if (method === "POST" && path === "/api/admin/setup") {
    requireSameOrigin(request);
    return setupAdmin(request, env);
  }

  if (method === "POST" && path === "/api/admin/login") {
    requireSameOrigin(request);
    return login(request, env);
  }

  if (method === "POST" && path === "/api/admin/logout") {
    requireSameOrigin(request);
    return logout(request, env);
  }

  if (method === "GET" && path === "/api/admin/session") {
    const session = await requireSession(request, env);
    return json({ ok: true, user: { id: session.adminId, username: session.username } });
  }

  const session = await requireSession(request, env);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    requireSameOrigin(request);
  }

  if (path === "/api/admin/groups/reorder" && method === "POST") {
    return reorderGroups(request, env, session);
  }

  if (path === "/api/admin/links/reorder" && method === "POST") {
    return reorderLinks(request, env, session);
  }

  if (path === "/api/admin/groups") {
    if (method === "GET") return listGroups(env.DB);
    if (method === "POST") return createGroup(request, env, session);
  }

  const groupMatch = path.match(/^\/api\/admin\/groups\/(\d+)$/);
  if (groupMatch) {
    const id = Number(groupMatch[1]);
    if (method === "PUT") return updateGroup(id, request, env, session);
    if (method === "DELETE") return deleteGroup(id, env, session, request);
  }

  if (path === "/api/admin/links") {
    if (method === "GET") return listLinks(env.DB);
    if (method === "POST") return createLink(request, env, session);
  }

  const linkMatch = path.match(/^\/api\/admin\/links\/(\d+)$/);
  if (linkMatch) {
    const id = Number(linkMatch[1]);
    if (method === "PUT") return updateLink(id, request, env, session);
    if (method === "DELETE") return deleteLink(id, env, session, request);
  }

  if (path === "/api/admin/settings") {
    if (method === "GET") return getSettings(env.DB);
    if (method === "PUT") return updateSettings(request, env, session);
  }

  if (path === "/api/admin/export" && method === "GET") {
    return exportData(env.DB);
  }

  if (path === "/api/admin/import" && method === "POST") {
    return importData(request, env, session);
  }

  if (path === "/api/admin/security/blocked" && method === "GET") {
    return listBlocked(env.DB);
  }

  const unblockMatch = path.match(/^\/api\/admin\/security\/blocked\/(.+)$/);
  if (unblockMatch && method === "DELETE") {
    return unblockIp(decodeURIComponent(unblockMatch[1]), env, session, request);
  }

  if (path === "/api/admin/security/whitelist") {
    if (method === "GET") return listWhitelist(env.DB);
    if (method === "POST") return addWhitelist(request, env, session);
  }

  const whitelistMatch = path.match(/^\/api\/admin\/security\/whitelist\/(\d+)$/);
  if (whitelistMatch && method === "DELETE") {
    return deleteWhitelist(Number(whitelistMatch[1]), env, session, request);
  }

  if (path === "/api/admin/audit-logs" && method === "GET") {
    return listAuditLogs(env.DB, url);
  }

  return json({ ok: false, error: "接口不存在" }, 404);
}

async function getNavigation(db: D1Database): Promise<Response> {
  const [settingsResult, groupsResult, linksResult] = await db.batch([
    db.prepare("SELECT key, value, value_type FROM settings ORDER BY key"),
    db.prepare(
      "SELECT id, name, description, icon, sort_order FROM groups WHERE is_visible = 1 ORDER BY sort_order, id",
    ),
    db.prepare(
      `SELECT id, group_id, title, url, description, icon_url, open_in_new_tab, sort_order
       FROM links WHERE is_visible = 1 ORDER BY group_id, sort_order, id`,
    ),
  ]);

  return json({
    ok: true,
    settings: rowsToSettings(settingsResult.results as Array<Record<string, unknown>>),
    groups: groupsResult.results,
    links: linksResult.results,
  });
}


type SuggestionProvider = "google" | "bing" | "baidu" | "duckduckgo";

async function getSearchSuggestions(url: URL): Promise<Response> {
  const query = String(url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const engine = String(url.searchParams.get("engine") ?? "google").toLowerCase();
  if (!query) {
    return cachedJson({ ok: true, suggestions: [] }, 60);
  }

  const providerOrder: SuggestionProvider[] = engine === "bing"
    ? ["bing", "google", "duckduckgo"]
    : engine === "baidu"
      ? ["baidu", "google", "duckduckgo"]
      : ["google", "duckduckgo"];

  for (const provider of providerOrder) {
    const suggestions = await fetchSuggestionProvider(provider, query);
    if (suggestions.length) {
      return cachedJson({ ok: true, suggestions, provider }, 300);
    }
  }

  // 联想服务临时不可用时返回空列表，前端仍会显示导航入口和本地搜索历史。
  return cachedJson({ ok: true, suggestions: [], provider: null }, 60);
}

async function fetchSuggestionProvider(provider: SuggestionProvider, query: string): Promise<string[]> {
  const endpoint = suggestionEndpoint(provider, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_800);

  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "User-Agent": "Mozilla/5.0 (compatible; ChisaNav/1.0)",
      },
    });
    if (!response.ok) return [];

    const text = await response.text();
    return parseSuggestionResponse(provider, text, query);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function suggestionEndpoint(provider: SuggestionProvider, query: string): string {
  const encoded = encodeURIComponent(query);
  switch (provider) {
    case "bing":
      return `https://api.bing.com/osjson.aspx?query=${encoded}&market=zh-CN`;
    case "baidu":
      return `https://suggestion.baidu.com/su?wd=${encoded}&action=opensearch&ie=UTF-8`;
    case "duckduckgo":
      return `https://duckduckgo.com/ac/?q=${encoded}&type=list`;
    default:
      return `https://suggestqueries.google.com/complete/search?client=firefox&hl=zh-CN&q=${encoded}`;
  }
}

function parseSuggestionResponse(provider: SuggestionProvider, text: string, query: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    let values: unknown[] = [];

    if (provider === "duckduckgo" && Array.isArray(parsed)) {
      values = parsed.map((item) => {
        if (item && typeof item === "object" && "phrase" in item) {
          return (item as { phrase?: unknown }).phrase;
        }
        return "";
      });
    } else if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
      values = parsed[1];
    }

    return sanitizeSuggestions(values, query);
  } catch {
    // 某些百度节点可能返回 JSONP；只提取回调括号中的 JSON 数组。
    const start = text.indexOf("(");
    const end = text.lastIndexOf(")");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start + 1, end)) as unknown;
        if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
          return sanitizeSuggestions(parsed[1], query);
        }
      } catch {
        return [];
      }
    }
    return [];
  }
}

function sanitizeSuggestions(values: unknown[], query: string): string[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;
    const suggestion = value.trim().replace(/\s+/g, " ").slice(0, 200);
    const key = suggestion.toLocaleLowerCase("zh-CN");
    if (!suggestion || key === normalizedQuery || seen.has(key)) continue;
    seen.add(key);
    result.push(suggestion);
    if (result.length >= 10) break;
  }
  return result;
}

async function setupAdmin(request: Request, env: Env): Promise<Response> {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS count FROM admins").first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) {
    return json({ ok: false, error: "管理员已经创建，初始化入口已关闭" }, 409);
  }

  if (!env.BOOTSTRAP_TOKEN) {
    return json({ ok: false, error: "尚未配置 BOOTSTRAP_TOKEN" }, 503);
  }

  const body = await readJson(request);
  const username = cleanText(body.username, 3, 32, "用户名");
  const password = cleanPassword(body.password);
  const bootstrapToken = cleanText(body.bootstrapToken, 8, 256, "初始化令牌");

  if (!safeEqual(bootstrapToken, env.BOOTSTRAP_TOKEN)) {
    return json({ ok: false, error: "初始化令牌不正确" }, 403);
  }

  const { hash, salt, iterations } = await hashPassword(password);
  const result = await env.DB.prepare(
    `INSERT INTO admins (username, password_hash, password_salt, password_iterations)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(username, hash, salt, iterations)
    .run();

  await writeAudit(env.DB, Number(result.meta.last_row_id), "admin.setup", "admin", String(result.meta.last_row_id), "创建首个管理员", clientIp(request));
  return json({ ok: true, message: "管理员创建成功，请登录" }, 201);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const username = cleanText(body.username, 1, 32, "用户名");
  const password = cleanPassword(body.password, false);
  const ip = clientIp(request);
  const isWhitelisted = await isIpWhitelisted(env.DB, ip);

  if (!isWhitelisted) {
    const attempt = await env.DB.prepare(
      "SELECT failed_count, blocked_until FROM login_attempts WHERE ip_address = ? AND username = ?",
    )
      .bind(ip, username)
      .first<{ failed_count: number; blocked_until: string | null }>();

    if (attempt?.blocked_until && new Date(attempt.blocked_until).getTime() > Date.now()) {
      return json(
        {
          ok: false,
          error: "登录尝试过多，该 IP 已暂时封禁",
          blockedUntil: attempt.blocked_until,
        },
        429,
      );
    }
  }

  const admin = await env.DB.prepare(
    `SELECT id, username, password_hash, password_salt, password_iterations
     FROM admins WHERE username = ? AND is_active = 1`,
  )
    .bind(username)
    .first<{
      id: number;
      username: string;
      password_hash: string;
      password_salt: string;
      password_iterations: number;
    }>();

  const valid = admin
    ? await verifyPassword(password, admin.password_hash, admin.password_salt, admin.password_iterations)
    : false;

  if (!valid || !admin) {
    if (!isWhitelisted) {
      const current = await env.DB.prepare(
        "SELECT failed_count, blocked_until FROM login_attempts WHERE ip_address = ? AND username = ?",
      )
        .bind(ip, username)
        .first<{ failed_count: number; blocked_until: string | null }>();

      const previousExpired = current?.blocked_until && new Date(current.blocked_until).getTime() <= Date.now();
      const failedCount = previousExpired ? 1 : Number(current?.failed_count ?? 0) + 1;
      const blockedUntil = failedCount >= LOGIN_FAILURE_LIMIT
        ? new Date(Date.now() + BLOCK_MINUTES * 60_000).toISOString()
        : null;

      await env.DB.prepare(
        `INSERT INTO login_attempts (ip_address, username, failed_count, blocked_until, last_attempt_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(ip_address, username) DO UPDATE SET
           failed_count = excluded.failed_count,
           blocked_until = excluded.blocked_until,
           last_attempt_at = CURRENT_TIMESTAMP`,
      )
        .bind(ip, username, failedCount, blockedUntil)
        .run();

      if (blockedUntil) {
        return json(
          {
            ok: false,
            error: `密码连续错误 ${LOGIN_FAILURE_LIMIT} 次，该 IP 已封禁 ${BLOCK_MINUTES} 分钟`,
            blockedUntil,
          },
          429,
        );
      }
    }

    return json({ ok: false, error: "用户名或密码不正确" }, 401);
  }

  await env.DB.prepare("DELETE FROM login_attempts WHERE ip_address = ? AND username = ?")
    .bind(ip, username)
    .run();

  const rawToken = randomToken(32);
  const tokenHash = await hashSessionToken(rawToken, env.SESSION_SECRET);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  const userAgent = (request.headers.get("User-Agent") ?? "").slice(0, 500);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sessions (admin_id, token_hash, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(admin.id, tokenHash, ip, userAgent, expiresAt),
    env.DB.prepare("UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(admin.id),
  ]);

  await writeAudit(env.DB, admin.id, "admin.login", "admin", String(admin.id), "后台登录", ip);

  const response = json({ ok: true, user: { id: admin.id, username: admin.username } });
  response.headers.append("Set-Cookie", sessionCookie(rawToken, SESSION_DAYS * 86_400, request));
  return response;
}

async function logout(request: Request, env: Env): Promise<Response> {
  const rawToken = getCookie(request, SESSION_COOKIE);
  if (rawToken) {
    const tokenHash = await hashSessionToken(rawToken, env.SESSION_SECRET);
    const session = await env.DB.prepare("SELECT admin_id FROM sessions WHERE token_hash = ?")
      .bind(tokenHash)
      .first<{ admin_id: number }>();
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    if (session) {
      await writeAudit(env.DB, session.admin_id, "admin.logout", "admin", String(session.admin_id), "退出后台", clientIp(request));
    }
  }

  const response = json({ ok: true });
  response.headers.append("Set-Cookie", clearSessionCookie(request));
  return response;
}

async function requireSession(request: Request, env: Env): Promise<SessionInfo> {
  const rawToken = getCookie(request, SESSION_COOKIE);
  if (!rawToken) throw new HttpError(401, "请先登录后台");

  const tokenHash = await hashSessionToken(rawToken, env.SESSION_SECRET);
  const row = await env.DB.prepare(
    `SELECT sessions.admin_id, admins.username
     FROM sessions
     JOIN admins ON admins.id = sessions.admin_id
     WHERE sessions.token_hash = ?
       AND sessions.expires_at > ?
       AND admins.is_active = 1`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first<{ admin_id: number; username: string }>();

  if (!row) throw new HttpError(401, "登录状态已失效，请重新登录");
  return { adminId: row.admin_id, username: row.username, tokenHash };
}

async function listGroups(db: D1Database): Promise<Response> {
  const result = await db.prepare("SELECT * FROM groups ORDER BY sort_order, id").all();
  return json({ ok: true, groups: result.results });
}

async function createGroup(request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  const name = cleanText(body.name, 1, 50, "分组名称");
  const description = cleanOptionalText(body.description, 200);
  const icon = cleanOptionalText(body.icon, 100);
  const isVisible = boolInt(body.isVisible, true);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM groups").first<{ max_order: number }>();
  const sortOrder = toInteger(body.sortOrder, Number(max?.max_order ?? 0) + 10, -1_000_000, 1_000_000);

  const result = await env.DB.prepare(
    `INSERT INTO groups (name, description, icon, sort_order, is_visible)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(name, description, icon, sortOrder, isVisible)
    .run();

  const id = Number(result.meta.last_row_id);
  await writeAudit(env.DB, session.adminId, "group.create", "group", String(id), name, clientIp(request));
  return json({ ok: true, id }, 201);
}

async function updateGroup(id: number, request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  const name = cleanText(body.name, 1, 50, "分组名称");
  const description = cleanOptionalText(body.description, 200);
  const icon = cleanOptionalText(body.icon, 100);
  const isVisible = boolInt(body.isVisible, true);
  const sortOrder = toInteger(body.sortOrder, 0, -1_000_000, 1_000_000);

  const result = await env.DB.prepare(
    `UPDATE groups SET name = ?, description = ?, icon = ?, sort_order = ?, is_visible = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(name, description, icon, sortOrder, isVisible, id)
    .run();

  if (!result.meta.changes) return json({ ok: false, error: "分组不存在" }, 404);
  await writeAudit(env.DB, session.adminId, "group.update", "group", String(id), name, clientIp(request));
  return json({ ok: true });
}

async function deleteGroup(id: number, env: Env, session: SessionInfo, request: Request): Promise<Response> {
  const row = await env.DB.prepare("SELECT name FROM groups WHERE id = ?").bind(id).first<{ name: string }>();
  if (!row) return json({ ok: false, error: "分组不存在" }, 404);

  await env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(id).run();
  await writeAudit(env.DB, session.adminId, "group.delete", "group", String(id), row.name, clientIp(request));
  return json({ ok: true });
}

async function reorderGroups(request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  const ids = cleanIdArray(body.ids);
  const statements = ids.map((id, index) =>
    env.DB.prepare("UPDATE groups SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind((index + 1) * 10, id)
  );
  if (statements.length) await env.DB.batch(statements);
  await writeAudit(env.DB, session.adminId, "group.reorder", "group", "", ids.join(","), clientIp(request));
  return json({ ok: true });
}

async function listLinks(db: D1Database): Promise<Response> {
  const result = await db.prepare(
    `SELECT links.*, groups.name AS group_name
     FROM links JOIN groups ON groups.id = links.group_id
     ORDER BY groups.sort_order, links.sort_order, links.id`,
  ).all();
  return json({ ok: true, links: result.results });
}

async function createLink(request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  const groupId = toInteger(body.groupId, 0, 1, Number.MAX_SAFE_INTEGER);
  await assertGroupExists(env.DB, groupId);
  const title = cleanText(body.title, 1, 80, "网站名称");
  const url = cleanHttpUrl(body.url, "网站地址");
  const description = cleanOptionalText(body.description, 300);
  const iconUrl = cleanOptionalUrl(body.iconUrl, 1000);
  const openInNewTab = boolInt(body.openInNewTab, true);
  const isVisible = boolInt(body.isVisible, true);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM links WHERE group_id = ?")
    .bind(groupId)
    .first<{ max_order: number }>();
  const sortOrder = toInteger(body.sortOrder, Number(max?.max_order ?? 0) + 10, -1_000_000, 1_000_000);

  const result = await env.DB.prepare(
    `INSERT INTO links (group_id, title, url, description, icon_url, open_in_new_tab, sort_order, is_visible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(groupId, title, url, description, iconUrl, openInNewTab, sortOrder, isVisible)
    .run();

  const id = Number(result.meta.last_row_id);
  await writeAudit(env.DB, session.adminId, "link.create", "link", String(id), `${title} ${url}`, clientIp(request));
  return json({ ok: true, id }, 201);
}

async function updateLink(id: number, request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  const groupId = toInteger(body.groupId, 0, 1, Number.MAX_SAFE_INTEGER);
  await assertGroupExists(env.DB, groupId);
  const title = cleanText(body.title, 1, 80, "网站名称");
  const url = cleanHttpUrl(body.url, "网站地址");
  const description = cleanOptionalText(body.description, 300);
  const iconUrl = cleanOptionalUrl(body.iconUrl, 1000);
  const openInNewTab = boolInt(body.openInNewTab, true);
  const sortOrder = toInteger(body.sortOrder, 0, -1_000_000, 1_000_000);
  const isVisible = boolInt(body.isVisible, true);

  const result = await env.DB.prepare(
    `UPDATE links SET group_id = ?, title = ?, url = ?, description = ?, icon_url = ?,
      open_in_new_tab = ?, sort_order = ?, is_visible = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(groupId, title, url, description, iconUrl, openInNewTab, sortOrder, isVisible, id)
    .run();

  if (!result.meta.changes) return json({ ok: false, error: "网址不存在" }, 404);
  await writeAudit(env.DB, session.adminId, "link.update", "link", String(id), `${title} ${url}`, clientIp(request));
  return json({ ok: true });
}

async function deleteLink(id: number, env: Env, session: SessionInfo, request: Request): Promise<Response> {
  const row = await env.DB.prepare("SELECT title, url FROM links WHERE id = ?").bind(id).first<{ title: string; url: string }>();
  if (!row) return json({ ok: false, error: "网址不存在" }, 404);

  await env.DB.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
  await writeAudit(env.DB, session.adminId, "link.delete", "link", String(id), `${row.title} ${row.url}`, clientIp(request));
  return json({ ok: true });
}

async function reorderLinks(request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  const groupId = toInteger(body.groupId, 0, 1, Number.MAX_SAFE_INTEGER);
  const ids = cleanIdArray(body.ids);
  const statements = ids.map((id, index) =>
    env.DB.prepare(
      "UPDATE links SET group_id = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(groupId, (index + 1) * 10, id)
  );
  if (statements.length) await env.DB.batch(statements);
  await writeAudit(env.DB, session.adminId, "link.reorder", "link", String(groupId), ids.join(","), clientIp(request));
  return json({ ok: true });
}

async function getSettings(db: D1Database): Promise<Response> {
  const result = await db.prepare("SELECT key, value, value_type FROM settings ORDER BY key").all();
  return json({ ok: true, settings: rowsToSettings(result.results as Array<Record<string, unknown>>) });
}

async function updateSettings(request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new HttpError(400, "设置数据格式不正确");
  }

  const values = settings as Record<string, unknown>;
  const normalized: Array<[string, string, string]> = [];

  for (const [key, raw] of Object.entries(values)) {
    if (!settingKeys.has(key)) continue;
    let value = String(raw ?? "").trim();
    let type = "text";

    if (["site_title", "site_subtitle", "greeting_name"].includes(key)) {
      value = cleanText(value, 0, 100, key, true);
    } else if (key === "default_search_engine") {
      if (!["google", "bing", "baidu", "github"].includes(value)) value = "google";
    } else if (key === "default_theme") {
      if (!["auto", "light", "dark"].includes(value)) value = "auto";
    } else if (key === "background_url") {
      value = cleanOptionalUrl(value, 2000);
    } else if (key === "card_opacity") {
      const n = clampNumber(value, 0.2, 1, 0.78);
      value = String(n);
      type = "number";
    } else if (key === "card_blur") {
      const n = clampNumber(value, 0, 40, 18);
      value = String(n);
      type = "number";
    }

    normalized.push([key, value, type]);
  }

  const statements = normalized.map(([key, value, type]) =>
    env.DB.prepare(
      `INSERT INTO settings (key, value, value_type, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, value_type = excluded.value_type, updated_at = CURRENT_TIMESTAMP`,
    ).bind(key, value, type)
  );

  if (statements.length) await env.DB.batch(statements);
  await writeAudit(env.DB, session.adminId, "settings.update", "settings", "", normalized.map(([key]) => key).join(","), clientIp(request));
  return json({ ok: true });
}

async function exportData(db: D1Database): Promise<Response> {
  const [groups, links, settings] = await db.batch([
    db.prepare("SELECT id, name, description, icon, sort_order, is_visible FROM groups ORDER BY sort_order, id"),
    db.prepare(
      `SELECT id, group_id, title, url, description, icon_url, open_in_new_tab, sort_order, is_visible
       FROM links ORDER BY group_id, sort_order, id`,
    ),
    db.prepare("SELECT key, value, value_type FROM settings ORDER BY key"),
  ]);

  const payload = {
    format: "chisa-nav-backup-v1",
    exportedAt: new Date().toISOString(),
    groups: groups.results,
    links: links.results,
    settings: settings.results,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="chisa-nav-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

async function importData(request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  if (body.format !== "chisa-nav-backup-v1") {
    throw new HttpError(400, "不是受支持的导航备份文件");
  }

  const groups = Array.isArray(body.groups) ? body.groups : [];
  const links = Array.isArray(body.links) ? body.links : [];
  const settings = Array.isArray(body.settings) ? body.settings : [];

  if (groups.length > 500 || links.length > 5000 || settings.length > 100) {
    throw new HttpError(400, "备份内容数量过多");
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM groups"),
    env.DB.prepare("DELETE FROM settings"),
  ];

  for (const raw of groups) {
    const item = raw as Record<string, unknown>;
    statements.push(
      env.DB.prepare(
        `INSERT INTO groups (id, name, description, icon, sort_order, is_visible)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        toInteger(item.id, 0, 1, Number.MAX_SAFE_INTEGER),
        cleanText(item.name, 1, 50, "分组名称"),
        cleanOptionalText(item.description, 200),
        cleanOptionalText(item.icon, 100),
        toInteger(item.sort_order, 0, -1_000_000, 1_000_000),
        boolInt(item.is_visible, true),
      ),
    );
  }

  const groupIds = new Set(groups.map((item) => Number((item as Record<string, unknown>).id)));
  for (const raw of links) {
    const item = raw as Record<string, unknown>;
    const groupId = toInteger(item.group_id, 0, 1, Number.MAX_SAFE_INTEGER);
    if (!groupIds.has(groupId)) throw new HttpError(400, "备份中的网址引用了不存在的分组");
    statements.push(
      env.DB.prepare(
        `INSERT INTO links (id, group_id, title, url, description, icon_url, open_in_new_tab, sort_order, is_visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        toInteger(item.id, 0, 1, Number.MAX_SAFE_INTEGER),
        groupId,
        cleanText(item.title, 1, 80, "网站名称"),
        cleanHttpUrl(item.url, "网站地址"),
        cleanOptionalText(item.description, 300),
        cleanOptionalUrl(item.icon_url, 1000),
        boolInt(item.open_in_new_tab, true),
        toInteger(item.sort_order, 0, -1_000_000, 1_000_000),
        boolInt(item.is_visible, true),
      ),
    );
  }

  for (const raw of settings) {
    const item = raw as Record<string, unknown>;
    const key = String(item.key ?? "");
    if (!settingKeys.has(key)) continue;
    statements.push(
      env.DB.prepare("INSERT INTO settings (key, value, value_type) VALUES (?, ?, ?)").bind(
        key,
        String(item.value ?? "").slice(0, 2000),
        String(item.value_type ?? "text").slice(0, 20),
      ),
    );
  }

  await env.DB.batch(statements);
  await writeAudit(env.DB, session.adminId, "backup.import", "backup", "", `${groups.length} groups, ${links.length} links`, clientIp(request));
  return json({ ok: true, message: "备份导入成功" });
}

async function listBlocked(db: D1Database): Promise<Response> {
  const result = await db.prepare(
    `SELECT id, ip_address, username, failed_count, blocked_until, last_attempt_at
     FROM login_attempts
     WHERE blocked_until IS NOT NULL AND blocked_until > ?
     ORDER BY blocked_until DESC`,
  )
    .bind(new Date().toISOString())
    .all();
  return json({ ok: true, blocked: result.results });
}

async function unblockIp(ip: string, env: Env, session: SessionInfo, request: Request): Promise<Response> {
  if (!ip || ip.length > 100) throw new HttpError(400, "IP 地址不正确");
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip_address = ?").bind(ip).run();
  await writeAudit(env.DB, session.adminId, "security.unblock", "ip", ip, "解除封禁", clientIp(request));
  return json({ ok: true });
}

async function listWhitelist(db: D1Database): Promise<Response> {
  const result = await db.prepare("SELECT * FROM ip_whitelist ORDER BY created_at DESC").all();
  return json({ ok: true, whitelist: result.results });
}

async function addWhitelist(request: Request, env: Env, session: SessionInfo): Promise<Response> {
  const body = await readJson(request);
  const ip = cleanText(body.ipAddress, 2, 100, "IP 地址");
  const note = cleanOptionalText(body.note, 200);
  try {
    const result = await env.DB.prepare("INSERT INTO ip_whitelist (ip_address, note) VALUES (?, ?)")
      .bind(ip, note)
      .run();
    const id = Number(result.meta.last_row_id);
    await writeAudit(env.DB, session.adminId, "security.whitelist.add", "ip", ip, note, clientIp(request));
    return json({ ok: true, id }, 201);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ ok: false, error: "该 IP 已在白名单中" }, 409);
    throw error;
  }
}

async function deleteWhitelist(id: number, env: Env, session: SessionInfo, request: Request): Promise<Response> {
  const row = await env.DB.prepare("SELECT ip_address FROM ip_whitelist WHERE id = ?").bind(id).first<{ ip_address: string }>();
  if (!row) return json({ ok: false, error: "白名单记录不存在" }, 404);
  await env.DB.prepare("DELETE FROM ip_whitelist WHERE id = ?").bind(id).run();
  await writeAudit(env.DB, session.adminId, "security.whitelist.delete", "ip", row.ip_address, "", clientIp(request));
  return json({ ok: true });
}

async function listAuditLogs(db: D1Database, url: URL): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 300);
  const result = await db.prepare(
    `SELECT audit_logs.*, admins.username
     FROM audit_logs LEFT JOIN admins ON admins.id = audit_logs.admin_id
     ORDER BY audit_logs.id DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return json({ ok: true, logs: result.results });
}

async function writeAudit(
  db: D1Database,
  adminId: number | null,
  action: string,
  targetType: string,
  targetId: string,
  details: string,
  ip: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_logs (admin_id, action, target_type, target_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(adminId, action, targetType, targetId, details.slice(0, 1000), ip)
    .run();
}

async function cleanupExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();
}

async function isIpWhitelisted(db: D1Database, ip: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM ip_whitelist WHERE ip_address = ?").bind(ip).first();
  return Boolean(row);
}

async function assertGroupExists(db: D1Database, id: number): Promise<void> {
  const row = await db.prepare("SELECT 1 AS found FROM groups WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(400, "所选分组不存在");
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100_000;
  const hash = await derivePassword(password, saltBytes, iterations);
  return { hash: bytesToBase64(hash), salt: bytesToBase64(saltBytes), iterations };
}

async function verifyPassword(password: string, expectedHash: string, salt: string, iterations: number): Promise<boolean> {
  const actual = await derivePassword(password, base64ToBytes(salt), iterations);
  return safeEqual(bytesToBase64(actual), expectedHash);
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);

  // TypeScript 5.9+ distinguishes ArrayBuffer-backed views from
  // SharedArrayBuffer-backed views. Copy the salt so Web Crypto receives
  // a Uint8Array that is definitely backed by ArrayBuffer.
  const saltCopy: Uint8Array<ArrayBuffer> = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltCopy, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

async function hashSessionToken(token: string, secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${secret}.${token}`));
  return bytesToBase64(new Uint8Array(digest));
}

function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return bytesToBase64Url(bytes);
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function sessionCookie(token: string, maxAge: number, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Strict`;
}

function clearSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly${secure}; SameSite=Strict`;
}

function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "local"
  ).slice(0, 100);
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const expected = new URL(request.url).origin;
  if (origin !== expected) throw new HttpError(403, "跨站请求已被拒绝");
}

async function readJson(request: Request): Promise<JsonRecord> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_JSON_BYTES) throw new HttpError(413, "请求内容过大");
  try {
    const data = await request.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid");
    return data as JsonRecord;
  } catch {
    throw new HttpError(400, "JSON 数据格式不正确");
  }
}

function rowsToSettings(rows: Array<Record<string, unknown>>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const row of rows) {
    const key = String(row.key ?? "");
    const value = String(row.value ?? "");
    result[key] = row.value_type === "number" ? Number(value) : value;
  }
  return result;
}

function cleanText(value: unknown, min: number, max: number, label: string, allowEmpty = false): string {
  const text = String(value ?? "").trim();
  if ((!allowEmpty && text.length < min) || text.length > max) {
    throw new HttpError(400, `${label}长度应为 ${min}-${max} 个字符`);
  }
  return text;
}

function cleanOptionalText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function cleanPassword(value: unknown, enforceStrong = true): string {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, "密码长度应为 8-128 个字符");
  }
  if (enforceStrong && (!/[A-Za-z]/.test(password) || !/\d/.test(password))) {
    throw new HttpError(400, "密码至少需要同时包含字母和数字");
  }
  return password;
}

function cleanHttpUrl(value: unknown, label: string): string {
  const text = cleanText(value, 4, 2000, label);
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    return url.toString();
  } catch {
    throw new HttpError(400, `${label}必须是 http:// 或 https:// 地址`);
  }
}

function cleanOptionalUrl(value: unknown, max: number): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length > max) throw new HttpError(400, "URL 过长");
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    return url.toString();
  } catch {
    throw new HttpError(400, "图标或背景地址必须是 http:// 或 https:// 地址");
  }
}

function boolInt(value: unknown, fallback: boolean): number {
  if (value === undefined || value === null || value === "") return fallback ? 1 : 0;
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

function toInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, "数字参数不正确");
  return n;
}

function cleanIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) throw new HttpError(400, "排序数据格式不正确");
  const ids = value.map((item) => toInteger(item, 0, 1, Number.MAX_SAFE_INTEGER));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "排序数据包含重复 ID");
  return ids;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeEqual(a: string, b: string): boolean {
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function cachedJson(data: unknown, maxAge: number): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${Math.min(maxAge, 60)}, s-maxage=${maxAge}`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
