create or replace function staging.corregir_soportes_pedido(
  p_num_ped text, p_nuevos_soportes jsonb, p_posiciones jsonb,
  p_nueva_silueta text default null, p_nueva_pos_ini int default null, p_tienda text default null
) returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_candidatos int;
  v_silueta_vieja text; v_pos_ini_vieja int; v_pos_fin_vieja int;
  v_tenia_hueco boolean;
  v_num_pos int;
  v_dest_silueta text; v_dest_pos_ini int; v_mismo_sitio boolean;
  v_compartido boolean;
  v_filas_viejas jsonb;
  v_max_pos int; v_pos_fin_nueva int;
  v_i int; v_pos int; v_def jsonb; v_conflicto boolean;
begin
  if p_tienda is not null then
    select * into v_pedido from staging.pedidos where ped = p_num_ped and tienda = p_tienda and silueta is not null for update;
    if not found then
      select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
      return jsonb_build_object('ok', false, 'error',
        case when v_candidatos > 0 then 'Este pedido no coincide con la tienda esperada — refresca e inténtalo de nuevo'
        else 'Pedido no encontrado en silueta' end);
    end if;
  else
    select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
    if v_candidatos > 1 then
      return jsonb_build_object('ok', false, 'error', 'Hay varios pedidos con este número en tiendas distintas — ábrelo desde Buscar para identificar la tienda correcta');
    end if;
    select * into v_pedido from staging.pedidos where ped = p_num_ped and silueta is not null for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado en silueta'); end if;
  end if;

  if v_pedido.silueta in ('Recogidas', 'Ya Cargados') then
    return jsonb_build_object('ok', false, 'error', 'Este pedido está en "' || v_pedido.silueta || '" (silueta ficticia, sin posiciones reales) — no hay soportes que corregir');
  end if;

  v_silueta_vieja := v_pedido.silueta;
  v_pos_ini_vieja := nullif(v_pedido.pos_ini, '')::int;
  v_pos_fin_vieja := nullif(v_pedido.pos_fin, '')::int;
  v_tenia_hueco := v_pos_ini_vieja is not null and v_pos_ini_vieja <> 0;
  v_num_pos := jsonb_array_length(p_posiciones);
  v_dest_silueta := coalesce(p_nueva_silueta, v_silueta_vieja);
  v_dest_pos_ini := coalesce(p_nueva_pos_ini, v_pos_ini_vieja, 0);
  v_mismo_sitio := v_tenia_hueco and v_dest_silueta = v_silueta_vieja and v_dest_pos_ini = v_pos_ini_vieja;

  if v_num_pos = 0 then
    if v_tenia_hueco then perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped); end if;
    update staging.pedidos set soportes = p_nuevos_soportes, silueta = v_dest_silueta, pos_ini = '0', pos_fin = '0', actualizado = now() where id = v_pedido.id;
    return jsonb_build_object('ok', true, 'silueta', v_dest_silueta, 'pos_ini', 0, 'pos_fin', 0);
  end if;

  -- REMANSUR compartir delante -- SOLO si el destino NO es el mismo sitio que el pedido
  -- ya ocupa (si no, compartiría consigo mismo -- bug real ya corregido en el original).
  if not v_mismo_sitio and v_num_pos = 1 and (p_posiciones->0->>'front') = 'reservado'
     and v_pedido.flujo in ('remansur_transporte','remansur_pro') then
    v_compartido := staging.compartir_frente_remansur(v_dest_silueta, v_dest_pos_ini, v_pedido.ped, v_pedido.tienda, v_pedido.flujo);
    if v_compartido then
      if v_tenia_hueco then perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped); end if;
      update staging.pedidos set soportes = p_nuevos_soportes, silueta = v_dest_silueta, pos_ini = v_dest_pos_ini::text, pos_fin = v_dest_pos_ini::text, actualizado = now() where id = v_pedido.id;
      return jsonb_build_object('ok', true, 'silueta', v_dest_silueta, 'pos_ini', v_dest_pos_ini, 'pos_fin', v_dest_pos_ini, 'compartido', true);
    end if;
  end if;

  -- Capturar filas REALES (no reconstrucción teórica) para poder deshacer si el destino no cabe
  v_filas_viejas := '[]'::jsonb;
  if v_tenia_hueco then
    select coalesce(jsonb_agg(jsonb_build_object(
        'silueta', silueta, 'pos', pos, 'layer', layer, 'pedido', pedido,
        'tienda', tienda, 'flujo', flujo, 'reservado', reservado
      )), '[]'::jsonb)
      into v_filas_viejas
      from staging.ocupacion_siluetas
      where silueta = v_silueta_vieja and pos::int between v_pos_ini_vieja and v_pos_fin_vieja and pedido = v_pedido.ped;
    perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped);
  end if;

  v_pos_fin_nueva := v_dest_pos_ini + v_num_pos - 1;
  v_max_pos := staging._max_pos_silueta(v_dest_silueta);
  v_conflicto := (v_max_pos is null) or (v_pos_fin_nueva > v_max_pos);
  if not v_conflicto and v_pedido.flujo not in ('remansur_transporte','remansur_pro') then
    select exists (
      select 1 from staging.ocupacion_siluetas
      where silueta = v_dest_silueta and pos::int between v_dest_pos_ini and v_pos_fin_nueva
        and (layer = 'back' or reservado = false)
    ) into v_conflicto;
  end if;

  if v_conflicto then
    if jsonb_array_length(v_filas_viejas) > 0 then
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        select x->>'silueta', x->>'pos', x->>'layer', x->>'pedido', x->>'tienda', x->>'flujo', (x->>'reservado')::boolean
        from jsonb_array_elements(v_filas_viejas) x
        on conflict (silueta, pos, layer) do nothing;
    end if;
    return jsonb_build_object('ok', false, 'error', 'Posición ' || v_dest_pos_ini || ' ya ocupada');
  end if;

  begin
    for v_i in 0 .. v_num_pos - 1 loop
      v_pos := v_dest_pos_ini + v_i;
      v_def := p_posiciones -> v_i;
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        values (v_dest_silueta, v_pos::text, 'back', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      if (v_def->>'front') = 'true' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (v_dest_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      elsif (v_def->>'front') = 'reservado' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (v_dest_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, true);
      end if;
    end loop;
  exception when unique_violation then
    if jsonb_array_length(v_filas_viejas) > 0 then
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        select x->>'silueta', x->>'pos', x->>'layer', x->>'pedido', x->>'tienda', x->>'flujo', (x->>'reservado')::boolean
        from jsonb_array_elements(v_filas_viejas) x
        on conflict (silueta, pos, layer) do nothing;
    end if;
    return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada (reclamada por otra operación al mismo tiempo)');
  end;

  update staging.pedidos set soportes = p_nuevos_soportes, silueta = v_dest_silueta, pos_ini = v_dest_pos_ini::text, pos_fin = v_pos_fin_nueva::text, actualizado = now() where id = v_pedido.id;
  return jsonb_build_object('ok', true, 'silueta', v_dest_silueta, 'pos_ini', v_dest_pos_ini, 'pos_fin', v_pos_fin_nueva);
end $$;
