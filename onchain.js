'use strict';
/* ================================================================
   LP Tracker Pro — onchain.js
   Lectura de posiciones Uniswap V3 (Ethereum, Arbitrum, Base).
   Solo lectura: nunca pide conectar ni firmar con la wallet.

   Fuentes:
   · Posición, rango, liquidez y fees sin cobrar → RPC públicos (eth_call)
   · Precios actuales e históricos               → DefiLlama (sin clave)
   · Depósitos, retiros y fecha de entrada       → subgraph de Uniswap
                                                   en The Graph (clave gratis)
================================================================ */

const ONCHAIN_CHAINS = {
  ethereum: {
    nombre: 'Ethereum',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    subgraph: '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
    explorer: 'https://etherscan.io'
  },
  arbitrum: {
    nombre: 'Arbitrum',
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
    npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    subgraph: 'HyW7A86UEdYVt5b9Lrw8W2F98yKecerHKutZTRbSCX27',
    explorer: 'https://arbiscan.io'
  },
  base: {
    nombre: 'Base',
    rpcs: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'],
    npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    subgraph: '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG',
    explorer: 'https://basescan.org'
  }
};

const STABLES = ['USDC', 'USDT', 'DAI', 'USDBC', 'USDC.E', 'USDT0', 'USD₮0', 'FRAX', 'LUSD', 'CRVUSD', 'USDE', 'PYUSD', 'GHO', 'USDS'];
const MAX_POSICIONES_POR_RED = 60;

const OnChain = (() => {

  // ── ABI mínimo (selectores) ─────────────────────────────────────
  const SEL = {
    balanceOf:           '0x70a08231',
    tokenOfOwnerByIndex: '0x2f745c59',
    positions:           '0x99fbab88',
    getPool:             '0x1698ee82',
    slot0:               '0x3850c7bd',
    symbol:              '0x95d89b41',
    decimals:            '0x313ce567',
    collect:             '0xfc6f7865'
  };
  const MAX_U128 = (1n << 128n) - 1n;
  const Q96      = 2 ** 96;

  const pad   = v => BigInt(v).toString(16).padStart(64, '0');
  const addr  = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const words = hex => (hex && hex.length > 2 ? hex.slice(2).match(/.{64}/g) || [] : []).map(w => BigInt('0x' + w));
  const toAddr = w => '0x' + w.toString(16).padStart(40, '0');
  const toInt  = w => (w >= 1n << 255n ? w - (1n << 256n) : w);

  function decodeString(hex) {
    const w = hex.slice(2);
    if (w.length === 64) { // bytes32 (tokens antiguos tipo MKR)
      return decodeURIComponent(w.replace(/(00)+$/, '').replace(/../g, '%$&')).trim();
    }
    const len = parseInt(w.slice(64, 128), 16);
    const bytes = w.slice(128, 128 + len * 2);
    try { return decodeURIComponent(bytes.replace(/../g, '%$&')); } catch { return '?'; }
  }

  // ── JSON-RPC con lotes y respaldo entre proveedores ─────────────
  let rid = 0;
  async function rpcBatch(chain, calls) {
    const urls = ONCHAIN_CHAINS[chain].rpcs;
    let lastErr;
    for (const url of urls) {
      try {
        const out = [];
        for (let i = 0; i < calls.length; i += 40) {
          const chunk = calls.slice(i, i + 40).map(c => ({ jsonrpc: '2.0', id: ++rid, method: c.method, params: c.params }));
          const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) });
          if (!r.ok) throw new Error(`RPC ${r.status}`);
          const res = await r.json();
          if (!Array.isArray(res)) throw new Error(res?.error?.message || 'Respuesta RPC inválida');
          const byId = new Map(res.map(x => [x.id, x]));
          chunk.forEach(c => {
            const x = byId.get(c.id);
            out.push(x && !x.error ? x.result : null);
          });
        }
        return out;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`No se pudo leer ${ONCHAIN_CHAINS[chain].nombre}: ${lastErr?.message || 'error de red'}`);
  }
  const ethCall = (to, data, from) => ({ method: 'eth_call', params: [from ? { from, to, data } : { to, data }, 'latest'] });

  // ── Tokens (con caché) ──────────────────────────────────────────
  const tokenCache = new Map();
  async function cargarTokens(chain, direcciones) {
    const faltan = [...new Set(direcciones)].filter(a => !tokenCache.has(chain + ':' + a));
    if (faltan.length) {
      const res = await rpcBatch(chain, faltan.flatMap(a => [ethCall(a, SEL.symbol), ethCall(a, SEL.decimals)]));
      faltan.forEach((a, i) => {
        const sym = res[2 * i] ? decodeString(res[2 * i]) : a.slice(0, 6);
        const dec = res[2 * i + 1] ? Number(words(res[2 * i + 1])[0]) : 18;
        tokenCache.set(chain + ':' + a, { address: a, symbol: sym || a.slice(0, 6), decimals: dec });
      });
    }
    return a => tokenCache.get(chain + ':' + a);
  }

  // ── Matemática Uniswap V3 ───────────────────────────────────────
  /** Cantidades (en unidades humanas) de una posición a un sqrtPrice dado */
  function cantidades(liq, sqrtP, tickLower, tickUpper, dec0, dec1) {
    const L  = Number(liq);
    const sa = Math.pow(1.0001, tickLower / 2);
    const sb = Math.pow(1.0001, tickUpper / 2);
    let a0 = 0, a1 = 0;
    if (sqrtP <= sa)      a0 = L * (sb - sa) / (sa * sb);
    else if (sqrtP >= sb) a1 = L * (sb - sa);
    else { a0 = L * (sb - sqrtP) / (sqrtP * sb); a1 = L * (sqrtP - sa); }
    return [a0 / 10 ** dec0, a1 / 10 ** dec1];
  }
  /** Precio humano de token0 expresado en token1 para un tick */
  const precioTick = (tick, dec0, dec1) => Math.pow(1.0001, tick) * 10 ** (dec0 - dec1);

  /**
   * Simula el valor de la posición si el token A pasa a valer paNueva USD
   * (token B se mantiene en pb). Devuelve cantidades de A y B.
   */
  function simular(v3, paNueva, pb) {
    const p0en1 = v3.aIsToken0 ? paNueva / pb : pb / paNueva;   // precio token0 en token1
    const raw   = p0en1 * 10 ** (v3.dec1 - v3.dec0);
    const [a0, a1] = cantidades(BigInt(v3.liquidity), Math.sqrt(raw), v3.tickLower, v3.tickUpper, v3.dec0, v3.dec1);
    return v3.aIsToken0 ? { qa: a0, qb: a1 } : { qa: a1, qb: a0 };
  }

  // ── Precios (DefiLlama) ─────────────────────────────────────────
  async function precios(claves, timestamp) {
    if (!claves.length) return {};
    const base = timestamp ? `https://coins.llama.fi/prices/historical/${timestamp}/` : 'https://coins.llama.fi/prices/current/';
    const r = await fetch(base + [...new Set(claves)].join(',') + '?searchWidth=12h');
    if (!r.ok) throw new Error('No se pudieron obtener precios');
    const j = await r.json();
    const out = {};
    Object.entries(j.coins || {}).forEach(([k, v]) => { out[k.toLowerCase()] = v.price; });
    return out;
  }
  /** Completa el precio que falte usando el precio de la propia pool */
  function completarPrecios(p0, p1, p0en1) {
    if (p0 && !p1 && p0en1) p1 = p0 / p0en1;
    if (p1 && !p0 && p0en1) p0 = p1 * p0en1;
    return [p0 || 0, p1 || 0];
  }

  // ── Historial de entrada (The Graph) ────────────────────────────
  function graphKey() {
    try { return localStorage.getItem('lp_graph_key') || (typeof GRAPH_API_KEY !== 'undefined' ? GRAPH_API_KEY : ''); }
    catch { return typeof GRAPH_API_KEY !== 'undefined' ? GRAPH_API_KEY : ''; }
  }
  async function historial(chain, ids) {
    const key = graphKey();
    if (!key || !ids.length) return {};
    const q = `{ positions(first: 1000, where: { id_in: [${ids.map(i => `"${i}"`).join(',')}] }) {
      id depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1
      collectedFeesToken0 collectedFeesToken1 transaction { timestamp } } }`;
    const r = await fetch(`https://gateway.thegraph.com/api/${key}/subgraphs/id/${ONCHAIN_CHAINS[chain].subgraph}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q })
    });
    const j = await r.json().catch(() => ({}));
    if (j.errors?.length) throw new Error('The Graph: ' + j.errors[0].message);
    const out = {};
    (j.data?.positions || []).forEach(p => {
      const n = k => parseFloat(p[k]) || 0;
      // "collectedFees" ya excluye el capital retirado (verificado en las 3 redes)
      out[p.id] = {
        dep0: n('depositedToken0'), dep1: n('depositedToken1'),
        ret0: n('withdrawnToken0'), ret1: n('withdrawnToken1'),
        fee0: n('collectedFeesToken0'),
        fee1: n('collectedFeesToken1'),
        timestamp: Number(p.transaction?.timestamp) || null
      };
    });
    return out;
  }

  // ── Lectura de posiciones ───────────────────────────────────────
  async function idsDeWallet(chain, owner) {
    const C = ONCHAIN_CHAINS[chain];
    const [bal] = await rpcBatch(chain, [ethCall(C.npm, SEL.balanceOf + addr(owner))]);
    const n = Math.min(Number(words(bal)[0] || 0n), MAX_POSICIONES_POR_RED * 4);
    if (!n) return [];
    const res = await rpcBatch(chain, Array.from({ length: n }, (_, i) =>
      ethCall(C.npm, SEL.tokenOfOwnerByIndex + addr(owner) + pad(i))));
    return res.filter(Boolean).map(h => words(h)[0].toString());
  }

  /**
   * Lee posiciones concretas. Devuelve objetos listos para mostrar y
   * guardar. `entrada` (opcional) permite reutilizar datos de entrada ya
   * guardados y evita volver a consultar The Graph.
   */
  async function leerPosiciones(chain, owner, ids, { incluirCerradas = false, entradas = {} } = {}) {
    const C = ONCHAIN_CHAINS[chain];
    const raw = await rpcBatch(chain, ids.map(id => ethCall(C.npm, SEL.positions + pad(id))));
    let pos = ids.map((id, i) => {
      const w = words(raw[i]);
      if (w.length < 12) return null;
      return { id, token0: toAddr(w[2]), token1: toAddr(w[3]), fee: Number(w[4]),
               tickLower: Number(toInt(w[5])), tickUpper: Number(toInt(w[6])), liquidity: w[7] };
    }).filter(Boolean);
    if (!incluirCerradas) pos = pos.filter(p => p.liquidity > 0n);
    pos = pos.slice(0, MAX_POSICIONES_POR_RED);
    if (!pos.length) return [];

    // Pools, slot0, fees sin cobrar y metadatos de tokens
    const pools = await rpcBatch(chain, pos.map(p => ethCall(C.factory, SEL.getPool + addr(p.token0) + addr(p.token1) + pad(p.fee))));
    pos.forEach((p, i) => { p.pool = pools[i] ? toAddr(words(pools[i])[0]) : null; });
    const [slots, fees, tok] = await Promise.all([
      rpcBatch(chain, pos.map(p => ethCall(p.pool, SEL.slot0))),
      rpcBatch(chain, pos.map(p => ethCall(C.npm, SEL.collect + pad(p.id) + addr(owner) + pad(MAX_U128) + pad(MAX_U128), owner))),
      cargarTokens(chain, pos.flatMap(p => [p.token0, p.token1]))
    ]);

    // Historial de entrada solo para las que no lo tienen guardado
    const sinEntrada = pos.filter(p => !entradas[p.id]).map(p => p.id);
    let hist = {};
    let errorHistorial = null;
    try { hist = await historial(chain, sinEntrada); } catch (e) { errorHistorial = e.message; }

    // Precios actuales e históricos
    const claves = pos.flatMap(p => [`${chain}:${p.token0}`, `${chain}:${p.token1}`]);
    const pxAhora = await precios(claves);
    const porFecha = {};
    for (const p of pos) {
      const ts = hist[p.id]?.timestamp;
      if (ts) (porFecha[ts] ||= []).push(`${chain}:${p.token0}`, `${chain}:${p.token1}`);
    }
    const pxEntrada = {};
    await Promise.all(Object.entries(porFecha).map(async ([ts, ks]) => { pxEntrada[ts] = await precios(ks, ts).catch(() => ({})); }));

    return pos.map((p, i) => {
      const t0 = tok(p.token0), t1 = tok(p.token1);
      const s0 = words(slots[i]);
      const sqrtP = Number(s0[0] || 0n) / Q96;
      const tick  = Number(toInt(s0[1] || 0n));
      const [a0, a1] = cantidades(p.liquidity, sqrtP, p.tickLower, p.tickUpper, t0.decimals, t1.decimals);
      const fw = words(fees[i]);
      const f0 = Number(fw[0] || 0n) / 10 ** t0.decimals, f1 = Number(fw[1] || 0n) / 10 ** t1.decimals;
      const p0en1 = sqrtP * sqrtP * 10 ** (t0.decimals - t1.decimals);
      const [px0, px1] = completarPrecios(pxAhora[`${chain}:${p.token0}`], pxAhora[`${chain}:${p.token1}`], p0en1)
        .map(x => +x.toPrecision(6));

      // Token B = stablecoin si la hay; si no, token1
      const aIsToken0 = !STABLES.includes(t0.symbol.toUpperCase()) || STABLES.includes(t1.symbol.toUpperCase());
      const A = aIsToken0 ? 0 : 1;
      const pick = (x0, x1) => (A === 0 ? [x0, x1] : [x1, x0]);

      const [tA, tB]     = pick(t0, t1);
      const [qa1, qb1]   = pick(a0, a1);
      const [pa1, pb1]   = pick(px0, px1);
      const [fA, fB]     = pick(f0, f1);
      const inRange      = tick >= p.tickLower && tick < p.tickUpper;

      // Rango expresado como precio de A en B
      const pl = precioTick(p.tickLower, t0.decimals, t1.decimals);
      const pu = precioTick(p.tickUpper, t0.decimals, t1.decimals);
      const [rangoMin, rangoMax] = aIsToken0 ? [pl, pu] : [1 / pu, 1 / pl];
      const precioActualAenB = aIsToken0 ? p0en1 : 1 / p0en1;

      // Entrada: guardada > The Graph > vacía (se completa a mano)
      let entrada = entradas[p.id] || null;
      const h = hist[p.id];
      if (!entrada && h) {
        const pe = pxEntrada[h.timestamp] || {};
        const [pe0, pe1] = completarPrecios(pe[`${chain}:${p.token0}`], pe[`${chain}:${p.token1}`], null);
        const [qa0, qb0] = pick(h.dep0 - h.ret0, h.dep1 - h.ret1);
        const [pa0, pb0] = pick(pe0, pe1);
        const [fcA, fcB] = pick(h.fee0, h.fee1);
        const r = (x, n) => +(+x).toPrecision(n);
        entrada = { qa0: r(Math.max(0, qa0), 8), qb0: r(Math.max(0, qb0), 8), pa0: r(pa0, 6), pb0: r(pb0, 6),
                    feesCobradasA: fcA, feesCobradasB: fcB,
                    fechaEntrada: new Date(h.timestamp * 1000).toISOString().slice(0, 10), ts: h.timestamp, fuente: 'thegraph' };
      }

      return {
        chain, owner: owner.toLowerCase(), tokenId: p.id, pool: p.pool, feeTier: p.fee / 10000,
        tokenA: tA.symbol, tokenB: tB.symbol, addrA: tA.address, addrB: tB.address,
        aIsToken0, dec0: t0.decimals, dec1: t1.decimals,
        tickLower: p.tickLower, tickUpper: p.tickUpper, tick, liquidity: p.liquidity.toString(),
        cerrada: p.liquidity === 0n, inRange, rangoMin, rangoMax, precioActualAenB,
        qa1, qb1, pa1, pb1,
        feesPendientesA: fA, feesPendientesB: fB,
        feesPendientesUSD: fA * pa1 + fB * pb1,
        valorUSD: qa1 * pa1 + qb1 * pb1,
        entrada, errorHistorial,
        actualizado: new Date().toISOString()
      };
    });
  }

  /** Busca todas las posiciones abiertas de una wallet en las 3 redes */
  async function buscarWallet(owner, opts = {}) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error('Dirección inválida. Debe empezar por 0x y tener 42 caracteres.');
    const redes = Object.keys(ONCHAIN_CHAINS);
    const resultados = await Promise.allSettled(redes.map(async chain => {
      const ids = await idsDeWallet(chain, owner);
      return ids.length ? leerPosiciones(chain, owner, ids, opts) : [];
    }));
    const posiciones = [], errores = [];
    resultados.forEach((r, i) => {
      if (r.status === 'fulfilled') posiciones.push(...r.value);
      else errores.push(`${ONCHAIN_CHAINS[redes[i]].nombre}: ${r.reason.message}`);
    });
    posiciones.sort((a, b) => b.valorUSD - a.valorUSD);
    return { posiciones, errores };
  }

  /** Precios históricos de A y B en una fecha (YYYY-MM-DD) para completar la entrada a mano */
  async function preciosEnFecha(chain, addrA, addrB, fecha) {
    const ts = Math.floor(new Date(fecha + 'T12:00:00Z').getTime() / 1000);
    const px = await precios([`${chain}:${addrA}`, `${chain}:${addrB}`], ts);
    return { pa0: px[`${chain}:${addrA}`.toLowerCase()] || 0, pb0: px[`${chain}:${addrB}`.toLowerCase()] || 0 };
  }

  return { buscarWallet, leerPosiciones, simular, preciosEnFecha, tieneGraphKey: () => !!graphKey(), cadenas: ONCHAIN_CHAINS };
})();

if (typeof module !== 'undefined') module.exports = OnChain;
