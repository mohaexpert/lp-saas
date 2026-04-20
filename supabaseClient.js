'use strict';
/* ================================================================
   LP Tracker Pro — supabaseClient.js

   ── SUPABASE SETUP (run in SQL Editor) ──────────────────────────

   -- Tabla pools
   create table if not exists pools (
     id         uuid default gen_random_uuid() primary key,
     user_id    uuid references auth.users(id) on delete cascade not null,
     nombre     text not null default 'Mi Pool',
     data       jsonb not null default '{}',
     created_at timestamptz default now(),
     updated_at timestamptz default now()
   );

   -- Tabla logs
   create table if not exists logs (
     id         uuid default gen_random_uuid() primary key,
     user_id    uuid references auth.users(id) on delete cascade not null,
     pool_id    uuid references pools(id) on delete cascade not null,
     fecha      date not null,
     hora       text,
     precio_a   numeric,
     precio_b   numeric,
     valor_pool numeric,
     il         numeric,
     pnl        numeric,
     roi        numeric,
     nota       text default '',
     created_at timestamptz default now()
   );

   -- Índices
   create index if not exists pools_user_id_idx on pools(user_id);
   create index if not exists logs_pool_id_idx  on logs(pool_id);
   create index if not exists logs_user_id_idx  on logs(user_id);

   -- Row Level Security (OBLIGATORIO)
   alter table pools enable row level security;
   alter table logs  enable row level security;

   create policy "Usuarios gestionan sus pools" on pools
     for all using (auth.uid() = user_id)
     with check (auth.uid() = user_id);

   create policy "Usuarios gestionan sus logs" on logs
     for all using (auth.uid() = user_id)
     with check (auth.uid() = user_id);

   ── FIN SQL ──────────────────────────────────────────────────────
================================================================ */

// ── Configuración del proyecto (reemplaza estos valores) ─────────
const SUPABASE_URL      = 'https://TU_PROJECT_REF.supabase.co';   // ← pega aquí tu Project URL
const SUPABASE_ANON_KEY = 'TU_ANON_PUBLIC_KEY';                   // ← pega aquí tu anon key

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
