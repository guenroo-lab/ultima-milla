-- Fase 3, Lote 3 -- registrar_pedido_manual
-- Traduce registrarPedidoManual/_registrarPedidoManualInterno (Backend.gs).
-- p_posiciones: calcularPosiciones(soportes) ya calculado en el cliente si
--   soportes no está vacío; si soportes SÍ está vacío, el original sintetiza
--   [{"back":true,"front":"reservado"}] (UNA posición reservada, NO bultos) --
--   el llamador debe replicar exactamente ese mismo valor por defecto, no [].
-- p_tiendas_pyxis: array de tiendas que el inventario Pyxis conoce para este
--   número (Object.keys(entry.porTienda) del original) -- NULL/vacío si el
--   pedido no está en NINGÚN inventario (el original deja pasar el alta sin
--   más en ese caso). Postgres no puede leer el inventario Pyxis directamente.
create or replace function staging.registrar_pedido_manual(
  p_num text, p_tienda text, p_flujo text, p_silueta text, p_pos_ini int,
  p_soportes jsonb, p_comentario text, p_posiciones jsonb, p_tiendas_pyxis text[] default null
) returns jsonb language plpgsql as $$
declare
  v_num text := trim(coalesce(p_num, ''));
  v_silueta text := coalesce(p_silueta, '');
  v_pos_ini int := coalesce(p_pos_ini, 1);
  v_pos_fin int;
  v_num_pos int := jsonb_array_length(coalesce(p_posiciones, '[]'::jsonb));
  v_comentario text := trim(coalesce(p_comentario, ''));
  v_flujo text := coalesce(nullif(p_flujo, ''), 'transporte');
  v_tienda text := coalesce(p_tienda, '');
  v_transportista text;
  v_id_pedido text;
  v_codigo_tienda text;
  v_existente staging.pedidos%rowtype;
  v_max_pos int;
  v_conflicto boolean;
  v_numero_carga_anterior text;
  v_pos_ini_vieja int; v_pos_fin_vieja int;
  v_i int; v_pos int; v_def jsonb;
begin
  if v_num = '' then return jsonb_build_object('ok', false, 'error', 'Número de pedido requerido'); end if;
  if v_silueta = '' then return jsonb_build_object('ok', false, 'error', 'Silueta requerida'); end if;

  perform pg_advisory_xact_lock(hashtext('staging.registrar_pedido_manual'));

  if v_tienda <> '' and p_tiendas_pyxis is not null and array_length(p_tiendas_pyxis, 1) > 0
     and not (v_tienda = any(p_tiendas_pyxis)) then
    return jsonb_build_object('ok', false, 'error',
      'El pedido ' || v_num || ' es de ' || array_to_string(p_tiendas_pyxis, ' / ') ||
      ', no de ' || v_tienda || '. Cambia la tienda en el formulario (o revisa el número).');
  end if;

  if v_num_pos = 0 then
    v_pos_ini := 0; v_pos_fin := 0;
  else
    v_pos_fin := v_pos_ini + v_num_pos - 1;
    if v_pos_ini < 1 then
      return jsonb_build_object('ok', false, 'error', 'La posición debe ser 1 o mayor — la posición 0 es solo para bultos sin soportes');
    end if;
  end if;

  v_codigo_tienda := case v_tienda
    when 'Marbella' then '014' when 'Málaga' then '036'
    when 'Granada' then '043' when 'Mijas' then '279'
    else '000'
  end;
  v_id_pedido := v_codigo_tienda || '::' || v_num;

  select * into v_existente from staging.pedidos where id = v_id_pedido for update;

  if v_num_pos > 0 then
    v_max_pos := staging._max_pos_silueta(v_silueta);
    if v_max_pos is null then return jsonb_build_object('ok', false, 'error', 'Silueta desconocida'); end if;
    if v_pos_fin > v_max_pos then
      return jsonb_build_object('ok', false, 'error', 'Se sale del rango (máx ' || v_max_pos || ')');
    end if;
    if v_flujo not in ('remansur_transporte','remansur_pro') then
      if v_existente.id is not null then
        select exists (
          select 1 from staging.ocupacion_siluetas
          where silueta = v_silueta and pos::int between v_pos_ini and v_pos_fin
            and (layer = 'back' or reservado = false) and pedido <> v_num
        ) into v_conflicto;
      else
        select exists (
          select 1 from staging.ocupacion_siluetas
          where silueta = v_silueta and pos::int between v_pos_ini and v_pos_fin
            and (layer = 'back' or reservado = false)
        ) into v_conflicto;
      end if;
      if v_conflicto then return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada'); end if;
    end if;
  end if;

  v_transportista := case v_flujo
    when 'transporte' then 'Correcaminos'
    when 'instalacion' then 'Correcaminos Inst.'
    when 'pro' then 'Correcaminos PRO'
    when 'remansur_transporte' then 'Remansur'
    when 'remansur_pro' then 'Remansur PRO'
    else v_flujo
  end;

  if v_existente.id is not null then
    v_numero_carga_anterior := v_existente.numero_carga;
    v_pos_ini_vieja := nullif(v_existente.pos_ini, '')::int;
    v_pos_fin_vieja := nullif(v_existente.pos_fin, '')::int;
    if v_existente.silueta is not null and v_existente.silueta <> '' and v_pos_ini_vieja is not null then
      begin
        perform staging._liberar_ocupacion(v_existente.silueta, v_pos_ini_vieja, v_pos_fin_vieja, v_num);
      exception when others then null;
      end;
    end if;

    update staging.pedidos set
      tienda = coalesce(nullif(v_tienda, ''), nullif(v_existente.tienda, ''), ''),
      flujo = v_flujo, transportista = v_transportista,
      estado = 'COMPLETADO_LISTO',
      silueta = v_silueta, pos_ini = v_pos_ini::text, pos_fin = v_pos_fin::text, soportes = p_soportes,
      comentario = v_comentario, numero_carga = null, intento_carga = null,
      actualizado = now()
      where id = v_id_pedido;

    if v_numero_carga_anterior is not null then
      delete from staging.cargas_pedidos
        where pedido_id = v_id_pedido
          and carga_id in (select id from staging.cargas where estado = 'GENERADA');
    end if;
  else
    insert into staging.pedidos (
      id, ped, tienda, transportista, flujo, estado, pct, operario,
      silueta, pos_ini, pos_fin, numero_carga, soportes, n_lin, n_ubic,
      comentario, actualizado
    ) values (
      v_id_pedido, v_num, v_tienda, v_transportista, v_flujo, 'COMPLETADO_LISTO', 100, 'Manual',
      v_silueta, v_pos_ini::text, v_pos_fin::text, null, p_soportes, 0, 0,
      v_comentario, now()
    );
  end if;

  if v_num_pos > 0 then
    begin
      for v_i in 0 .. v_num_pos - 1 loop
        v_pos := v_pos_ini + v_i;
        v_def := p_posiciones -> v_i;
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (v_silueta, v_pos::text, 'back', v_num, v_tienda, v_flujo, false);
        if (v_def->>'front') = 'true' then
          insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
            values (v_silueta, v_pos::text, 'front', v_num, v_tienda, v_flujo, false);
        else
          insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
            values (v_silueta, v_pos::text, 'front', v_num, v_tienda, v_flujo, true);
        end if;
      end loop;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada (reclamada por otra operación al mismo tiempo)');
    end;
  end if;

  return jsonb_build_object('ok', true, 'silueta', v_silueta, 'posIni', v_pos_ini, 'posFin', v_pos_fin);
end $$;

grant execute on function staging.registrar_pedido_manual(text, text, text, text, int, jsonb, text, jsonb, text[]) to service_role;
