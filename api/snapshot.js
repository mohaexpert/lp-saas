'use strict';
/* ================================================================
   LP Tracker Pro — api/snapshot.js
   Registro diario automático (Vercel Cron, ver vercel.json).

   Recorre todas las pools importadas de la blockchain, actualiza sus
   datos y guarda un registro por pool, aunque nadie abra la app.

   Variables de entorno (Vercel → Settings → Environment Variables):
   · SUPABASE_SECRET_KEY  secret key de Supabase (sb_secret_…). Solo
                          aquí, nunca en el código ni en el navegador.
   · CRON_SECRET          Vercel la envía en cada ejecución del cron;
                          sin ella nadie más puede disparar la tarea.
================================================================ */

const { GRAPH_API_KEY } = require('../config.js');
global.GRAPH_API_KEY = GRAPH_API_KEY;               // onchain.js la lee como global
const OnChain = require('../onchain.js');
const { dataDesdePosicion, datosCompletos, ejecutarCalculos } = require('../calc.js');

const SUPABASE_URL = 'https://bjamxvdofffrcolzslgk.supabase.co';
const HORAS_MIN_ENTRE_REGISTROS = 20;   // evita duplicar si la app ya registró hoy

async function db(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]}: ${r.status} ${await r.text()}`);
  return method === 'GET' ? r.json() : null;
}

module.exports = async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  if (!process.env.SUPABASE_SECRET_KEY) {
    return res.status(500).json({ error: 'Falta SUPABASE_SECRET_KEY en Vercel' });
  }

  const pools = (await db('pools?select=id,user_id,nombre,data')).filter(p => p.data?.v3);

  // Agrupar por red y wallet: una lectura on-chain por grupo
  const grupos = {};
  pools.forEach(p => { const k = p.data.v3.chain + '|' + p.data.v3.owner; (grupos[k] ||= []).push(p); });

  const resumen = { pools: pools.length, actualizadas: 0, registros: 0, errores: [] };
  const ahora = new Date();

  for (const grupo of Object.values(grupos)) {
    const { chain, owner } = grupo[0].data.v3;
    try {
      const entradas = {};
      grupo.forEach(p => { if (p.data.qa0 > 0 || p.data.qb0 > 0) entradas[p.data.v3.tokenId] = true; });
      const posiciones = await OnChain.leerPosiciones(chain, owner, grupo.map(p => p.data.v3.tokenId),
        { incluirCerradas: true, entradas });

      for (const pool of grupo) {
        const pos = posiciones.find(x => x.tokenId === pool.data.v3.tokenId);
        if (!pos) continue;
        const data = dataDesdePosicion(pos, pool.data);

        const ultimo = data.v3.ultimoRegistro ? new Date(data.v3.ultimoRegistro).getTime() : 0;
        if (datosCompletos(data) && !data.v3.cerrada && ahora - ultimo >= HORAS_MIN_ENTRE_REGISTROS * 3600_000) {
          const r = ejecutarCalculos(data);
          await db('logs', { method: 'POST', body: {
            user_id: pool.user_id, pool_id: pool.id,
            fecha: ahora.toISOString().slice(0, 10), hora: ahora.toISOString().slice(11, 16) + ' UTC',
            precio_a: data.pa1, precio_b: data.pb1, valor_pool: r.valorPool,
            il: r.ilPct, pnl: r.pnl, roi: r.roi,
            nota: `Auto diario · ${data.v3.inRange ? 'en rango' : 'FUERA de rango'}`
          } });
          data.v3.ultimoRegistro = ahora.toISOString();
          resumen.registros++;
        }

        await db(`pools?id=eq.${pool.id}`, { method: 'PATCH', body: { data, updated_at: ahora.toISOString() } });
        resumen.actualizadas++;
      }
    } catch (err) {
      resumen.errores.push(`${chain} ${owner.slice(0, 8)}…: ${err.message}`);
    }
  }

  console.log('snapshot', JSON.stringify(resumen));
  res.status(200).json(resumen);
};
