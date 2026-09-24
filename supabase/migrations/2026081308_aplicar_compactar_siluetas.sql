create or replace function staging.aplicar_compactar_siluetas(p_movimientos jsonb) returns jsonb language plpgsql as $$
declare
  v_omitidos text[] := '{}';
  v_aplicados jsonb := '[]'::jsonb;
  v_mov jsonb;
  v_ped record;
  v_origen_real boolean;
  v_idx int := 0;
begin
  if p_movimientos is null or jsonb_array_length(p_movimientos) = 0 then
    return jsonb_build_object('ok', true, 'aplicados', 0, 'movimientos', '[]'::jsonb, 'omitidos', '[]'::jsonb);
  end if;

  create temporary table _cs_validos (
    idx int, ped text, tienda text, flujo text,
    silueta_vieja text, pos_ini_vieja int, pos_fin_vieja int,
    silueta_nueva text, pos_ini_nueva int, pos_fin_nueva int,
    posiciones jsonb, pedido_id text
  ) on commit drop;

  -- Fase A: validar el ORIGEN de cada movimiento contra el estado real actual
  for v_mov in select * from jsonb_array_elements(p_movimientos)
  loop
    select id, silueta, nullif(pos_ini,'')::int as pos_ini into v_ped from staging.pedidos where ped = (v_mov->>'ped');
    if not found then
      v_omitidos := array_append(v_omitidos, (v_mov->>'ped') || ' (el pedido ya no existe)');
      continue;
    end if;
    if v_ped.silueta is distinct from (v_mov->>'siluetaVieja')
       or coalesce(v_ped.pos_ini, -1) is distinct from (v_mov->>'posIniVieja')::int then
      v_omitidos := array_append(v_omitidos, (v_mov->>'ped') || ' (cambió de posición mientras tanto)');
      continue;
    end if;
    if (v_mov->>'posIniVieja')::int > 0 then
      select exists (
        select 1 from staging.ocupacion_siluetas
        where silueta = (v_mov->>'siluetaVieja') and pedido = (v_mov->>'ped')
          and pos::int between (v_mov->>'posIniVieja')::int and (v_mov->>'posFinVieja')::int
      ) into v_origen_real;
      if not v_origen_real then
        v_omitidos := array_append(v_omitidos, (v_mov->>'ped') || ' (PEDIDOS decía ' || (v_mov->>'siluetaVieja') ||
          (v_mov->>'posIniVieja') || ' pero el mapa físico no tiene ninguna fila ahí -- no se mueve, para no duplicarlo; revisar a mano)');
        continue;
      end if;
    end if;
    insert into _cs_validos values (
      v_idx, v_mov->>'ped', v_mov->>'tienda', v_mov->>'flujo',
      v_mov->>'siluetaVieja', (v_mov->>'posIniVieja')::int, (v_mov->>'posFinVieja')::int,
      v_mov->>'siluetaNueva', (v_mov->>'posIniNueva')::int, (v_mov->>'posFinNueva')::int,
      coalesce(v_mov->'posiciones', '[]'::jsonb), v_ped.id
    );
    v_idx := v_idx + 1;
  end loop;

  -- Fase B: mapa virtual de ocupación EN VIVO, liberando los orígenes de TODOS los válidos de golpe
  create temporary table _cs_ocupado (silueta text, pos int, primary key (silueta, pos)) on commit drop;
  insert into _cs_ocupado select silueta, pos::int from staging.ocupacion_siluetas on conflict do nothing;
  delete from _cs_ocupado o using _cs_validos v
    where v.pos_ini_vieja > 0 and o.silueta = v.silueta_vieja and o.pos between v.pos_ini_vieja and v.pos_fin_vieja;

  create temporary table _cs_aplicar (
    ped text, pedido_id text, tienda text, silueta_vieja text, pos_ini_vieja int, pos_fin_vieja int,
    silueta_nueva text, pos_ini_nueva int, pos_fin_nueva int, posiciones jsonb, flujo text
  ) on commit drop;

  for v_ped in select * from _cs_validos order by idx
  loop
    if v_ped.pos_ini_nueva = 0 then
      insert into _cs_aplicar values (v_ped.ped, v_ped.pedido_id, v_ped.tienda, v_ped.silueta_vieja, v_ped.pos_ini_vieja, v_ped.pos_fin_vieja,
        v_ped.silueta_nueva, 0, 0, '[]'::jsonb, v_ped.flujo);
      continue;
    end if;
    if exists (
      select 1 from generate_series(v_ped.pos_ini_nueva, v_ped.pos_fin_nueva) p
      where exists (select 1 from _cs_ocupado o where o.silueta = v_ped.silueta_nueva and o.pos = p)
    ) then
      v_omitidos := array_append(v_omitidos, v_ped.ped || ' (el destino ' || v_ped.silueta_nueva || v_ped.pos_ini_nueva || ' ya no estaba libre)');
      continue;
    end if;
    insert into _cs_ocupado select v_ped.silueta_nueva, p from generate_series(v_ped.pos_ini_nueva, v_ped.pos_fin_nueva) p on conflict do nothing;
    insert into _cs_aplicar values (v_ped.ped, v_ped.pedido_id, v_ped.tienda, v_ped.silueta_vieja, v_ped.pos_ini_vieja, v_ped.pos_fin_vieja,
      v_ped.silueta_nueva, v_ped.pos_ini_nueva, v_ped.pos_fin_nueva, v_ped.posiciones, v_ped.flujo);
  end loop;

  -- Fase C: aplicar de verdad -- primero liberar TODO lo viejo, luego crear TODO lo nuevo
  for v_ped in select * from _cs_aplicar where pos_ini_vieja > 0
  loop
    perform staging._liberar_ocupacion(v_ped.silueta_vieja, v_ped.pos_ini_vieja, v_ped.pos_fin_vieja, v_ped.ped);
  end loop;

  for v_ped in select * from _cs_aplicar
  loop
    if v_ped.pos_ini_nueva > 0 then
      declare
        v_i int; v_pos int; v_def jsonb; v_num_pos int := jsonb_array_length(v_ped.posiciones);
      begin
        for v_i in 0 .. v_num_pos - 1 loop
          v_pos := v_ped.pos_ini_nueva + v_i;
          v_def := v_ped.posiciones -> v_i;
          insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
            values (v_ped.silueta_nueva, v_pos::text, 'back', v_ped.ped, v_ped.tienda, v_ped.flujo, false);
          if (v_def->>'front') = 'true' then
            insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
              values (v_ped.silueta_nueva, v_pos::text, 'front', v_ped.ped, v_ped.tienda, v_ped.flujo, false);
          elsif (v_def->>'front') = 'reservado' then
            insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
              values (v_ped.silueta_nueva, v_pos::text, 'front', v_ped.ped, v_ped.tienda, v_ped.flujo, true);
          end if;
        end loop;
      end;
    end if;
    update staging.pedidos set silueta = v_ped.silueta_nueva, pos_ini = v_ped.pos_ini_nueva::text, pos_fin = v_ped.pos_fin_nueva::text, actualizado = now()
      where id = v_ped.pedido_id;
    v_aplicados := v_aplicados || jsonb_build_object('ped', v_ped.ped, 'siluetaNueva', v_ped.silueta_nueva, 'posIniNueva', v_ped.pos_ini_nueva, 'posFinNueva', v_ped.pos_fin_nueva);
  end loop;

  return jsonb_build_object('ok', true, 'aplicados', jsonb_array_length(v_aplicados), 'movimientos', v_aplicados, 'omitidos', to_jsonb(v_omitidos));
end $$;
