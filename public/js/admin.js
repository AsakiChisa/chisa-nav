const state = {
  user: null,
  groups: [],
  links: [],
  settings: {},
  whitelist: [],
  blocked: [],
  logs: [],
  needsSetup: false,
};

const authView = document.querySelector("#authView");
const dashboardView = document.querySelector("#dashboardView");
const groupDialog = document.querySelector("#groupDialog");
const linkDialog = document.querySelector("#linkDialog");
const whitelistDialog = document.querySelector("#whitelistDialog");

async function api(path, options = {}) {
  const config = {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(options.headers || {}) },
    ...options,
  };
  if (config.body && !(config.body instanceof FormData) && typeof config.body !== "string") {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(path, config);
  const contentType = response.headers.get("Content-Type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  document.querySelector("#toastRoot").append(el);
  setTimeout(() => el.remove(), 3600);
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(String(value).includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function initialize() {
  try {
    const session = await api("/api/admin/session");
    state.user = session.user;
    await enterDashboard();
  } catch (error) {
    if (error.status !== 401) toast(error.message, "error");
    await showAuth();
  }
}

async function showAuth() {
  authView.hidden = false;
  dashboardView.hidden = true;
  try {
    const result = await api("/api/admin/setup-status");
    state.needsSetup = Boolean(result.needsSetup);
  } catch (error) {
    state.needsSetup = false;
    document.querySelector("#authHint").textContent = error.message;
  }

  document.querySelector("#bootstrapField").hidden = !state.needsSetup;
  document.querySelector("#authTitle").textContent = state.needsSetup ? "创建首个管理员" : "管理后台";
  document.querySelector("#authDescription").textContent = state.needsSetup
    ? "数据库已经准备好，现在创建后台管理员账号。"
    : "登录后管理分组、网址和首页外观。";
  document.querySelector("#authSubmit").textContent = state.needsSetup ? "创建管理员" : "登录";
  document.querySelector("#authPassword").autocomplete = state.needsSetup ? "new-password" : "current-password";
  document.querySelector("#authHint").textContent = state.needsSetup
    ? "密码至少 8 位，并同时包含字母和数字。"
    : "连续输错 3 次会暂时封禁当前 IP。";
}

async function enterDashboard() {
  authView.hidden = true;
  dashboardView.hidden = false;
  document.querySelector("#currentUser").textContent = state.user.username;
  document.querySelector("#statUser").textContent = state.user.username;
  await loadCoreData();
  await Promise.allSettled([loadSecurity(), loadLogs()]);
}

async function loadCoreData() {
  const [groups, links, settings] = await Promise.all([
    api("/api/admin/groups"),
    api("/api/admin/links"),
    api("/api/admin/settings"),
  ]);
  state.groups = groups.groups || [];
  state.links = links.links || [];
  state.settings = settings.settings || {};
  renderAll();
}

function renderAll() {
  renderOverview();
  renderGroupOptions();
  renderGroups();
  renderLinks();
  renderSettings();
}

function renderOverview() {
  document.querySelector("#statGroups").textContent = state.groups.length;
  document.querySelector("#statLinks").textContent = state.links.length;
  document.querySelector("#statVisible").textContent = state.links.filter((item) => Number(item.is_visible) === 1).length;
}

function renderGroupOptions() {
  const filter = document.querySelector("#linkGroupFilter");
  const selected = filter.value;
  filter.innerHTML = '<option value="all">全部分组</option>' + state.groups
    .map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`)
    .join("");
  filter.value = [...filter.options].some((option) => option.value === selected) ? selected : "all";

  const select = document.querySelector('#linkForm select[name="groupId"]');
  const old = select.value;
  select.innerHTML = state.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  if ([...select.options].some((option) => option.value === old)) select.value = old;
}

function renderGroups() {
  const container = document.querySelector("#groupsList");
  if (!state.groups.length) {
    container.innerHTML = '<div class="empty-row">还没有分组，请先新增一个。</div>';
    return;
  }
  container.innerHTML = state.groups.map((group) => `
    <div class="sortable-row" draggable="true" data-group-id="${group.id}">
      <span class="drag-handle" title="拖动排序">⋮⋮</span>
      <div class="row-main"><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.icon || "未设置图标标识")}</small></div>
      <div class="row-secondary">${escapeHtml(group.description || "暂无说明")}</div>
      <span class="badge ${Number(group.is_visible) === 1 ? "visible" : "hidden"}">${Number(group.is_visible) === 1 ? "显示中" : "已隐藏"}</span>
      <div class="row-actions"><button class="text-button" data-edit-group="${group.id}">编辑</button><button class="text-button danger" data-delete-group="${group.id}">删除</button></div>
    </div>
  `).join("");
  bindGroupDrag();
}

function renderLinks() {
  const container = document.querySelector("#linksContainer");
  const filter = document.querySelector("#linkGroupFilter").value;
  const keyword = document.querySelector("#linkSearch").value.trim().toLowerCase();
  const groups = filter === "all" ? state.groups : state.groups.filter((group) => String(group.id) === filter);

  let html = "";
  for (const group of groups) {
    const links = state.links.filter((link) => {
      if (Number(link.group_id) !== Number(group.id)) return false;
      if (!keyword) return true;
      return `${link.title} ${link.url} ${link.description || ""}`.toLowerCase().includes(keyword);
    });
    if (!links.length && (keyword || filter !== "all")) continue;
    html += `
      <div class="panel link-group-panel" data-link-group="${group.id}">
        <div class="link-group-heading"><h3>${escapeHtml(group.name)}</h3><span>${links.length} 个网址</span></div>
        <div class="sortable-list link-sortable-list">
          ${links.length ? links.map((link) => `
            <div class="sortable-row link-row" draggable="true" data-link-id="${link.id}" data-group-id="${group.id}">
              <span class="drag-handle" title="拖动排序">⋮⋮</span>
              <div class="row-main"><strong>${escapeHtml(link.title)}</strong><small>${escapeHtml(link.description || "暂无说明")}</small></div>
              <div class="link-url" title="${escapeHtml(link.url)}">${escapeHtml(link.url)}</div>
              <span class="badge ${Number(link.is_visible) === 1 ? "visible" : "hidden"}">${Number(link.is_visible) === 1 ? "显示中" : "已隐藏"}</span>
              <div class="row-actions"><button class="text-button" data-edit-link="${link.id}">编辑</button><button class="text-button danger" data-delete-link="${link.id}">删除</button></div>
            </div>
          `).join("") : '<div class="empty-row">这个分组还没有网址。</div>'}
        </div>
      </div>`;
  }
  container.innerHTML = html || '<div class="panel empty-row">没有符合条件的网址。</div>';
  bindLinkDrag();
}

function renderSettings() {
  const form = document.querySelector("#settingsForm");
  for (const [key, value] of Object.entries(state.settings)) {
    const field = form.elements.namedItem(key);
    if (field) field.value = value;
  }
  updateRangeLabels();
}

async function loadSecurity() {
  const [whitelist, blocked] = await Promise.all([
    api("/api/admin/security/whitelist"),
    api("/api/admin/security/blocked"),
  ]);
  state.whitelist = whitelist.whitelist || [];
  state.blocked = blocked.blocked || [];
  renderSecurity();
}

function renderSecurity() {
  const whitelist = document.querySelector("#whitelistList");
  whitelist.innerHTML = state.whitelist.length ? state.whitelist.map((item) => `
    <div class="simple-item"><div><strong>${escapeHtml(item.ip_address)}</strong><small>${escapeHtml(item.note || "无备注")} · ${formatDate(item.created_at)}</small></div><button class="text-button danger" data-delete-whitelist="${item.id}">删除</button></div>
  `).join("") : '<div class="empty-row">白名单为空。</div>';

  const blocked = document.querySelector("#blockedList");
  blocked.innerHTML = state.blocked.length ? state.blocked.map((item) => `
    <div class="simple-item"><div><strong>${escapeHtml(item.ip_address)}</strong><small>用户名：${escapeHtml(item.username || "-")} · 到期：${formatDate(item.blocked_until)}</small></div><button class="text-button" data-unblock-ip="${encodeURIComponent(item.ip_address)}">解封</button></div>
  `).join("") : '<div class="empty-row">当前没有被封禁的 IP。</div>';
}

async function loadLogs() {
  const result = await api("/api/admin/audit-logs?limit=200");
  state.logs = result.logs || [];
  renderLogs();
}

function renderLogs() {
  const container = document.querySelector("#logsList");
  container.innerHTML = state.logs.length ? state.logs.map((log) => `
    <div class="log-item">
      <span>${formatDate(log.created_at)}</span>
      <span class="log-action">${escapeHtml(log.action)}</span>
      <span class="log-details">${escapeHtml(log.details || `${log.target_type || ""} ${log.target_id || ""}`)}</span>
      <span>${escapeHtml(log.ip_address || "-")}</span>
    </div>
  `).join("") : '<div class="empty-row">暂无操作日志。</div>';
}

function goPage(name) {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === name));
  document.querySelectorAll(".page").forEach((panel) => panel.classList.toggle("active", panel.dataset.pagePanel === name));
  const labels = {
    overview: ["概览", "管理你的浏览器快速导航主页"],
    groups: ["分组管理", "创建分类并调整展示顺序"],
    links: ["网址管理", "添加、编辑和整理快速入口"],
    appearance: ["外观设置", "调整标题、背景与主题"],
    security: ["安全设置", "管理封禁记录和 IP 白名单"],
    logs: ["操作日志", "查看最近的后台操作"],
    backup: ["备份恢复", "导出或恢复导航配置"],
  };
  document.querySelector("#pageTitle").textContent = labels[name][0];
  document.querySelector("#pageSubtitle").textContent = labels[name][1];
  document.querySelector(".sidebar").classList.remove("open");
}

function openGroupDialog(group = null) {
  const form = document.querySelector("#groupForm");
  form.reset();
  form.elements.id.value = group?.id || "";
  form.elements.name.value = group?.name || "";
  form.elements.description.value = group?.description || "";
  form.elements.icon.value = group?.icon || "";
  form.elements.isVisible.checked = group ? Number(group.is_visible) === 1 : true;
  document.querySelector("#groupDialogTitle").textContent = group ? "编辑分组" : "新增分组";
  groupDialog.showModal();
}

function openLinkDialog(link = null) {
  if (!state.groups.length) {
    toast("请先创建一个分组", "error");
    goPage("groups");
    return;
  }
  const form = document.querySelector("#linkForm");
  form.reset();
  renderGroupOptions();
  form.elements.id.value = link?.id || "";
  form.elements.title.value = link?.title || "";
  form.elements.groupId.value = link?.group_id || state.groups[0].id;
  form.elements.url.value = link?.url || "";
  form.elements.description.value = link?.description || "";
  form.elements.iconUrl.value = link?.icon_url || "";
  form.elements.openInNewTab.checked = link ? Number(link.open_in_new_tab) === 1 : true;
  form.elements.isVisible.checked = link ? Number(link.is_visible) === 1 : true;
  document.querySelector("#linkDialogTitle").textContent = link ? "编辑网址" : "新增网址";
  linkDialog.showModal();
}

function bindGroupDrag() {
  let dragged = null;
  document.querySelectorAll("[data-group-id]").forEach((row) => {
    row.addEventListener("dragstart", () => { dragged = row; row.classList.add("dragging"); });
    row.addEventListener("dragend", async () => {
      row.classList.remove("dragging");
      document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      const ids = [...document.querySelectorAll("#groupsList [data-group-id]")].map((el) => Number(el.dataset.groupId));
      try {
        await api("/api/admin/groups/reorder", { method: "POST", body: { ids } });
        await loadCoreData();
        toast("分组顺序已保存");
      } catch (error) { toast(error.message, "error"); }
      dragged = null;
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === row) return;
      row.classList.add("drag-over");
      const rect = row.getBoundingClientRect();
      row.parentElement.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  });
}

function bindLinkDrag() {
  let dragged = null;
  document.querySelectorAll("[data-link-id]").forEach((row) => {
    row.addEventListener("dragstart", () => { dragged = row; row.classList.add("dragging"); });
    row.addEventListener("dragend", async () => {
      row.classList.remove("dragging");
      document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      const groupId = Number(row.dataset.groupId);
      const ids = [...document.querySelectorAll(`[data-link-group="${groupId}"] [data-link-id]`)].map((el) => Number(el.dataset.linkId));
      try {
        await api("/api/admin/links/reorder", { method: "POST", body: { groupId, ids } });
        await loadCoreData();
        toast("网址顺序已保存");
      } catch (error) { toast(error.message, "error"); }
      dragged = null;
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === row || dragged.dataset.groupId !== row.dataset.groupId) return;
      row.classList.add("drag-over");
      const rect = row.getBoundingClientRect();
      row.parentElement.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  });
}

function updateRangeLabels() {
  const form = document.querySelector("#settingsForm");
  document.querySelector("#opacityValue").textContent = Number(form.elements.card_opacity.value || 0.78).toFixed(2);
  document.querySelector("#blurValue").textContent = `${form.elements.card_blur.value || 18}px`;
}

document.querySelector("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#authSubmit");
  button.disabled = true;
  document.querySelector("#authHint").textContent = "正在处理…";
  try {
    const body = {
      username: document.querySelector("#authUsername").value,
      password: document.querySelector("#authPassword").value,
    };
    if (state.needsSetup) body.bootstrapToken = document.querySelector("#bootstrapToken").value;
    if (state.needsSetup) {
      await api("/api/admin/setup", { method: "POST", body });
      toast("管理员创建成功，请登录");
      state.needsSetup = false;
      document.querySelector("#authPassword").value = "";
      document.querySelector("#bootstrapToken").value = "";
      await showAuth();
    } else {
      const result = await api("/api/admin/login", { method: "POST", body });
      state.user = result.user;
      await enterDashboard();
      toast("登录成功");
    }
  } catch (error) {
    let message = error.message;
    if (error.data?.blockedUntil) message += `，解封时间：${formatDate(error.data.blockedUntil)}`;
    document.querySelector("#authHint").textContent = message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  try { await api("/api/admin/logout", { method: "POST", body: {} }); } catch {}
  state.user = null;
  await showAuth();
});

document.querySelector("#sidebarNav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (button) goPage(button.dataset.page);
});
document.querySelectorAll("[data-go-page]").forEach((button) => button.addEventListener("click", () => goPage(button.dataset.goPage)));
document.querySelector("#mobileMenuButton").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));

document.querySelector("#addGroupButton").addEventListener("click", () => openGroupDialog());
document.querySelector("#addLinkButton").addEventListener("click", () => openLinkDialog());
document.querySelector("#addWhitelistButton").addEventListener("click", () => { document.querySelector("#whitelistForm").reset(); whitelistDialog.showModal(); });

document.querySelector("#groupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return groupDialog.close();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const body = {
    name: form.elements.name.value,
    description: form.elements.description.value,
    icon: form.elements.icon.value,
    isVisible: form.elements.isVisible.checked,
    sortOrder: id ? state.groups.find((item) => String(item.id) === id)?.sort_order : undefined,
  };
  try {
    await api(id ? `/api/admin/groups/${id}` : "/api/admin/groups", { method: id ? "PUT" : "POST", body });
    groupDialog.close();
    await loadCoreData();
    toast(id ? "分组已更新" : "分组已创建");
  } catch (error) { toast(error.message, "error"); }
});

document.querySelector("#linkForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return linkDialog.close();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const body = {
    title: form.elements.title.value,
    groupId: Number(form.elements.groupId.value),
    url: form.elements.url.value,
    description: form.elements.description.value,
    iconUrl: form.elements.iconUrl.value,
    openInNewTab: form.elements.openInNewTab.checked,
    isVisible: form.elements.isVisible.checked,
    sortOrder: id ? state.links.find((item) => String(item.id) === id)?.sort_order : undefined,
  };
  try {
    await api(id ? `/api/admin/links/${id}` : "/api/admin/links", { method: id ? "PUT" : "POST", body });
    linkDialog.close();
    await loadCoreData();
    toast(id ? "网址已更新" : "网址已创建");
  } catch (error) { toast(error.message, "error"); }
});

document.querySelector("#whitelistForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") return whitelistDialog.close();
  const form = event.currentTarget;
  try {
    await api("/api/admin/security/whitelist", { method: "POST", body: { ipAddress: form.elements.ipAddress.value, note: form.elements.note.value } });
    whitelistDialog.close();
    await loadSecurity();
    toast("IP 已加入白名单");
  } catch (error) { toast(error.message, "error"); }
});

document.addEventListener("click", async (event) => {
  const editGroup = event.target.closest("[data-edit-group]");
  if (editGroup) return openGroupDialog(state.groups.find((item) => Number(item.id) === Number(editGroup.dataset.editGroup)));
  const editLink = event.target.closest("[data-edit-link]");
  if (editLink) return openLinkDialog(state.links.find((item) => Number(item.id) === Number(editLink.dataset.editLink)));

  const deleteGroup = event.target.closest("[data-delete-group]");
  if (deleteGroup) {
    const group = state.groups.find((item) => Number(item.id) === Number(deleteGroup.dataset.deleteGroup));
    if (!confirm(`确定删除分组“${group.name}”吗？其中的网址也会一起删除。`)) return;
    try { await api(`/api/admin/groups/${group.id}`, { method: "DELETE" }); await loadCoreData(); toast("分组已删除"); } catch (error) { toast(error.message, "error"); }
    return;
  }

  const deleteLink = event.target.closest("[data-delete-link]");
  if (deleteLink) {
    const link = state.links.find((item) => Number(item.id) === Number(deleteLink.dataset.deleteLink));
    if (!confirm(`确定删除网址“${link.title}”吗？`)) return;
    try { await api(`/api/admin/links/${link.id}`, { method: "DELETE" }); await loadCoreData(); toast("网址已删除"); } catch (error) { toast(error.message, "error"); }
    return;
  }

  const deleteWhitelist = event.target.closest("[data-delete-whitelist]");
  if (deleteWhitelist) {
    if (!confirm("确定从白名单中删除这个 IP 吗？")) return;
    try { await api(`/api/admin/security/whitelist/${deleteWhitelist.dataset.deleteWhitelist}`, { method: "DELETE" }); await loadSecurity(); toast("白名单记录已删除"); } catch (error) { toast(error.message, "error"); }
    return;
  }

  const unblock = event.target.closest("[data-unblock-ip]");
  if (unblock) {
    try { await api(`/api/admin/security/blocked/${unblock.dataset.unblockIp}`, { method: "DELETE" }); await loadSecurity(); toast("IP 已解除封禁"); } catch (error) { toast(error.message, "error"); }
  }
});

document.querySelector("#linkGroupFilter").addEventListener("change", renderLinks);
document.querySelector("#linkSearch").addEventListener("input", renderLinks);

document.querySelector("#settingsForm").addEventListener("input", updateRangeLabels);
document.querySelector("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await api("/api/admin/settings", { method: "PUT", body: { settings: data } });
    const result = await api("/api/admin/settings");
    state.settings = result.settings;
    renderSettings();
    toast("外观设置已保存");
  } catch (error) { toast(error.message, "error"); }
});

document.querySelector("#refreshBlockedButton").addEventListener("click", async () => { try { await loadSecurity(); toast("安全记录已刷新"); } catch (error) { toast(error.message, "error"); } });
document.querySelector("#refreshLogsButton").addEventListener("click", async () => { try { await loadLogs(); toast("日志已刷新"); } catch (error) { toast(error.message, "error"); } });

document.querySelector("#exportButton").addEventListener("click", () => { window.location.href = "/api/admin/export"; });
document.querySelector("#importButton").addEventListener("click", async () => {
  const file = document.querySelector("#importFile").files[0];
  if (!file) return toast("请先选择 JSON 备份文件", "error");
  if (!confirm("导入会替换现有分组、网址和设置，确定继续吗？")) return;
  try {
    const body = JSON.parse(await file.text());
    await api("/api/admin/import", { method: "POST", body });
    await loadCoreData();
    toast("备份导入成功");
  } catch (error) { toast(error.message || "备份文件格式不正确", "error"); }
});

initialize();
