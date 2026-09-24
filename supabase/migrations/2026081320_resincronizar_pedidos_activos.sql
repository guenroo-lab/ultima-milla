-- Helpers de clasificación de ubicación (ImportarPyxis.gs: clasificarUbicacion/esPicking)
create or replace function staging._clasificar_ubicacion(p_dir text)
returns text language plpgsql immutable as $$
declare
  v_d text;
begin
  v_d := normalize(upper(trim(coalesce(p_dir, ''))), NFC);

  if v_d in ('L','L1','L2','L3','LUNE','M','M1','M2','M3','MART',
             'X','X1','X2','X3','MIER','MIÉR','J','J1','J2','J3','JUEV',
             'V','V1','V2','V3','VIER','S','SABA','TAISA','TOR','VALEN',
             'DEV','TIEND') then
    return 'transitoria';
  end if;
  if v_d ~ '^(LUNE|MART|MIER|MIÉR|JUEV|VIER|SABA|DOMI)' then
    return 'transitoria';
  end if;
  if left(v_d, 1) = 'X' then
    return 'cantilever';
  end if;
  if v_d ~ '^3[012]000' then
    return 'zona_especial';
  end if;
  if left(v_d, 3) = '467' then
    return 'expedicion';
  end if;
  if v_d ~ 'BULTO|TAPETA|ESPEJO|0\.5M|PICKING' then
    return 'picking';
  end if;
  return 'palet';
end $$;

create or replace function staging._es_picking(p_dir text)
returns boolean language sql immutable as $$
  select staging._clasificar_ubicacion(p_dir) in ('picking', 'cantilever');
$$;

-- Motor: equivalente de renovarDireccionesPedidoExistente (ImportarClasificacion.gs).
-- p_transportista_nuevo (opcional): corrección de transportista -- desde
-- resincronizar_pedidos_activos siempre es NULL/igual al actual (rama muerta
-- verificada en ese call site); desde importar_clasificacion SÍ puede diferir.
create or replace function staging._renovar_direcciones_pedido(
  p_id_pedido text, p_lineas_nuevas jsonb, p_transportista_nuevo text default null
) returns table(nuevas int, actualizadas int, ya_en_silueta boolean, es_parcial boolean, transporte_cambiado boolean)
language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_lineas jsonb := coalesce(p_lineas_nuevas, '[]'::jsonb);
  v_max_idx int;
  v_nuevas_cnt int := 0;
  v_actualizadas_cnt int := 0;
  v_total_lineas int; v_procesadas int; v_preparadas int; v_pct int; v_estado_nuevo text; v_n_ubic int;
  v_transporte_cambiado boolean := false;
  v_flujo_nuevo text;
begin
  select * into v_pedido from staging.pedidos where id = p_id_pedido for update;
  if not found then
    return query select 0, 0, false, false, false;
    return;
  end if;

  if v_pedido.silueta is not null and v_pedido.silueta <> '' then
    return query select 0, 0, true, false, false;
    return;
  end if;

  if v_pedido.parcial then
    return query select 0, 0, false, true, false;
    return;
  end if;

  with existentes as (
    select l.id, l.ref, l.dir, l.estado,
           row_number() over (partition by l.ref order by l.idx) as rn
    from staging.lineas_preparacion l
    where l.id_pedido = p_id_pedido
  ),
  nuevas_num as (
    select (elem->>'ref') as ref, (elem->>'dir') as dir,
           row_number() over (partition by (elem->>'ref') order by ord) as rn
    from jsonb_array_elements(v_lineas) with ordinality as t(elem, ord)
  ),
  emparejadas as (
    select e.id, e.estado, n.dir as dir_nueva
    from existentes e
    join nuevas_num n on n.ref = e.ref and n.rn = e.rn
    where e.dir is distinct from n.dir
  )
  update staging.lineas_preparacion l set
    dir = em.dir_nueva,
    tipo_ubic = staging._clasificar_ubicacion(em.dir_nueva),
    es_picking = staging._es_picking(em.dir_nueva),
    estado = case when em.estado in ('PREPARADO','NO_SALE','NO_ENCONTRADO','POSPUESTO') then 'PENDIENTE' else em.estado end,
    motivo = case when em.estado in ('PREPARADO','NO_SALE','NO_ENCONTRADO','POSPUESTO') then null else l.motivo end,
    operario = case when em.estado in ('PREPARADO','NO_SALE','NO_ENCONTRADO','POSPUESTO') then null else l.operario end,
    ts = case when em.estado in ('PREPARADO','NO_SALE','NO_ENCONTRADO','POSPUESTO') then null else l.ts end
  from emparejadas em
  where l.id = em.id;
  get diagnostics v_actualizadas_cnt = row_count;

  select coalesce(max(idx), -1) into v_max_idx from staging.lineas_preparacion where id_pedido = p_id_pedido;

  with existentes as (
    select l.ref, row_number() over (partition by l.ref order by l.idx) as rn
    from staging.lineas_preparacion l
    where l.id_pedido = p_id_pedido
  ),
  nuevas_num as (
    select (elem->>'ref') as ref, (elem->>'dir') as dir, (elem->>'ean') as ean,
           (elem->>'des') as des, (elem->>'ctd')::numeric as ctd, ord,
           row_number() over (partition by (elem->>'ref') order by ord) as rn
    from jsonb_array_elements(v_lineas) with ordinality as t(elem, ord)
  ),
  altas_raw as (
    select n.ref, n.dir, n.ean, n.des, n.ctd, n.ord
    from nuevas_num n
    left join existentes e on e.ref = n.ref and e.rn = n.rn
    where e.ref is null
  ),
  altas_dedup as (
    select *, row_number() over (partition by ref, dir, ctd order by ord) as dup_rn
    from altas_raw
  ),
  altas_final as (
    select ref, dir, ean, des, ctd from altas_dedup where dup_rn = 1
  ),
  altas_ordenadas as (
    select ref, dir, ean, des, ctd,
           row_number() over (order by staging._es_picking(dir) asc, dir asc, ref asc) as pos
    from altas_final
  )
  insert into staging.lineas_preparacion
    (id, id_pedido, idx, dir, ref, ean, des, ctd, tipo_ubic, es_picking, estado, motivo, operario, ts)
  select
    p_id_pedido || '::L' || (v_max_idx + pos), p_id_pedido, (v_max_idx + pos),
    dir, ref, ean, des, ctd,
    staging._clasificar_ubicacion(dir), staging._es_picking(dir),
    'PENDIENTE', null, null, null
  from altas_ordenadas;
  get diagnostics v_nuevas_cnt = row_count;

  if p_transportista_nuevo is not null and v_pedido.transportista is distinct from p_transportista_nuevo then
    v_flujo_nuevo := case p_transportista_nuevo
      when 'Correcaminos' then 'transporte'
      when 'Correcaminos Instalaciones' then 'instalacion'
      when 'Correcaminos PRO' then 'pro'
      when 'Remansur' then 'remansur_transporte'
      when 'Remansur PRO' then 'remansur_pro'
      when 'GruaRemansur' then 'grua_remansur'
      else v_pedido.flujo
    end;
    update staging.pedidos set transportista = p_transportista_nuevo, flujo = v_flujo_nuevo, actualizado = now()
      where id = p_id_pedido;
    begin
      insert into staging.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
        values (p_id_pedido || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text,
          p_id_pedido, v_pedido.ped, v_pedido.tienda, p_transportista_nuevo, v_flujo_nuevo, 'REIMPORTADO', now());
    exception when others then null;
    end;
    v_transporte_cambiado := true;
  end if;

  if v_nuevas_cnt = 0 and v_actualizadas_cnt = 0 then
    if v_transporte_cambiado then
      update staging.pedidos set actualizado = now() where id = p_id_pedido;
    end if;
    return query select 0, 0, false, false, v_transporte_cambiado;
    return;
  end if;

  select count(*),
         count(*) filter (where estado in ('PREPARADO','NO_SALE','NO_ENCONTRADO')),
         count(*) filter (where estado = 'PREPARADO'),
         count(distinct dir)
    into v_total_lineas, v_procesadas, v_preparadas, v_n_ubic
    from staging.lineas_preparacion where id_pedido = p_id_pedido;

  v_pct := case when v_total_lineas > 0 then round((v_procesadas::numeric / v_total_lineas) * 100) else 0 end;
  if v_procesadas = v_total_lineas and v_preparadas = v_total_lineas then v_estado_nuevo := 'COMPLETADO_LISTO';
  elsif v_procesadas = v_total_lineas then v_estado_nuevo := 'PARCIAL_LISTO';
  elsif v_procesadas > 0 then v_estado_nuevo := 'EN_PREPARACION';
  else v_estado_nuevo := 'PENDIENTE';
  end if;

  update staging.pedidos set
    n_lin = v_total_lineas, n_ubic = v_n_ubic, pct = v_pct, estado = v_estado_nuevo, actualizado = now()
  where id = p_id_pedido;

  return query select v_nuevas_cnt, v_actualizadas_cnt, false, false, v_transporte_cambiado;
end $$;

-- Función pública: resincronizar_pedidos_activos
create or replace function staging.resincronizar_pedidos_activos(p_inventario jsonb)
returns jsonb language plpgsql as $$
declare
  v_lock_key bigint := hashtextextended('staging.resincronizar_pedidos_activos', 0);
  v_got_lock boolean := false;
  v_intentos int := 0;
  v_inventario jsonb := coalesce(p_inventario, '[]'::jsonb);
  v_pedido record;
  v_lineas jsonb;
  v_revisados int := 0;
  v_sin_cambios int := 0;
  v_actualizados jsonb := '[]'::jsonb;
  v_no_encontrados jsonb := '[]'::jsonb;
  v_nuevas int; v_actualizadas int; v_ya_en_silueta boolean; v_es_parcial boolean;
  v_detalles text[];
begin
  loop
    v_got_lock := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_got_lock or v_intentos >= 20;
    v_intentos := v_intentos + 1;
    perform pg_sleep(0.1);
  end loop;

  if not v_got_lock then
    return jsonb_build_object('ok', true, 'revisados', 0, 'actualizados', '[]'::jsonb,
      'sinCambios', 0, 'noEncontrados', '[]'::jsonb, 'omitidoPorSolape', true);
  end if;

  for v_pedido in
    select * from staging.pedidos
    where coalesce(estado, '') not in ('ENTREGADO','DEVUELTO_ALMACEN','ENVIADO_TIENDA','SALIDA_MANUAL','CERRADO_SIN_SILUETA')
      and (silueta is null or silueta = '')
      and parcial = false
    order by id
  loop
    v_revisados := v_revisados + 1;

    select elem -> 'lineas' into v_lineas
      from jsonb_array_elements(v_inventario) elem
      where (elem ->> 'ped') = v_pedido.ped and (elem ->> 'tienda') = v_pedido.tienda
      limit 1;

    if v_lineas is null then
      v_no_encontrados := v_no_encontrados || jsonb_build_array(v_pedido.ped || ' (' || v_pedido.tienda || ')');
      continue;
    end if;

    select r.nuevas, r.actualizadas, r.ya_en_silueta, r.es_parcial
      into v_nuevas, v_actualizadas, v_ya_en_silueta, v_es_parcial
      from staging._renovar_direcciones_pedido(v_pedido.id, v_lineas) r;

    if v_nuevas > 0 or v_actualizadas > 0 then
      v_detalles := array[]::text[];
      if v_nuevas > 0 then
        v_detalles := v_detalles || ('+' || v_nuevas || ' nueva' || case when v_nuevas <> 1 then 's' else '' end);
      end if;
      if v_actualizadas > 0 then
        v_detalles := v_detalles || (v_actualizadas || ' actualizada' || case when v_actualizadas <> 1 then 's' else '' end);
      end if;
      v_actualizados := v_actualizados || jsonb_build_array(v_pedido.ped || ' (' || array_to_string(v_detalles, ', ') || ')');
    else
      v_sin_cambios := v_sin_cambios + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'revisados', v_revisados, 'actualizados', v_actualizados,
    'sinCambios', v_sin_cambios, 'noEncontrados', v_no_encontrados);
end $$;

grant execute on function staging._clasificar_ubicacion(text) to service_role;
grant execute on function staging._es_picking(text) to service_role;
grant execute on function staging._renovar_direcciones_pedido(text, jsonb, text) to service_role;
grant execute on function staging.resincronizar_pedidos_activos(jsonb) to service_role;
