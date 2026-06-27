const form = document.querySelector("#search-form");
const input = document.querySelector("#q");
const button = form.querySelector("button");
const results = document.querySelector("#results");

const MWMBL_ENDPOINT = "https://api.mwmbl.org/search";

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

const params = new URLSearchParams(window.location.search);
const initialQuery = params.get("q") || "";

input.value = initialQuery;

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
  runSearch(query);
});

window.addEventListener("popstate", () => {
  const query = new URLSearchParams(window.location.search).get("q") || "";
  input.value = query;
  if (query) runSearch(query);
  else results.innerHTML = "";
});

if (initialQuery) {
  runSearch(initialQuery);
}

async function runSearch(query) {
  setStatus(`Searching for "${query}"...`);
  button.disabled = true;

  try {
    const items = await search(query);
    renderResults(items, query);
  } catch (error) {
    setStatus("Search is temporarily unavailable. Please try again in a moment.");
    console.error(error);
  } finally {
    button.disabled = false;
  }
}

async function search(query) {
  try {
    return await searchMwmbl(query);
  } catch (error) {
    console.warn("Mwmbl search failed, trying SearXNG.", error);
    const data = await searchSearxng(query);
    return data.results || [];
  }
}

async function searchMwmbl(query) {
  const url = new URL(MWMBL_ENDPOINT);
  url.searchParams.set("s", query);

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
    content: joinMwmblParts(item.extract)
  }));
}

async function searchSearxng(query) {
  const urls = SEARXNG_ENDPOINTS.map((base) => {
    const url = new URL("/search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "en");
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
          return data;
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("No search endpoint responded.");
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
  const cleanItems = items
    .filter((item) => item && item.url && item.title)
    .slice(0, 12);

  if (!cleanItems.length) {
    setStatus(`No results found for "${query}".`);
    return;
  }

  results.innerHTML = cleanItems
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

function joinMwmblParts(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => part.value || "").join("");
}
