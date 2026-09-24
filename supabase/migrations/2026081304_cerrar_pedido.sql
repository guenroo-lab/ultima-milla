create or replace function staging.cerrar_pedido(
  p_id_pedido text, p_silueta text, p_pos_ini int,
  p_posiciones jsonb, p_soportes jsonb, p_operario text
) returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_num_pos int := jsonb_array_length(p_posiciones);
  v_pos_fin int;
  v_compartido boolean;
  v_max_pos int;
  v_i int; v_pos int; v_def jsonb;
  v_conflicto boolean;
begin
  select * into v_pedido from staging.pedidos where id = p_id_pedido for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado'); end if;

  if v_num_pos = 0 then
    update staging.pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini='0', pos_fin='0',
      soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
      where id = p_id_pedido;
    return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', 0, 'pos_fin', 0);
  end if;

  if v_num_pos = 1 and (p_posiciones->0->>'front') = 'reservado'
     and v_pedido.flujo in ('remansur_transporte','remansur_pro') then
    v_compartido := staging.compartir_frente_remansur(p_silueta, p_pos_ini, v_pedido.ped, v_pedido.tienda, v_pedido.flujo);
    if v_compartido then
      update staging.pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini=p_pos_ini::text, pos_fin=p_pos_ini::text,
        soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
        where id = p_id_pedido;
      return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', p_pos_ini, 'pos_fin', p_pos_ini, 'compartido', true);
    end if;
  end if;

  v_pos_fin := p_pos_ini + v_num_pos - 1;
  v_max_pos := staging._max_pos_silueta(p_silueta);
  if v_max_pos is null then return jsonb_build_object('ok', false, 'error', 'Silueta desconocida'); end if;
  if v_pos_fin > v_max_pos then
    return jsonb_build_object('ok', false, 'error', 'Se sale del rango (máx ' || v_max_pos || ')');
  end if;

  if v_pedido.flujo not in ('remansur_transporte','remansur_pro') then
    select exists (
      select 1 from staging.ocupacion_siluetas
      where silueta = p_silueta and pos::int between p_pos_ini and v_pos_fin
        and (layer = 'back' or reservado = false)
    ) into v_conflicto;
    if v_conflicto then return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada'); end if;
  end if;

  begin
    for v_i in 0 .. v_num_pos - 1 loop
      v_pos := p_pos_ini + v_i;
      v_def := p_posiciones -> v_i;
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        values (p_silueta, v_pos::text, 'back', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      if (v_def->>'front') = 'true' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (p_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      elsif (v_def->>'front') = 'reservado' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (p_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, true);
      end if;
    end loop;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error',
      case when v_pedido.flujo in ('remansur_transporte','remansur_pro')
        then 'Esa posición ya tiene una fila física de otro pedido en la misma capa -- Remansur puede colocarse libremente pero no puede solapar sobre un hueco YA ocupado en la misma capa (back/front); revisa el mapa antes de reintentar'
        else 'Posición ya ocupada (reclamada por otra operación al mismo tiempo)'
      end);
  end;

  update staging.pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini=p_pos_ini::text, pos_fin=v_pos_fin::text,
    soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
    where id = p_id_pedido;

  return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', p_pos_ini, 'pos_fin', v_pos_fin);
end $$;
