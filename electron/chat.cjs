function localEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Enter a local Ollama address, such as http://localhost:11434.');
  return url.origin;
}
async function request(endpoint, route, body, signal) {
  const response = await fetch(`${localEndpoint(endpoint)}${route}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal || AbortSignal.timeout(10000),
  });
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new Error('The model response exceeded the 2 MB limit.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok || value.error)
    throw new Error(value.error || `Ollama returned HTTP ${response.status}.`);
  return value;
}
async function models(endpoint) {
  const value = await request(endpoint, '/api/tags');
  if (!Array.isArray(value.models))
    throw new Error('This server did not return an Ollama model list.');
  return value.models.map((model) => model.name).filter((name) => typeof name === 'string');
}
async function send({ endpoint, model, messages }, signal, onChunk = () => {}) {
  if (
    typeof model !== 'string' ||
    !model.trim() ||
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > 100 ||
    messages.some(
      (m) =>
        !m || !['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string' ||
        (m.images !== undefined && (!Array.isArray(m.images) || m.images.length > 8 || m.images.some((image) => typeof image !== 'string' || image.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image)))),
    ) ||
    messages.reduce((sum, message) => sum + message.content.length, 0) > 1500000 ||
    messages.reduce((sum, message) => sum + (message.images || []).reduce((bytes, image) => bytes + image.length, 0), 0) > 28 * 1024 * 1024
  )
    throw new Error('Choose a model and keep conversations under 100 messages, 1.5 MB of text and 20 MB of images.');
  const response = await fetch(`${localEndpoint(endpoint)}/api/chat`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text();
    let message;
    try {
      message = JSON.parse(detail).error;
    } catch {
      /* Use the HTTP status below. */
    }
    throw new Error(message || `Ollama returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error('The model returned no response stream.');
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let done = false;
  let received = 0;
  const consume = (line) => {
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('The model returned an invalid response stream.');
    }
    if (value.error) throw new Error(String(value.error));
    if (typeof value.message?.content === 'string' && value.message.content) {
      content += value.message.content;
      if (content.length > 2 * 1024 * 1024)
        throw new Error('The model response exceeded the 2 MB limit.');
      onChunk(value.message.content);
    }
    if (value.done === true) done = true;
  };
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > 2 * 1024 * 1024) throw new Error('The model response exceeded the 2 MB limit.');
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 2 * 1024 * 1024)
      throw new Error('The model response exceeded the 2 MB limit.');
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      consume(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  }
  pending += decoder.decode();
  consume(pending);
  if (!done) throw new Error('The model response ended before completion.');
  if (!content.trim()) throw new Error('The model returned no text. Try another model or prompt.');
  return content;
}
module.exports = { localEndpoint, models, send };
