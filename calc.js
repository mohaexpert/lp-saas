'use strict';
/* ================================================================
   LP Tracker Pro — calc.js
   Motor de cálculo puro, compartido por el navegador (app.js) y el
   servidor (api/snapshot.js). Sin DOM ni red.
================================================================ */

// En el navegador OnChain es global (onchain.js); en Node se importa
const simularV3 = (...args) =>
  (typeof OnChain !== 'undefined' ? OnChain : require('./onchain.js')).simular(...args);

function hoy() {
  return new Date().toISOString().slice(0, 10);
}

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

/** Días transcurridos con decimales (usa el instante exacto de entrada si se conoce) */
function diasExactos(d) {
  const ini = d.v3?.entradaTs ? d.v3.entradaTs * 1000
            : d.fechaEntrada ? new Date(d.fechaEntrada + 'T00:00:00Z').getTime() : null;
  if (!ini) return 0;
  if (!d.v3) return Math.max(1, calcularDias(d.fechaEntrada, d.fechaActual || hoy()));
  return Math.max((Date.now() - ini) / 86_400_000, 1 / 24);
}

/**
 * Posición Uniswap V3 (liquidez concentrada): las cantidades salen de la
 * liquidez y el rango, no de x·y=k. Con el precio leído de la blockchain se
 * usan las cantidades reales; con otro precio (edición manual) se simulan.
 */
function posicionV3(d, pa1, pb1) {
  const live = Math.abs(pa1 - d.v3.pa1Live) < 1e-9 && Math.abs(pb1 - d.v3.pb1Live) < 1e-9;
  const { qa, qb } = live ? { qa: d.qa1, qb: d.qb1 } : simularV3(d.v3, pa1, pb1);
  const valorPool = qa * pa1 + qb * pb1;
  const valorHODL = calcularHODL(d.qa0, d.qb0, pa1, pb1);
  return { qa1: qa, qb1: qb, valorPool, ilPct: valorHODL > 0 ? valorPool / valorHODL - 1 : 0 };
}

/** ¿Hay datos suficientes para calcular? (V3 admite depósitos de un solo token) */
function datosCompletos(d) {
  if (!(d.pa0 > 0 && d.pb0 > 0 && d.pa1 > 0 && d.pb1 > 0)) return false;
  return d.v3 ? (d.qa0 > 0 || d.qb0 > 0) : (d.qa0 > 0 && d.qb0 > 0);
}

/** Punto de entrada: devuelve todas las métricas derivadas */
function ejecutarCalculos(d) {
  const valorInicial          = d.qa0 * d.pa0 + d.qb0 * d.pb0;
  const { qa1, qb1, valorPool, ilPct } = d.v3
    ? posicionV3(d, d.pa1, d.pb1)
    : { ...calcularPool(d.qa0, d.qb0, d.pa1, d.pb1), ilPct: calcularIL(d.pa0, d.pb0, d.pa1, d.pb1) };
  const valorHODL             = calcularHODL(d.qa0, d.qb0, d.pa1, d.pb1);
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

/** Combina una posición leída de la blockchain con los datos ya guardados */
function dataDesdePosicion(pos, prev = {}) {
  const tienePrev = prev.qa0 > 0 || prev.qb0 > 0;
  const e = tienePrev
    ? { qa0: prev.qa0, qb0: prev.qb0, pa0: prev.pa0, pb0: prev.pb0, fechaEntrada: prev.fechaEntrada,
        feesCobradasA: prev.v3?.feesCobradasA || 0, feesCobradasB: prev.v3?.feesCobradasB || 0,
        ts: prev.v3?.entradaTs || null, fuente: prev.v3?.fuenteEntrada || 'manual' }
    : (pos.entrada || {});
  const fees = (e.feesCobradasA || 0) * pos.pa1 + (e.feesCobradasB || 0) * pos.pb1 + pos.feesPendientesUSD;

  return {
    tokenA: pos.tokenA, tokenB: pos.tokenB,
    qa0: e.qa0, qb0: e.qb0, pa0: e.pa0, pb0: e.pb0,
    pa1: pos.pa1, pb1: pos.pb1, fees,
    fechaEntrada: e.fechaEntrada || '', fechaActual: hoy(),
    qa1: pos.qa1, qb1: pos.qb1,
    v3: {
      chain: pos.chain, owner: pos.owner, tokenId: pos.tokenId, pool: pos.pool, feeTier: pos.feeTier,
      addrA: pos.addrA, addrB: pos.addrB, aIsToken0: pos.aIsToken0, dec0: pos.dec0, dec1: pos.dec1,
      tickLower: pos.tickLower, tickUpper: pos.tickUpper, tick: pos.tick, liquidity: pos.liquidity,
      inRange: pos.inRange, cerrada: pos.cerrada, rangoMin: pos.rangoMin, rangoMax: pos.rangoMax,
      precioActualAenB: pos.precioActualAenB, pa1Live: pos.pa1, pb1Live: pos.pb1,
      feesPendientesUSD: pos.feesPendientesUSD,
      participacion: pos.participacion, feesPoolDia: pos.feesPoolDia, feesDiaEstimado: pos.feesDiaEstimado,
      feesCobradasA: e.feesCobradasA || 0, feesCobradasB: e.feesCobradasB || 0,
      fuenteEntrada: e.fuente || null,
      entradaTs: e.ts || null,
      actualizado: pos.actualizado,
      ultimoRegistro: prev.v3?.ultimoRegistro || null
    }
  };
}


if (typeof module !== 'undefined') {
  module.exports = {
    hoy, calcularIL, calcularPool, calcularHODL, calcularPnL, calcularROI, calcularROIMensual,
    calcularDias, diasExactos, posicionV3, datosCompletos, ejecutarCalculos, dataDesdePosicion
  };
}
