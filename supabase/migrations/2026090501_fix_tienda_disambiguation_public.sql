-- Fase 3, Pieza 3 -- fix post-despliegue (2026-09-05)
-- Hallazgo de revisión adversarial: 4 RPC ya en `public` resuelven un pedido
-- SOLO por `ped` (where ped = X order by id limit 1), sin tienda -- si el
-- mismo número existe en dos tiendas a la vez (ya ha pasado de verdad en
-- este proyecto: 291164/291463 Mijas/Málaga), pueden mutar en silencio el
-- pedido de la tienda EQUIVOCADA. Las RPC hermanas (mover_pedido_de_silueta,
-- corregir_soportes_pedido, liberar_pedido_de_silueta, reabrir_pedido,
-- registrar_pedido_manual) ya hacen esta comprobación bien -- estas 4 se
-- quedaron atrás. Mismo idioma que esas: si se da p_tienda, filtrar por
-- tienda exacta (si no hay match, se trata como "no encontrado" en vez de
-- coger el de otra tienda); si NO se da p_tienda y hay más de un candidato,
-- error explícito de ambigüedad.

-- 1) cambiar_flujo_pedido: nuevo overload con p_tienda (el de 2 parámetros
-- se deja tal cual -- ningún llamador lo usa ya, ver Backend.gs).
create or replace function public.cambiar_flujo_pedido(p_num_ped text, p_nuevo_flujo text, p_tienda text default null)
returns jsonb language plpgsql as $$
declare
  v_pedido public.pedidos%rowtype;
  v_flujo_anterior text;
  v_transportista text;
  v_ahora timestamptz := now();
  v_candidatos int;
begin
  v_transportista := case p_nuevo_flujo
    when 'transporte' then 'Correcaminos'
    when 'instalacion' then 'Correcaminos Instalaciones'
    when 'pro' then 'Correcaminos PRO'
    when 'remansur_transporte' then 'Remansur'
    when 'remansur_pro' then 'Remansur PRO'
    when 'grua_remansur' then 'GruaRemansur'
    else null
  end;
  if v_transportista is null then
    return jsonb_build_object('ok', false, 'error', 'Tipo de transporte no válido');
  end if;

  if p_tienda is not null then
    select * into v_pedido from public.pedidos where ped = p_num_ped and tienda = p_tienda order by id limit 1 for update;
  else
    select count(*) into v_candidatos from public.pedidos where ped = p_num_ped;
    if v_candidatos > 1 then
      return jsonb_build_object('ok', false, 'error', 'Hay varios pedidos con este número en tiendas distintas — ábrelo desde 🔍 Buscar para identificar la tienda correcta');
    end if;
    select * into v_pedido from public.pedidos where ped = p_num_ped order by id limit 1 for update;
  end if;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;

  v_flujo_anterior := v_pedido.flujo;

  update public.pedidos set flujo = p_nuevo_flujo, transportista = v_transportista, actualizado = v_ahora
    where id = v_pedido.id;

  if v_flujo_anterior is distinct from p_nuevo_flujo then
    begin
      insert into public.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
        values (v_pedido.id || '::' || (extract(epoch from v_ahora) * 1000)::bigint::text,
          v_pedido.id, v_pedido.ped, v_pedido.tienda, v_transportista, p_nuevo_flujo, 'CAMBIO_MANUAL', v_ahora);
    exception when others then
      null;
    end;
  end if;

  if v_pedido.silueta is not null then
    update public.ocupacion_siluetas set flujo = p_nuevo_flujo
      where silueta = v_pedido.silueta and tienda = v_pedido.tienda and pedido = v_pedido.ped;
  end if;

  return jsonb_build_object('ok', true, 'flujo', p_nuevo_flujo, 'transportista', v_transportista);
end $$;

grant execute on function public.cambiar_flujo_pedido(text, text, text) to service_role;

-- 2) borrar_pedido_no_sacado: nuevo overload con p_tienda.
create or replace function public.borrar_pedido_no_sacado(p_num_ped text, p_tienda text default null)
returns jsonb language plpgsql as $$
declare
  v_pedido public.pedidos%rowtype;
  v_n_lineas int;
  v_candidatos int;
begin
  if p_tienda is not null then
    select * into v_pedido from public.pedidos where ped = p_num_ped and tienda = p_tienda order by id limit 1 for update;
  else
    select count(*) into v_candidatos from public.pedidos where ped = p_num_ped;
    if v_candidatos > 1 then
      return jsonb_build_object('ok', false, 'error', 'Hay varios pedidos con este número en tiendas distintas — ábrelo desde 🔍 Buscar para identificar la tienda correcta');
    end if;
    select * into v_pedido from public.pedidos where ped = p_num_ped order by id limit 1 for update;
  end if;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;

  if v_pedido.silueta is not null then
    return jsonb_build_object('ok', false, 'error',
      'Este pedido ya está en la silueta ' || v_pedido.silueta || '. Libéralo antes desde la Pantalla de administración.');
  end if;

  if exists (
    select 1 from public.lineas_preparacion
    where id_pedido = v_pedido.id
      and estado is distinct from 'PENDIENTE'
  ) then
    return jsonb_build_object('ok', false, 'error',
      'Un operario ya ha empezado a preparar este pedido (ya tiene ubicaciones marcadas). Solo se puede borrar un pedido que nadie ha tocado todavía.');
  end if;

  with borradas as (
    delete from public.lineas_preparacion
    where id_pedido = v_pedido.id
    returning 1
  )
  select count(*) into v_n_lineas from borradas;

  delete from public.pedidos where id = v_pedido.id;

  return jsonb_build_object('ok', true, 'lineasBorradas', v_n_lineas);
end $$;

grant execute on function public.borrar_pedido_no_sacado(text, text) to service_role;

-- 3) registrar_recogidas_masivo: la resolución de "¿ya existe?" ahora respeta
-- p_tienda -- si se da, solo puede reconvertir un pedido de ESA tienda; si no
-- hay match en esa tienda, se trata como alta nueva (nunca toca el de otra
-- tienda). El resto de la función queda idéntico.
create or replace function public.registrar_recogidas_masivo(p_numeros_pedido text[], p_tienda text default null)
returns jsonb language plpgsql as $$
declare
  v_nombre_silueta constant text := 'Recogidas';
  v_lista text[];
  v_num text;
  v_vistos text[] := '{}';
  v_max_pos int;
  v_pedido public.pedidos%rowtype;
  v_anadidos int := 0;
  v_reconvertidos int := 0;
  v_ya_existian text[] := '{}';
  v_detalle text;
  v_estado_label text;
  v_tienda_final text;
  v_new_id text;
  v_hist_id text;
begin
  select array_agg(trim(x) order by ord) into v_lista
    from unnest(p_numeros_pedido) with ordinality as t(x, ord)
    where trim(x) <> '';

  if v_lista is null then
    return jsonb_build_object('ok', false, 'error', 'No se ha indicado ningún número de pedido');
  end if;

  perform pg_advisory_xact_lock(hashtext('public.registrar_recogidas_masivo'));

  select coalesce(max(nullif(pos_ini, '')::int), 0) into v_max_pos
    from public.pedidos where silueta = v_nombre_silueta;

  foreach v_num in array v_lista loop
    if v_num = any(v_vistos) then
      v_ya_existian := array_append(v_ya_existian, v_num || ' (repetido en la lista pegada)');
      continue;
    end if;
    v_vistos := array_append(v_vistos, v_num);

    if p_tienda is not null then
      select * into v_pedido from public.pedidos where ped = v_num and tienda = p_tienda order by id limit 1 for update;
    else
      select * into v_pedido from public.pedidos where ped = v_num order by id limit 1 for update;
    end if;

    if found then
      if v_pedido.silueta = v_nombre_silueta then
        v_ya_existian := array_append(v_ya_existian, v_num || ' (ya está en Recogidas)');
        continue;
      end if;

      if coalesce(v_pedido.estado, '') not in
         ('ENTREGADO', 'DEVUELTO_ALMACEN', 'ENVIADO_TIENDA', 'SALIDA_MANUAL', 'CERRADO_SIN_SILUETA')
      then
        v_estado_label := case v_pedido.estado
          when 'PENDIENTE' then 'Pendiente'
          when 'EN_PREPARACION' then 'En preparación'
          when 'COMPLETADO_LISTO' then 'Listo · en silueta'
          when 'PARCIAL_LISTO' then 'Listo parcial · con faltantes'
          when 'COMPLETADO' then 'En silueta'
          when 'ENTREGADO' then 'Entregado'
          when 'CARGA_2' then 'Pendiente carga 2'
          when 'DEVUELTO_ALMACEN' then 'Devuelto a almacén'
          when 'ENVIADO_TIENDA' then 'Enviado a tienda'
          when 'SALIDA_MANUAL' then 'Salida manual'
          when 'CERRADO_SIN_SILUETA' then 'Cerrado · todo faltante'
          else null
        end;
        v_detalle := 'ya existe · ' || coalesce(v_estado_label, v_pedido.estado, 'null');
        if v_pedido.silueta is not null then
          v_detalle := v_detalle || ' · en ' || v_pedido.silueta ||
            (case when coalesce(nullif(v_pedido.pos_ini, '')::int, 0) <> 0 then v_pedido.pos_ini else '' end);
        end if;
        v_ya_existian := array_append(v_ya_existian, v_num || ' (' || v_detalle || ')');
        continue;
      end if;

      if v_pedido.silueta is not null
         and coalesce(nullif(v_pedido.pos_ini, '')::int, 0) <> 0
         and exists (select 1 from public.config_siluetas cs where cs.silueta = v_pedido.silueta)
      then
        begin
          perform public._liberar_ocupacion(
            v_pedido.silueta, nullif(v_pedido.pos_ini, '')::int, nullif(v_pedido.pos_fin, '')::int, v_pedido.ped);
        exception when others then
          null;
        end;
      end if;

      delete from public.cargas_pedidos
        where pedido_id = v_pedido.id
          and carga_id in (select id from public.cargas where estado = 'GENERADA');

      v_tienda_final := coalesce(nullif(v_pedido.tienda, ''), nullif(p_tienda, ''));
      v_max_pos := v_max_pos + 1;

      update public.pedidos set
        tienda = v_tienda_final, transportista = 'Correcaminos', flujo = 'transporte',
        estado = 'COMPLETADO_LISTO', pct = 100, operario = 'Recogidas',
        silueta = v_nombre_silueta, pos_ini = v_max_pos::text, pos_fin = v_max_pos::text,
        numero_carga = null, soportes = '[]'::jsonb, intento_carga = null,
        actualizado = now()
        where id = v_pedido.id;

      v_hist_id := v_pedido.id || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
      begin
        insert into public.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
          values (v_hist_id, v_pedido.id, v_num, v_tienda_final, 'Correcaminos', 'transporte', 'RECOGIDAS', now());
      exception when others then
        null;
      end;

      v_reconvertidos := v_reconvertidos + 1;
      continue;
    end if;

    v_max_pos := v_max_pos + 1;
    v_new_id := 'REC_' || v_num || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
    v_tienda_final := nullif(p_tienda, '');

    insert into public.pedidos (
      id, ped, tienda, transportista, flujo, estado, pct, operario,
      silueta, pos_ini, pos_fin, numero_carga, soportes, n_lin, n_ubic, actualizado
    ) values (
      v_new_id, v_num, v_tienda_final, 'Correcaminos', 'transporte', 'COMPLETADO_LISTO', 100, 'Recogidas',
      v_nombre_silueta, v_max_pos::text, v_max_pos::text, null, '[]'::jsonb, 0, 0, now()
    );

    v_hist_id := v_new_id || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
    begin
      insert into public.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
        values (v_hist_id, v_new_id, v_num, v_tienda_final, 'Correcaminos', 'transporte', 'RECOGIDAS', now());
    exception when others then
      null;
    end;

    v_anadidos := v_anadidos + 1;
  end loop;

  return jsonb_build_object(
    'ok', true, 'anadidos', v_anadidos, 'reconvertidos', v_reconvertidos,
    'yaExistian', to_jsonb(v_ya_existian)
  );
end $$;

grant execute on function public.registrar_recogidas_masivo(text[], text) to service_role;

-- 4) registrar_ya_cargados_masivo: mismo fix exacto que registrar_recogidas_masivo.
create or replace function public.registrar_ya_cargados_masivo(p_numeros_pedido text[], p_tienda text default null)
returns jsonb language plpgsql as $$
declare
  v_nombre_silueta constant text := 'Ya Cargados';
  v_lista text[];
  v_num text;
  v_vistos text[] := '{}';
  v_max_pos int;
  v_pedido public.pedidos%rowtype;
  v_anadidos int := 0;
  v_reconvertidos int := 0;
  v_ya_existian text[] := '{}';
  v_detalle text;
  v_estado_label text;
  v_tienda_final text;
  v_new_id text;
  v_hist_id text;
begin
  select array_agg(trim(x) order by ord) into v_lista
    from unnest(p_numeros_pedido) with ordinality as t(x, ord)
    where trim(x) <> '';

  if v_lista is null then
    return jsonb_build_object('ok', false, 'error', 'No se ha indicado ningún número de pedido');
  end if;

  perform pg_advisory_xact_lock(hashtext('public.registrar_ya_cargados_masivo'));

  select coalesce(max(nullif(pos_ini, '')::int), 0) into v_max_pos
    from public.pedidos where silueta = v_nombre_silueta;

  foreach v_num in array v_lista loop
    if v_num = any(v_vistos) then
      v_ya_existian := array_append(v_ya_existian, v_num || ' (repetido en la lista pegada)');
      continue;
    end if;
    v_vistos := array_append(v_vistos, v_num);

    if p_tienda is not null then
      select * into v_pedido from public.pedidos where ped = v_num and tienda = p_tienda order by id limit 1 for update;
    else
      select * into v_pedido from public.pedidos where ped = v_num order by id limit 1 for update;
    end if;

    if found then
      if v_pedido.silueta = v_nombre_silueta then
        v_ya_existian := array_append(v_ya_existian, v_num || ' (ya está en Ya Cargados)');
        continue;
      end if;

      if coalesce(v_pedido.estado, '') not in
         ('ENTREGADO', 'DEVUELTO_ALMACEN', 'ENVIADO_TIENDA', 'SALIDA_MANUAL', 'CERRADO_SIN_SILUETA')
      then
        v_estado_label := case v_pedido.estado
          when 'PENDIENTE' then 'Pendiente'
          when 'EN_PREPARACION' then 'En preparación'
          when 'COMPLETADO_LISTO' then 'Listo · en silueta'
          when 'PARCIAL_LISTO' then 'Listo parcial · con faltantes'
          when 'COMPLETADO' then 'En silueta'
          when 'ENTREGADO' then 'Entregado'
          when 'CARGA_2' then 'Pendiente carga 2'
          when 'DEVUELTO_ALMACEN' then 'Devuelto a almacén'
          when 'ENVIADO_TIENDA' then 'Enviado a tienda'
          when 'SALIDA_MANUAL' then 'Salida manual'
          when 'CERRADO_SIN_SILUETA' then 'Cerrado · todo faltante'
          else null
        end;
        v_detalle := 'ya existe · ' || coalesce(v_estado_label, v_pedido.estado, 'null');
        if v_pedido.silueta is not null then
          v_detalle := v_detalle || ' · en ' || v_pedido.silueta ||
            (case when coalesce(nullif(v_pedido.pos_ini, '')::int, 0) <> 0 then v_pedido.pos_ini else '' end);
        end if;
        v_ya_existian := array_append(v_ya_existian, v_num || ' (' || v_detalle || ')');
        continue;
      end if;

      if v_pedido.silueta is not null
         and coalesce(nullif(v_pedido.pos_ini, '')::int, 0) <> 0
         and exists (select 1 from public.config_siluetas cs where cs.silueta = v_pedido.silueta)
      then
        begin
          perform public._liberar_ocupacion(
            v_pedido.silueta, nullif(v_pedido.pos_ini, '')::int, nullif(v_pedido.pos_fin, '')::int, v_pedido.ped);
        exception when others then
          null;
        end;
      end if;

      delete from public.cargas_pedidos
        where pedido_id = v_pedido.id
          and carga_id in (select id from public.cargas where estado = 'GENERADA');

      v_tienda_final := coalesce(nullif(v_pedido.tienda, ''), nullif(p_tienda, ''));
      v_max_pos := v_max_pos + 1;

      update public.pedidos set
        tienda = v_tienda_final,
        estado = 'COMPLETADO_LISTO', pct = 100, operario = 'Ya Cargado',
        silueta = v_nombre_silueta, pos_ini = v_max_pos::text, pos_fin = v_max_pos::text,
        numero_carga = null, soportes = '[]'::jsonb, intento_carga = null,
        comentario = 'Pedido ya cargado anteriormente', actualizado = now()
        where id = v_pedido.id;

      v_hist_id := v_pedido.id || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
      begin
        insert into public.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
          values (v_hist_id, v_pedido.id, v_num, v_tienda_final, v_pedido.transportista, v_pedido.flujo, 'YA_CARGADOS', now());
      exception when others then
        null;
      end;

      v_reconvertidos := v_reconvertidos + 1;
      continue;
    end if;

    v_max_pos := v_max_pos + 1;
    v_new_id := 'YAC_' || v_num || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
    v_tienda_final := nullif(p_tienda, '');

    insert into public.pedidos (
      id, ped, tienda, transportista, flujo, estado, pct, operario,
      silueta, pos_ini, pos_fin, numero_carga, soportes, n_lin, n_ubic,
      comentario, actualizado
    ) values (
      v_new_id, v_num, v_tienda_final, 'Correcaminos', 'transporte', 'COMPLETADO_LISTO', 100, 'Ya Cargado',
      v_nombre_silueta, v_max_pos::text, v_max_pos::text, null, '[]'::jsonb, 0, 0,
      'Pedido ya cargado anteriormente', now()
    );

    v_hist_id := v_new_id || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
    begin
      insert into public.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
        values (v_hist_id, v_new_id, v_num, v_tienda_final, 'Correcaminos', 'transporte', 'YA_CARGADOS', now());
    exception when others then
      null;
    end;

    v_anadidos := v_anadidos + 1;
  end loop;

  return jsonb_build_object(
    'ok', true, 'anadidos', v_anadidos, 'reconvertidos', v_reconvertidos,
    'yaExistian', to_jsonb(v_ya_existian)
  );
end $$;

grant execute on function public.registrar_ya_cargados_masivo(text[], text) to service_role;
