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

function showError(msg) {
  const el = $('errorMsg');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError() { $('errorMsg').classList.add('hidden'); }

const DIAS_PROYECCION = 7;   // días de datos reales antes de proyectar

/**
 * Proyección de fees con precio constante: lo que la posición ganó de
 * verdad por día (fees ÷ días), llevado a semana y mes. Solo se calcula
 * con al menos DIAS_PROYECCION días de historial; antes queda "en espera".
 * Estados: 'lista' · 'espera' · 'fuera' (de rango) · 'sinfees'
 */
function calcularProyeccion(res, d) {
  if (!(res.valorPool > 0)) return null;
  if (d.v3 && (!d.v3.inRange || d.v3.cerrada)) return { estado: 'fuera' };   // fuera de rango no genera fees
  const dias = diasExactos(d);
  const porDia = dias > 0 && res.fees > 0 ? res.fees / dias : null;
  if (dias < DIAS_PROYECCION) return { estado: 'espera', dias, porDia, faltan: DIAS_PROYECCION - dias };
  if (!porDia) return { estado: 'sinfees', dias };
  const sem = porDia * 7, mes = porDia * 30.4375;
  return { estado: 'lista', dias, porDia, sem, mes, semPct: sem / res.valorPool * 100, mesPct: mes / res.valorPool * 100 };
}

const fmtFaltan = f => f < 1 ? `faltan ${Math.max(1, Math.ceil(f * 24))} h` : `faltan ${Math.ceil(f)} día${Math.ceil(f) === 1 ? '' : 's'}`;
/** Texto corto cuando todavía no hay proyección */
function textoSinProy(proy) {
  if (!proy) return '';
  if (proy.estado === 'fuera')   return 'Fuera de rango: no genera fees';
  if (proy.estado === 'espera')  return `Esperando 1 semana de datos · ${fmtFaltan(proy.faltan)}`;
  if (proy.estado === 'sinfees') return 'Sin fees en el periodo';
  return '';
}

/** Cantidad de cada token y su valor en USD */
function composicion(d, res) {
  const qa = res?.qa1 ?? d.qa1, qb = res?.qb1 ?? d.qb1;
  if (!isFinite(qa) || !isFinite(qb) || !(d.pa1 > 0)) return null;
  return [
    { sym: d.tokenA, q: qa, usd: qa * d.pa1 },
    { sym: d.tokenB, q: qb, usd: qb * (d.pb1 || 0) }
  ];
}
// Versiones "envueltas" o puenteadas que se agrupan con su token base en el resumen
const TOKEN_BASE = { WETH: 'ETH', WBTC: 'BTC', CBBTC: 'BTC', 'USDC.E': 'USDC', USDBC: 'USDC', 'USD₮0': 'USDT', USDT0: 'USDT' };
const fmtCant = q => fmt(q, q >= 1000 ? 2 : q >= 1 ? 4 : 6);
const fmtSigno = (n, f) => (n >= 0 ? '+' : '') + f(n);
const composicionHtml = comp => comp.map(t =>
  `<div class="comp-row"><span class="comp-q">${fmtCant(t.q)} ${escHtml(t.sym)}</span><span class="comp-usd">≈ ${fmtUSD(t.usd)}</span></div>`).join('');

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
  // Las pools on-chain conservan sus datos de blockchain (cantidades vivas, rango…)
  const prev = state.activePool?.data?.v3 ? state.activePool.data : null;
  return {
    ...(prev ? { v3: prev.v3, qa1: prev.qa1, qb1: prev.qb1 } : {}),
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
  if (d.v3) {
    if (!(d.qa0 > 0 || d.qb0 > 0)) return 'Escribe cuánto depositaste al entrar (al menos uno de los dos tokens).';
  } else {
    if (!(d.qa0 > 0)) return 'Cantidad de Token A debe ser mayor a 0.';
    if (!(d.qb0 > 0)) return 'Cantidad de Token B debe ser mayor a 0.';
  }
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
  $('rInicialComp').textContent = `${fmtCant(d.qa0)} ${d.tokenA} + ${fmtCant(d.qb0)} ${d.tokenB}`;
  setV('rPool', fmtUSD(res.valorPool), res.valorPool >= res.valorInicial ? 'positive' : 'neutral');
  $('rPoolComp').innerHTML = composicionHtml(composicion(d, res));
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
  const proy = calcularProyeccion(res, d);
  const lista = proy?.estado === 'lista';
  const vacio = proy?.estado === 'espera' ? '⏳ En espera' : '—';
  setV('rProySem', lista ? fmtSigno(proy.semPct, fmtPct) : vacio, lista ? 'positive' : 'neutral');
  $('rProySemUsd').textContent = lista ? `${fmtSigno(proy.sem, fmtUSD)} por semana` : textoSinProy(proy);
  setV('rProyMes', lista ? fmtSigno(proy.mesPct, fmtPct) : vacio, lista ? 'positive' : 'neutral');
  $('rProyMesUsd').textContent = lista ? `${fmtSigno(proy.mes, fmtUSD)} por mes · ${fmtPct(proy.mesPct * 12)} APR` : '';

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
    ...(d.v3?.feesPoolDia > 0 ? [
      ['Fees diarios de la pool', fmtUSD(d.v3.feesPoolDia), 'Promedio de los últimos 7 días', ''],
      ['Tu participación', d.v3.participacion > 0 ? fmtNum(d.v3.participacion * 100, 4) + '%' : '0%',
        d.v3.participacion > 0 ? 'De la liquidez activa en el precio actual' : 'Fuera de rango: no recibes fees', ''],
    ] : []),
    ['Fees por día (real)', proy?.porDia ? fmtUSD(proy.porDia) : '—',
      proy?.porDia ? `Promedio de ${fmt(proy.dias, proy.dias < 2 ? 1 : 0)} días` + (lista ? '' : ' · aún no se proyecta') : '', 'positive'],
    ['Proyección semanal', lista ? fmtSigno(proy.sem, fmtUSD) : vacio, lista ? fmtPct(proy.semPct) + ' del valor actual' : textoSinProy(proy), lista ? 'positive' : ''],
    ['Proyección mensual', lista ? fmtSigno(proy.mes, fmtUSD) : vacio, lista ? fmtPct(proy.mesPct) + ' · si el precio sigue en rango' : '', lista ? 'positive' : ''],
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
  if (!datosCompletos(d)) return;

  const { valorPool, ilPct } = d.v3
    ? posicionV3(d, paNueva, d.pb1)
    : { ...calcularPool(d.qa0, d.qb0, paNueva, d.pb1), ilPct: calcularIL(d.pa0, d.pb0, paNueva, d.pb1) };
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
    refrescarOnchain();
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
    if (esOnchain(saved)) refrescarOnchain([saved]);   // datos frescos + primer registro automático
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
  renderOnchainCard(pool);
  if (datosCompletos(d)) {
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
  renderOnchainCard(null);
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
    if (!datosCompletos(d)) return null;
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
  let totalInv = 0, totalVal = 0, totalPnL = 0, totalFees = 0, totalSem = 0, totalMes = 0;
  let valProy = 0, enEspera = 0, faltanMin = Infinity;
  let roiN = 0;
  let tieneMetricas = false;
  const tokens = {};   // composición agregada por token

  state.pools.forEach(pool => {
    const res = tryCalc(pool.data);
    (composicion(pool.data, res) || []).forEach(t => {
      const k = TOKEN_BASE[t.sym.toUpperCase()] || t.sym.toUpperCase();
      tokens[k] ||= { sym: k, q: 0, usd: 0 };
      tokens[k].q += t.q; tokens[k].usd += t.usd;
    });
    if (!res) return;
    totalInv  += res.valorInicial;
    totalVal  += res.valorPool;
    totalPnL  += res.pnl;
    totalFees += res.fees;
    const proy = calcularProyeccion(res, pool.data);
    if (proy?.estado === 'lista') { totalSem += proy.sem; totalMes += proy.mes; valProy += res.valorPool; }
    if (proy?.estado === 'espera') { enEspera++; faltanMin = Math.min(faltanMin, proy.faltan); }
    roiN++;
    tieneMetricas = true;
  });

  const comp = Object.values(tokens).filter(t => t.usd > 0.005).sort((a, b) => b.usd - a.usd);
  $('dashComposicion').classList.toggle('hidden', !comp.length);
  $('dashComposicion').innerHTML = comp.length ? `
    <span class="pf-comp-title">Tus tokens en pools</span>
    ${comp.map(t => `<span class="pf-comp-chip"><strong>${fmtCant(t.q)} ${escHtml(t.sym)}</strong> ≈ ${fmtUSD(t.usd)}</span>`).join('')}` : '';

  if (tieneMetricas) {
    $('dashSummary').classList.remove('hidden');
    $('pfInvertido').textContent = fmtUSD(totalInv);
    $('pfValor').textContent     = fmtUSD(totalVal);
    $('pfFees').textContent      = fmtUSD(totalFees);
    const roiActual = totalInv > 0 ? totalPnL / totalInv * 100 : 0;
    $('pfROI').textContent = fmtSigno(roiActual, fmtPct);
    $('pfROI').className   = 'ps-value ' + colorClass(roiActual);
    // % sobre el valor de las pools que ya tienen proyección
    const notaEspera = enEspera ? `${enEspera} en espera · ${fmtFaltan(faltanMin)}` : '';
    const vacioDash = enEspera ? '⏳ En espera' : '—';
    $('pfSem').textContent = totalSem > 0 ? fmtSigno(totalSem / valProy * 100, fmtPct) : vacioDash;
    $('pfSemUsd').textContent = totalSem > 0 ? fmtSigno(totalSem, fmtUSD) + (enEspera ? ` · ${enEspera} en espera` : '') : notaEspera;
    $('pfMes').textContent = totalMes > 0 ? fmtSigno(totalMes / valProy * 100, fmtPct) : vacioDash;
    $('pfMesUsd').textContent = totalMes > 0 ? fmtSigno(totalMes, fmtUSD) : '';

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
    const v3    = d.v3;
    const rangoHtml = v3 ? (() => {
      const e = v3.cerrada ? ['closed', 'Cerrada'] : v3.inRange ? ['in', 'En rango'] : ['out', 'Fuera de rango'];
      return `<div class="pc-onchain">${escHtml(nombreRed(v3.chain))} · ${fmt(v3.feeTier, v3.feeTier < 0.1 ? 2 : 1)}%
        <span class="oc-state oc-state--${e[0]}">● ${e[1]}</span></div>`;
    })() : '';

    let metricsHtml = `<div class="pcm-nodata" style="font-size:.76rem;color:var(--text-3);padding:8px 0">
      ${v3 ? 'Completa el depósito inicial para ver PnL y ROI' : 'Actualiza los precios para ver métricas'}
    </div>`;
    let scoreBarHtml = '';
    let senalBadge   = '<span class="pc-signal">⚪ Sin datos</span>';

    if (res) {
      const { score, factores } = calcularHealthScore(res);
      const senal = calcularSenal(score);
      const proy = calcularProyeccion(res, d);
      const scoreColor = score >= 75 ? 'var(--positive)' : score >= 50 ? 'var(--warning)' : score >= 25 ? 'var(--caution)' : 'var(--negative)';

      senalBadge = `<span class="pc-signal">${senal.emoji} ${senal.nombre}</span>`;
      metricsHtml = `
        <div class="pc-metrics">
          <div class="pcm-item">
            <span class="pcm-label">PnL</span>
            <span class="pcm-value ${colorClass(res.pnl)}">${res.pnl >= 0 ? '+' : ''}${fmtUSD(res.pnl)}</span>
          </div>
          <div class="pcm-item">
            <span class="pcm-label">ROI actual</span>
            <span class="pcm-value ${colorClass(res.roi)}">${fmtSigno(res.roi, fmtPct)}</span>
          </div>
          <div class="pcm-item">
            <span class="pcm-label">IL</span>
            <span class="pcm-value ${res.ilPct < -0.05 ? 'negative' : 'neutral'}">${fmtPct(res.ilPct * 100)}</span>
          </div>
          <div class="pcm-item">
            <span class="pcm-label">Fees</span>
            <span class="pcm-value positive">${fmtUSD(res.fees)}</span>
          </div>
          <div class="pcm-item">
            <span class="pcm-label">Proy. semana</span>
            <span class="pcm-value ${proy?.estado === 'lista' ? 'positive' : 'neutral'}">${proy?.estado === 'lista' ? fmtSigno(proy.semPct, fmtPct) : proy?.estado === 'espera' ? '⏳ En espera' : '—'}</span>
            <span class="pcm-sub">${proy?.estado === 'lista' ? fmtSigno(proy.sem, fmtUSD) : proy?.estado === 'espera' ? fmtFaltan(proy.faltan) : proy?.estado === 'fuera' ? 'fuera de rango' : ''}</span>
          </div>
          <div class="pcm-item">
            <span class="pcm-label">Proy. mes</span>
            <span class="pcm-value ${proy?.estado === 'lista' ? 'positive' : 'neutral'}">${proy?.estado === 'lista' ? fmtSigno(proy.mesPct, fmtPct) : proy?.estado === 'espera' ? '⏳ En espera' : '—'}</span>
            <span class="pcm-sub">${proy?.estado === 'lista' ? fmtSigno(proy.mes, fmtUSD) : ''}</span>
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
            ${rangoHtml}
          </div>
          ${senalBadge}
        </div>
        ${(() => { const c = composicion(d, res); return c ? `<div class="pc-comp">${composicionHtml(c)}</div>` : ''; })()}
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
  $('poolView').classList.toggle('hidden', view !== 'pool');
  $('importView').classList.toggle('hidden', view !== 'import');
  $('navDashboard').classList.toggle('nav-item--active', isDash);
  $('navImport').classList.toggle('nav-item--active', view === 'import');
  if (isDash) renderDashboard();
  if (view === 'import') renderPosicionesEncontradas();
  $('mainContent').scrollTop = 0;
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
   ON-CHAIN — importar wallet, actualización y registro automático
================================================================ */
const AUTO_REGISTRO_HORAS = 6;     // snapshot automático como máximo cada 6 h
const AUTO_REFRESCO_MIN   = 5;     // con la app abierta, refresca cada 5 min

const esOnchain = pool => !!pool?.data?.v3;
const nombreRed = chain => OnChain.cadenas[chain]?.nombre || chain;
const linkUniswap = v3 => `https://app.uniswap.org/positions/v3/${v3.chain}/${v3.tokenId}`;
const fmtPrecio = n => !isFinite(n) ? '—' : n >= 1000 ? fmt(n, 0) : n >= 1 ? fmt(n, 2) : fmtNum(n, 6);

function haceCuanto(iso) {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1)  return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

/** Guarda un snapshot automático si toca (cada AUTO_REGISTRO_HORAS) */
async function autoRegistrar(pool) {
  const d = pool.data;
  if (!datosCompletos(d) || d.v3.cerrada) return false;
  const ultimo = d.v3.ultimoRegistro ? new Date(d.v3.ultimoRegistro).getTime() : 0;
  if (Date.now() - ultimo < AUTO_REGISTRO_HORAS * 3600_000) return false;

  const res = ejecutarCalculos(d);
  const ahora = new Date();
  const log = await DB.saveLog({
    user_id: state.user.id, pool_id: pool.id,
    fecha: ahora.toISOString().slice(0, 10), hora: ahora.toTimeString().slice(0, 5),
    precio_a: d.pa1, precio_b: d.pb1, valor_pool: res.valorPool,
    il: res.ilPct, pnl: res.pnl, roi: res.roi,
    nota: `Auto · ${d.v3.inRange ? 'en rango' : 'FUERA de rango'}`
  });
  d.v3.ultimoRegistro = ahora.toISOString();
  if (state.activePoolId === pool.id) { state.logs.unshift(log); renderLogs(); }
  return true;
}

/** Relee de la blockchain todas las pools on-chain (o las indicadas) */
let _refrescando = null;
async function refrescarOnchain(pools = state.pools.filter(esOnchain)) {
  if (!pools.length) return;
  if (_refrescando) return _refrescando;
  setSyncLabel('Actualizando desde la blockchain…');

  _refrescando = (async () => {
    // Agrupar por red y wallet para hacer pocas llamadas
    const grupos = {};
    pools.forEach(p => { const k = p.data.v3.chain + '|' + p.data.v3.owner; (grupos[k] ||= []).push(p); });

    let errores = 0, registros = 0;
    await Promise.all(Object.values(grupos).map(async grupo => {
      const { chain, owner } = grupo[0].data.v3;
      const entradas = {};
      grupo.forEach(p => { if (p.data.qa0 > 0 || p.data.qb0 > 0) entradas[p.data.v3.tokenId] = true; });
      try {
        const posiciones = await OnChain.leerPosiciones(chain, owner, grupo.map(p => p.data.v3.tokenId),
          { incluirCerradas: true, entradas });
        for (const pool of grupo) {
          const pos = posiciones.find(x => x.tokenId === pool.data.v3.tokenId);
          if (!pos) continue;
          pool.data = dataDesdePosicion(pos, pool.data);
          if (await autoRegistrar(pool)) registros++;
          const saved = await DB.savePool({ id: pool.id, userId: state.user.id, nombre: pool.nombre, data: pool.data });
          Object.assign(pool, saved, { data: pool.data });
        }
      } catch (err) { errores++; console.error(err); }
    }));

    renderSidebarPools();
    if (state.view === 'dashboard') renderDashboard();
    if (state.view === 'pool' && esOnchain(state.activePool)) refrescarVistaPool();
    setSyncLabel(errores ? 'Algunas redes no respondieron · reintenta en un momento'
                         : `Actualizado ${haceCuanto(new Date().toISOString())}` + (registros ? ` · ${registros} registro(s) automático(s)` : ''));
  })();
  try { await _refrescando; } finally { _refrescando = null; }
}

function setSyncLabel(txt) { const el = $('dashSync'); if (el) el.textContent = txt; }

/** Vuelve a pintar el detalle de la pool activa con sus datos nuevos */
function refrescarVistaPool() {
  const pool = state.activePool;
  escribirForm(pool.data);
  renderOnchainCard(pool);
  if (datosCompletos(pool.data)) {
    const res = ejecutarCalculos(pool.data);
    state.lastCalc = { res, d: pool.data };
    renderResultados(res, pool.data);
    renderDecision(res);
    $('simulatorSection').classList.remove('hidden');
  }
}

/* ── Tarjeta on-chain en el detalle ─────────────────────────────── */
function renderOnchainCard(pool) {
  const card = $('onchainCard');
  const v3 = pool?.data?.v3;
  if (!v3) { card.classList.add('hidden'); return; }
  const d = pool.data;

  // Posición del precio dentro del rango (con margen visual del 25 %)
  const ancho = v3.rangoMax - v3.rangoMin;
  const lo = v3.rangoMin - ancho * 0.25, hi = v3.rangoMax + ancho * 0.25;
  const pct = x => Math.max(0, Math.min(100, (x - lo) / (hi - lo) * 100));
  const estado = v3.cerrada ? ['closed', 'Cerrada'] : v3.inRange ? ['in', 'En rango'] : ['out', 'Fuera de rango'];
  const faltaEntrada = !(d.qa0 > 0 || d.qb0 > 0) || !(d.pa0 > 0);

  card.innerHTML = `
    <div class="oc-top">
      <div class="oc-chips">
        <span class="oc-chip">${escHtml(nombreRed(v3.chain))}</span>
        <span class="oc-chip">Uniswap V3 · ${fmt(v3.feeTier, v3.feeTier < 0.1 ? 2 : 1)}%</span>
        <a class="oc-chip oc-chip--link" href="${linkUniswap(v3)}" target="_blank" rel="noopener">#${escHtml(v3.tokenId)} ↗</a>
        <span class="oc-state oc-state--${estado[0]}">● ${estado[1]}</span>
      </div>
      <div class="oc-sync">
        <span>Actualizado ${haceCuanto(v3.actualizado)}</span>
        <button id="btnRefreshPool" class="btn btn-secondary btn-sm">↻ Actualizar</button>
      </div>
    </div>
    <div class="oc-range">
      <div class="oc-range-track">
        <div class="oc-range-band" style="left:${pct(v3.rangoMin)}%;width:${pct(v3.rangoMax) - pct(v3.rangoMin)}%"></div>
        <div class="oc-range-now oc-range-now--${estado[0]}" style="left:${pct(v3.precioActualAenB)}%"></div>
      </div>
      <div class="oc-range-labels">
        <span>Mín ${fmtPrecio(v3.rangoMin)}</span>
        <span class="oc-range-cur">Precio ${fmtPrecio(v3.precioActualAenB)} ${escHtml(d.tokenB)} por ${escHtml(d.tokenA)}</span>
        <span>Máx ${fmtPrecio(v3.rangoMax)}</span>
      </div>
    </div>
    <div class="oc-stats">
      <div><span class="oc-k">Ahora en la pool</span><span class="oc-v">${fmtNum(d.qa1)} ${escHtml(d.tokenA)} + ${fmtNum(d.qb1, 2)} ${escHtml(d.tokenB)}</span></div>
      <div><span class="oc-k">Fees sin cobrar</span><span class="oc-v positive">${fmtUSD(v3.feesPendientesUSD)}</span></div>
      <div><span class="oc-k">Entrada</span><span class="oc-v">${
        faltaEntrada ? '<span class="warning">Falta completar</span>'
        : `${escHtml(d.fechaEntrada || '—')} · ${v3.fuenteEntrada === 'thegraph' ? 'automática' : 'manual'}`}</span></div>
    </div>
    ${faltaEntrada ? `<div class="oc-hint">
      No se encontró el historial de entrada${OnChain.tieneGraphKey() ? '' : ' (falta la clave de The Graph)'}.
      Escribe abajo cuánto depositaste de cada token y la <strong>fecha de entrada</strong>:
      los precios de ese día se completan solos.</div>` : ''}`;
  card.classList.remove('hidden');
  $('btnRefreshPool').addEventListener('click', async () => {
    setBtnLoading('btnRefreshPool', true);
    await refrescarOnchain([state.activePool]);
    toast('Datos actualizados desde la blockchain ✓', 'ok');
  });
}

/** Al poner la fecha de entrada en una pool on-chain, trae los precios de ese día */
async function autocompletarPreciosEntrada() {
  const v3 = state.activePool?.data?.v3;
  const fecha = $('fechaEntrada').value;
  if (!v3 || !fecha || (parseFloat($('pa0').value) > 0 && parseFloat($('pb0').value) > 0)) return;
  try {
    const { pa0, pb0 } = await OnChain.preciosEnFecha(v3.chain, v3.addrA, v3.addrB, fecha);
    if (pa0) $('pa0').value = +pa0.toPrecision(6);
    if (pb0) $('pb0').value = +pb0.toPrecision(6);
    if (pa0 || pb0) toast(`Precios del ${fecha} completados`, 'ok');
  } catch { toast('No se encontraron precios para esa fecha', 'err'); }
}

/* ── Vista Importar wallet ──────────────────────────────────────── */
let _posicionesEncontradas = [];

function abrirImportar() {
  try { $('walletInput').value ||= localStorage.getItem('lp_wallet') || ''; } catch {}
  renderGraphStatus();
  showView('import');
}

function renderGraphStatus() {
  const ok = OnChain.tieneGraphKey();
  $('graphStatus').innerHTML = ok
    ? '<span class="positive">● Conectado</span> — el depósito y la fecha de entrada se completan solos.'
    : '<span class="warning">● Sin clave</span> — verás todo en vivo, pero el depósito inicial lo escribes tú una vez.';
}

async function buscarWallet() {
  const wallet = $('walletInput').value.trim();
  try { localStorage.setItem('lp_wallet', wallet); } catch {}
  $('importResults').innerHTML = '';
  $('importStatus').innerHTML = '<div class="spinner"></div><span>Buscando posiciones en Ethereum, Arbitrum y Base…</span>';
  $('importStatus').className = 'center-loading';
  setBtnLoading('btnBuscarWallet', true);
  try {
    const { posiciones, errores } = await OnChain.buscarWallet(wallet, { incluirCerradas: $('chkCerradas').checked });
    _posicionesEncontradas = posiciones;
    const aviso = errores.length ? ` · ${errores.join(' · ')}` : '';
    $('importStatus').className = 'import-status';
    $('importStatus').textContent = posiciones.length
      ? `${posiciones.length} posición(es) encontrada(s)${aviso}`
      : `No hay posiciones abiertas de Uniswap V3 en esta wallet${aviso}`;
    renderPosicionesEncontradas();
  } catch (err) {
    $('importStatus').className = 'import-status negative';
    $('importStatus').textContent = err.message;
  } finally {
    setBtnLoading('btnBuscarWallet', false);
  }
}

const yaSeguida = pos => state.pools.find(p => p.data?.v3?.chain === pos.chain && p.data.v3.tokenId === pos.tokenId);

function renderPosicionesEncontradas() {
  const lista = _posicionesEncontradas;
  $('btnSeguirTodas').classList.toggle('hidden', !lista.some(p => !yaSeguida(p)));
  $('importResults').innerHTML = lista.map((pos, i) => {
    const seguida = yaSeguida(pos);
    const estado = pos.cerrada ? ['closed', 'Cerrada'] : pos.inRange ? ['in', 'En rango'] : ['out', 'Fuera de rango'];
    return `
      <div class="pool-card import-card">
        <div class="pc-header">
          <div>
            <div class="pc-name">${escHtml(pos.tokenA)}/${escHtml(pos.tokenB)}</div>
            <div class="pc-date">${escHtml(nombreRed(pos.chain))} · ${fmt(pos.feeTier, pos.feeTier < 0.1 ? 2 : 1)}% · #${escHtml(pos.tokenId)}</div>
          </div>
          <span class="oc-state oc-state--${estado[0]}">● ${estado[1]}</span>
        </div>
        <div class="pc-metrics">
          <div class="pcm-item"><span class="pcm-label">Valor</span><span class="pcm-value neutral">${fmtUSD(pos.valorUSD)}</span></div>
          <div class="pcm-item"><span class="pcm-label">Fees sin cobrar</span><span class="pcm-value positive">${fmtUSD(pos.feesPendientesUSD)}</span></div>
          <div class="pcm-item"><span class="pcm-label">Rango</span><span class="pcm-value neutral">${fmtPrecio(pos.rangoMin)} – ${fmtPrecio(pos.rangoMax)}</span></div>
          <div class="pcm-item"><span class="pcm-label">Entrada</span><span class="pcm-value ${pos.entrada ? 'neutral' : 'warning'}">${pos.entrada ? escHtml(pos.entrada.fechaEntrada) : 'Por completar'}</span></div>
        </div>
        <div class="pc-footer">
          ${seguida
            ? `<button class="pc-btn" data-ver="${seguida.id}">Ya la sigues · Ver →</button>`
            : `<button class="pc-btn pc-btn--follow" data-seguir="${i}">＋ Seguir esta pool</button>`}
        </div>
      </div>`;
  }).join('');

  $('importResults').querySelectorAll('[data-seguir]').forEach(btn =>
    btn.addEventListener('click', () => seguirPosiciones([_posicionesEncontradas[+btn.dataset.seguir]], btn)));
  $('importResults').querySelectorAll('[data-ver]').forEach(btn =>
    btn.addEventListener('click', () => { const p = state.pools.find(x => x.id === btn.dataset.ver); if (p) abrirPool(p); }));
}

async function seguirPosiciones(lista, btn) {
  if (btn) btn.disabled = true;
  let ok = 0;
  for (const pos of lista) {
    if (yaSeguida(pos)) continue;
    try {
      const data = dataDesdePosicion(pos);
      const saved = await DB.savePool({ id: null, userId: state.user.id, nombre: `${pos.tokenA}/${pos.tokenB}`, data });
      state.pools.unshift(saved);
      await autoRegistrar(saved);   // primer snapshot inmediato
      if (saved.data.v3.ultimoRegistro)
        await DB.savePool({ id: saved.id, userId: state.user.id, nombre: saved.nombre, data: saved.data });
      ok++;
    } catch (err) { toast('Error guardando: ' + err.message, 'err'); }
  }
  renderSidebarPools();
  renderPosicionesEncontradas();
  if (ok) toast(ok === 1 ? 'Pool agregada a tu seguimiento ✓' : `${ok} pools agregadas ✓`, 'ok');
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
  $('navImport').addEventListener('click', abrirImportar);
  $('btnImportDash').addEventListener('click', abrirImportar);
  $('btnImportEmpty').addEventListener('click', abrirImportar);
  $('btnRefreshAll').addEventListener('click', () => refrescarOnchain());

  // ── Importar wallet ────────────────────────────────────────────
  $('btnBuscarWallet').addEventListener('click', buscarWallet);
  $('walletInput').addEventListener('keydown', e => { if (e.key === 'Enter') buscarWallet(); });
  $('btnSeguirTodas').addEventListener('click', e =>
    seguirPosiciones(_posicionesEncontradas.filter(p => !yaSeguida(p)), e.currentTarget));
  $('btnGuardarGraphKey').addEventListener('click', () => {
    try { localStorage.setItem('lp_graph_key', $('graphKeyInput').value.trim()); } catch {}
    $('graphKeyInput').value = '';
    renderGraphStatus();
    toast(OnChain.tieneGraphKey() ? 'Clave guardada ✓' : 'Clave eliminada', 'ok');
  });
  $('fechaEntrada').addEventListener('change', autocompletarPreciosEntrada);

  // Con la app abierta, las pools on-chain se mantienen al día solas
  setInterval(() => { if (state.user && !document.hidden) refrescarOnchain(); }, AUTO_REFRESCO_MIN * 60_000);

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
