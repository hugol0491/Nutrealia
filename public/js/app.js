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
  sheetsUrl: 'https://script.google.com/macros/s/AKfycby-Oc0v1RqtESxe5g5YsIEKFl-gGZctzzuNxWwgbQvjHY2MaDUqKvFkucAcPYX45rcH/exec',

  // Metas nutricionales diarias base
  metas: { kcal: 1800, prot: 120, cho: 200, grasa: 60 },

  // Actividades disponibles y sus kcal default al seleccionar el chip
  actividades: {
    cardio:  { emoji: '🏃‍♀️', nombre: 'Cardio',   kcalDefault: 250 },
    fuerza:  { emoji: '🏋️',  nombre: 'Fuerza',   kcalDefault: 200 },
    yoga:    { emoji: '🧘',   nombre: 'Yoga',     kcalDefault: 150 },
    caminar: { emoji: '🚶‍♀️', nombre: 'Caminata', kcalDefault: 100 },
  },

  // Perfil para el prompt de sistema de Claude (comprimido para ahorrar tokens)
  perfil: 'Paciente: Mariana. Metas base: 1800kcal|120P|200C|60G. Ejercicio: +kcal a meta, extra va a carbs (kcal/4). Meta ajustada incluida en cada check-in.',

  // Restricciones alimentarias (dejar vacio si no aplica)
  restricciones: '',

  // Modelos por funcion — Haiku es ~75% mas barato, adecuado para estimacion de macros
  // Opciones: 'claude-sonnet-4-6' o 'claude-haiku-4-5-20251001'
  modeloCheckin: 'claude-sonnet-4-6',
  modeloCerrar: 'claude-sonnet-4-6',
  modeloResumen: 'claude-sonnet-4-6',

  // Tamano maximo de foto en bytes (3 MB para no exceder limites de Netlify Functions)
  maxPhotoBytes: 3 * 1024 * 1024,

  // Dimension maxima de foto en px (se redimensiona antes de enviar para ahorrar tokens de vision)
  maxImagePx: 768,
};

// ─── SYSTEM PROMPTS ──────────────────────────

const SYSTEM_CHECKIN = `Nutricionista de ${CONFIG.nombre}. ${CONFIG.perfil}
${CONFIG.restricciones ? 'Restricciones: ' + CONFIG.restricciones : ''}
Espanol, amable, metricas. Tabla metas vs consumido. 1 recomendacion. Estimaciones con "(est)". Max 1 pregunta. No diagnosticos. No sumar kcal ejercicio a ingeridas. Concisa: max 150 palabras antes del JSON.
OBLIGATORIO al final (JSON, enteros, SOLO esta comida, sin texto despues):
MACROS:{"kcal":N,"prot":N,"cho":N,"grasa":N}`;

function buildSystemCerrar() {
  return `Nutricionista de ${CONFIG.nombre}. ${CONFIG.perfil}
${CONFIG.restricciones ? 'Restricciones: ' + CONFIG.restricciones : ''}
Solo recomienda lo que falta para llegar a metas sin exceder ningun macro. Concisa. Espanol.`;
}

function buildSystemResumen(metas) {
  return `Nutricionista de ${CONFIG.nombre}. ${CONFIG.perfil}
Meta ajustada: ${metas.kcal}kcal|${metas.prot}P|${metas.cho}C|${metas.grasa}G.
Resumen diario max 300 palabras, markdown: 1)Tabla macros vs meta 2)Proteina 3)Adherencia 4)3 prioridades manana. Espanol, motivador.`;
}

// ─── ESTADO GLOBAL ───────────────────────────

let log = [];
let photoB64 = null;
let photoMime = null;
let acts = [];
let ejercicioKcal = 0;
// Se recalcula en cada uso para que funcione si la PWA queda abierta al pasar medianoche.
function todayKey() {
  return new Date().toDateString();
}

// ─── FUNCION PROXY PARA CLAUDE API ──────────

async function callClaude(system, messages, maxTokens, model) {
  const res = await fetch('/.netlify/functions/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages, max_tokens: maxTokens || 500, model: model || CONFIG.modeloCheckin }),
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
  // Evita lookbehind (no soportado en Safari iOS < 16.4): usamos un marcador temporal
  // para proteger los ** ya transformados y luego restituir los asteriscos de italicas.
  h = h.replace(/<strong>/g, '\u0001strong\u0001').replace(/<\/strong>/g, '\u0001/strong\u0001');
  h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  h = h.replace(/\u0001strong\u0001/g, '<strong>').replace(/\u0001\/strong\u0001/g, '</strong>');
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
  // Reemplazo de saltos simples sin lookbehind: tokenizamos por '\n' y saltamos
  // los que quedan junto a etiquetas de bloque.
  h = h
    .split('\n')
    .map((part, i, arr) => {
      if (i === 0) return part;
      const prev = arr[i - 1];
      const prevEndsWithTag = /[>]$/.test(prev);
      const curStartsWithTag = /^</.test(part);
      return (prevEndsWithTag || curStartsWithTag ? '' : '<br>') + part;
    })
    .join('');
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
        return r ? Math.max(0, parseInt(r[1], 10)) : 0;
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
    lbl.textContent = 'Sin conexi\u00f3n \u2014 puedes registrar igual';
    console.warn('Sheets GET:', e.message);
  }
}

// ─── GOOGLE SHEETS: GUARDAR ──────────────────

async function guardarSheets(entry, analisis) {
  const st = document.getElementById('save-st');
  st.textContent = 'Guardando\u2026';
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
    st.textContent = '\u2713 Guardado';
    st.className = 'save-st ok';
    document.getElementById('slbl').textContent = `${log.length} registro${log.length > 1 ? 's' : ''} hoy \u00b7 guardado \u2713`;
    document.getElementById('sdot').style.background = '#3B6D11';
  } catch (e) {
    st.textContent = '\u2715 No se pudo guardar: ' + e.message;
    st.className = 'save-st err';
  }
}

async function guardarEdicionSheets(entry, analisis) {
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
    localStorage.setItem('mn_acts_' + todayKey(), JSON.stringify(acts));
  } catch {}
  try {
    if (ejercicioKcal > 0) localStorage.setItem('mn_ejkcal_' + todayKey(), ejercicioKcal);
    else localStorage.removeItem('mn_ejkcal_' + todayKey());
  } catch {}
}

function restaurarEstado() {
  // Restaurar actividades
  try {
    const savedActs = JSON.parse(localStorage.getItem('mn_acts_' + todayKey()) || '[]');
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
    const savedPeso = localStorage.getItem('mn_peso_' + todayKey());
    if (savedPeso) document.getElementById('peso-hoy').value = savedPeso;
  } catch {}
  // Restaurar kcal de ejercicio
  try {
    const savedEjKcal = parseInt(localStorage.getItem('mn_ejkcal_' + todayKey()) || '0', 10);
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
  const r = new FileReader();
  r.onload = (ev) => {
    // Redimensionar para ahorrar tokens de vision (~90% menos tokens en fotos grandes)
    const img = new Image();
    img.onload = () => {
      const max = CONFIG.maxImagePx || 768;
      let w = img.width, h = img.height;
      if (w > max || h > max) {
        const ratio = Math.min(max / w, max / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const resizedUrl = canvas.toDataURL('image/jpeg', 0.75);
      photoB64 = resizedUrl.split(',')[1];
      photoMime = 'image/jpeg';
      document.getElementById('photo-prev').src = resizedUrl;
      document.getElementById('photo-prev-wrap').classList.add('show');
      document.getElementById('photo-btn').classList.add('has');
      document.getElementById('photo-lbl').textContent = '\u2713 Foto adjunta';
    };
    img.src = ev.target.result;
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

  const actStr = getActStr();
  const metas = getMetas();
  // Enviar solo totales consumidos (ahorra ~50-80 tokens vs listar cada comida)
  const totales = log.reduce(
    (a, e) => ({ k: a.k + (+e.macros.kcal || 0), p: a.p + (+e.macros.prot || 0), c: a.c + (+e.macros.cho || 0), g: a.g + (+e.macros.grasa || 0) }),
    { k: 0, p: 0, c: 0, g: 0 }
  );
  const prevResumen = log.length
    ? `Consumido hoy: ${Math.round(totales.k)}kcal/${Math.round(totales.p)}P/${Math.round(totales.c)}C/${Math.round(totales.g)}G (${log.length} comidas)`
    : 'Primera comida del dia.';

  const content = [];
  if (photoB64) content.push({ type: 'image', source: { type: 'base64', media_type: photoMime, data: photoB64 } });
  content.push({
    type: 'text',
    text: [
      `${meal}: ${desc || '(ver foto)'}`,
      `Act: ${actStr}`,
      peso ? `Peso: ${peso}kg` : null,
      `Meta: ${metas.kcal}kcal|${metas.prot}P|${metas.cho}C|${metas.grasa}G`,
      prevResumen,
      'Check-in de esta comida.',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  });

  try {
    const aiText = await callClaude(SYSTEM_CHECKIN, [{ role: 'user', content }], 500, CONFIG.modeloCheckin);
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
      `<div class="resp loading">Error: ${escH(err.message)}<br><br>Verifica tu conexi\u00f3n e intenta de nuevo.</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Analizar y registrar';
}

// ─── CERRAR DIA ──────────────────────────────

async function cerrarDia() {
  const btn = document.getElementById('cerrar-btn');
  if (!log.length) {
    document.getElementById('cerrar-wrap').innerHTML =
      '<div class="resp">Todav\u00eda no hay comidas registradas hoy. Registra tu primera comida. ' + CONFIG.emoji + '</div>';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Calculando\u2026';
  document.getElementById('cerrar-wrap').innerHTML =
    '<div class="resp loading">Calculando lo que te falta para cerrar el d\u00eda\u2026 ' + CONFIG.emoji + '</div>';

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
      '<div class="resp">\u00a1Ya cerraste el d\u00eda al 100%! Tus macros est\u00e1n completos. ' + CONFIG.emoji + '</div>';
    btn.disabled = false;
    btn.textContent = '\ud83c\udfaf \u00bfQu\u00e9 me falta para cerrar el d\u00eda?';
    return;
  }

  function descMacro(nombre, d, falt, unit) {
    if (d < 0) return `${nombre}: EXCEDIDA por ${Math.abs(d)}${unit} (no agregar mas)`;
    if (falt === 0) return `${nombre}: cubierta (no agregar mas)`;
    return `${nombre}: faltan ${falt}${unit}`;
  }
  // Estos textos se envian dentro del prompt a Claude (no se muestran en UI).
  // Se mantienen sin acentos para no afectar la eficiencia de tokens.
  const estadoMacros = [
    descMacro('Calorias', diff.kcal, falta.kcal, 'kcal'),
    descMacro('Proteina', diff.prot, falta.prot, 'g'),
    descMacro('Carbohidratos', diff.cho, falta.cho, 'g'),
    descMacro('Grasa', diff.grasa, falta.grasa, 'g'),
  ].join('\n');

  // Formato compacto para comidas (cerrar dia necesita el detalle individual)
  const comidas = log.map((e) => `${e.meal}: ${e.food} [${e.macros.kcal}/${e.macros.prot}/${e.macros.cho}/${e.macros.grasa}]`).join('\n');
  const hora = new Date().getHours();
  const momento = hora < 12 ? 'manana' : hora < 17 ? 'tarde' : 'noche';

  const prompt = `Hoy:
${comidas}
Meta: ${metas.kcal}kcal|${metas.prot}P|${metas.cho}C|${metas.grasa}G
Consumido: ${Math.round(consumido.kcal)}kcal|${Math.round(consumido.prot)}P|${Math.round(consumido.cho)}C|${Math.round(consumido.grasa)}G
${estadoMacros}
Hora: ${momento}
3 opciones para cerrar al 100%. Tabla macros por opcion. Cantidades exactas (g, tazas, piezas).`;

  try {
    const aiText = await callClaude(buildSystemCerrar(), [{ role: 'user', content: prompt }], 700, CONFIG.modeloCerrar);
    document.getElementById('cerrar-wrap').innerHTML = '<div class="resp">' + mdToHtml(aiText) + '</div>';
  } catch (e) {
    document.getElementById('cerrar-wrap').innerHTML =
      `<div class="resp loading">Error: ${escH(e.message)}<br><br>Verifica tu conexi\u00f3n e intenta de nuevo.</div>`;
  }
  btn.disabled = false;
  btn.textContent = '\ud83c\udfaf \u00bfQu\u00e9 me falta para cerrar el d\u00eda?';
}

// ─── HISTORIAL ───────────────────────────────

function renderHist() {
  const c = document.getElementById('hist-list');
  if (!log.length) {
    c.innerHTML =
      '<div class="empty">Sin registros esta sesi\u00f3n.<br>\u00a1Registra tu primer alimento! ' +
      CONFIG.emoji +
      '<br><br><small>El historial completo est\u00e1 en los registros de Nutrealia en manos expertas, \u00a1gracias por confiar en Nutrealia!</small></div>';
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
  // Totales excluyendo la comida que se edita
  const otros = log.filter((_, i) => i !== idx);
  const totOtros = otros.reduce(
    (a, e) => ({ k: a.k + (+e.macros.kcal || 0), p: a.p + (+e.macros.prot || 0), c: a.c + (+e.macros.cho || 0), g: a.g + (+e.macros.grasa || 0) }),
    { k: 0, p: 0, c: 0, g: 0 }
  );
  const prevResumen = otros.length
    ? `Otras comidas: ${Math.round(totOtros.k)}kcal/${Math.round(totOtros.p)}P/${Math.round(totOtros.c)}C/${Math.round(totOtros.g)}G`
    : 'Unica comida del dia.';

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
                `${newMeal}: ${newDesc}`,
                `Act: ${actStr}`,
                `Meta: ${metas.kcal}kcal|${metas.prot}P|${metas.cho}C|${metas.grasa}G`,
                prevResumen,
                'Check-in (correccion de registro anterior).',
              ].join('\n'),
            },
          ],
        },
      ],
      500,
      CONFIG.modeloCheckin
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
    { label: 'Calor\u00edas', key: 'kcal', unit: 'kcal' },
    { label: 'Prote\u00edna', key: 'prot', unit: 'g' },
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
    '<div class="resp loading">Preparando tu resumen del d\u00eda\u2026 ' + CONFIG.emoji + '</div>';

  const metas = getMetas();
  const todas = log
    .map((e) => `${e.meal} ${e.time}: ${e.food} [${e.macros.kcal}/${e.macros.prot}/${e.macros.cho}/${e.macros.grasa}]`)
    .join('\n');

  try {
    const aiText = await callClaude(
      buildSystemResumen(metas),
      [{ role: 'user', content: `Resumen del dia:\n${todas}` }],
      700,
      CONFIG.modeloResumen
    );
    document.getElementById('resumen-wrap').innerHTML = '<div class="resp">' + mdToHtml(aiText) + '</div>';
  } catch (e) {
    document.getElementById('resumen-wrap').innerHTML =
      `<div class="resp loading">Error: ${escH(e.message)}<br><br>Verifica tu conexi\u00f3n e intenta de nuevo.</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Ver resumen del d\u00eda';
}

// ─── INICIALIZACION ──────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setTime();
  setInterval(setTime, 30000);

  // Guardar peso al escribirlo
  document.getElementById('peso-hoy').addEventListener('input', function () {
    try {
      if (this.value) localStorage.setItem('mn_peso_' + todayKey(), this.value);
    } catch {}
  });

  // Guardar y aplicar kcal de ejercicio
  document.getElementById('ejercicio-kcal').addEventListener('input', function () {
    ejercicioKcal = Math.max(0, parseInt(this.value, 10) || 0);
    updateBanner();
    try {
      if (ejercicioKcal > 0) localStorage.setItem('mn_ejkcal_' + todayKey(), ejercicioKcal);
      else localStorage.removeItem('mn_ejkcal_' + todayKey());
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
