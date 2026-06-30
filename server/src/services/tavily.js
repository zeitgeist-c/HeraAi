import { config } from '../config.js';

export async function searchWeb(query, maxResults = 10) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tavily API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.results.map(r => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  }));
}
