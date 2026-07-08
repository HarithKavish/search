const form = document.querySelector("#search-form");
const input = document.querySelector("#q");
const button = form.querySelector("button");
const results = document.querySelector("#results");
const loadMoreButton = document.querySelector("#load-more");
const settingsToggle = document.querySelector("#settings-toggle");
const settingsMenu = document.querySelector("#settings-menu");
const backgroundButton = document.querySelector("#background-button");
const backgroundFile = document.querySelector("#background-file");
const historyPanel = document.querySelector("#history-panel");
const historyToggle = document.querySelector("#history-toggle");
const modeTabs = document.querySelectorAll(".mode-tab");
const imageViewer = document.querySelector("#image-viewer");
const imageViewerClose = document.querySelector("#image-viewer-close");
const imageViewerImg = document.querySelector("#image-viewer-img");
const imageViewerUrl = document.querySelector("#image-viewer-url");
const imageViewerTitle = document.querySelector("#image-viewer-title");

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
const HISTORY_KEY = "search_history_items";
const HISTORY_ENABLED_KEY = "search_history_enabled";
const HISTORY_LIMIT = 7;
const params = new URLSearchParams(window.location.search);
const initialQuery = params.get("q") || "";
const initialMode = params.get("type") === "images" ? "images" : "web";

let currentQuery = initialQuery;
let currentMode = initialMode;
let currentPage = 1;
let currentItems = [];
let activeRequestId = 0;
let visibleCount = 0;
let revealTimer = null;
let revealTarget = 0;
let providersPending = 0;
let historyEnabled = window.localStorage.getItem(HISTORY_ENABLED_KEY) === "true";

input.value = initialQuery;
loadMoreButton.hidden = true;
settingsMenu.hidden = true;
historyToggle.checked = historyEnabled;
applySavedBackground();
setMode(currentMode);

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

historyToggle.addEventListener("change", () => {
  historyEnabled = historyToggle.checked;
  window.localStorage.setItem(HISTORY_ENABLED_KEY, String(historyEnabled));

  if (!historyEnabled) {
    historyPanel.hidden = true;
  } else if (document.activeElement === input) {
    renderHistoryPanel();
  }
});

window.addEventListener("click", (event) => {
  if (settingsMenu.hidden) return;
  if (settingsMenu.contains(event.target) || settingsToggle.contains(event.target)) return;
  settingsMenu.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
});

input.addEventListener("focus", () => {
  renderHistoryPanel();
});

input.addEventListener("search", () => {
  if (input.value) return;
  resetToHome();
});

input.addEventListener("input", () => {
  if (!input.value.trim()) {
    renderHistoryPanel();
  } else {
    historyPanel.hidden = true;
  }
});

window.addEventListener("click", (event) => {
  if (event.target === input || historyPanel.contains(event.target)) return;
  historyPanel.hidden = true;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = input.value.trim();

  if (!query) {
    input.focus();
    return;
  }

  pushSearchUrl(query);
  saveSearch(query);
  historyPanel.hidden = true;
  startSearch(query);
});

loadMoreButton.addEventListener("click", () => {
  if (!currentQuery || currentMode !== "web") return;
  fetchNextPage();
});

modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const mode = tab.dataset.mode === "images" ? "images" : "web";
    setMode(mode);

    if (!currentQuery) return;
    pushSearchUrl(currentQuery);
    startSearch(currentQuery);
  });
});

window.addEventListener("popstate", () => {
  const nextParams = new URLSearchParams(window.location.search);
  const query = nextParams.get("q") || "";
  setMode(nextParams.get("type") === "images" ? "images" : "web");
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
  revealTarget = 0;
  providersPending = 0;
  stopReveal();
  closeImageViewer();
  loadMoreButton.hidden = true;
  loadMoreButton.disabled = true;
  results.innerHTML = "";

  if (currentMode === "images") {
    searchImages(query);
  } else {
    searchPage(query, 1);
  }
}

function fetchNextPage() {
  revealTarget = Math.min(currentItems.length, revealTarget + DISPLAY_CHUNK);
  startReveal(currentQuery, activeRequestId);
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
    revealTarget = DISPLAY_CHUNK;
    providersPending = page === 1 ? 3 : 2;
    stopReveal();
    results.innerHTML = "";
    let providerCount = 0;

    const providerTasks = [
      searchMwmbl(query).then((items) => enqueueResults(items, query, requestId)).catch(() => {}).finally(() => completeProvider(requestId, () => providerCount += 1)),
      searchSearxng(query, page).then((items) => enqueueResults(items, query, requestId)).catch(() => {}).finally(() => completeProvider(requestId, () => providerCount += 1)),
      page === 1 ? searchDuckDuckGo(query).then((items) => enqueueResults(items, query, requestId)).catch(() => {}).finally(() => completeProvider(requestId, () => providerCount += 1)) : Promise.resolve()
    ];

    await Promise.all(providerTasks);
    if (requestId !== activeRequestId) return;
    if (!currentItems.length && providerCount) {
      setStatus(`No results found for "${query}".`);
    }
    updateLoadMore();
  } catch (error) {
    if (requestId !== activeRequestId) return;
    setStatus(error.message || "Search failed.");
    console.error(error);
    loadMoreButton.hidden = true;
  } finally {
    if (requestId === activeRequestId) {
      button.disabled = false;
      updateLoadMore();
    }
  }
}

async function searchImages(query) {
  const requestId = ++activeRequestId;
  setStatus(`Searching images for "${query}"...`);
  button.disabled = true;
  loadMoreButton.hidden = true;
  loadMoreButton.disabled = true;

  try {
    // Prefer Wikimedia Commons first because it works on static hosting.
    // If that returns nothing, fall back to the local proxy and then SearxNG.
    let items = [];
    try {
      items = await searchWikimediaImages(query);
      if (!items.length) {
        items = await searchProxyImages(query);
      }
    } catch (proxyErr) {
      console.warn("image proxy failed, falling back to SearxNG:", proxyErr);
      items = await searchSearxngImages(query);
    }

    if (requestId !== activeRequestId) return;
    currentItems = items || [];
    renderImages(currentItems, query);
  } catch (error) {
    if (requestId !== activeRequestId) return;
    setStatus(error.message || "Image search failed.");
    console.error(error);
  } finally {
    if (requestId === activeRequestId) {
      button.disabled = false;
    }
  }
}

async function searchProxyImages(query) {
  const url = `/api/images?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, 15000);
  if (!response.ok) {
    throw new Error(`${response.status} from image proxy`);
  }

  const data = await response.json();
  if (Array.isArray(data.results)) {
    return mergeImageResults(data.results.map(normalizeImageResult));
  }

  if (Array.isArray(data)) {
    return mergeImageResults(data.map(normalizeImageResult));
  }

  throw new Error("No results from image proxy.");
}

async function searchWikimediaImages(query) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrlimit", String(FETCH_LIMIT));
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata");
  url.searchParams.set("iiurlwidth", "600");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const response = await fetchWithTimeout(url.toString(), {
    headers: { accept: "application/json" },
    cache: "no-store"
  }, 12000);

  if (!response.ok) {
    throw new Error(`${response.status} from Wikimedia Commons`);
  }

  const data = await response.json();
  const pages = Object.values(data?.query?.pages || {});
  return mergeImageResults(pages.map(normalizeCommonsImageResult));
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

async function searchSearxngImages(query) {
  const urls = SEARXNG_ENDPOINTS.map((base) => {
    const url = new URL("/search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "en");
    url.searchParams.set("categories", "images");
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
          return mergeImageResults(data.results.map(normalizeImageResult));
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("No image endpoint responded.");
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
  const timer = window.setTimeout(() => controller.abort(new DOMException(`Request timed out after ${timeout}ms`, "TimeoutError")), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error(`Request timed out after ${timeout}ms while fetching ${url}`);
    }
    throw error;
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

function renderImages(items, query) {
  const cleanItems = items.filter((item) => item && item.src);

  if (!cleanItems.length) {
    setStatus(`No images found for "${query}".`);
    return;
  }

  results.innerHTML = `
    <div class="image-grid">
      ${cleanItems.map(renderImageItem).join("")}
    </div>
  `;
}

function renderImageItem(item, index) {
  const src = escapeHtml(item.thumb || item.src);
  const alt = escapeHtml(item.title || "");

  return `
    <button type="button" class="image-result" data-index="${index}" aria-label="${alt || "Open image"}">
      <img src="${src}" alt="${alt}" loading="lazy">
    </button>
  `;
}

function setStatus(message) {
  results.innerHTML = `<p class="status">${escapeHtml(message)}</p>`;
}

function resetResults() {
  currentQuery = "";
  currentPage = 1;
  currentItems = [];
  visibleCount = 0;
  revealTarget = 0;
  providersPending = 0;
  stopReveal();
  closeImageViewer();
  results.innerHTML = "";
  loadMoreButton.hidden = true;
  loadMoreButton.disabled = true;
  historyPanel.hidden = true;
}

results.addEventListener("click", (event) => {
  const button = event.target.closest(".image-result");
  if (!button) return;

  const item = currentItems[Number(button.dataset.index)];
  if (item) openImageViewer(item);
});

imageViewerClose.addEventListener("click", closeImageViewer);

imageViewer.addEventListener("click", (event) => {
  if (event.target === imageViewer) closeImageViewer();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !imageViewer.hidden) closeImageViewer();
});

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

function normalizeImageResult(item) {
  const src = item?.img_src || item?.thumbnail_src || item?.thumbnail || item?.src || "";
  const thumb = item?.thumbnail_src || item?.thumbnail || item?.img_src || item?.src || "";

  return {
    src,
    thumb,
    url: item?.url || item?.source || item?.img_src || "",
    title: item?.title || item?.content || "",
    content: item?.content || item?.title || item?.url || ""
  };
}

function normalizeCommonsImageResult(page) {
  const imageInfo = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  const src = imageInfo?.thumburl || imageInfo?.url || "";

  return {
    src,
    thumb: imageInfo?.thumburl || imageInfo?.url || "",
    url: imageInfo?.descriptionurl || imageInfo?.url || "",
    title: page?.title || "",
    content: page?.title || imageInfo?.descriptionurl || ""
  };
}

function mergeImageResults(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    if (!item?.src) continue;
    if (seen.has(item.src)) continue;
    seen.add(item.src);
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

function saveSearch(query) {
  if (!historyEnabled) return;

  const next = [
    query,
    ...readHistory().filter((item) => item.toLowerCase() !== query.toLowerCase())
  ].slice(0, HISTORY_LIMIT);

  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}

function readHistory() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
  } catch {
    return [];
  }
}

function renderHistoryPanel() {
  if (!historyEnabled) {
    historyPanel.hidden = true;
    return;
  }

  const items = readHistory();
  if (!items.length) {
    historyPanel.hidden = true;
    return;
  }

  historyPanel.innerHTML = items
    .map((item) => `<button type="button" class="history-item" data-query="${encodeURIComponent(item)}">${escapeHtml(item)}</button>`)
    .join("");
  historyPanel.hidden = false;
}

historyPanel.addEventListener("click", (event) => {
  const button = event.target.closest(".history-item");
  if (!button) return;

  const query = decodeURIComponent(button.getAttribute("data-query") || "");
  if (!query) return;

  input.value = query;
  historyPanel.hidden = true;
  pushSearchUrl(query);
  startSearch(query);
});

function resetToHome() {
  const homeUrl = `${window.location.origin}${window.location.pathname}`;
  window.history.pushState(null, "", homeUrl);
  input.value = "";
  setMode("web");
  resetResults();
}

function setMode(mode) {
  currentMode = mode === "images" ? "images" : "web";
  modeTabs.forEach((tab) => {
    const active = tab.dataset.mode === currentMode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
}

function pushSearchUrl(query) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("q", query);
  if (currentMode === "images") nextUrl.searchParams.set("type", "images");
  else nextUrl.searchParams.delete("type");
  window.history.pushState(null, "", nextUrl);
}

function openImageViewer(item) {
  imageViewerImg.src = item.src;
  imageViewerImg.alt = item.title || "";
  imageViewerUrl.href = item.url || item.src;
  imageViewerUrl.textContent = item.url || item.src;
  imageViewerTitle.textContent = item.content || item.title || "";
  imageViewer.hidden = false;
}

function closeImageViewer() {
  imageViewer.hidden = true;
  imageViewerImg.removeAttribute("src");
}

function enqueueResults(items, query, requestId) {
  if (requestId !== activeRequestId || !Array.isArray(items) || !items.length) return;

  currentItems = mergeResults([...currentItems, ...items]);
  if (results.querySelector(".status")) results.innerHTML = "";
  startReveal(query, requestId);
}

function startReveal(query, requestId) {
  if (revealTimer || requestId !== activeRequestId) return;
  loadMoreButton.hidden = true;
  revealTimer = window.setInterval(() => {
    if (requestId !== activeRequestId) {
      stopReveal();
      return;
    }

    if (visibleCount >= currentItems.length || visibleCount >= revealTarget) {
      stopReveal();
      updateLoadMore();
      return;
    }

    const item = currentItems[visibleCount];
    if (item) {
      results.insertAdjacentHTML("beforeend", renderItem(item));
      visibleCount += 1;
    }
  }, 70);
}

function renderItem(item) {
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
}

function updateLoadMore() {
  if (currentMode !== "web") {
    loadMoreButton.hidden = true;
    loadMoreButton.disabled = true;
    return;
  }

  const moreBuffered = currentItems.length > visibleCount;
  const waitingForCurrentChunk = Boolean(revealTimer) || visibleCount < revealTarget;

  loadMoreButton.hidden = waitingForCurrentChunk || !moreBuffered;
  loadMoreButton.disabled = !moreBuffered;
}

function stopReveal() {
  if (revealTimer) {
    window.clearInterval(revealTimer);
    revealTimer = null;
  }
}

function completeProvider(requestId, callback) {
  if (requestId !== activeRequestId) return;
  providersPending = Math.max(0, providersPending - 1);
  callback();
  updateLoadMore();
}
