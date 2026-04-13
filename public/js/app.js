/* ══════════════════════════════════════════════
   Mariana Nutrealia — App principal
   ══════════════════════════════════════════════ */

// ─── CONFIGURACION CENTRALIZADA ──────────────
// Edita estos valores para personalizar la app.
// En una futura version multi-paciente, estos datos
// vendrian de un backend o de la URL.

const CONFIG = {
  nombre: 'Mariana',
  emoji: '🍍',

  // URL del Apps Script desplegado como web app
  // INSTRUCCION: reemplaza con tu URL real despues de publicar el Apps Script
  sheetsUrl: 'REEMPLAZAR_CON_TU_URL_DE_APPS_SCRIPT',

  // Metas nutricionales diarias base
  metas: { kcal: 1800, prot: 120, cho: 200, grasa: 60 },

  // Actividades disponibles y sus kcal default al seleccionar el chip
  actividades: {
    cardio:  { emoji: '🏃‍♀️', nombre: 'Cardio',   kcalDefault: 250 },
    fuerza:  { emoji: '🏋️',  nombre: 'Fuerza',   kcalDefault: 200 },
    yoga:    { emoji: '🧘',   nombre: 'Yoga',     kcalDefault: 150 },
    caminar: { emoji: '🚶‍♀️', nombre: 'Caminata', kcalDefault: 100 },
  },

  // Perfil para el prompt de sistema de Claude
  perfil: `PERFIL:
- Nombre: Mariana
- Objetivo: mantener una alimentacion balanceada y saludable
METAS DIARIAS BASE: 1,800 kcal | 120g proteina | 200g carbohidratos | 60g grasa
AJUSTE ENTRENAMIENTO: cuando se registran kcal quemadas en ejercicio, ese total se suma a la meta base y el extra va integro a carbohidratos (kcal_ejercicio / 4 = gramos extra de carbs). La meta ajustada ya viene calculada en cada check-in.`,

  // Restricciones alimentarias (dejar vacio si no aplica)
  restricciones: '',

  // Tamano maximo de foto en bytes (3 MB para no exceder limites de Netlify Functions)
  maxPhotoBytes: 3 * 1024 * 1024,
};

// ─── SYSTEM PROMPTS ──────────────────────────

const SYSTEM_CHECKIN = `Eres un asistente de nutricion profesional para ${CONFIG.nombre}. ${CONFIG.perfil}
${CONFIG.restricciones ? 'RESTRICCIONES: ' + CONFIG.restricciones : ''}
INSTRUCCIONES:
1. Responde en espanol, tono amable y profesional. Unidades metricas.
2. Fundamenta en evidencia cientifica.
3. Cada check-in incluye: a) actividad y meta calorica ajustada, b) tabla metas vs consumido con checkmarks, c) UNA recomendacion accionable.
4. Marca estimaciones como "(estimado)". Maximo UNA pregunta de seguimiento.
5. NO diagnosticos medicos. NUNCA sumes kcal actividad a kcal ingeridas.
6. Usa markdown con tablas para la comparacion de macros.
7. Al final, en linea separada, escribe exactamente esto (JSON estrictamente valido: claves con comillas dobles, valores enteros sin texto adicional):
MACROS:{"kcal":N,"prot":N,"cho":N,"grasa":N}
N = entero de ESTA comida unicamente. Esta linea es obligatoria y debe ser la ULTIMA del mensaje, sin texto despues.`;

function buildSystemCerrar() {
  return `Eres un asistente de nutricion profesional para ${CONFIG.nombre}. ${CONFIG.perfil}
${CONFIG.restricciones ? 'RESTRICCIONES para recomendaciones: ' + CONFIG.restricciones : ''}
REGLA CRITICA: Solo recomienda exactamente lo que haga falta para llegar a metas sin exceder NINGUN macro.`;
}

function buildSystemResumen(metas) {
  return `Eres un asistente de nutricion profesional para ${CONFIG.nombre}. ${CONFIG.perfil}
Meta ajustada hoy: ${metas.kcal} kcal | ${metas.prot}g prot | ${metas.cho}g carbs | ${metas.grasa}g grasa
Genera resumen diario en 500 palabras max con markdown:
1) Tabla kcal/macros vs meta con indicadores
2) Evaluacion de proteina
3) Adherencia
4) Tres prioridades para manana
Tono profesional y motivador. En espanol.`;
}

// ─── ESTADO GLOBAL ───────────────────────────

let log = [];
let photoB64 = null;
let photoMime = null;
let acts = [];
let ejercicioKcal = 0;
const TODAY = new Date().toDateString();

// ─── FUNCION PROXY PARA CLAUDE API ──────────

async function callClaude(system, messages, maxTokens) {
  const res = await fetch('/.netlify/functions/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages, max_tokens: maxTokens || 1000 }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `Error del servidor (${res.status})`);
  }

  const text = data.content?.find((b) => b.type === 'text')?.text || '';
  if (!text) throw new Error('Respuesta vacia del servidor');

  return text;
}

// ─── UTILIDADES ──────────────────────────────

function escH(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdToHtml(text) {
  let h = escH(text);
  // Tablas
  h = h.replace(/((?:^|\n)\|.+\|(?:\n\|.+\|)+)/g, (block) => {
    const lines = block.trim().split('\n').filter((l) => l.trim());
    if (lines.length < 2) return block;
    let t = '<table>';
    lines.forEach((line, i) => {
      if (/^\|[\s\-|:]+\|$/.test(line)) return;
      const cells = line.split('|').slice(1, -1);
      const tag = i === 0 ? 'th' : 'td';
      t += '<tr>' + cells.map((c) => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    return t + '</table>';
  });
  h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  h = h.replace(/((?:^|\n)[-•*] .+(?:\n[-•*] .+)*)/g, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map((l) => '<li>' + l.replace(/^[-•*]\s*/, '') + '</li>')
      .join('');
    return '<ul>' + items + '</ul>';
  });
  h = h.replace(/((?:^|\n)\d+\. .+(?:\n\d+\. .+)*)/g, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map((l) => '<li>' + l.replace(/^\d+\.\s*/, '') + '</li>')
      .join('');
    return '<ol>' + items + '</ol>';
  });
  h = h.replace(/\n{2,}/g, '</p><p>');
  h = '<p>' + h + '</p>';
  h = h.replace(/(?<!>)\n(?!<)/g, '<br>');
  h = h.replace(/<p>\s*<\/p>/g, '');
  return h;
}

function getMetas() {
  const m = { ...CONFIG.metas };
  if (ejercicioKcal > 0) {
    m.kcal = CONFIG.metas.kcal + ejercicioKcal;
    m.cho = CONFIG.metas.cho + Math.round(ejercicioKcal / 4);
  }
  return m;
}

function getActStr() {
  const parts = [...acts];
  if (ejercicioKcal > 0) parts.push(`ejercicio: ${ejercicioKcal} kcal quemadas`);
  return parts.length ? parts.join(', ') : 'no especificada';
}

function extractMacros(txt) {
  const m = txt.match(/MACROS:\s*(\{[^}]+\})/);
  if (m) {
    try {
      const p = JSON.parse(m[1]);
      return {
        kcal: Math.max(0, Math.round(+p.kcal || 0)),
        prot: Math.max(0, Math.round(+p.prot || 0)),
        cho: Math.max(0, Math.round(+p.cho || 0)),
        grasa: Math.max(0, Math.round(+p.grasa || 0)),
      };
    } catch {
      const b = m[1];
      const n = (k) => {
        const r = b.match(new RegExp('"?' + k + '"?\\s*:\\s*(\\d+)'));
        return r ? Math.max(0, parseInt(r[1])) : 0;
      };
      return { kcal: n('kcal'), prot: n('prot'), cho: n('cho'), grasa: n('grasa') };
    }
  }
  const tail = txt.slice(-300);
  return {
    kcal: Math.max(0, +(tail.match(/(\d+)\s*kcal/i)?.[1] || 0)),
    prot: Math.max(0, +(tail.match(/(\d+)\s*g\s*(?:de\s*)?prot/i)?.[1] || 0)),
    cho: Math.max(0, +(tail.match(/(\d+)\s*g\s*(?:de\s*)?(?:carb|cho)/i)?.[1] || 0)),
    grasa: Math.max(0, +(tail.match(/(\d+)\s*g\s*(?:de\s*)?gras/i)?.[1] || 0)),
  };
}

function cleanTxt(t) {
  return t.replace(/MACROS:\s*\{[^}]+\}/, '').trim();
}

function fechaLocalHoy() {
  const n = new Date();
  return (
    n.getFullYear() +
    '-' +
    String(n.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(n.getDate()).padStart(2, '0')
  );
}

function esHoy(ts) {
  if (!ts) return false;
  try {
    const d = new Date(ts);
    const hoy = new Date();
    return d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth() && d.getDate() === hoy.getDate();
  } catch {
    return false;
  }
}

// ─── UI: RELOJ Y FECHA ──────────────────────

function setTime() {
  const n = new Date();
  document.getElementById('time-now').textContent = n.toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
  });
  document.getElementById('fecha-hoy').textContent = n.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

// ─── UI: MACROS ──────────────────────────────

function updateMacros() {
  const metas = getMetas();
  const t = log.reduce(
    (a, e) => ({
      kcal: a.kcal + (+e.macros.kcal || 0),
      prot: a.prot + (+e.macros.prot || 0),
      cho: a.cho + (+e.macros.cho || 0),
      grasa: a.grasa + (+e.macros.grasa || 0),
    }),
    { kcal: 0, prot: 0, cho: 0, grasa: 0 }
  );
  ['kcal', 'prot', 'cho', 'grasa'].forEach((k) => {
    const v = Math.round(t[k]);
    document.getElementById('mv-' + k).textContent = v || '\u2014';
    const r = v / metas[k];
    document.getElementById('mp-' + k).className = 'mp' + (v <= 0 ? '' : r > 1.05 ? ' over' : r >= 0.8 ? ' good' : '');
  });
}

function updateBanner() {
  const m = getMetas();
  const b = document.getElementById('act-banner');
  if (m.kcal !== CONFIG.metas.kcal) {
    b.textContent = `🏃‍♀️ Meta ajustada: ${m.kcal.toLocaleString()} kcal \u00b7 ${m.cho}g carbs`;
    b.classList.add('show');
  } else {
    b.classList.remove('show');
  }
  document.getElementById('mm-kcal').textContent = '/' + m.kcal.toLocaleString();
  document.getElementById('mm-cho').textContent = '/' + m.cho;
  updateMacros();
}

// ─── GOOGLE SHEETS: CARGAR HOY ───────────────

async function cargarHoy() {
  const dot = document.getElementById('sdot');
  const lbl = document.getElementById('slbl');

  if (CONFIG.sheetsUrl.startsWith('REEMPLAZAR')) {
    dot.style.animation = '';
    dot.style.background = '#BA7517';
    lbl.textContent = 'Google Sheets no configurado';
    return;
  }

  try {
    const url = CONFIG.sheetsUrl + '?localDate=' + fechaLocalHoy() + '&t=' + Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    const res = await fetch(url, { method: 'GET', credentials: 'omit', redirect: 'follow', signal: ac.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (data.status === 'ok') {
      const entries = (data.entries || []).filter((e) => esHoy(e.timestamp));
      log = entries.map((e) => ({
        meal: e.tipo || '',
        food: e.descripcion || '',
        time: (() => {
          try {
            return new Date(e.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
          } catch {
            return '\u2014';
          }
        })(),
        ts: e.timestamp || '',
        macros: {
          kcal: Math.max(0, +e.kcal || 0),
          prot: Math.max(0, +e.proteina || 0),
          cho: Math.max(0, +e.carbohidratos || 0),
          grasa: Math.max(0, +e.grasas || 0),
        },
        actividad: e.actividad || '',
        peso: e.peso || '',
        analysis: e.analisis || '',
      }));
      updateMacros();
      dot.style.animation = '';
      dot.style.background = '#3B6D11';
      const n = log.length;
      lbl.textContent = n ? `${n} registro${n > 1 ? 's' : ''} cargado${n > 1 ? 's' : ''} de hoy` : 'Sin registros hoy';
    } else {
      throw new Error(data.msg || 'Error');
    }
  } catch (e) {
    dot.style.animation = '';
    dot.style.background = '#993556';
    lbl.textContent = 'Sin conexion a Sheets \u2014 puedes registrar igual';
    console.warn('Sheets GET:', e.message);
  }
}

// ─── GOOGLE SHEETS: GUARDAR ──────────────────

async function guardarSheets(entry, analisis) {
  if (CONFIG.sheetsUrl.startsWith('REEMPLAZAR')) {
    document.getElementById('save-st').textContent = '\u26a0 Google Sheets no configurado';
    document.getElementById('save-st').className = 'save-st err';
    return;
  }

  const st = document.getElementById('save-st');
  st.textContent = 'Guardando en Google Sheets\u2026';
  st.className = 'save-st';
  try {
    await fetch(CONFIG.sheetsUrl, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({
        timestamp: entry.ts,
        tipo: entry.meal,
        descripcion: entry.food,
        kcal: entry.macros.kcal || 0,
        proteina: entry.macros.prot || 0,
        carbohidratos: entry.macros.cho || 0,
        grasas: entry.macros.grasa || 0,
        actividad: entry.actividad,
        peso: entry.peso,
        analisis: analisis.substring(0, 1500),
      }),
    });
    st.textContent = '\u2713 Guardado en Google Sheets';
    st.className = 'save-st ok';
    document.getElementById('slbl').textContent = `${log.length} registro${log.length > 1 ? 's' : ''} hoy \u00b7 Sheets \u2713`;
    document.getElementById('sdot').style.background = '#3B6D11';
  } catch (e) {
    st.textContent = '\u2715 No se pudo guardar en Sheets: ' + e.message;
    st.className = 'save-st err';
  }
}

async function guardarEdicionSheets(entry, analisis) {
  if (CONFIG.sheetsUrl.startsWith('REEMPLAZAR')) return;
  try {
    await fetch(CONFIG.sheetsUrl, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({
        action: 'update',
        timestamp: entry.ts,
        tipo: entry.meal,
        descripcion: entry.food,
        kcal: entry.macros.kcal || 0,
        proteina: entry.macros.prot || 0,
        carbohidratos: entry.macros.cho || 0,
        grasas: entry.macros.grasa || 0,
        actividad: entry.actividad,
        peso: entry.peso || '',
        analisis: analisis.substring(0, 1500),
      }),
    });
  } catch (e) {
    console.warn('Sheets update:', e.message);
  }
}

// ─── TABS ────────────────────────────────────

function goTab(id) {
  ['reg', 'hist', 'prog'].forEach((t, i) => {
    document.querySelectorAll('.tab')[i].classList.toggle('active', t === id);
    document.getElementById('sec-' + t).classList.toggle('active', t === id);
  });
  if (id === 'hist') renderHist();
  if (id === 'prog') renderProg();
}

// ─── ACTIVIDADES ─────────────────────────────

function toggleAct(el, val) {
  el.classList.toggle('sel');
  acts = el.classList.contains('sel') ? [...acts, val] : acts.filter((a) => a !== val);
  const chipKcal = acts.reduce((s, a) => s + (CONFIG.actividades[a]?.kcalDefault || 0), 0);
  ejercicioKcal = chipKcal;
  document.getElementById('ejercicio-kcal').value = chipKcal || '';
  updateBanner();
  try {
    localStorage.setItem('mn_acts_' + TODAY, JSON.stringify(acts));
  } catch {}
  try {
    if (ejercicioKcal > 0) localStorage.setItem('mn_ejkcal_' + TODAY, ejercicioKcal);
    else localStorage.removeItem('mn_ejkcal_' + TODAY);
  } catch {}
}

function restaurarEstado() {
  // Restaurar actividades
  try {
    const savedActs = JSON.parse(localStorage.getItem('mn_acts_' + TODAY) || '[]');
    if (savedActs.length) {
      acts = savedActs;
      document.querySelectorAll('.chip').forEach((chip) => {
        const val = chip.getAttribute('onclick')?.match(/'([^']+)'\)/)?.[1];
        if (val && acts.includes(val)) chip.classList.add('sel');
      });
      updateBanner();
    }
  } catch {}
  // Restaurar peso
  try {
    const savedPeso = localStorage.getItem('mn_peso_' + TODAY);
    if (savedPeso) document.getElementById('peso-hoy').value = savedPeso;
  } catch {}
  // Restaurar kcal de ejercicio
  try {
    const savedEjKcal = parseInt(localStorage.getItem('mn_ejkcal_' + TODAY) || '0');
    if (savedEjKcal > 0) {
      ejercicioKcal = savedEjKcal;
      document.getElementById('ejercicio-kcal').value = savedEjKcal;
      updateBanner();
    }
  } catch {}
}

// ─── FOTO ────────────────────────────────────

function handlePhoto(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.type.startsWith('image/')) {
    alert('El archivo debe ser una imagen.');
    document.getElementById('file-in').value = '';
    return;
  }
  if (f.size > CONFIG.maxPhotoBytes) {
    alert(`Foto muy grande (max ${Math.round(CONFIG.maxPhotoBytes / 1024 / 1024)} MB).`);
    return;
  }
  photoMime = f.type;
  const r = new FileReader();
  r.onload = (ev) => {
    photoB64 = ev.target.result.split(',')[1];
    document.getElementById('photo-prev').src = ev.target.result;
    document.getElementById('photo-prev-wrap').classList.add('show');
    document.getElementById('photo-btn').classList.add('has');
    document.getElementById('photo-lbl').textContent = '\u2713 Foto adjunta';
  };
  r.readAsDataURL(f);
}

function clearPhoto() {
  photoB64 = null;
  photoMime = null;
  document.getElementById('file-in').value = '';
  document.getElementById('photo-prev-wrap').classList.remove('show');
  document.getElementById('photo-btn').classList.remove('has');
  document.getElementById('photo-lbl').textContent = 'Adjuntar foto de la comida';
}

// ─── REGISTRAR COMIDA ────────────────────────

async function registrar() {
  const desc = document.getElementById('food-desc').value.trim();
  const meal = document.getElementById('meal-type').value;
  const peso = document.getElementById('peso-hoy').value;

  if (!desc && !photoB64) {
    alert('Describe lo que comiste o adjunta una foto.');
    return;
  }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Analizando\u2026';
  document.getElementById('resp-wrap').innerHTML =
    '<div class="resp loading">Analizando tu comida\u2026 ' + CONFIG.emoji + '</div>';
  document.getElementById('save-st').textContent = '';

  const prevHoy = log
    .slice(-5)
    .map((e) => `${e.meal}(${e.time}): ${e.food} | macros:${JSON.stringify(e.macros)}`)
    .join('\n') || 'Sin registros previos hoy.';
  const actStr = getActStr();
  const metas = getMetas();

  const content = [];
  if (photoB64) content.push({ type: 'image', source: { type: 'base64', media_type: photoMime, data: photoB64 } });
  content.push({
    type: 'text',
    text: [
      `Comida: ${meal}`,
      `Descripcion: ${desc || '(ver foto)'}`,
      `Actividad hoy: ${actStr}`,
      peso ? `Peso hoy: ${peso} kg` : null,
      `Meta calorica ajustada hoy: ${metas.kcal} kcal | ${metas.prot}g prot | ${metas.cho}g carbs | ${metas.grasa}g grasa`,
      '',
      'Comidas previas hoy:',
      prevHoy,
      '',
      'Realiza el check-in de esta comida.',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  });

  try {
    const aiText = await callClaude(SYSTEM_CHECKIN, [{ role: 'user', content }], 1000);
    const macros = extractMacros(aiText);
    const clean = cleanTxt(aiText);
    const entry = {
      meal,
      food: desc || '(foto)',
      peso: peso || '',
      time: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
      ts: new Date().toISOString(),
      analysis: aiText,
      macros,
      actividad: actStr,
      img: photoB64 ? `data:${photoMime};base64,${photoB64}` : null,
    };
    log.push(entry);
    updateMacros();
    document.getElementById('resp-wrap').innerHTML = '<div class="resp">' + mdToHtml(clean) + '</div>';
    await guardarSheets(entry, clean);
    document.getElementById('food-desc').value = '';
    clearPhoto();
  } catch (err) {
    document.getElementById('resp-wrap').innerHTML =
      `<div class="resp loading">Error: ${escH(err.message)}<br><br>Verifica tu conexion e intenta de nuevo.</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Analizar y registrar';
}

// ─── CERRAR DIA ──────────────────────────────

async function cerrarDia() {
  const btn = document.getElementById('cerrar-btn');
  if (!log.length) {
    document.getElementById('cerrar-wrap').innerHTML =
      '<div class="resp">Todavia no hay comidas registradas hoy. Registra tu primera comida. ' + CONFIG.emoji + '</div>';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Calculando\u2026';
  document.getElementById('cerrar-wrap').innerHTML =
    '<div class="resp loading">Calculando lo que te falta\u2026 ' + CONFIG.emoji + '</div>';

  const metas = getMetas();
  const consumido = log.reduce(
    (a, e) => ({
      kcal: a.kcal + (+e.macros.kcal || 0),
      prot: a.prot + (+e.macros.prot || 0),
      cho: a.cho + (+e.macros.cho || 0),
      grasa: a.grasa + (+e.macros.grasa || 0),
    }),
    { kcal: 0, prot: 0, cho: 0, grasa: 0 }
  );

  const diff = {
    kcal: metas.kcal - Math.round(consumido.kcal),
    prot: metas.prot - Math.round(consumido.prot),
    cho: metas.cho - Math.round(consumido.cho),
    grasa: metas.grasa - Math.round(consumido.grasa),
  };
  const falta = {
    kcal: Math.max(0, diff.kcal),
    prot: Math.max(0, diff.prot),
    cho: Math.max(0, diff.cho),
    grasa: Math.max(0, diff.grasa),
  };

  const todoCubierto = falta.kcal === 0 && falta.prot === 0 && falta.cho === 0 && falta.grasa === 0;
  const sinExcesos = diff.kcal >= -50 && diff.prot >= -5 && diff.cho >= -10 && diff.grasa >= -5;
  if (todoCubierto && sinExcesos) {
    document.getElementById('cerrar-wrap').innerHTML =
      '<div class="resp">Ya cerraste el dia al 100%! Tus macros estan completos. ' + CONFIG.emoji + '</div>';
    btn.disabled = false;
    btn.textContent = 'Que me falta para cerrar el dia?';
    return;
  }

  function descMacro(nombre, d, falt, unit) {
    if (d < 0) return `${nombre}: EXCEDIDA por ${Math.abs(d)}${unit} (no agregar mas)`;
    if (falt === 0) return `${nombre}: cubierta (no agregar mas)`;
    return `${nombre}: faltan ${falt}${unit}`;
  }
  const estadoMacros = [
    descMacro('Calorias', diff.kcal, falta.kcal, 'kcal'),
    descMacro('Proteina', diff.prot, falta.prot, 'g'),
    descMacro('Carbohidratos', diff.cho, falta.cho, 'g'),
    descMacro('Grasa', diff.grasa, falta.grasa, 'g'),
  ].join('\n');

  const comidas =
    log.map((e) => `${e.meal}: ${e.food} | macros:${JSON.stringify(e.macros)}`).join('\n') || 'Sin registros.';
  const hora = new Date().getHours();
  const momento = hora < 12 ? 'manana' : hora < 17 ? 'tarde' : 'noche';

  const prompt = `${CONFIG.nombre} lleva registrado hoy:
${comidas}

Meta del dia: ${metas.kcal} kcal | ${metas.prot}g prot | ${metas.cho}g carbs | ${metas.grasa}g grasa
Consumido: ${Math.round(consumido.kcal)} kcal | ${Math.round(consumido.prot)}g prot | ${Math.round(consumido.cho)}g carbs | ${Math.round(consumido.grasa)}g grasa

Estado real de cada macro:
${estadoMacros}

Hora del dia: ${momento}

Dame exactamente 3 opciones de comida para cerrar el dia lo mas cerca posible al 100%. Considera el estado real de cada macro: si alguno ya esta excedido, NO agregues mas de ese macro. Si alguno falta, cubrelo. Usa formato markdown con tabla de macros por opcion. Se muy especifica con cantidades (gramos, tazas, piezas). Tono motivador.`;

  try {
    const aiText = await callClaude(buildSystemCerrar(), [{ role: 'user', content: prompt }], 900);
    document.getElementById('cerrar-wrap').innerHTML = '<div class="resp">' + mdToHtml(aiText) + '</div>';
  } catch (e) {
    document.getElementById('cerrar-wrap').innerHTML =
      `<div class="resp loading">Error: ${escH(e.message)}<br><br>Verifica tu conexion e intenta de nuevo.</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Que me falta para cerrar el dia?';
}

// ─── HISTORIAL ───────────────────────────────

function renderHist() {
  const c = document.getElementById('hist-list');
  if (!log.length) {
    c.innerHTML =
      '<div class="empty">Sin registros esta sesion.<br>Registra tu primer alimento. ' +
      CONFIG.emoji +
      '<br><br><small>El historial completo esta en tu Google Sheets.</small></div>';
    return;
  }
  const bc = { Desayuno: 'bd', Almuerzo: 'ba', Cena: 'bc', Snack: 'bs' };
  const mealOpts = ['Desayuno', 'Almuerzo', 'Cena', 'Snack'];
  c.innerHTML = log
    .slice()
    .reverse()
    .map((e, i) => {
      const idx = log.length - 1 - i;
      const m = e.macros;
      const opts = mealOpts.map((o) => `<option${o === e.meal ? ' selected' : ''}>${o}</option>`).join('');
      const foodEsc = escH(e.food === '(foto)' ? '' : e.food);
      return `<div class="log-item">
      <div id="view-${idx}">
        <div class="log-top">
          <span class="badge ${bc[e.meal] || 'bs'}">${escH(e.meal)}</span>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="log-time">${escH(e.time)}</span>
            <button class="log-edit-btn" onclick="toggleEdit(${idx})" title="Editar comida">&#9998;</button>
          </div>
        </div>
        <div class="log-food" id="food-txt-${idx}">${escH(e.food)}</div>
        <div class="log-macros" id="macros-txt-${idx}"><span>${m.kcal} kcal</span><span>${m.prot}g prot</span><span>${m.cho}g carbs</span><span>${m.grasa}g grasa</span></div>
        ${e.img ? `<img src="${e.img}" style="max-height:65px;border-radius:8px;margin:4px 0;object-fit:cover;" alt="Foto comida">` : ''}
        ${e.analysis ? `<button class="log-expand" onclick="toggleDetail(${idx})">Ver analisis &#9662;</button><div class="log-detail resp" id="detail-${idx}">${mdToHtml(cleanTxt(e.analysis))}</div>` : ''}
      </div>
      <div class="edit-form" id="edit-form-${idx}">
        <div class="card-title" style="margin-bottom:6px">Editar comida</div>
        <select class="edit-meal-sel" id="edit-meal-${idx}">${opts}</select>
        <textarea id="edit-desc-${idx}" style="width:100%;border:0.5px solid var(--border-sec);border-radius:var(--radius-md);padding:10px 12px;font-size:13px;font-family:'DM Sans',sans-serif;color:var(--text-pri);background:var(--bg-pri);resize:none;min-height:70px;line-height:1.55;outline:none" placeholder="Describe la comida corregida\u2026">${foodEsc}</textarea>
        <div class="edit-btns">
          <button class="btn" id="edit-btn-${idx}" onclick="guardarEdicion(${idx})">Recalcular</button>
          <button class="btn btn-pina" onclick="toggleEdit(${idx})">Cancelar</button>
        </div>
        <div class="edit-st" id="edit-st-${idx}"></div>
      </div>
    </div>`;
    })
    .join('');
}

function toggleDetail(idx) {
  document.getElementById('detail-' + idx).classList.toggle('show');
}

function toggleEdit(idx) {
  const form = document.getElementById('edit-form-' + idx);
  const view = document.getElementById('view-' + idx);
  const show = !form.classList.contains('show');
  form.classList.toggle('show', show);
  view.style.opacity = show ? '0.4' : '1';
  if (show) document.getElementById('edit-desc-' + idx).focus();
  document.getElementById('edit-st-' + idx).textContent = '';
}

async function guardarEdicion(idx) {
  const newDesc = document.getElementById('edit-desc-' + idx).value.trim();
  const newMeal = document.getElementById('edit-meal-' + idx).value;
  if (!newDesc) {
    alert('Describe la comida corregida.');
    return;
  }
  const btn = document.getElementById('edit-btn-' + idx);
  const st = document.getElementById('edit-st-' + idx);
  btn.disabled = true;
  btn.textContent = 'Recalculando\u2026';
  st.textContent = 'Analizando con los datos corregidos\u2026';
  st.className = 'edit-st';

  const metas = getMetas();
  const actStr = getActStr();
  const prevHoy =
    log
      .filter((_, i) => i !== idx)
      .slice(-5)
      .map((e) => `${e.meal}(${e.time}): ${e.food} | macros:${JSON.stringify(e.macros)}`)
      .join('\n') || 'Sin registros previos.';

  try {
    const aiText = await callClaude(
      SYSTEM_CHECKIN,
      [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Comida: ${newMeal}`,
                `Descripcion: ${newDesc}`,
                `Actividad hoy: ${actStr}`,
                `Meta calorica ajustada hoy: ${metas.kcal} kcal | ${metas.prot}g prot | ${metas.cho}g carbs | ${metas.grasa}g grasa`,
                '',
                'Otras comidas del dia:',
                prevHoy,
                '',
                'Realiza el check-in de esta comida (es una correccion de un registro anterior).',
              ].join('\n'),
            },
          ],
        },
      ],
      1000
    );
    const macros = extractMacros(aiText);
    const clean = cleanTxt(aiText);
    log[idx].meal = newMeal;
    log[idx].food = newDesc;
    log[idx].macros = macros;
    log[idx].analysis = aiText;
    log[idx].actividad = actStr;
    updateMacros();
    renderHist();
    guardarEdicionSheets(log[idx], clean);
  } catch (err) {
    st.textContent = 'Error: ' + escH(err.message);
    st.className = 'edit-st err';
    btn.disabled = false;
    btn.textContent = 'Recalcular';
  }
}

// ─── PROGRESO ────────────────────────────────

function renderProg() {
  const metas = getMetas();
  const t = log.reduce(
    (a, e) => ({
      kcal: a.kcal + (+e.macros.kcal || 0),
      prot: a.prot + (+e.macros.prot || 0),
      cho: a.cho + (+e.macros.cho || 0),
      grasa: a.grasa + (+e.macros.grasa || 0),
    }),
    { kcal: 0, prot: 0, cho: 0, grasa: 0 }
  );
  document.getElementById('pg-comidas').textContent = log.length;
  const lp = [...log].reverse().find((e) => e.peso);
  document.getElementById('pg-peso').textContent = lp ? lp.peso + ' kg' : '\u2014';
  const bars = [
    { label: 'Calorias', key: 'kcal', unit: 'kcal' },
    { label: 'Proteina', key: 'prot', unit: 'g' },
    { label: 'Carbohidratos', key: 'cho', unit: 'g' },
    { label: 'Grasa', key: 'grasa', unit: 'g' },
  ];
  document.getElementById('prog-bars').innerHTML = bars
    .map((b) => {
      const val = Math.round(t[b.key]);
      const max = metas[b.key];
      const pct = Math.min(100, Math.round((val / max) * 100));
      const ratio = val / max;
      const color = ratio > 1.05 ? 'red' : ratio >= 0.8 ? 'green' : 'yellow';
      return `<div class="pbar-row"><div class="pbar-head"><span class="pbar-name">${b.label}</span><span class="pbar-nums">${val}${b.unit} / ${max}${b.unit}</span></div><div class="pbar-track"><div class="pbar-fill ${color}" style="width:${pct}%"></div></div></div>`;
    })
    .join('');
}

// ─── RESUMEN DEL DIA ─────────────────────────

async function generarResumen() {
  if (!log.length) {
    alert('Registra al menos una comida primero.');
    return;
  }
  const btn = document.getElementById('summary-btn');
  btn.disabled = true;
  btn.textContent = 'Generando\u2026';
  document.getElementById('resumen-wrap').innerHTML =
    '<div class="resp loading">Preparando tu resumen del dia\u2026 ' + CONFIG.emoji + '</div>';

  const metas = getMetas();
  const todas = log
    .map((e) => `${e.meal}(${e.time}): ${e.food} | macros:${JSON.stringify(e.macros)} | actividad:${e.actividad}`)
    .join('\n');

  try {
    const aiText = await callClaude(
      buildSystemResumen(metas),
      [{ role: 'user', content: `Resumen del dia.\n\nComidas:\n${todas}` }],
      1000
    );
    document.getElementById('resumen-wrap').innerHTML = '<div class="resp">' + mdToHtml(aiText) + '</div>';
  } catch (e) {
    document.getElementById('resumen-wrap').innerHTML =
      `<div class="resp loading">Error: ${escH(e.message)}<br><br>Verifica tu conexion e intenta de nuevo.</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Ver resumen del dia';
}

// ─── INICIALIZACION ──────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setTime();
  setInterval(setTime, 30000);

  // Guardar peso al escribirlo
  document.getElementById('peso-hoy').addEventListener('input', function () {
    try {
      if (this.value) localStorage.setItem('mn_peso_' + TODAY, this.value);
    } catch {}
  });

  // Guardar y aplicar kcal de ejercicio
  document.getElementById('ejercicio-kcal').addEventListener('input', function () {
    ejercicioKcal = Math.max(0, parseInt(this.value) || 0);
    updateBanner();
    try {
      if (ejercicioKcal > 0) localStorage.setItem('mn_ejkcal_' + TODAY, ejercicioKcal);
      else localStorage.removeItem('mn_ejkcal_' + TODAY);
    } catch {}
  });

  // Registrar service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registro fallido:', err);
    });
  }

  cargarHoy();
  restaurarEstado();
});
