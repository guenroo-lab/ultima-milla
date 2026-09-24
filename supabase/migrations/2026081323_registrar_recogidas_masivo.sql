create or replace function staging.registrar_recogidas_masivo(p_numeros_pedido text[], p_tienda text default null)
returns jsonb language plpgsql as $$
declare
  v_nombre_silueta constant text := 'Recogidas';
  v_lista text[];
  v_num text;
  v_vistos text[] := '{}';
  v_max_pos int;
  v_pedido staging.pedidos%rowtype;
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

  perform pg_advisory_xact_lock(hashtext('staging.registrar_recogidas_masivo'));

  select coalesce(max(nullif(pos_ini, '')::int), 0) into v_max_pos
    from staging.pedidos where silueta = v_nombre_silueta;

  foreach v_num in array v_lista loop
    if v_num = any(v_vistos) then
      v_ya_existian := array_append(v_ya_existian, v_num || ' (repetido en la lista pegada)');
      continue;
    end if;
    v_vistos := array_append(v_vistos, v_num);

    select * into v_pedido from staging.pedidos where ped = v_num order by id limit 1 for update;

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
         and exists (select 1 from staging.config_siluetas cs where cs.silueta = v_pedido.silueta)
      then
        begin
          perform staging._liberar_ocupacion(
            v_pedido.silueta, nullif(v_pedido.pos_ini, '')::int, nullif(v_pedido.pos_fin, '')::int, v_pedido.ped);
        exception when others then
          null;
        end;
      end if;

      delete from staging.cargas_pedidos
        where pedido_id = v_pedido.id
          and carga_id in (select id from staging.cargas where estado = 'GENERADA');

      v_tienda_final := coalesce(nullif(v_pedido.tienda, ''), nullif(p_tienda, ''));
      v_max_pos := v_max_pos + 1;

      -- A diferencia de Ya Cargados: transportista/flujo se FUERZAN a
      -- Correcaminos/transporte, y no se toca 'comentario'.
      update staging.pedidos set
        tienda = v_tienda_final, transportista = 'Correcaminos', flujo = 'transporte',
        estado = 'COMPLETADO_LISTO', pct = 100, operario = 'Recogidas',
        silueta = v_nombre_silueta, pos_ini = v_max_pos::text, pos_fin = v_max_pos::text,
        numero_carga = null, soportes = '[]'::jsonb, intento_carga = null,
        actualizado = now()
        where id = v_pedido.id;

      v_hist_id := v_pedido.id || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
      begin
        insert into staging.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
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

    insert into staging.pedidos (
      id, ped, tienda, transportista, flujo, estado, pct, operario,
      silueta, pos_ini, pos_fin, numero_carga, soportes, n_lin, n_ubic, actualizado
    ) values (
      v_new_id, v_num, v_tienda_final, 'Correcaminos', 'transporte', 'COMPLETADO_LISTO', 100, 'Recogidas',
      v_nombre_silueta, v_max_pos::text, v_max_pos::text, null, '[]'::jsonb, 0, 0, now()
    );

    v_hist_id := v_new_id || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
    begin
      insert into staging.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
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

grant execute on function staging.registrar_recogidas_masivo(text[], text) to service_role;
