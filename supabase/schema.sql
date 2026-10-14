-- ================================================================
-- LP Tracker Pro — esquema de Supabase
-- Pegar completo en Supabase → SQL Editor → Run. Se puede correr
-- varias veces sin romper nada.
-- ================================================================

-- Pools que sigue cada usuario (manuales o importadas de la wallet)
create table if not exists public.pools (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users(id) on delete cascade not null default auth.uid(),
  nombre     text not null default 'Mi Pool',
  data       jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Registros (snapshots) de cada pool
create table if not exists public.logs (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users(id) on delete cascade not null default auth.uid(),
  pool_id    uuid references public.pools(id) on delete cascade not null,
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

create index if not exists pools_user_id_idx on public.pools(user_id);
create index if not exists logs_pool_id_idx  on public.logs(pool_id);
create index if not exists logs_user_id_idx  on public.logs(user_id);

-- Seguridad: cada usuario solo ve y modifica lo suyo
alter table public.pools enable row level security;
alter table public.logs  enable row level security;

drop policy if exists "Usuarios gestionan sus pools" on public.pools;
create policy "Usuarios gestionan sus pools" on public.pools
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Usuarios gestionan sus logs" on public.logs;
create policy "Usuarios gestionan sus logs" on public.logs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.pools p where p.id = pool_id and p.user_id = (select auth.uid()))
  );
