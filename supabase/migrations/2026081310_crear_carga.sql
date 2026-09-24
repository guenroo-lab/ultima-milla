create or replace function staging.crear_carga(p_numeros_pedido text[], p_responsable text default '')
returns jsonb language plpgsql as $$
declare
  v_numeros text[];
  v_max_num int;
  v_num_carga int;
  v_carga_id text;
  v_encontrados jsonb := '[]'::jsonb;
  v_no_encontrados text[] := '{}';
  v_num text;
  v_ped staging.pedidos%rowtype;
  v_idx int;
  v_fecha date := current_date;
begin
  -- Serializa TODAS las llamadas a crear_carga entre sí -- mismo efecto que
  -- el LockService.getScriptLock() global del original, evita la carrera de
  -- numCarga de raíz en vez de detectarla después con ON CONFLICT.
  perform pg_advisory_xact_lock(hashtext('staging.crear_carga'));

  select array_agg(x order by ord desc) into v_numeros
    from unnest(p_numeros_pedido) with ordinality as t(x, ord)
    where trim(x) <> '';

  if v_numeros is null then
    return jsonb_build_object('ok', false, 'error', 'Ningún pedido encontrado en silueta', 'noEncontrados', '[]'::jsonb);
  end if;

  foreach v_num in array v_numeros loop
    select * into v_ped from staging.pedidos
      where ped = trim(v_num) and silueta is not null and silueta <> ''
        and coalesce(estado, '') <> 'ENTREGADO'
      order by id limit 1;
    if found then
      v_encontrados := v_encontrados || jsonb_build_object(
        'idPedido', v_ped.id, 'ped', v_ped.ped, 'tienda', v_ped.tienda,
        'transportista', v_ped.transportista, 'flujo', v_ped.flujo,
        'silueta', v_ped.silueta, 'posIni', v_ped.pos_ini::numeric, 'posFin', v_ped.pos_fin::numeric,
        'soportes', coalesce(v_ped.soportes, '[]'::jsonb), 'estado', 'PENDIENTE'
      );
    else
      v_no_encontrados := array_append(v_no_encontrados, trim(v_num));
    end if;
  end loop;

  if jsonb_array_length(v_encontrados) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Ningún pedido encontrado en silueta', 'noEncontrados', to_jsonb(v_no_encontrados));
  end if;

  select coalesce(max(num_carga::int), 0) into v_max_num from staging.cargas where num_carga ~ '^[0-9]+$';
  v_num_carga := v_max_num + 1;
  v_carga_id := 'CARGA_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

  -- Añadir numeroCarga a cada item, ahora que existe v_num_carga.
  select coalesce(jsonb_agg(elem || jsonb_build_object('numeroCarga', v_num_carga)), '[]'::jsonb)
    into v_encontrados
    from jsonb_array_elements(v_encontrados) elem;

  insert into staging.cargas (id, num_carga, fecha, estado, responsable)
    values (v_carga_id, v_num_carga::text, v_fecha, 'GENERADA', coalesce(p_responsable, ''));

  for v_idx in 0 .. jsonb_array_length(v_encontrados) - 1 loop
    insert into staging.cargas_pedidos (carga_id, pedido_id, posicion)
      values (v_carga_id, v_encontrados->v_idx->>'idPedido', v_idx)
      on conflict (carga_id, pedido_id) do nothing;
    update staging.pedidos set numero_carga = v_num_carga::text where id = v_encontrados->v_idx->>'idPedido';
  end loop;

  return jsonb_build_object('ok', true, 'carga', jsonb_build_object(
    'id', v_carga_id, 'numCarga', v_num_carga, 'fecha', v_fecha, 'estado', 'GENERADA',
    'responsable', coalesce(p_responsable, ''), 'items', v_encontrados
  ), 'noEncontrados', to_jsonb(v_no_encontrados));
end $$;
