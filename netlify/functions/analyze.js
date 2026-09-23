// Netlify Function — proxy seguro para Claude API
// La API key se lee de la variable de entorno ANTHROPIC_API_KEY configurada en Netlify

exports.handler = async function (event) {
  // Solo POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY no configurada en el servidor' }),
    };
  }

  // Validacion basica de origen (bloquea peticiones desde otros dominios)
  // Netlify inyecta URL (principal), DEPLOY_URL (deploy actual) y DEPLOY_PRIME_URL (branch/preview).
  const origin = event.headers.origin || event.headers.referer || '';
  const allowedOrigins = [process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL].filter(Boolean);
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const isAllowed =
    !origin ||
    isLocalhost ||
    allowedOrigins.length === 0 ||
    allowedOrigins.some((u) => origin.startsWith(u));
  if (!isAllowed) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Origen no autorizado' }),
    };
  }

  // Parsear body
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'JSON invalido en el cuerpo de la peticion' }),
    };
  }

  const { messages, system, max_tokens } = payload;

  // Validar campos requeridos
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 10) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Campo messages invalido' }),
    };
  }
  if (typeof system !== 'string' || system.length === 0 || system.length > 6000) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Campo system invalido' }),
    };
  }

  // Modelo configurable — solo los permitidos.
  // Haiku 4.5 usa ID con fecha para pinning reproducible.
  // Sonnet 4.6 se sustituye por Sonnet 5 (mejor y más barato): se mapea aquí también para
  // los celulares que aún tengan el app.js viejo en caché y sigan pidiendo 'claude-sonnet-4-6'.
  const ALLOWED_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
  const pedido = payload.model === 'claude-sonnet-4-6' ? 'claude-sonnet-5' : payload.model;
  const model = ALLOWED_MODELS.includes(pedido) ? pedido : DEFAULT_MODEL;
  const esSonnet5 = model === 'claude-sonnet-5';
  // Sonnet 5 cuenta ~30% más tokens por el mismo texto que Sonnet 4.6: se escala el límite
  // pedido para no cortar respuestas que antes cabían.
  const pedidoTokens = Math.min(Math.max(parseInt(max_tokens, 10) || 500, 100), 1500);
  const maxTokens = esSonnet5 ? Math.ceil(pedidoTokens * 1.3) : pedidoTokens;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Sonnet 5 razona por defecto si no se indica; Sonnet 4.6 no lo hacía. Se apaga para
        // conservar la misma rapidez y que el razonamiento no se coma el límite de tokens.
        ...(esSonnet5 ? { thinking: { type: 'disabled' } } : {}),
        system,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: data.error?.message || 'Error en Claude API' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No se pudo conectar con Claude API: ' + err.message }),
    };
  }
};
