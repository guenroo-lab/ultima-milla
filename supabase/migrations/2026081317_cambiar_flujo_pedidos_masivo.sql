create or replace function staging.cambiar_flujo_pedidos_masivo(p_numeros text[], p_nuevo_flujo text)
returns jsonb language plpgsql as $$
declare
  v_transportista text;
  v_num text;
  v_vistos text[] := '{}';
  v_no_encontrados text[] := '{}';
  v_ambiguos text[] := '{}';
  v_ids text[] := '{}';
  v_ids_grupo text[];
  v_ts timestamptz := now();
  v_cambiados int := 0;
  v_pedido record;
  v_claves text[] := '{}';
begin
  v_transportista := case p_nuevo_flujo
    when 'transporte'          then 'Correcaminos'
    when 'instalacion'         then 'Correcaminos Instalaciones'
    when 'pro'                 then 'Correcaminos PRO'
    when 'remansur_transporte' then 'Remansur'
    when 'remansur_pro'        then 'Remansur PRO'
    when 'grua_remansur'       then 'GruaRemansur'
    else null
  end;
  if v_transportista is null then
    return jsonb_build_object('ok', false, 'error', 'Tipo de transporte no válido');
  end if;

  foreach v_num in array coalesce(p_numeros, '{}'::text[]) loop
    v_num := trim(v_num);
    continue when v_num is null or v_num = '';
    continue when v_num = any(v_vistos);
    v_vistos := array_append(v_vistos, v_num);

    select array_agg(id order by id) into v_ids_grupo from staging.pedidos where ped = v_num;
    if v_ids_grupo is null then
      v_no_encontrados := array_append(v_no_encontrados, v_num);
    elsif array_length(v_ids_grupo, 1) > 1 then
      v_ambiguos := array_append(v_ambiguos, v_num);
    else
      v_ids := array_append(v_ids, v_ids_grupo[1]);
    end if;
  end loop;

  if array_length(v_vistos, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'Sin pedidos');
  end if;

  if array_length(v_ids, 1) is null then
    return jsonb_build_object('ok', true, 'cambiados', 0,
      'noEncontrados', to_jsonb(v_no_encontrados), 'ambiguos', to_jsonb(v_ambiguos));
  end if;

  for v_pedido in
    select * from staging.pedidos where id = any(v_ids) order by id for update
  loop
    update staging.pedidos
      set flujo = p_nuevo_flujo, transportista = v_transportista, actualizado = v_ts
      where id = v_pedido.id;

    if v_pedido.silueta is not null and v_pedido.silueta <> '' then
      v_claves := array_append(v_claves, v_pedido.ped || '|' || v_pedido.tienda);
    end if;

    if v_pedido.flujo is distinct from p_nuevo_flujo then
      begin
        insert into staging.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
        values (
          v_pedido.id || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text,
          v_pedido.id, v_pedido.ped, nullif(v_pedido.tienda, ''), v_transportista, p_nuevo_flujo, 'CAMBIO_MANUAL', v_ts
        );
      exception when others then
        null;
      end;
    end if;

    v_cambiados := v_cambiados + 1;
  end loop;

  if array_length(v_claves, 1) is not null then
    update staging.ocupacion_siluetas o
      set flujo = p_nuevo_flujo
      where (o.pedido || '|' || o.tienda) = any(v_claves);
  end if;

  return jsonb_build_object('ok', true, 'cambiados', v_cambiados,
    'noEncontrados', to_jsonb(v_no_encontrados), 'ambiguos', to_jsonb(v_ambiguos));
end $$;

grant execute on function staging.cambiar_flujo_pedidos_masivo(text[], text) to service_role;
