-- Fase 3, Lote 3 -- importar_clasificacion
-- Traduce importarClasificacion() (ImportarClasificacion.gs), ayudada por
-- crearPedidoConLineas (ImportarPyxis.gs). El inventario Pyxis (cargarInventario,
-- indice) y la resolución de colisiones de tienda (resolverOcurrencia) viven
-- FUERA de este esquema (Drive/Excel) -- igual que ya se decidió para
-- resincronizar_pedidos_activos, esta RPC recibe las entradas YA RESUELTAS por
-- el llamador: p_entradas es un array [{ped,tienda,transporte,lineas:[{ref,dir,
-- ean,des,ctd}],esParcial,comentario}], una por cada (ped,tienda) ya decidido.
-- 'transporte' es la ZONA del clasificador ('Transporte'|'Instalaciones'|'PRO'
-- |'Remansur'), no el nombre final del transportista -- se mapea aquí igual
-- que ZONA_TRANSPORTISTA en el original.
create or replace function staging.importar_clasificacion(p_entradas jsonb)
returns jsonb language plpgsql as $$
declare
  v_entrada jsonb;
  v_num_ped text;
  v_tienda text;
  v_transporte text;
  v_transportista text;
  v_codigo_tienda text;
  v_id_pedido text;
  v_lineas jsonb;
  v_es_parcial boolean;
  v_comentario text;
  v_creados jsonb := '[]'::jsonb;
  v_omitidos jsonb := '[]'::jsonb;
  v_no_encontrados jsonb := '[]'::jsonb;
  v_existente staging.pedidos%rowtype;
  v_estado_label text;
  v_comentario_sin_aplicar text;
  v_nuevas int; v_actualizadas int; v_ya_en_silueta boolean; v_es_parcial_r boolean; v_transporte_cambiado boolean;
  v_detalles text[];
  v_flujo text;
  v_lineas_ordenadas jsonb;
  v_n_lin int; v_n_ubic int;
  v_idx int;
  v_linea jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('staging.importar_clasificacion'));

  for v_entrada in select * from jsonb_array_elements(coalesce(p_entradas, '[]'::jsonb))
  loop
    v_num_ped := trim(v_entrada->>'ped');
    v_tienda := v_entrada->>'tienda';
    v_transporte := v_entrada->>'transporte';
    v_lineas := coalesce(v_entrada->'lineas', '[]'::jsonb);
    v_es_parcial := coalesce((v_entrada->>'esParcial')::boolean, false);
    v_comentario := nullif(trim(coalesce(v_entrada->>'comentario', '')), '');

    -- Zona -> transportista real. Si no mapea a ninguna zona conocida, el
    -- original la SALTA en silencio (sin añadirla a ninguna lista).
    v_transportista := case v_transporte
      when 'Transporte' then 'Correcaminos'
      when 'Instalaciones' then 'Correcaminos Instalaciones'
      when 'PRO' then 'Correcaminos PRO'
      when 'Remansur' then 'Remansur'
      else null
    end;
    if v_transportista is null then
      continue;
    end if;

    -- CONFIG.TIENDAS = ['Málaga','Marbella','Mijas'] (Granada no está en
    -- expedición real, ver hallazgo de inconsistencia ya documentado en el
    -- inventario de la migración -- CONFIG.CODIGO_TIENDA sí la incluye pero
    -- CONFIG.TIENDAS no).
    if v_tienda is null or v_tienda not in ('Málaga', 'Marbella', 'Mijas') then
      v_no_encontrados := v_no_encontrados || to_jsonb(v_num_ped || ' (' || coalesce(v_tienda, '?') || ' fuera de expedición)');
      continue;
    end if;

    v_codigo_tienda := case v_tienda
      when 'Marbella' then '014' when 'Málaga' then '036'
      when 'Granada' then '043' when 'Mijas' then '279'
      else '000'
    end;
    v_id_pedido := v_codigo_tienda || '::' || v_num_ped;

    select * into v_existente from staging.pedidos where id = v_id_pedido for update;

    if found then
      if coalesce(v_existente.estado, '') in ('ENTREGADO','DEVUELTO_ALMACEN','ENVIADO_TIENDA','SALIDA_MANUAL','CERRADO_SIN_SILUETA') then
        v_estado_label := case v_existente.estado
          when 'ENTREGADO' then 'Entregado' when 'DEVUELTO_ALMACEN' then 'Devuelto a almacén'
          when 'ENVIADO_TIENDA' then 'Enviado a tienda' when 'SALIDA_MANUAL' then 'Salida manual'
          when 'CERRADO_SIN_SILUETA' then 'Cerrado · todo faltante' else v_existente.estado
        end;
        v_omitidos := v_omitidos || to_jsonb(v_num_ped || ' (' || v_estado_label || ', ya resuelto — no se toca)');
        continue;
      end if;

      v_comentario_sin_aplicar := case when v_comentario is not null
        then ' · comentario NO aplicado (el pedido ya existía -- coméntalo desde la pantalla de Silueta)' else '' end;

      select r.nuevas, r.actualizadas, r.ya_en_silueta, r.es_parcial, r.transporte_cambiado
        into v_nuevas, v_actualizadas, v_ya_en_silueta, v_es_parcial_r, v_transporte_cambiado
        from staging._renovar_direcciones_pedido(v_id_pedido, v_lineas, v_transportista) r;

      if v_nuevas > 0 or v_actualizadas > 0 or v_transporte_cambiado then
        v_detalles := array[]::text[];
        if v_transporte_cambiado then v_detalles := v_detalles || ('transporte → ' || v_transporte); end if;
        if v_nuevas > 0 then v_detalles := v_detalles || ('+' || v_nuevas || ' dirección' || (case when v_nuevas <> 1 then 'es' else '' end) || ' nueva' || (case when v_nuevas <> 1 then 's' else '' end)); end if;
        if v_actualizadas > 0 then v_detalles := v_detalles || (v_actualizadas || ' dirección' || (case when v_actualizadas <> 1 then 'es' else '' end) || ' actualizada' || (case when v_actualizadas <> 1 then 's' else '' end) || ' (cambió de sitio)'); end if;
        v_creados := v_creados || to_jsonb(v_num_ped || ' (' || array_to_string(v_detalles, ', ') || ')' || v_comentario_sin_aplicar);
      elsif v_ya_en_silueta then
        v_omitidos := v_omitidos || to_jsonb(v_num_ped || ' (ya está en silueta, no se actualiza)' || v_comentario_sin_aplicar);
      else
        v_estado_label := case v_existente.estado
          when 'PENDIENTE' then 'Pendiente' when 'EN_PREPARACION' then 'En preparación'
          when 'COMPLETADO_LISTO' then 'Listo · en silueta' when 'PARCIAL_LISTO' then 'Listo parcial · con faltantes'
          when 'COMPLETADO' then 'En silueta' when 'CARGA_2' then 'Pendiente carga 2'
          else coalesce(v_existente.estado, 'null')
        end;
        v_omitidos := v_omitidos || to_jsonb(v_num_ped || ' (ya existe en el sistema, sin cambios · ' || v_estado_label || ')' || v_comentario_sin_aplicar);
      end if;
      continue;
    end if;

    -- Alta nueva: equivalente a crearPedidoConLineas.
    v_flujo := case v_transportista
      when 'Correcaminos' then 'transporte' when 'Correcaminos Instalaciones' then 'instalacion'
      when 'Correcaminos PRO' then 'pro' when 'Remansur' then 'remansur_transporte'
      when 'Remansur PRO' then 'remansur_pro' when 'GruaRemansur' then 'grua_remansur'
      else 'transporte'
    end;

    -- Deduplicar por ref+dir+ctd exactos (mismo criterio que deduplicarLineasPyxis_),
    -- luego ordenar no-picking primero, picking/cantilever al final, por dir.
    with numeradas as (
      select elem, ord from jsonb_array_elements(v_lineas) with ordinality as t(elem, ord)
    ),
    dedup as (
      select elem, ord,
        row_number() over (partition by (elem->>'ref'), (elem->>'dir'), (elem->>'ctd') order by ord) as dup_rn
      from numeradas
    )
    select coalesce(jsonb_agg(elem order by staging._es_picking(elem->>'dir') asc, (elem->>'dir') asc, (elem->>'ref') asc), '[]'::jsonb)
      into v_lineas_ordenadas
      from dedup where dup_rn = 1;

    v_n_lin := jsonb_array_length(v_lineas_ordenadas);
    select count(distinct (elem->>'dir')) into v_n_ubic from jsonb_array_elements(v_lineas_ordenadas) elem;

    insert into staging.pedidos (
      id, ped, tienda, transportista, flujo, estado, pct, operario,
      silueta, pos_ini, pos_fin, numero_carga, soportes, n_lin, n_ubic,
      parcial, comentario, actualizado
    ) values (
      v_id_pedido, v_num_ped, v_tienda, v_transportista, v_flujo, 'PENDIENTE', 0, null,
      null, null, null, null, '[]'::jsonb, v_n_lin, coalesce(v_n_ubic, 0),
      v_es_parcial, coalesce(v_comentario, ''), now()
    );

    begin
      insert into staging.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
        values (v_id_pedido || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text,
          v_id_pedido, v_num_ped, v_tienda, v_transportista, v_flujo, 'ALTA', now());
    exception when others then null;
    end;

    v_idx := 0;
    for v_linea in select * from jsonb_array_elements(v_lineas_ordenadas)
    loop
      insert into staging.lineas_preparacion (id, id_pedido, idx, dir, ref, ean, des, ctd, tipo_ubic, es_picking, estado, motivo, operario, ts)
        values (
          v_id_pedido || '::L' || v_idx, v_id_pedido, v_idx,
          v_linea->>'dir', v_linea->>'ref', v_linea->>'ean', v_linea->>'des', (v_linea->>'ctd')::numeric,
          staging._clasificar_ubicacion(v_linea->>'dir'), staging._es_picking(v_linea->>'dir'),
          'PENDIENTE', null, null, null
        );
      v_idx := v_idx + 1;
    end loop;

    v_creados := v_creados || to_jsonb(v_num_ped);
  end loop;

  return jsonb_build_object('ok', true, 'creados', v_creados, 'omitidos', v_omitidos,
    'noEncontrados', v_no_encontrados, 'colisiones', '[]'::jsonb);
end $$;

grant execute on function staging.importar_clasificacion(jsonb) to service_role;
