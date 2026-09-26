const searchEngines = {
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  baidu: { name: "百度", url: "https://www.baidu.com/s?wd=" },
  github: { name: "GitHub", url: "https://github.com/search?q=" },
};

const SEARCH_HISTORY_KEY = "chisa-nav-search-history-v1";
const MAX_SEARCH_HISTORY = 40;
const MAX_SUGGESTIONS = 10;
const SUGGEST_DEBOUNCE_MS = 180;

const state = {
  settings: {},
  groups: [],
  links: [],
  suggestions: [],
  activeSuggestionIndex: -1,
  suggestionRequestId: 0,
  activeCategory: localStorage.getItem("chisa-nav-active-category") || "all",
};

const root = document.documentElement;
const navigationRoot = document.querySelector("#navigationRoot");
const categoryBar = document.querySelector("#categoryBar");
const categoryTabs = document.querySelector("#categoryTabs");
const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#searchInput");
const searchEngine = document.querySelector("#searchEngine");
const searchInputWrap = document.querySelector("#searchInputWrap");
const suggestionList = document.querySelector("#suggestionList");
const suggestionStatus = document.querySelector("#suggestionStatus");
const themeButton = document.querySelector("#themeButton");
let suggestionTimer = null;

function applyTheme(theme) {
  const requested = ["auto", "light", "dark"].includes(theme) ? theme : "auto";
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = requested === "auto" ? (prefersDark ? "dark" : "light") : requested;

  root.dataset.theme = resolved;
  localStorage.setItem("chisa-nav-theme", requested);

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", resolved === "dark" ? "#171b24" : "#f4f6fa");

  if (themeButton) {
    themeButton.disabled = false;
    themeButton.textContent = resolved === "dark" ? "☀" : "◐";
    const modeText = requested === "auto" ? `跟随系统（当前${resolved === "dark" ? "深色" : "浅色"}）` : (resolved === "dark" ? "深色" : "浅色");
    themeButton.title = `${modeText}，点击切换主题`;
    themeButton.setAttribute("aria-label", `${modeText}，点击切换主题`);
  }
}

function cycleTheme() {
  const current = localStorage.getItem("chisa-nav-theme") || state.settings.default_theme || "auto";
  const order = ["auto", "light", "dark"];
  const index = order.indexOf(current);
  applyTheme(order[(index < 0 ? 0 : index + 1) % order.length]);
}

function updateClock() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 6 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const name = state.settings.greeting_name || "浅咲";
  document.querySelector("#greetingText").textContent = `${greeting}，${name}`;
  document.querySelector("#clockText").textContent = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  document.querySelector("#dateText").textContent = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(now);
}

function faviconFor(link) {
  if (link.icon_url) return link.icon_url;
  try {
    return `${new URL(link.url).origin}/favicon.ico`;
  } catch {
    return "";
  }
}

function visibleGroupsWithLinks() {
  return state.groups.filter((group) =>
    state.links.some((link) => Number(link.group_id) === Number(group.id)),
  );
}

function categoryKey(groupId) {
  return `group:${Number(groupId)}`;
}

function displayGroupName(group) {
  const name = String(group?.name || "").trim();
  if (["常用网站", "常用网址", "常用链接"].includes(name)) return "常用";
  return name || "未命名";
}

function resolveActiveCategory(groups) {
  const valid = new Set(["all", ...groups.map((group) => categoryKey(group.id))]);
  if (!valid.has(state.activeCategory)) state.activeCategory = "all";
}

function renderCategoryTabs() {
  const groups = visibleGroupsWithLinks();
  resolveActiveCategory(groups);
  categoryTabs.innerHTML = "";

  if (!groups.length) {
    categoryBar.hidden = true;
    return;
  }

  const items = [
    { key: "all", label: "全部", count: state.links.length },
    ...groups.map((group) => ({
      key: categoryKey(group.id),
      label: displayGroupName(group),
      count: state.links.filter((link) => Number(link.group_id) === Number(group.id)).length,
    })),
  ];

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-tab";
    button.dataset.category = item.key;
    button.setAttribute("role", "tab");
    const active = item.key === state.activeCategory;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.innerHTML = `<span>${escapeHtml(item.label)}</span><small>${item.count}</small>`;
    button.addEventListener("click", () => {
      state.activeCategory = item.key;
      localStorage.setItem("chisa-nav-active-category", item.key);
      renderCategoryTabs();
      renderNavigation();
      categoryTabs.querySelector(".category-tab.is-active")?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    });
    categoryTabs.append(button);
  }

  categoryBar.hidden = false;
}

function createDashboardLinkCard(link, group, template) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.href = link.url;
  card.target = Number(link.open_in_new_tab) === 1 ? "_blank" : "_self";
  card.rel = "noopener noreferrer";
  card.title = link.description || `${link.title} · ${safeHostname(link.url)}`;
  card.querySelector(".link-title").textContent = link.title;
  card.querySelector(".link-description").textContent = link.description || safeHostname(link.url);

  const groupTag = card.querySelector(".link-group-tag");
  groupTag.textContent = group ? displayGroupName(group) : "";
  groupTag.hidden = true;

  const icon = card.querySelector(".link-icon");
  const iconWrap = card.querySelector(".link-icon-wrap");
  card.querySelector(".link-icon-fallback").textContent = (link.title || "?").slice(0, 1).toUpperCase();
  const iconUrl = faviconFor(link);
  if (!iconUrl) {
    iconWrap.classList.add("is-fallback");
  } else {
    icon.src = iconUrl;
    icon.addEventListener("error", () => iconWrap.classList.add("is-fallback"), { once: true });
  }
  return card;
}

function renderDashboardGroup(group, links, template, { single = false } = {}) {
  const section = document.createElement("section");
  section.className = `dashboard-group${single ? " is-single" : ""}`;

  const heading = document.createElement("div");
  heading.className = "dashboard-group-heading";
  const title = document.createElement("h2");
  title.textContent = displayGroupName(group);
  const count = document.createElement("span");
  count.textContent = `${links.length}`;
  heading.append(title, count);

  if (group?.description) {
    const description = document.createElement("p");
    description.textContent = group.description;
    heading.append(description);
  }

  const list = document.createElement("div");
  list.className = "dashboard-link-list";
  for (const link of links) {
    list.append(createDashboardLinkCard(link, group, template));
  }

  section.append(heading, list);
  return section;
}

function renderNavigation() {
  navigationRoot.innerHTML = "";
  const groups = visibleGroupsWithLinks();

  if (!groups.length) {
    categoryBar.hidden = true;
    navigationRoot.innerHTML = '<div class="empty-state">还没有导航入口，请前往管理后台添加。</div>';
    return;
  }

  resolveActiveCategory(groups);
  const template = document.querySelector("#linkCardTemplate");
  const selectedGroupId = state.activeCategory.startsWith("group:")
    ? Number(state.activeCategory.split(":")[1])
    : null;

  const dashboard = document.createElement("div");
  dashboard.className = `dashboard-grid${selectedGroupId ? " is-filtered" : ""}`;

  if (selectedGroupId) {
    const group = groups.find((item) => Number(item.id) === selectedGroupId);
    const links = state.links.filter((link) => Number(link.group_id) === selectedGroupId);
    if (group) dashboard.append(renderDashboardGroup(group, links, template, { single: true }));
  } else {
    for (const group of groups) {
      const links = state.links.filter((link) => Number(link.group_id) === Number(group.id));
      if (!links.length) continue;
      dashboard.append(renderDashboardGroup(group, links, template));
    }
  }

  navigationRoot.append(dashboard);
}

function applySettings() {
  const settings = state.settings;
  document.title = settings.site_title || "浅咲导航";
  document.querySelector("#siteSubtitle").textContent = settings.site_subtitle || "收藏常用网站，快速抵达";
  document.querySelector("#siteTitleFooter").textContent = settings.site_title || "浅咲导航";
  root.style.setProperty("--card-opacity", String(settings.card_opacity ?? 0.78));
  root.style.setProperty("--card-blur", `${Number(settings.card_blur ?? 18)}px`);
  if (settings.background_url) {
    root.style.setProperty("--custom-background", `url("${String(settings.background_url).replaceAll('"', '\\"')}")`);
  } else {
    root.style.removeProperty("--custom-background");
  }

  const savedEngine = localStorage.getItem("chisa-nav-search-engine");
  searchEngine.value = savedEngine && searchEngines[savedEngine] ? savedEngine : settings.default_search_engine || "google";
  applyTheme(localStorage.getItem("chisa-nav-theme") || settings.default_theme || "auto");
}

async function loadNavigation() {
  try {
    const response = await fetch("/api/navigation", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "加载失败");
    state.settings = data.settings || {};
    state.groups = data.groups || [];
    state.links = data.links || [];
    applySettings();
    renderCategoryTabs();
    renderNavigation();
    updateClock();
  } catch (error) {
    navigationRoot.innerHTML = `<div class="error-card">导航内容加载失败：${escapeHtml(error.message)}</div>`;
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value || "");
  }
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function readSearchHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item.query === "string")
      .map((item) => ({
        query: item.query.trim().slice(0, 200),
        count: Math.max(1, Number(item.count) || 1),
        lastUsed: Number(item.lastUsed) || 0,
      }))
      .filter((item) => item.query);
  } catch {
    return [];
  }
}

function rememberSearch(query) {
  const cleaned = String(query || "").trim().slice(0, 200);
  if (!cleaned) return;
  const history = readSearchHistory();
  const key = normalizeSearchText(cleaned);
  const existing = history.find((item) => normalizeSearchText(item.query) === key);
  if (existing) {
    existing.query = cleaned;
    existing.count += 1;
    existing.lastUsed = Date.now();
  } else {
    history.push({ query: cleaned, count: 1, lastUsed: Date.now() });
  }
  history.sort((a, b) => b.lastUsed - a.lastUsed || b.count - a.count);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_SEARCH_HISTORY)));
}

function localLinkSuggestions(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];

  return state.links
    .map((link) => {
      const title = normalizeSearchText(link.title);
      const description = normalizeSearchText(link.description);
      const hostname = normalizeSearchText(safeHostname(link.url));
      const fullUrl = normalizeSearchText(link.url);
      let score = Number.POSITIVE_INFINITY;

      if (title === normalized) score = 0;
      else if (title.startsWith(normalized)) score = 5;
      else if (hostname.startsWith(normalized)) score = 9;
      else if (title.includes(normalized)) score = 13;
      else if (hostname.includes(normalized)) score = 17;
      else if (description.includes(normalized)) score = 22;
      else if (fullUrl.includes(normalized)) score = 26;

      return { link, score };
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || Number(a.link.sort_order || 0) - Number(b.link.sort_order || 0))
    .slice(0, 6)
    .map(({ link }) => ({
      type: "link",
      text: link.title,
      detail: safeHostname(link.url),
      url: link.url,
      iconUrl: faviconFor(link),
      openInNewTab: Number(link.open_in_new_tab) === 1,
    }));
}

function historySuggestions(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];

  return readSearchHistory()
    .map((item) => {
      const value = normalizeSearchText(item.query);
      let score = Number.POSITIVE_INFINITY;
      if (value === normalized) score = 0;
      else if (value.startsWith(normalized)) score = 5;
      else if (value.includes(normalized)) score = 15;
      return { ...item, score };
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || b.count - a.count || b.lastUsed - a.lastUsed)
    .slice(0, 6)
    .map((item) => ({ type: "history", text: item.query, detail: "搜索历史" }));
}

function mergeSuggestions(...groups) {
  const seen = new Set();
  const merged = [];

  for (const group of groups) {
    for (const item of group) {
      const primaryKey = normalizeSearchText(item.type === "link" ? `link:${item.url}` : `query:${item.text}`);
      const textKey = normalizeSearchText(`query:${item.text}`);
      if (!primaryKey || seen.has(primaryKey) || seen.has(textKey)) continue;
      seen.add(primaryKey);
      seen.add(textKey);
      merged.push(item);
      if (merged.length >= MAX_SUGGESTIONS) return merged;
    }
  }
  return merged;
}

function suggestionIcon(item) {
  if (item.type === "link") return "↗";
  if (item.type === "history") return "↶";
  return "⌕";
}

function renderSuggestions(items) {
  state.suggestions = items.slice(0, MAX_SUGGESTIONS);
  state.activeSuggestionIndex = -1;
  suggestionList.innerHTML = "";

  if (!state.suggestions.length || !searchInput.value.trim()) {
    closeSuggestions();
    return;
  }

  state.suggestions.forEach((item, index) => {
    const option = document.createElement("li");
    option.id = `search-suggestion-${index}`;
    option.className = "suggestion-item";
    option.dataset.index = String(index);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");

    const iconWrap = document.createElement("span");
    iconWrap.className = "suggestion-icon";
    if (item.type === "link" && item.iconUrl) {
      const image = document.createElement("img");
      image.src = item.iconUrl;
      image.alt = "";
      image.addEventListener("error", () => {
        image.remove();
        iconWrap.textContent = suggestionIcon(item);
      }, { once: true });
      iconWrap.append(image);
    } else {
      iconWrap.textContent = suggestionIcon(item);
    }

    const copy = document.createElement("span");
    copy.className = "suggestion-copy";
    const text = document.createElement("span");
    text.className = "suggestion-text";
    text.textContent = item.text;
    const detail = document.createElement("span");
    detail.className = "suggestion-detail";
    detail.textContent = item.type === "link" ? `快捷入口 · ${item.detail || ""}` : item.detail || "搜索建议";
    copy.append(text, detail);

    const action = document.createElement("span");
    action.className = "suggestion-action";
    action.textContent = item.type === "link" ? "打开" : searchEngines[searchEngine.value]?.name || "搜索";

    option.append(iconWrap, copy, action);
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => activateSuggestion(index));
    option.addEventListener("mousemove", () => setActiveSuggestion(index));
    suggestionList.append(option);
  });

  suggestionList.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
  suggestionStatus.textContent = `找到 ${state.suggestions.length} 条建议`;
}

function setActiveSuggestion(index) {
  if (!state.suggestions.length) return;
  const nextIndex = (index + state.suggestions.length) % state.suggestions.length;
  state.activeSuggestionIndex = nextIndex;
  const options = suggestionList.querySelectorAll(".suggestion-item");
  options.forEach((option, optionIndex) => {
    const active = optionIndex === nextIndex;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", active ? "true" : "false");
  });
  searchInput.setAttribute("aria-activedescendant", `search-suggestion-${nextIndex}`);
  options[nextIndex]?.scrollIntoView({ block: "nearest" });
}

function closeSuggestions() {
  suggestionList.hidden = true;
  suggestionList.innerHTML = "";
  state.suggestions = [];
  state.activeSuggestionIndex = -1;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
  suggestionStatus.textContent = "";
}

function performSearch(query) {
  const cleaned = String(query || "").trim();
  if (!cleaned) return searchInput.focus();
  rememberSearch(cleaned);
  closeSuggestions();
  const engine = searchEngines[searchEngine.value] || searchEngines.google;
  window.location.href = engine.url + encodeURIComponent(cleaned);
}

function activateSuggestion(index) {
  const item = state.suggestions[index];
  if (!item) return;

  if (item.type === "link" && item.url) {
    closeSuggestions();
    if (item.openInNewTab) {
      window.open(item.url, "_blank", "noopener,noreferrer");
      searchInput.select();
    } else {
      window.location.href = item.url;
    }
    return;
  }

  searchInput.value = item.text;
  performSearch(item.text);
}

async function fetchOnlineSuggestions(query, requestId) {
  try {
    const params = new URLSearchParams({ q: query, engine: searchEngine.value });
    const response = await fetch(`/api/suggest?${params}`, {
      headers: { Accept: "application/json" },
    });
    const data = await response.json();
    if (requestId !== state.suggestionRequestId) return [];
    if (!response.ok || !data.ok || !Array.isArray(data.suggestions)) return [];
    return data.suggestions
      .filter((item) => typeof item === "string" && item.trim())
      .slice(0, MAX_SUGGESTIONS)
      .map((text) => ({ type: "online", text: text.trim(), detail: "热门联想" }));
  } catch {
    return [];
  }
}

async function updateSuggestions() {
  const query = searchInput.value.trim();
  const requestId = ++state.suggestionRequestId;
  if (!query) {
    closeSuggestions();
    return;
  }

  const links = localLinkSuggestions(query);
  const history = historySuggestions(query);
  renderSuggestions(mergeSuggestions(links, history));

  const online = await fetchOnlineSuggestions(query, requestId);
  if (requestId !== state.suggestionRequestId || searchInput.value.trim() !== query) return;
  renderSuggestions(mergeSuggestions(links, history, online));
}

function scheduleSuggestions() {
  window.clearTimeout(suggestionTimer);
  suggestionTimer = window.setTimeout(updateSuggestions, SUGGEST_DEBOUNCE_MS);
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.activeSuggestionIndex >= 0) {
    activateSuggestion(state.activeSuggestionIndex);
    return;
  }
  performSearch(searchInput.value);
});

searchInput.addEventListener("input", scheduleSuggestions);
searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim()) scheduleSuggestions();
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    if (!state.suggestions.length) return;
    event.preventDefault();
    setActiveSuggestion(state.activeSuggestionIndex + 1);
  } else if (event.key === "ArrowUp") {
    if (!state.suggestions.length) return;
    event.preventDefault();
    setActiveSuggestion(state.activeSuggestionIndex <= 0 ? state.suggestions.length - 1 : state.activeSuggestionIndex - 1);
  } else if (event.key === "Escape") {
    closeSuggestions();
  }
});

searchEngine.addEventListener("change", () => {
  localStorage.setItem("chisa-nav-search-engine", searchEngine.value);
  searchInput.focus();
  if (searchInput.value.trim()) scheduleSuggestions();
});

themeButton?.addEventListener("click", cycleTheme);

document.addEventListener("pointerdown", (event) => {
  if (!searchInputWrap.contains(event.target) && event.target !== searchEngine) closeSuggestions();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    searchInput.focus();
  }
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const current = localStorage.getItem("chisa-nav-theme") || state.settings.default_theme || "auto";
  if (current === "auto") applyTheme("auto");
});

setInterval(updateClock, 30_000);
loadNavigation();
