'use strict';
/* ================================================================
   LP Tracker Pro — supabaseClient.js

   Las tablas y las reglas de seguridad están en supabase/schema.sql
   (pegar en Supabase → SQL Editor → Run).
================================================================ */

// ── Configuración del proyecto (reemplaza estos valores) ─────────
// La publishable key es pública por diseño: la seguridad la da RLS
// (ver supabase/schema.sql). Nunca pongas aquí la secret / service_role.
const SUPABASE_URL      = 'https://bjamxvdofffrcolzslgk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_z2L7hzTClPqLD1qv4tAZYg_vo3kPhrW';

// ── Inicializar cliente ──────────────────────────────────────────
const { createClient } = supabase; // expuesto por el CDN
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:   true,
    autoRefreshToken: true,
    storageKey:       'lp_tracker_pro_session'
  }
});

/* ================================================================
   CAPA DE BASE DE DATOS
   Todos los métodos lanzan el error para que la capa de UI lo maneje.
================================================================ */
const DB = {

  // ── Pools ───────────────────────────────────────────────────────

  async getPools(userId) {
    const { data, error } = await sb
      .from('pools')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  },

  async savePool({ id, userId, nombre, data }) {
    if (id) {
      const { data: row, error } = await sb
        .from('pools')
        .update({ nombre, data, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return row;
    }
    const { data: row, error } = await sb
      .from('pools')
      .insert({ user_id: userId, nombre, data })
      .select()
      .single();
    if (error) throw error;
    return row;
  },

  async deletePool(id) {
    const { error } = await sb.from('pools').delete().eq('id', id);
    if (error) throw error;
  },

  // ── Logs ────────────────────────────────────────────────────────

  async getLogs(poolId) {
    const { data, error } = await sb
      .from('logs')
      .select('*')
      .eq('pool_id', poolId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  },

  async saveLog(payload) {
    const { data, error } = await sb
      .from('logs')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async deleteLog(id) {
    const { error } = await sb.from('logs').delete().eq('id', id);
    if (error) throw error;
  }
};
