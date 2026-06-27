const form = document.querySelector("#search-form");
const input = document.querySelector("#q");
const button = form.querySelector("button");
const results = document.querySelector("#results");

const DUCKDUCKGO_ENDPOINT = "https://api.duckduckgo.com/";

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
    const items = await searchDuckDuckGo(query);
    renderResults(items, query);
  } catch (error) {
    setStatus(error.message || "Search failed.");
    console.error(error);
  } finally {
    button.disabled = false;
  }
}

async function searchDuckDuckGo(query) {
  const url = new URL(DUCKDUCKGO_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("skip_disambig", "1");

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`${response.status} from DuckDuckGo`);
  }

  const data = await response.json();
  if (!data) {
    throw new Error("Unexpected DuckDuckGo response.");
  }

  const items = [];

  if (data.AbstractText && data.AbstractURL) {
    items.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      content: data.AbstractText
    });
  }

  for (const topic of flattenDuckDuckGoTopics(data.RelatedTopics || [])) {
    if (topic && topic.FirstURL && topic.Text) {
      items.push({
        title: topic.Text.split(" - ")[0] || topic.Text,
        url: topic.FirstURL,
        content: topic.Text
      });
    }
  }

  return items;
}

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
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
      const content = escapeHtml(item.content || "");

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

function flattenDuckDuckGoTopics(topics) {
  return topics.flatMap((topic) => {
    if (topic && Array.isArray(topic.Topics)) {
      return flattenDuckDuckGoTopics(topic.Topics);
    }

    return [topic];
  });
}
