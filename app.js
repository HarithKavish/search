const form = document.querySelector("#search-form");
const input = document.querySelector("#q");
const button = form.querySelector("button");
const results = document.querySelector("#results");
const loadMoreButton = document.querySelector("#load-more");
const settingsToggle = document.querySelector("#settings-toggle");
const settingsMenu = document.querySelector("#settings-menu");
const backgroundButton = document.querySelector("#background-button");
const backgroundFile = document.querySelector("#background-file");

const MWMBL_ENDPOINT = "https://api.mwmbl.org/search";
const DDG_ENDPOINT = "https://api.duckduckgo.com/";
const SEARXNG_ENDPOINTS = [
  "https://search.hbubli.cc",
  "https://baresearch.org",
  "https://opnxng.com",
  "https://priv.au"
];

const CORS_PROXIES = [
  (url) => url,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];

const FETCH_LIMIT = 100;
const DISPLAY_CHUNK = 25;
const BG_KEY = "search_background_url";
const params = new URLSearchParams(window.location.search);
const initialQuery = params.get("q") || "";

let currentQuery = initialQuery;
let currentPage = 1;
let currentItems = [];
let activeRequestId = 0;
let visibleCount = 0;
let revealTimer = null;
let revealQueue = [];

input.value = initialQuery;
loadMoreButton.hidden = true;
settingsMenu.hidden = true;
applySavedBackground();

settingsToggle.addEventListener("click", () => {
  const open = settingsMenu.hidden;
  settingsMenu.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
});

backgroundButton.addEventListener("click", () => {
  backgroundFile.value = "";
  backgroundFile.click();
  settingsMenu.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
});

backgroundFile.addEventListener("change", async () => {
  const file = backgroundFile.files && backgroundFile.files[0];
  if (!file) return;

  const dataUrl = await fileToDataUrl(file);
  window.localStorage.setItem(BG_KEY, dataUrl);
  applySavedBackground(dataUrl);
});

window.addEventListener("click", (event) => {
  if (settingsMenu.hidden) return;
  if (settingsMenu.contains(event.target) || settingsToggle.contains(event.target)) return;
  settingsMenu.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = input.value.trim();

  if (!query) {
    input.focus();
    return;
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("q", query);
  window.history.pushState(null, "", nextUrl);
  startSearch(query);
});

loadMoreButton.addEventListener("click", () => {
  if (!currentQuery) return;
  fetchNextPage();
});

window.addEventListener("popstate", () => {
  const query = new URLSearchParams(window.location.search).get("q") || "";
  input.value = query;

  if (query) {
    startSearch(query, false);
  } else {
    resetResults();
  }
});

if (initialQuery) {
  startSearch(initialQuery, false);
}

function startSearch(query) {
  currentQuery = query;
  currentPage = 1;
  currentItems = [];
  visibleCount = 0;
  revealQueue = [];
  stopReveal();
  loadMoreButton.hidden = true;
  results.innerHTML = "";
  searchPage(query, 1);
}

function fetchNextPage() {
  visibleCount = Math.min(currentItems.length, visibleCount + DISPLAY_CHUNK);
  renderResults(currentItems, currentQuery);
  loadMoreButton.hidden = visibleCount >= currentItems.length;
}

async function searchPage(query, page) {
  const requestId = ++activeRequestId;
  setStatus(`Searching for "${query}"...`);
  button.disabled = true;
  loadMoreButton.disabled = true;

  try {
    currentPage = page;
    currentItems = [];
    visibleCount = 0;
    stopReveal();
    results.innerHTML = "";

    const providerTasks = [
      searchMwmbl(query).then((items) => enqueueResults(items, query, requestId)).catch(() => {}),
      searchSearxng(query, page).then((items) => enqueueResults(items, query, requestId)).catch(() => {}),
      page === 1 ? searchDuckDuckGo(query).then((items) => enqueueResults(items, query, requestId)).catch(() => {}) : Promise.resolve()
    ];

    await Promise.all(providerTasks);
    if (requestId !== activeRequestId) return;
    loadMoreButton.hidden = visibleCount >= currentItems.length;
  } catch (error) {
    if (requestId !== activeRequestId) return;
    setStatus(error.message || "Search failed.");
    console.error(error);
    loadMoreButton.hidden = true;
  } finally {
    if (requestId === activeRequestId) {
      button.disabled = false;
      loadMoreButton.disabled = false;
    }
  }
}

async function searchMwmbl(query) {
  const url = new URL(MWMBL_ENDPOINT);
  url.searchParams.set("s", query);
  url.searchParams.set("limit", String(FETCH_LIMIT));

  const response = await fetchWithTimeout(url.toString(), {
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`${response.status} from Mwmbl`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Unexpected Mwmbl response.");
  }

  return data.map((item) => ({
    title: joinMwmblParts(item.title),
    url: item.url,
    content: joinMwmblParts(item.extract),
    source: "mwmbl"
  }));
}

async function searchSearxng(query, page) {
  const urls = SEARXNG_ENDPOINTS.map((base) => {
    const url = new URL("/search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "en");
    url.searchParams.set("page", String(page));
    url.searchParams.set("results", String(FETCH_LIMIT));
    return url.toString();
  });

  let lastError;

  for (const url of urls) {
    for (const proxied of CORS_PROXIES.map((proxy) => proxy(url))) {
      try {
        const response = await fetchWithTimeout(proxied, {
          headers: { accept: "application/json" },
          cache: "no-store"
        });

        if (!response.ok) {
          throw new Error(`${response.status} from ${proxied}`);
        }

        const data = await response.json();
        if (Array.isArray(data.results)) {
          return data.results.map((item) => ({
            title: item.title || "",
            url: item.url,
            content: item.content || item.snippet || "",
            source: "searxng"
          }));
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("No SearXNG endpoint responded.");
}

async function searchDuckDuckGo(query) {
  const url = new URL(DDG_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("skip_disambig", "1");
  url.searchParams.set("_", String(Date.now()));

  const response = await fetchWithTimeout(url.toString(), {
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`${response.status} from DuckDuckGo`);
  }

  const data = await response.json();
  const items = [];

  if (data?.AbstractText && data?.AbstractURL) {
    items.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      content: data.AbstractText,
      source: "duckduckgo"
    });
  }

  for (const topic of flattenTopics(data?.RelatedTopics || [])) {
    if (topic?.FirstURL && topic?.Text) {
      items.push({
        title: topic.Text.split(" - ")[0] || topic.Text,
        url: topic.FirstURL,
        content: topic.Text,
        source: "duckduckgo"
      });
    }
  }

  return items;
}

async function fetchWithTimeout(url, options = {}, timeout = 7000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timer);
  }
}

function renderResults(items, query) {
  const cleanItems = items.filter((item) => item && item.url && item.title);
  const showItems = cleanItems.slice(0, visibleCount || DISPLAY_CHUNK);

  if (!showItems.length) {
    setStatus(`No results found for "${query}".`);
    return;
  }

  results.innerHTML = showItems
    .map((item) => {
      const title = escapeHtml(item.title);
      const url = escapeHtml(item.url);
      const content = escapeHtml(item.content || item.snippet || "");

      return `
        <article class="result">
          <a href="${url}" rel="noopener noreferrer">${title}</a>
          <div class="url">${url}</div>
          <p class="snippet">${content}</p>
        </article>
      `;
    })
    .join("");
}

function setStatus(message) {
  results.innerHTML = `<p class="status">${escapeHtml(message)}</p>`;
}

function resetResults() {
  currentQuery = "";
  currentPage = 1;
  currentItems = [];
  visibleCount = 0;
  revealQueue = [];
  stopReveal();
  results.innerHTML = "";
  loadMoreButton.hidden = true;
}

function applySavedBackground(overrideUrl) {
  const url = overrideUrl ?? window.localStorage.getItem(BG_KEY) ?? "";
  if (!url) {
    document.documentElement.style.setProperty("--bg-image", "none");
    return;
  }

  document.documentElement.style.setProperty("--bg-image", `url("${escapeCssUrl(url)}")`);
}

function flattenTopics(topics) {
  return topics.flatMap((topic) => {
    if (topic && Array.isArray(topic.Topics)) return flattenTopics(topic.Topics);
    return [topic];
  });
}

function mergeResults(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    if (!item?.url || !item?.title) continue;
    const key = `${item.url}::${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function settledValue(result) {
  return result.status === "fulfilled" && Array.isArray(result.value) ? result.value : [];
}

function joinMwmblParts(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => part.value || "").join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char];
  });
}

function escapeCssUrl(value) {
  return String(value).replace(/["\\\n\r\f]/g, "\\$&");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image."));
    reader.readAsDataURL(file);
  });
}

function revealStreamingItems(items, query, requestId) {
  revealQueue = items.slice(visibleCount);
  stopReveal();

  if (!revealQueue.length || requestId !== activeRequestId) {
    visibleCount = Math.min(currentItems.length, DISPLAY_CHUNK);
    loadMoreButton.hidden = currentItems.length <= visibleCount;
    renderResults(currentItems, query);
    return;
  }

  visibleCount = Math.min(currentItems.length, 1);
  renderResults(currentItems, query);
  revealTimer = window.setInterval(() => {
    if (requestId !== activeRequestId) {
      stopReveal();
      return;
    }

    const next = revealQueue.shift();
    if (next) {
      visibleCount = Math.min(currentItems.length, visibleCount + 1);
      renderResults(currentItems, query);
      loadMoreButton.hidden = visibleCount >= currentItems.length;
    }

    if (!revealQueue.length) {
      stopReveal();
    }
  }, 90);
}

function enqueueResults(items, query, requestId) {
  if (requestId !== activeRequestId || !Array.isArray(items) || !items.length) return;

  currentItems = mergeResults([...currentItems, ...items]);

  if (!visibleCount) {
    visibleCount = 1;
    renderResults(currentItems, query);
  }

  const alreadyVisible = visibleCount;
  revealQueue = currentItems.slice(alreadyVisible);
  stopReveal();

  revealTimer = window.setInterval(() => {
    if (requestId !== activeRequestId) {
      stopReveal();
      return;
    }

    if (visibleCount >= currentItems.length || visibleCount >= DISPLAY_CHUNK) {
      stopReveal();
      loadMoreButton.hidden = visibleCount >= currentItems.length;
      return;
    }

    visibleCount += 1;
    renderResults(currentItems, query);
    loadMoreButton.hidden = visibleCount >= currentItems.length;
  }, 70);
}

function stopReveal() {
  if (revealTimer) {
    window.clearInterval(revealTimer);
    revealTimer = null;
  }
}
