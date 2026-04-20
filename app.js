'use strict';
/* ================================================================
   LP Tracker Pro — app.js
   Modelo: AMM x·y=k (Uniswap V2, pools 50/50)
   Auth + DB: Supabase
================================================================ */

/* ================================================================
   ESTADO GLOBAL
================================================================ */
const state = {
  user:          null,   // objeto de usuario Supabase
  pools:         [],     // array de pools del usuario
  activePoolId:  null,   // ID del pool activo (null = nuevo)
  activePool:    null,   // objeto pool completo
  logs:          [],     // logs del pool activo
  lastCalc:      null,   // { res, d } del último cálculo
  view:          'dashboard'
};

/* ================================================================
   UTILIDADES DOM / FORMATO
================================================================ */
const $ = id => document.getElementById(id);

function fmt(n, d = 2) {
  if (!isFinite(n)) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: d, maximumFractionDigits: d
  });
}
const fmtUSD = n => '$' + fmt(n, 2);
const fmtPct = n => fmt(n, 2) + '%';
const fmtNum = (n, d = 4) => fmt(n, d);

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function colorClass(n) {
  return n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';
}

function hoy() {
  return new Date().toISOString().slice(0, 10);
}

function showError(msg) {
  const el = $('errorMsg');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError() { $('errorMsg').classList.add('hidden'); }

/* ================================================================
   MOTOR DE CÁLCULO FINANCIERO — funciones puras
================================================================ */

/**
 * Impermanent Loss porcentual.
 * P  = (pa1/pa0) / (pb1/pb0)
 * IL = 2·√P / (1+P) − 1  → siempre ≤ 0
 */
function calcularIL(pa0, pb0, pa1, pb1) {
  const P = (pa1 / pa0) / (pb1 / pb0);
  return 2 * Math.sqrt(P) / (1 + P) - 1;
}

/**
 * Rebalanceo AMM x·y=k.
 * k   = qa0·qb0
 * qa1 = √(k·pb1/pa1)
 * qb1 = √(k·pa1/pb1)
 */
function calcularPool(qa0, qb0, pa1, pb1) {
  const k   = qa0 * qb0;
  const qa1 = Math.sqrt(k * pb1 / pa1);
  const qb1 = Math.sqrt(k * pa1 / pb1);
  return { qa1, qb1, valorPool: qa1 * pa1 + qb1 * pb1 };
}

function calcularHODL(qa0, qb0, pa1, pb1) { return qa0 * pa1 + qb0 * pb1; }
function calcularPnL(valorPool, fees, valorInicial) { return valorPool + fees - valorInicial; }
function calcularROI(pnl, valorInicial) {
  return valorInicial > 0 ? (pnl / valorInicial) * 100 : 0;
}
function calcularROIMensual(roi, dias) {
  if (dias < 1) return 0;
  const meses = dias / 30.4375;
  return (Math.pow(1 + roi / 100, 1 / meses) - 1) * 100;
}
function calcularDias(fechaA, fechaB) {
  if (!fechaA || !fechaB) return 0;
  const diff = new Date(fechaB + 'T00:00:00Z') - new Date(fechaA + 'T00:00:00Z');
  return Math.max(0, Math.round(diff / 86_400_000));
}

/** Punto de entrada: devuelve todas las métricas derivadas */
function ejecutarCalculos(d) {
  const valorInicial          = d.qa0 * d.pa0 + d.qb0 * d.pb0;
  const { qa1, qb1, valorPool } = calcularPool(d.qa0, d.qb0, d.pa1, d.pb1);
  const valorHODL             = calcularHODL(d.qa0, d.qb0, d.pa1, d.pb1);
  const ilPct                 = calcularIL(d.pa0, d.pb0, d.pa1, d.pb1);
  const ilUsd                 = valorHODL * ilPct;
  const pnl                   = calcularPnL(valorPool, d.fees, valorInicial);
  const roi                   = calcularROI(pnl, valorInicial);
  const dias                  = calcularDias(d.fechaEntrada, d.fechaActual);
  const roiMensual            = calcularROIMensual(roi, dias);
  const pnlVsHODL             = (valorPool + d.fees) - valorHODL;
  const feesVsIL              = d.fees + ilUsd;

  return {
    valorInicial, valorPool, valorHODL,
    qa1, qb1, ilPct, ilUsd, fees: d.fees,
    pnl, roi, roiMensual, roiAnual: roiMensual * 12,
    dias, pnlVsHODL, feesVsIL
  };
}

/* ================================================================
   MOTOR DE DECISIÓN — Health Score 0-100
================================================================ */

function calcularHealthScore(res) {
  const factores = [];

  // ── Factor 1: Fees vs IL (25 pts) ────────────────────────────
  const ilAbs   = Math.abs(res.ilUsd);
  const ratio   = ilAbs < 0.01 ? 1 : res.fees / ilAbs;
  let f1, f1label, f1estado;
  if (ilAbs < 0.5)      { f1 = 22; f1label = 'IL casi nulo (precios estables)'; f1estado = 'ok'; }
  else if (ratio >= 1)  { f1 = 25; f1label = 'Fees cubren el IL completamente'; f1estado = 'ok'; }
  else if (ratio >= .75){ f1 = 18; f1label = 'Fees cubren 75%+ del IL';         f1estado = 'mid'; }
  else if (ratio >= .5) { f1 = 12; f1label = 'Fees cubren 50%+ del IL';         f1estado = 'mid'; }
  else if (ratio >= .25){ f1 = 5;  f1label = 'Fees < 50% del IL';               f1estado = 'bad'; }
  else                  { f1 = 0;  f1label = 'Fees no compensan el IL';          f1estado = 'bad'; }
  factores.push({
    label: 'Fees vs IL', pts: f1, maxPts: 25, estado: f1estado,
    nombre: f1label,
    detalle: ilAbs < 0.5 ? 'Sin IL significativo' : `Ratio cobertura: ${(ratio * 100).toFixed(0)}%`
  });

  // ── Factor 2: PnL Real (25 pts) ──────────────────────────────
  let f2, f2label, f2estado;
  const roiPct = res.roi;
  if (roiPct > 10)      { f2 = 25; f2label = 'PnL excelente (ROI > 10%)';   f2estado = 'ok'; }
  else if (roiPct > 3)  { f2 = 20; f2label = 'PnL positivo (ROI > 3%)';     f2estado = 'ok'; }
  else if (roiPct > 0)  { f2 = 14; f2label = 'PnL positivo moderado';        f2estado = 'ok'; }
  else if (roiPct > -2) { f2 = 7;  f2label = 'PnL levemente negativo';       f2estado = 'mid'; }
  else if (roiPct > -5) { f2 = 2;  f2label = 'PnL negativo (-5% a -2%)';    f2estado = 'bad'; }
  else                  { f2 = 0;  f2label = 'PnL muy negativo (< -5%)';     f2estado = 'bad'; }
  factores.push({
    label: 'PnL Real', pts: f2, maxPts: 25, estado: f2estado,
    nombre: f2label, detalle: `PnL: ${fmtUSD(res.pnl)} · ROI: ${fmtPct(res.roi)}`
  });

  // ── Factor 3: Pool vs HODL (25 pts) ──────────────────────────
  let f3, f3label, f3estado;
  const hodlPct = res.valorHODL > 0 ? (res.pnlVsHODL / res.valorHODL) * 100 : 0;
  if (hodlPct > 3)      { f3 = 25; f3label = 'Pool supera al HODL claramente'; f3estado = 'ok'; }
  else if (hodlPct >= 0){ f3 = 18; f3label = 'Pool supera al HODL';            f3estado = 'ok'; }
  else if (hodlPct > -2){ f3 = 9;  f3label = 'HODL ligeramente mejor';         f3estado = 'mid'; }
  else                  { f3 = 0;  f3label = 'HODL hubiera sido mejor';         f3estado = 'bad'; }
  factores.push({
    label: 'Pool vs HODL', pts: f3, maxPts: 25, estado: f3estado,
    nombre: f3label,
    detalle: `Diferencia: ${fmtUSD(res.pnlVsHODL)} (${hodlPct >= 0 ? '+' : ''}${hodlPct.toFixed(2)}%)`
  });

  // ── Factor 4: Estabilidad de precios + tiempo (25 pts) ───────
  const ilAbs4 = Math.abs(res.ilPct * 100);
  const dias    = res.dias;
  let base;
  if (ilAbs4 < 1)       base = 22;
  else if (ilAbs4 < 3)  base = 17;
  else if (ilAbs4 < 7)  base = 11;
  else if (ilAbs4 < 15) base = 4;
  else                  base = 0;

  let tiempoAdj = 0;
  if (dias >= 180 && res.pnl > 0) tiempoAdj =  3;
  else if (dias >= 90)             tiempoAdj =  2;
  else if (dias >= 30)             tiempoAdj =  1;
  else if (dias < 3)               tiempoAdj = -3;

  const f4 = Math.max(0, Math.min(25, base + tiempoAdj));
  let f4label;
  if (ilAbs4 < 1)       f4label = 'Precios muy estables (IL < 1%)';
  else if (ilAbs4 < 3)  f4label = 'Precios estables (IL 1–3%)';
  else if (ilAbs4 < 7)  f4label = 'Volatilidad moderada (IL 3–7%)';
  else if (ilAbs4 < 15) f4label = 'Alta volatilidad (IL 7–15%)';
  else                  f4label = 'Volatilidad extrema (IL > 15%)';
  const f4estado = f4 >= 17 ? 'ok' : f4 >= 9 ? 'mid' : 'bad';

  factores.push({
    label: 'Estabilidad & Tiempo', pts: f4, maxPts: 25, estado: f4estado,
    nombre: f4label, detalle: `IL: ${ilAbs4.toFixed(2)}% · ${dias} días en el pool`
  });

  const score = Math.min(100, factores.reduce((s, f) => s + f.pts, 0));
  return { score, factores };
}

function calcularSenal(score) {
  if (score >= 75) return {
    emoji: '🟢', nombre: 'MANTENER', clase: 'positive',
    desc:   'Tu posición está funcionando bien. Las métricas clave son favorables.',
    accion: 'Continúa acumulando fees y registra el progreso diariamente.'
  };
  if (score >= 50) return {
    emoji: '🟡', nombre: 'REVISAR', clase: 'warning',
    desc:   'Hay señales mixtas. Vale la pena monitorear de cerca los próximos días.',
    accion: 'Evalúa si las fees proyectadas cubrirán el IL en las próximas semanas.'
  };
  if (score >= 25) return {
    emoji: '🟠', nombre: 'PRECAUCIÓN', clase: 'caution',
    desc:   'Las métricas muestran señales preocupantes. El riesgo supera el rendimiento.',
    accion: 'Considera retirar parte de la liquidez o revisar tu estrategia de entrada.'
  };
  return {
    emoji: '🔴', nombre: 'CONSIDERA SALIR', clase: 'negative',
    desc:   'Las métricas son desfavorables. El IL y las pérdidas superan las fees generadas.',
    accion: 'Evalúa retirar tu liquidez para evitar pérdidas mayores.'
  };
}

/* ================================================================
   FORMULARIO
================================================================ */
function leerForm() {
  return {
    tokenA:       $('tokenA').value.trim() || 'Token A',
    tokenB:       $('tokenB').value.trim() || 'Token B',
    qa0:          parseFloat($('qa0').value)  || 0,
    qb0:          parseFloat($('qb0').value)  || 0,
    pa0:          parseFloat($('pa0').value)  || 0,
    pb0:          parseFloat($('pb0').value)  || 0,
    pa1:          parseFloat($('pa1').value)  || 0,
    pb1:          parseFloat($('pb1').value)  || 0,
    fees:         parseFloat($('fees').value) || 0,
    fechaEntrada: $('fechaEntrada').value,
    fechaActual:  $('fechaActual').value
  };
}

function escribirForm(data) {
  const d = data || {};
  ['tokenA','tokenB','qa0','qb0','pa0','pb0','pa1','pb1',
   'fees','fechaEntrada','fechaActual'].forEach(id => {
    $(id).value = d[id] ?? '';
  });
  if (!d.fechaActual) $('fechaActual').value = hoy();
}

function limpiarForm() {
  escribirForm({});
  hideError();
  $('resultsSection').classList.add('hidden');
  $('decisionSection').classList.add('hidden');
  $('simulatorSection').classList.add('hidden');
  $('simResults').classList.add('hidden');
  state.lastCalc = null;
}

function validar(d) {
  if (!(d.qa0 > 0)) return 'Cantidad de Token A debe ser mayor a 0.';
  if (!(d.qb0 > 0)) return 'Cantidad de Token B debe ser mayor a 0.';
  if (!(d.pa0 > 0)) return 'Precio inicial de Token A debe ser mayor a 0.';
  if (!(d.pb0 > 0)) return 'Precio inicial de Token B debe ser mayor a 0.';
  if (!(d.pa1 > 0)) return 'Precio actual de Token A debe ser mayor a 0.';
  if (!(d.pb1 > 0)) return 'Precio actual de Token B debe ser mayor a 0.';
  if (d.fechaEntrada && d.fechaActual && d.fechaActual < d.fechaEntrada)
    return 'La fecha actual no puede ser anterior a la fecha de entrada.';
  return null;
}

/* ================================================================
   RENDER — RESULTADOS
================================================================ */
function renderResultados(res, d) {
  // Banner resumen
  const banner = $('summaryBanner');
  if (res.pnl >= 0) {
    banner.className = 'summary-banner banner-ok';
    banner.innerHTML = `✅ <span>Posición <strong>rentable</strong>. PnL: <strong>${fmtUSD(res.pnl)}</strong> · ROI: <strong>${fmtPct(res.roi)}</strong></span>`;
  } else {
    banner.className = 'summary-banner banner-bad';
    banner.innerHTML = `⚠️ <span>Posición con <strong>pérdida neta</strong>. PnL: <strong>${fmtUSD(res.pnl)}</strong>. Las fees no compensan el IL aún.</span>`;
  }

  // Fila 1
  const setV = (id, txt, cls) => {
    const el = $(id); if (!el) return;
    el.textContent = txt;
    if (cls) el.className = 'metric-value ' + cls;
  };
  setV('rInicial', fmtUSD(res.valorInicial), 'neutral');
  $('rInicialComp').textContent = `${fmtNum(d.qa0)} ${d.tokenA} + ${fmtNum(d.qb0)} ${d.tokenB}`;
  setV('rPool', fmtUSD(res.valorPool), res.valorPool >= res.valorInicial ? 'positive' : 'neutral');
  $('rPoolComp').textContent = `${fmtNum(res.qa1)} ${d.tokenA} + ${fmtNum(res.qb1)} ${d.tokenB}`;
  setV('rHODL', fmtUSD(res.valorHODL), 'neutral');
  setV('rFees', fmtUSD(res.fees), 'positive');
  $('rFeesNote').textContent = res.feesVsIL >= 0 ? '✓ Fees cubren el IL' : `IL pendiente: ${fmtUSD(Math.abs(res.feesVsIL))}`;
  $('rFeesNote').className = 'metric-detail ' + (res.feesVsIL >= 0 ? 'positive' : 'warning');

  // Fila 2
  const ilPct100 = res.ilPct * 100;
  setV('rILpct', fmtPct(ilPct100), ilPct100 < -5 ? 'negative' : ilPct100 < -1 ? 'warning' : 'neutral');
  $('rILusd').textContent = `${fmtUSD(res.ilUsd)} vs HODL`;
  $('ilBarFill').style.width = Math.min(Math.abs(ilPct100) / 30 * 100, 100) + '%';

  setV('rPnL', fmtUSD(res.pnl), colorClass(res.pnl));
  $('rPnLvsHODL').textContent = (res.pnlVsHODL >= 0 ? '▲ ' : '▼ ') + 'vs HODL: ' + fmtUSD(res.pnlVsHODL);
  $('rPnLvsHODL').className = 'metric-detail ' + colorClass(res.pnlVsHODL);

  setV('rROI', fmtPct(res.roi), colorClass(res.roi));
  $('rDias').textContent = res.dias > 0 ? `${res.dias} días en el pool` : 'Menos de 1 día';
  setV('rROIMensual', fmtPct(res.roiMensual) + '/mes', colorClass(res.roiMensual));
  $('rROIAnual').textContent = `${fmtPct(res.roiAnual)} APR estimado`;

  // Desglose
  const rows = [
    ['Inversión inicial', fmtUSD(res.valorInicial),
      `${fmtNum(d.qa0)} ${d.tokenA} × $${fmtNum(d.pa0)} + ${fmtNum(d.qb0)} ${d.tokenB} × $${fmtNum(d.pb0)}`, ''],
    ['Valor actual del pool', fmtUSD(res.valorPool),
      `${fmtNum(res.qa1)} ${d.tokenA} × $${fmtNum(d.pa1)} + ${fmtNum(res.qb1)} ${d.tokenB} × $${fmtNum(d.pb1)}`,
      res.valorPool >= res.valorInicial ? 'positive' : ''],
    ['Valor HODL', fmtUSD(res.valorHODL), 'Sin el rebalanceo automático', ''],
    ['sep'],
    ['Impermanent Loss (USD)', fmtUSD(res.ilUsd), fmtPct(ilPct100) + ' del valor HODL', 'negative'],
    ['Fees acumuladas', fmtUSD(res.fees), '', 'positive'],
    ['Fees + IL neto', fmtUSD(res.feesVsIL),
      res.feesVsIL >= 0 ? 'Fees compensan el IL ✓' : 'Fees no cubren el IL aún',
      res.feesVsIL >= 0 ? 'positive' : 'negative'],
    ['sep'],
    ['PnL Real', fmtUSD(res.pnl), fmtPct(res.roi), colorClass(res.pnl)],
    ['PnL vs HODL', fmtUSD(res.pnlVsHODL),
      res.pnlVsHODL >= 0 ? 'Mejor que guardar los tokens' : 'HODL hubiera sido más rentable',
      colorClass(res.pnlVsHODL)],
    ['sep'],
    ['Días en el pool', `${res.dias} días`, '', ''],
    ['ROI mensualizado', fmtPct(res.roiMensual) + '/mes', fmtPct(res.roiAnual) + ' APR', colorClass(res.roiMensual)],
  ];

  $('breakdownBody').innerHTML = rows.map(r => {
    if (r[0] === 'sep') return `<tr class="sep"><td colspan="3"><hr/></td></tr>`;
    const [label, val, nota, cls] = r;
    return `<tr>
      <td>${label}</td>
      <td class="${cls}">${val}</td>
      <td>${nota}</td>
    </tr>`;
  }).join('');

  $('resultsSection').classList.remove('hidden');
}

/* ================================================================
   RENDER — MOTOR DE DECISIÓN
================================================================ */
function renderDecision(res) {
  const { score, factores } = calcularHealthScore(res);
  const senal = calcularSenal(score);

  $('healthScore').textContent = score;

  const fill = $('healthBarFill');
  fill.style.width = score + '%';
  fill.style.background = score >= 75 ? 'var(--positive)' : score >= 50 ? 'var(--warning)' : score >= 25 ? 'var(--caution)' : 'var(--negative)';

  $('senalEmoji').textContent = senal.emoji;
  $('senalLabel').textContent = senal.nombre;
  $('senalLabel').className = 'signal-name ' + senal.clase;
  $('senalDesc').textContent = senal.desc;
  $('senalAccion').textContent = '→ ' + senal.accion;

  $('factoresList').innerHTML = factores.map(f => `
    <li class="factor-item">
      <div class="factor-info">
        <span class="factor-name">${f.label}</span>
        <span class="factor-detail">${f.nombre} · ${f.detalle}</span>
      </div>
      <span class="factor-pts">${f.pts}/${f.maxPts} pts</span>
      <span class="factor-dot factor-dot--${f.estado}"></span>
    </li>
  `).join('');

  $('decisionSection').classList.remove('hidden');
}

/* ================================================================
   SIMULADOR
================================================================ */
function renderSimulador(paNueva) {
  if (!state.lastCalc) { toast('Calcula primero para usar el simulador', 'err'); return; }
  const { d, res: resActual } = state.lastCalc;
  if (!(d.qa0 > 0 && d.qb0 > 0 && d.pa0 > 0 && d.pb0 > 0 && d.pb1 > 0)) return;

  const { valorPool } = calcularPool(d.qa0, d.qb0, paNueva, d.pb1);
  const ilPct         = calcularIL(d.pa0, d.pb0, paNueva, d.pb1);
  const valorInicial  = d.qa0 * d.pa0 + d.qb0 * d.pb0;
  const pnl           = calcularPnL(valorPool, d.fees, valorInicial);
  const diffPnl       = pnl - resActual.pnl;

  const il100 = ilPct * 100;
  $('simIL').textContent  = fmtPct(il100);
  $('simIL').className    = 'sim-val ' + (il100 < -5 ? 'negative' : il100 < -1 ? 'warning' : 'positive');
  $('simPool').textContent = fmtUSD(valorPool);
  $('simPool').className   = 'sim-val neutral';
  $('simPnL').textContent  = fmtUSD(pnl);
  $('simPnL').className    = 'sim-val ' + colorClass(pnl);
  $('simDiff').textContent = (diffPnl >= 0 ? '+' : '') + fmtUSD(diffPnl) + ' vs estado actual';
  $('simDiff').className   = 'sim-val ' + colorClass(diffPnl);

  $('simResults').classList.remove('hidden');
}

/* ================================================================
   LOGS — operaciones
================================================================ */
async function cargarLogs(poolId) {
  $('logEmpty').classList.add('hidden');
  $('logTableWrap').classList.add('hidden');
  $('logLoading').classList.remove('hidden');

  try {
    state.logs = await DB.getLogs(poolId);
    renderLogs();
  } catch (err) {
    toast('Error cargando registros: ' + err.message, 'err');
    state.logs = [];
    renderLogs();
  } finally {
    $('logLoading').classList.add('hidden');
  }
}

function renderLogs() {
  const logs    = state.logs;
  const d       = state.lastCalc?.d || state.activePool?.data || {};
  const tA      = escHtml(d.tokenA || 'A');
  const tB      = escHtml(d.tokenB || 'B');

  if (logs.length > 0) {
    $('logColA').textContent = `Precio ${tA}`;
    $('logColB').textContent = `Precio ${tB}`;
  }

  if (logs.length === 0) {
    $('logEmpty').classList.remove('hidden');
    $('logTableWrap').classList.add('hidden');
    return;
  }

  $('logEmpty').classList.add('hidden');
  $('logTableWrap').classList.remove('hidden');

  $('logBody').innerHTML = logs.map(log => {
    const ilColor  = log.il < -0.05 ? 'negative' : log.il < -0.01 ? 'warning' : 'neutral';
    const pnlColor = colorClass(log.pnl);
    const hora     = log.hora || '';

    return `<tr>
      <td class="td-mono">
        ${escHtml(log.fecha)}
        ${hora ? `<span style="display:block;font-size:.68rem;color:var(--text-3)">${escHtml(hora)}</span>` : ''}
      </td>
      <td class="td-mono">$${fmtNum(log.precio_a, 4)}</td>
      <td class="td-mono">$${fmtNum(log.precio_b, 4)}</td>
      <td class="td-mono">${fmtUSD(log.valor_pool)}</td>
      <td class="td-mono ${ilColor}">${fmtPct((log.il || 0) * 100)}</td>
      <td class="td-mono ${pnlColor}">${fmtUSD(log.pnl)}</td>
      <td class="td-mono ${pnlColor}">${fmtPct(log.roi || 0)}</td>
      <td class="td-nota" title="${escHtml(log.nota)}">${escHtml(log.nota) || '—'}</td>
      <td>
        <button class="log-del-btn" data-logid="${log.id}" title="Eliminar">×</button>
      </td>
    </tr>`;
  }).join('');

  $('logBody').querySelectorAll('.log-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('¿Eliminar este registro?')) eliminarLog(btn.dataset.logid);
    });
  });
}

async function registrarLog() {
  if (!state.lastCalc) { toast('Calcula primero antes de registrar', 'err'); return; }
  if (!state.activePoolId) { toast('Guarda la pool primero', 'err'); return; }

  setBtnLoading('btnRegistrarHoy', true);
  const { res, d } = state.lastCalc;
  const ahora = new Date();

  const payload = {
    user_id:    state.user.id,
    pool_id:    state.activePoolId,
    fecha:      ahora.toISOString().slice(0, 10),
    hora:       ahora.toTimeString().slice(0, 5),
    precio_a:   d.pa1,
    precio_b:   d.pb1,
    valor_pool: res.valorPool,
    il:         res.ilPct,
    pnl:        res.pnl,
    roi:        res.roi,
    nota:       $('logNota').value.trim()
  };

  try {
    const saved = await DB.saveLog(payload);
    state.logs.unshift(saved);
    $('logNota').value = '';
    renderLogs();
    toast('Snapshot registrado ✓', 'ok');
  } catch (err) {
    toast('Error guardando registro: ' + err.message, 'err');
  } finally {
    setBtnLoading('btnRegistrarHoy', false);
  }
}

async function eliminarLog(id) {
  try {
    await DB.deleteLog(id);
    state.logs = state.logs.filter(l => l.id !== id);
    renderLogs();
    toast('Registro eliminado', 'ok');
  } catch (err) {
    toast('Error eliminando: ' + err.message, 'err');
  }
}

/* ================================================================
   POOLS — operaciones
================================================================ */
async function cargarPools() {
  $('dashLoading').classList.remove('hidden');
  $('dashEmpty').classList.add('hidden');
  $('dashSummary').classList.add('hidden');
  $('poolCardsGrid').classList.add('hidden');

  try {
    state.pools = await DB.getPools(state.user.id);
    renderSidebarPools();
    renderDashboard();
  } catch (err) {
    toast('Error cargando pools: ' + err.message, 'err');
  } finally {
    $('dashLoading').classList.add('hidden');
  }
}

async function guardarPool() {
  const d = leerForm();
  const nombre = `${d.tokenA || 'Token A'}/${d.tokenB || 'Token B'}`;

  setBtnLoading('btnGuardarPool', true);
  try {
    const saved = await DB.savePool({
      id:     state.activePoolId,
      userId: state.user.id,
      nombre,
      data:   d
    });

    const idx = state.pools.findIndex(p => p.id === saved.id);
    if (idx >= 0) state.pools[idx] = saved;
    else          state.pools.unshift(saved);

    state.activePoolId = saved.id;
    state.activePool   = saved;

    renderSidebarPools();
    $('poolViewTitle').textContent = nombre;
    $('poolViewSub').textContent   = `Guardado · ${new Date().toLocaleDateString('es-ES')}`;
    $('btnEliminarPool').classList.remove('hidden');
    $('btnGuardarLabel').textContent = 'Actualizar Pool';
    toast('Pool guardada correctamente ✓', 'ok');
  } catch (err) {
    toast('Error guardando: ' + err.message, 'err');
  } finally {
    setBtnLoading('btnGuardarPool', false);
  }
}

async function eliminarPool(id) {
  if (!confirm('¿Eliminar esta pool permanentemente? También se borrarán todos sus registros.')) return;
  try {
    await DB.deletePool(id);
    state.pools = state.pools.filter(p => p.id !== id);
    if (state.activePoolId === id) {
      state.activePoolId = null;
      state.activePool   = null;
    }
    renderSidebarPools();
    showView('dashboard');
    toast('Pool eliminada', 'ok');
  } catch (err) {
    toast('Error eliminando pool: ' + err.message, 'err');
  }
}

function abrirPool(pool) {
  state.activePoolId = pool.id;
  state.activePool   = pool;
  state.lastCalc     = null;
  state.logs         = [];

  limpiarForm();
  escribirForm(pool.data);
  $('poolViewTitle').textContent = pool.nombre;
  $('poolViewSub').textContent   = `Guardado el ${new Date(pool.updated_at || pool.created_at).toLocaleDateString('es-ES')}`;
  $('btnEliminarPool').classList.remove('hidden');
  $('btnGuardarLabel').textContent = 'Actualizar Pool';

  showView('pool');
  renderSidebarPools();

  // Intentar recalcular con los datos guardados
  const d = pool.data;
  if (d.qa0 > 0 && d.qb0 > 0 && d.pa0 > 0 && d.pb0 > 0 && d.pa1 > 0 && d.pb1 > 0) {
    const res = ejecutarCalculos(d);
    state.lastCalc = { res, d };
    renderResultados(res, d);
    renderDecision(res);
    $('simTokenName').textContent = d.tokenA || 'Token A';
    $('simulatorSection').classList.remove('hidden');
  }

  cargarLogs(pool.id);
}

function nuevaPool() {
  state.activePoolId = null;
  state.activePool   = null;
  state.logs         = [];

  limpiarForm();
  $('poolViewTitle').textContent = 'Nueva Pool';
  $('poolViewSub').textContent   = 'Completa los datos y calcula tu rendimiento';
  $('btnEliminarPool').classList.add('hidden');
  $('btnGuardarLabel').textContent = 'Guardar Pool';
  $('logEmpty').classList.remove('hidden');
  $('logTableWrap').classList.add('hidden');

  renderSidebarPools();
  showView('pool');
}

/* ================================================================
   RENDER — SIDEBAR & DASHBOARD
================================================================ */
function renderSidebarPools() {
  const list = $('sidebarPoolList');
  if (state.pools.length === 0) {
    list.innerHTML = '<div class="sb-pool-empty">Sin pools guardadas</div>';
    return;
  }

  list.innerHTML = state.pools.map(pool => {
    const activo = pool.id === state.activePoolId;
    const res    = tryCalc(pool.data);
    const senal  = res ? calcularSenal(calcularHealthScore(res).score) : null;
    return `
      <div class="sb-pool-item ${activo ? 'sb-pool-item--active' : ''}" data-id="${pool.id}">
        <span class="sb-pool-item-signal">${senal?.emoji || '⚪'}</span>
        <span class="sb-pool-item-name">${escHtml(pool.nombre)}</span>
        <button class="sb-pool-del" data-del="${pool.id}" title="Eliminar">×</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.sb-pool-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.dataset.del) return;
      const pool = state.pools.find(p => p.id === el.dataset.id);
      if (pool) abrirPool(pool);
    });
  });
  list.querySelectorAll('.sb-pool-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      eliminarPool(btn.dataset.del);
    });
  });
}

/** Intenta calcular sin lanzar — devuelve null si faltan datos */
function tryCalc(data) {
  try {
    const d = data || {};
    if (!(d.qa0 > 0 && d.qb0 > 0 && d.pa0 > 0 && d.pb0 > 0 && d.pa1 > 0 && d.pb1 > 0)) return null;
    return ejecutarCalculos(d);
  } catch { return null; }
}

function renderDashboard() {
  if (state.pools.length === 0) {
    $('dashEmpty').classList.remove('hidden');
    $('dashSummary').classList.add('hidden');
    $('poolCardsGrid').classList.add('hidden');
    return;
  }

  $('dashEmpty').classList.add('hidden');

  // Portfolio aggregate
  let totalInv = 0, totalVal = 0, totalPnL = 0, totalFees = 0;
  let roiSum = 0, roiN = 0;
  let tieneMetricas = false;

  state.pools.forEach(pool => {
    const res = tryCalc(pool.data);
    if (!res) return;
    totalInv  += res.valorInicial;
    totalVal  += res.valorPool;
    totalPnL  += res.pnl;
    totalFees += res.fees;
    roiSum    += res.roi;
    roiN++;
    tieneMetricas = true;
  });

  if (tieneMetricas) {
    $('dashSummary').classList.remove('hidden');
    $('pfInvertido').textContent = fmtUSD(totalInv);
    $('pfValor').textContent     = fmtUSD(totalVal);
    $('pfFees').textContent      = fmtUSD(totalFees);
    $('pfROI').textContent       = fmtPct(roiN > 0 ? roiSum / roiN : 0);

    const pnlEl = $('pfPnL');
    pnlEl.textContent = (totalPnL >= 0 ? '+' : '') + fmtUSD(totalPnL);
    pnlEl.className   = 'ps-value ' + colorClass(totalPnL);
    $('pfCount').textContent = roiN;
  }

  renderPoolCards();
}

function renderPoolCards() {
  const grid = $('poolCardsGrid');
  grid.classList.remove('hidden');

  grid.innerHTML = state.pools.map(pool => {
    const res   = tryCalc(pool.data);
    const d     = pool.data || {};
    const dias  = calcularDias(d.fechaEntrada, d.fechaActual || hoy());

    let metricsHtml = `<div class="pcm-nodata" style="font-size:.76rem;color:var(--text-3);padding:8px 0">
      Actualiza los precios para ver métricas
    </div>`;
    let scoreBarHtml = '';
    let senalBadge   = '<span class="pc-signal">⚪ Sin datos</span>';

    if (res) {
      const { score, factores } = calcularHealthScore(res);
      const senal = calcularSenal(score);
      const scoreColor = score >= 75 ? 'var(--positive)' : score >= 50 ? 'var(--warning)' : score >= 25 ? 'var(--caution)' : 'var(--negative)';

      senalBadge = `<span class="pc-signal">${senal.emoji} ${senal.nombre}</span>`;
      metricsHtml = `
        <div class="pc-metrics">
          <div class="pcm-item">
            <span class="pcm-label">PnL</span>
            <span class="pcm-value ${colorClass(res.pnl)}">${res.pnl >= 0 ? '+' : ''}${fmtUSD(res.pnl)}</span>
          </div>
          <div class="pcm-item">
            <span class="pcm-label">ROI</span>
            <span class="pcm-value ${colorClass(res.roi)}">${fmtPct(res.roi)}</span>
          </div>
          <div class="pcm-item">
            <span class="pcm-label">IL</span>
            <span class="pcm-value ${res.ilPct < -0.05 ? 'negative' : 'neutral'}">${fmtPct(res.ilPct * 100)}</span>
          </div>
          <div class="pcm-item">
            <span class="pcm-label">Fees</span>
            <span class="pcm-value positive">${fmtUSD(res.fees)}</span>
          </div>
        </div>`;
      scoreBarHtml = `
        <div class="pc-score-bar">
          <div class="pc-score-track">
            <div class="pc-score-fill" style="width:${score}%;background:${scoreColor}"></div>
          </div>
          <span class="pc-score-num">${score}/100</span>
        </div>`;
    }

    return `
      <div class="pool-card" data-id="${pool.id}">
        <div class="pc-header">
          <div>
            <div class="pc-name">${escHtml(pool.nombre)}</div>
            <div class="pc-date">${d.fechaEntrada || '—'} · ${dias} días</div>
          </div>
          ${senalBadge}
        </div>
        ${metricsHtml}
        ${scoreBarHtml}
        <div class="pc-footer">
          <button class="pc-btn" data-action="ver" data-id="${pool.id}">Ver detalle →</button>
          <button class="pc-btn pc-btn--del" data-action="del" data-id="${pool.id}">Eliminar</button>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.pc-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (btn.dataset.action === 'ver') {
        const pool = state.pools.find(p => p.id === btn.dataset.id);
        if (pool) abrirPool(pool);
      } else {
        eliminarPool(btn.dataset.id);
      }
    });
  });

  grid.querySelectorAll('.pool-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.pc-btn')) return;
      const pool = state.pools.find(p => p.id === card.dataset.id);
      if (pool) abrirPool(pool);
    });
  });
}

/* ================================================================
   NAVEGACIÓN DE VISTAS
================================================================ */
function showView(view) {
  state.view = view;
  const isDash = view === 'dashboard';
  $('dashView').classList.toggle('hidden', !isDash);
  $('poolView').classList.toggle('hidden', isDash);
  $('navDashboard').classList.toggle('nav-item--active', isDash);
  if (isDash) renderDashboard();
}

/* ================================================================
   AUTH UI
================================================================ */
function showAuthScreen() {
  $('loadingScreen').classList.add('hidden');
  $('authScreen').classList.remove('hidden');
  $('appScreen').classList.add('hidden');
}

function showApp(user) {
  state.user = user;
  $('loadingScreen').classList.add('hidden');
  $('authScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');

  const email = user.email || '';
  $('userEmail').textContent  = email;
  $('userAvatar').textContent = email.charAt(0).toUpperCase();

  showView('dashboard');
  cargarPools();
}

function setAuthAlert(msg, tipo = 'error') {
  const el = $('authAlert');
  el.textContent = msg;
  el.className = `auth-alert auth-alert--${tipo}`;
  el.classList.remove('hidden');
}
function clearAuthAlert() { $('authAlert').classList.add('hidden'); }

function setBtnLoading(btnId, loading) {
  const btn = $(btnId);
  if (!btn) return;
  btn.disabled = loading;
  const txt = btn.querySelector('.btn-text');
  const spn = btn.querySelector('.btn-spin');
  if (txt) txt.classList.toggle('hidden', loading);
  if (spn) spn.classList.toggle('hidden', !loading);
}

/* ================================================================
   TOOLTIPS
================================================================ */
const TIPS = {
  hodl: {
    title: '¿Qué significa HODL?',
    html: `
      <strong>HODL</strong> significa guardar tus tokens sin hacer nada con ellos.<br><br>
      El <strong>Valor HODL</strong> muestra cuánto valdrían hoy tus tokens originales
      <em>si no los hubieras depositado en el pool</em>. Es tu punto de referencia:<br><br>
      → <strong>Valor Pool &gt; Valor HODL</strong>: la pool fue más rentable que holdear<br>
      → <strong>Valor Pool &lt; Valor HODL</strong>: hubieras ganado más sin entrar<br><br>
      Puedes tener PnL positivo y aún así haber sido peor que HODL si los tokens subieron mucho.`
  },
  il: {
    title: '¿Qué es el Impermanent Loss?',
    html: `
      El <strong>Impermanent Loss</strong> es la pérdida temporal que ocurre cuando los precios
      cambian respecto al momento en que depositaste. El AMM rebalancea automáticamente las
      cantidades de cada token, resultando en menos valor que si hubieras hecho HODL.<br><br>
      Se llama <em>"impermanente"</em> porque si los precios vuelven al nivel inicial, el IL desaparece.<br><br>
      <strong>Fórmula exacta (AMM x·y=k, pool 50/50):</strong>
      <div class="tip-formula">
        P  = (Pa_actual / Pa_inicial) ÷ (Pb_actual / Pb_inicial)<br>
        IL = 2·√P / (1 + P) − 1
      </div><br>
      <strong>Regla clave:</strong> las fees que ganas deben superar el IL para que el LP sea rentable.`
  },
  pnl: {
    title: '¿Qué es el PnL Real?',
    html: `
      <strong>PnL</strong> (Profit and Loss) es tu ganancia o pérdida total real, incluyendo todos los factores:<br><br>
      <div class="tip-formula">PnL Real = Valor del pool + Fees − Inversión inicial</div><br>
      → <strong>PnL positivo</strong>: ganaste dinero en términos absolutos<br>
      → <strong>PnL negativo</strong>: perdiste dinero en términos absolutos<br><br>
      El <strong>PnL vs HODL</strong> compara tu resultado contra simplemente haber guardado los tokens.
      Puedes tener PnL positivo y aún así haber sido menos rentable que hodlear si los precios subieron mucho.`
  }
};

function mostrarTip(tipo) {
  const tip = TIPS[tipo]; if (!tip) return;
  $('tipTitle').textContent = tip.title;
  $('tipBody').innerHTML    = tip.html;
  $('tipOverlay').classList.remove('hidden');
}
function cerrarTip() { $('tipOverlay').classList.add('hidden'); }

/* ================================================================
   TOAST
================================================================ */
let _toastTimer;
function toast(msg, tipo = 'ok') {
  const el = $('toast');
  clearTimeout(_toastTimer);
  el.textContent = msg;
  el.className   = `toast ${tipo} show`;
  el.classList.remove('hidden');
  _toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 280);
  }, 2800);
}

/* ================================================================
   INICIALIZACIÓN
================================================================ */
async function init() {
  // Comprobar sesión existente
  try {
    const session = await Auth.getSession();
    if (session?.user) {
      showApp(session.user);
    } else {
      showAuthScreen();
    }
  } catch {
    showAuthScreen();
  }

  // Escuchar cambios de auth en tiempo real
  Auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      showApp(session.user);
    } else if (event === 'SIGNED_OUT') {
      state.user = null; state.pools = []; state.activePoolId = null;
      showAuthScreen();
    }
  });

  // ── Auth tabs ──────────────────────────────────────────────────
  $('tabLogin').addEventListener('click', () => {
    $('tabLogin').classList.add('auth-tab--active');
    $('tabRegister').classList.remove('auth-tab--active');
    $('loginForm').classList.remove('hidden');
    $('registerForm').classList.add('hidden');
    clearAuthAlert();
  });
  $('tabRegister').addEventListener('click', () => {
    $('tabRegister').classList.add('auth-tab--active');
    $('tabLogin').classList.remove('auth-tab--active');
    $('registerForm').classList.remove('hidden');
    $('loginForm').classList.add('hidden');
    clearAuthAlert();
  });

  // ── Login ──────────────────────────────────────────────────────
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    clearAuthAlert();
    setBtnLoading('loginBtn', true);
    try {
      await Auth.signIn($('loginEmail').value.trim(), $('loginPassword').value);
      // onAuthStateChange maneja el resto
    } catch (err) {
      setAuthAlert(err.message);
    } finally {
      setBtnLoading('loginBtn', false);
    }
  });

  // ── Registro ───────────────────────────────────────────────────
  $('registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    clearAuthAlert();
    const email    = $('regEmail').value.trim();
    const password = $('regPassword').value;
    const confirm  = $('regConfirm').value;
    if (password !== confirm) { setAuthAlert('Las contraseñas no coinciden.'); return; }
    if (password.length < 6)  { setAuthAlert('La contraseña debe tener al menos 6 caracteres.'); return; }

    setBtnLoading('registerBtn', true);
    try {
      const { user, session } = await Auth.signUp(email, password);
      if (session) {
        // Auto-login si el email no requiere confirmación
        showApp(session.user);
      } else {
        setAuthAlert('¡Cuenta creada! Revisa tu email para confirmar tu cuenta.', 'success');
      }
    } catch (err) {
      setAuthAlert(err.message);
    } finally {
      setBtnLoading('registerBtn', false);
    }
  });

  // ── Logout ─────────────────────────────────────────────────────
  $('btnLogout').addEventListener('click', async () => {
    try { await Auth.signOut(); } catch { showAuthScreen(); }
  });

  // ── Navegación ─────────────────────────────────────────────────
  $('navDashboard').addEventListener('click', () => showView('dashboard'));
  $('navNewPool').addEventListener('click',   nuevaPool);
  $('btnFirstPool').addEventListener('click', nuevaPool);
  $('btnVolverDash').addEventListener('click', () => showView('dashboard'));

  // ── Pool actions ───────────────────────────────────────────────
  $('btnGuardarPool').addEventListener('click', guardarPool);
  $('btnEliminarPool').addEventListener('click', () => {
    if (state.activePoolId) eliminarPool(state.activePoolId);
  });

  // ── Calcular ───────────────────────────────────────────────────
  $('btnCalcular').addEventListener('click', () => {
    const d = leerForm();
    const err = validar(d);
    if (err) { showError(err); return; }
    hideError();

    const res = ejecutarCalculos(d);
    state.lastCalc = { res, d };

    renderResultados(res, d);
    renderDecision(res);
    $('simTokenName').textContent = d.tokenA || 'Token A';
    $('simulatorSection').classList.remove('hidden');
    $('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('btnLimpiar').addEventListener('click', limpiarForm);

  // ── Simulador ──────────────────────────────────────────────────
  $('btnSimular').addEventListener('click', () => {
    const p = parseFloat($('simPrecio').value);
    if (!(p > 0)) { toast('Ingresa un precio válido', 'err'); return; }
    renderSimulador(p);
  });
  $('simPrecio').addEventListener('input', () => $('simResults').classList.add('hidden'));

  // ── Registro diario ────────────────────────────────────────────
  $('btnRegistrarHoy').addEventListener('click', registrarLog);

  // ── Tooltips ───────────────────────────────────────────────────
  document.querySelectorAll('.tip-btn').forEach(btn => {
    btn.addEventListener('click', () => mostrarTip(btn.dataset.tip));
  });
  $('tipClose').addEventListener('click', cerrarTip);
  $('tipOverlay').addEventListener('click', e => { if (e.target === $('tipOverlay')) cerrarTip(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarTip(); });

  // ── Enter en inputs numéricos calcula ──────────────────────────
  document.querySelectorAll('#poolView .input').forEach(input => {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') $('btnCalcular').click(); });
  });

  // Fecha actual por defecto al cargar
  $('fechaActual').value = hoy();
}

document.addEventListener('DOMContentLoaded', init);
