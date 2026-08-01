const searchEngines = {
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  baidu: { name: "百度", url: "https://www.baidu.com/s?wd=" },
  github: { name: "GitHub", url: "https://github.com/search?q=" },
};

const state = {
  settings: {},
  groups: [],
  links: [],
};

const root = document.documentElement;
const navigationRoot = document.querySelector("#navigationRoot");
const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#searchInput");
const searchEngine = document.querySelector("#searchEngine");
const themeButton = document.querySelector("#themeButton");

function applyTheme(theme) {
  let resolved = theme;
  if (theme === "auto") {
    resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  root.dataset.theme = resolved;
  localStorage.setItem("chisa-nav-theme", theme);
  themeButton.textContent = resolved === "dark" ? "☀" : "◐";
}

function cycleTheme() {
  const current = localStorage.getItem("chisa-nav-theme") || state.settings.default_theme || "auto";
  const order = ["auto", "light", "dark"];
  applyTheme(order[(order.indexOf(current) + 1) % order.length]);
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

function renderNavigation() {
  navigationRoot.innerHTML = "";
  const visibleGroups = state.groups.filter((group) => state.links.some((link) => Number(link.group_id) === Number(group.id)));

  if (!visibleGroups.length) {
    navigationRoot.innerHTML = '<div class="empty-state">还没有导航入口，请前往管理后台添加。</div>';
    return;
  }

  const template = document.querySelector("#linkCardTemplate");

  for (const group of visibleGroups) {
    const links = state.links.filter((link) => Number(link.group_id) === Number(group.id));
    const section = document.createElement("section");
    section.className = "nav-section";

    const heading = document.createElement("div");
    heading.className = "section-heading";
    const headingCopy = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = group.name;
    headingCopy.append(title);
    if (group.description) {
      const description = document.createElement("p");
      description.textContent = group.description;
      headingCopy.append(description);
    }
    const count = document.createElement("span");
    count.className = "section-count";
    count.textContent = `${links.length} 个入口`;
    heading.append(headingCopy, count);

    const grid = document.createElement("div");
    grid.className = "link-grid";

    for (const link of links) {
      const card = template.content.firstElementChild.cloneNode(true);
      card.href = link.url;
      card.target = Number(link.open_in_new_tab) === 1 ? "_blank" : "_self";
      card.rel = "noopener noreferrer";
      card.querySelector(".link-title").textContent = link.title;
      card.querySelector(".link-description").textContent = link.description || new URL(link.url).hostname;

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
      grid.append(card);
    }

    section.append(heading, grid);
    navigationRoot.append(section);
  }
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

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return searchInput.focus();
  const engine = searchEngines[searchEngine.value] || searchEngines.google;
  window.location.href = engine.url + encodeURIComponent(query);
});

searchEngine.addEventListener("change", () => {
  localStorage.setItem("chisa-nav-search-engine", searchEngine.value);
  searchInput.focus();
});

themeButton.addEventListener("click", cycleTheme);

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    searchInput.focus();
  }
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((localStorage.getItem("chisa-nav-theme") || state.settings.default_theme || "auto") === "auto") applyTheme("auto");
});

setInterval(updateClock, 30_000);
loadNavigation();
