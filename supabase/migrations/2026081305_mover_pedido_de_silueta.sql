create or replace function staging.mover_pedido_de_silueta(
  p_num_ped text, p_nueva_silueta text, p_nueva_pos_ini int, p_posiciones jsonb, p_tienda text default null
) returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_candidatos int;
  v_silueta_vieja text; v_pos_ini_vieja int; v_pos_fin_vieja int;
  v_num_pos int; v_compartido boolean; v_max_pos int; v_pos_fin_nueva int;
  v_i int; v_pos int; v_def jsonb; v_conflicto boolean;
begin
  if p_tienda is not null then
    select * into v_pedido from staging.pedidos where ped = p_num_ped and tienda = p_tienda and silueta is not null for update;
    if not found then
      select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
      return jsonb_build_object('ok', false, 'error',
        case when v_candidatos > 0 then 'Este pedido no coincide con la tienda esperada — refresca el mapa e inténtalo de nuevo'
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

  v_silueta_vieja := v_pedido.silueta;
  v_pos_ini_vieja := nullif(v_pedido.pos_ini, '')::int;
  v_pos_fin_vieja := nullif(v_pedido.pos_fin, '')::int;
  v_num_pos := jsonb_array_length(p_posiciones);

  if v_num_pos = 0 then
    update staging.pedidos set silueta = p_nueva_silueta, pos_ini = '0', pos_fin = '0', actualizado = now() where id = v_pedido.id;
    return jsonb_build_object('ok', true, 'silueta', p_nueva_silueta, 'pos_ini', 0, 'pos_fin', 0);
  end if;

  if v_silueta_vieja = p_nueva_silueta and v_pos_ini_vieja = p_nueva_pos_ini then
    return jsonb_build_object('ok', true, 'silueta', p_nueva_silueta, 'pos_ini', p_nueva_pos_ini,
      'pos_fin', p_nueva_pos_ini + v_num_pos - 1, 'sin_cambios', true);
  end if;

  if v_num_pos = 1 and (p_posiciones->0->>'front') = 'reservado' and v_pedido.flujo in ('remansur_transporte','remansur_pro') then
    v_compartido := staging.compartir_frente_remansur(p_nueva_silueta, p_nueva_pos_ini, v_pedido.ped, v_pedido.tienda, v_pedido.flujo);
    if v_compartido then
      if v_pos_ini_vieja is not null then perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped); end if;
      update staging.pedidos set silueta = p_nueva_silueta, pos_ini = p_nueva_pos_ini::text, pos_fin = p_nueva_pos_ini::text, actualizado = now() where id = v_pedido.id;
      return jsonb_build_object('ok', true, 'silueta', p_nueva_silueta, 'pos_ini', p_nueva_pos_ini, 'pos_fin', p_nueva_pos_ini, 'compartido', true);
    end if;
  end if;

  v_pos_fin_nueva := p_nueva_pos_ini + v_num_pos - 1;
  v_max_pos := staging._max_pos_silueta(p_nueva_silueta);
  if v_max_pos is null then return jsonb_build_object('ok', false, 'error', 'Silueta desconocida'); end if;
  if v_pos_fin_nueva > v_max_pos then
    return jsonb_build_object('ok', false, 'error', 'Se sale del rango (máx ' || v_max_pos || ')');
  end if;

  if v_pedido.flujo not in ('remansur_transporte','remansur_pro') then
    select exists (
      select 1 from staging.ocupacion_siluetas
      where silueta = p_nueva_silueta and pos::int between p_nueva_pos_ini and v_pos_fin_nueva
        and (layer = 'back' or reservado = false) and pedido <> v_pedido.ped
    ) into v_conflicto;
    if v_conflicto then
      return jsonb_build_object('ok', false, 'error', 'Posición ' || p_nueva_pos_ini || ' ya ocupada');
    end if;
  end if;

  if v_pos_ini_vieja is not null then perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped); end if;

  begin
    for v_i in 0 .. v_num_pos - 1 loop
      v_pos := p_nueva_pos_ini + v_i;
      v_def := p_posiciones -> v_i;
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        values (p_nueva_silueta, v_pos::text, 'back', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      if (v_def->>'front') = 'true' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (p_nueva_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      elsif (v_def->>'front') = 'reservado' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (p_nueva_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, true);
      end if;
    end loop;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error',
      case when v_pedido.flujo in ('remansur_transporte','remansur_pro')
        then 'Esa posición ya tiene una fila física de otro pedido en la misma capa -- el pedido quedó SIN silueta, hay que elegir otro destino'
        else 'Posición ya ocupada (reclamada por otra operación al mismo tiempo) -- el pedido quedó SIN silueta, hay que reintentar'
      end);
  end;

  update staging.pedidos set silueta = p_nueva_silueta, pos_ini = p_nueva_pos_ini::text, pos_fin = v_pos_fin_nueva::text, actualizado = now() where id = v_pedido.id;
  return jsonb_build_object('ok', true, 'silueta', p_nueva_silueta, 'pos_ini', p_nueva_pos_ini, 'pos_fin', v_pos_fin_nueva);
end $$;
