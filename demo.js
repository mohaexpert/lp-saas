'use strict';
/* ================================================================
   LP Tracker Pro — demo.js
   Modo demo: reemplaza Supabase por localStorage y entra con un
   perfil de ejemplo. Se activa si Supabase no está configurado
   o si la URL lleva ?demo. Para reiniciar los datos: ?demo=reset
================================================================ */

const DEMO_ACTIVO =
  SUPABASE_URL.includes('TU_PROJECT_REF') || new URLSearchParams(location.search).has('demo');

if (DEMO_ACTIVO) {
  const KEY       = 'lp_tracker_demo';
  const DEMO_USER = { id: 'demo-user', email: 'demo@lptracker.pro' };

  if (new URLSearchParams(location.search).get('demo') === 'reset') localStorage.removeItem(KEY);

  const uid  = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  const dia  = n => { const f = new Date(); f.setDate(f.getDate() - n); return f.toISOString().slice(0, 10); };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const save = s => localStorage.setItem(KEY, JSON.stringify(s));

  // ── Datos de ejemplo ────────────────────────────────────────────
  function seed() {
    const pools = [
      { id: uid(), user_id: DEMO_USER.id, nombre: 'ETH/USDC',
        data: { tokenA: 'ETH', tokenB: 'USDC', qa0: 2, qb0: 5000, pa0: 2500, pb0: 1,
                pa1: 2780, pb1: 1, fees: 214.5, fechaEntrada: dia(60), fechaActual: dia(0) },
        created_at: new Date(Date.now() - 60 * 864e5).toISOString() },
      { id: uid(), user_id: DEMO_USER.id, nombre: 'SOL/USDC',
        data: { tokenA: 'SOL', tokenB: 'USDC', qa0: 30, qb0: 4500, pa0: 150, pb0: 1,
                pa1: 124, pb1: 1, fees: 96.2, fechaEntrada: dia(35), fechaActual: dia(0) },
        created_at: new Date(Date.now() - 35 * 864e5).toISOString() }
    ];

    // Historial diario: precios que van del de entrada al actual
    const historial = [
      { pool: pools[0], dias: [56, 49, 42, 35, 28, 21, 14, 7, 0],
        precios: [2460, 2390, 2520, 2610, 2580, 2700, 2650, 2740, 2780],
        notas: ['Entrada inicial', '', 'Rebote', '', '', 'Rompió 2.700', '', '', 'Revisión semanal'] },
      { pool: pools[1], dias: [30, 24, 18, 12, 6, 0],
        precios: [146, 139, 141, 132, 127, 124],
        notas: ['Entrada inicial', '', '', 'Ojo: IL creciendo', '', 'Evaluar salida'] }
    ];

    const logs = [];
    historial.forEach(({ pool, dias, precios, notas }) => {
      const d = pool.data;
      dias.forEach((n, i) => {
        const fees = d.fees * (1 - n / dias[0] * 0.95);
        const res  = ejecutarCalculos({ ...d, pa1: precios[i], fees, fechaActual: dia(n) });
        logs.push({ id: uid(), user_id: DEMO_USER.id, pool_id: pool.id, fecha: dia(n), hora: '09:00',
                    precio_a: precios[i], precio_b: 1, valor_pool: res.valorPool,
                    il: res.ilPct, pnl: res.pnl, roi: res.roi, nota: notas[i],
                    created_at: new Date(Date.now() - n * 864e5).toISOString() });
      });
    });
    return { signedIn: true, pools, logs };
  }

  // Los cálculos viven en app.js, que carga después: se siembra al primer uso
  const store = () => { let s = load(); if (!s) { s = seed(); save(s); } return s; };
  const desc  = (a, b) => b.created_at.localeCompare(a.created_at);

  // ── Auth falso ──────────────────────────────────────────────────
  let authCb = null;
  const sesion = () => ({ user: DEMO_USER });
  Object.assign(Auth, {
    async getSession()  { const s = load(); return !s || s.signedIn ? sesion() : null; },
    async signIn()      { const s = store(); s.signedIn = true; save(s); authCb?.('SIGNED_IN', sesion()); },
    async signUp()      { await this.signIn(); return { user: DEMO_USER, session: sesion() }; },
    async signOut()     { const s = store(); s.signedIn = false; save(s); authCb?.('SIGNED_OUT', null); },
    onAuthStateChange(cb) { authCb = cb; return { unsubscribe() {} }; }
  });

  // ── Base de datos en localStorage ───────────────────────────────
  Object.assign(DB, {
    async getPools()  { return store().pools.slice().sort(desc); },
    async savePool({ id, nombre, data }) {
      const s = store();
      let row = id && s.pools.find(p => p.id === id);
      if (row) Object.assign(row, { nombre, data, updated_at: new Date().toISOString() });
      else s.pools.push(row = { id: uid(), user_id: DEMO_USER.id, nombre, data, created_at: new Date().toISOString() });
      save(s); return row;
    },
    async deletePool(id) {
      const s = store();
      s.pools = s.pools.filter(p => p.id !== id);
      s.logs  = s.logs.filter(l => l.pool_id !== id);
      save(s);
    },
    async getLogs(poolId) { return store().logs.filter(l => l.pool_id === poolId).sort(desc); },
    async saveLog(payload) {
      const s = store();
      const row = { ...payload, id: uid(), created_at: new Date().toISOString() };
      s.logs.push(row); save(s); return row;
    },
    async deleteLog(id) { const s = store(); s.logs = s.logs.filter(l => l.id !== id); save(s); }
  });

  // ── Aviso visible ───────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'Modo demo · los datos se guardan solo en este navegador';
    b.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'background:#f59e0b;color:#111;font:600 12px/1 system-ui,sans-serif;padding:8px 14px;border-radius:999px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none';
    document.body.appendChild(b);
    ['loginEmail', 'regEmail'].forEach(id => { const el = document.getElementById(id); if (el) el.value = DEMO_USER.email; });
  });
}
