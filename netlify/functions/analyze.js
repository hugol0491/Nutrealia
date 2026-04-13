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
  const origin = event.headers.origin || event.headers.referer || '';
  const siteUrl = process.env.URL || ''; // Netlify inyecta URL del sitio automaticamente
  if (siteUrl && origin && !origin.startsWith(siteUrl) && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
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

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(Math.max(parseInt(max_tokens) || 1000, 100), 2000),
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
