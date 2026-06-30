async function getBaseUrl() {
  return new Promise((resolve) => {
    if (chrome?.storage?.local) {
      chrome.storage.local.get(['backendUrl'], (result) => {
        resolve(result.backendUrl || 'http://localhost:3001');
      });
    } else {
      resolve('http://localhost:3001');
    }
  });
}

async function* streamFromEndpoint(endpoint, body, signal) {
  const baseUrl = await getBaseUrl();
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: 'Backend hatası' } }));
    throw new Error(err.error?.message || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let currentEvent = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
        continue;
      }
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          yield { event: currentEvent, data };
        } catch (e) {
          // skip malformed JSON
        }
        currentEvent = '';
      }
    }
  }
}

export async function* streamChat(messages, options = {}, geminiKeys = [], signal) {
  const gen = streamFromEndpoint('/api/chat', {
    messages,
    systemInstruction: options.systemInstruction || '',
    geminiKeys,
  }, signal);
  for await (const evt of gen) {
    yield evt;
  }
}

export async function* streamResearch(question, geminiKeys = [], tavilyKeys = [], signal) {
  const gen = streamFromEndpoint('/api/research', {
    question,
    geminiKeys,
    tavilyKeys,
  }, signal);
  for await (const evt of gen) {
    yield evt;
  }
}

export async function* streamVision(messages, image, options = {}, geminiKeys = [], signal) {
  const gen = streamFromEndpoint('/api/vision', {
    messages,
    image: image || undefined,
    systemInstruction: options.systemInstruction || '',
    geminiKeys,
  }, signal);
  for await (const evt of gen) {
    yield evt;
  }
}

export async function testKey(provider, key) {
  const baseUrl = await getBaseUrl();
  const res = await fetch(`${baseUrl}/api/test-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  return res.json();
}

export async function checkHealth() {
  const baseUrl = await getBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}
