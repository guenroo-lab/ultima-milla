create or replace function staging.liberar_pedido_de_silueta(
  p_num_ped text, p_disposicion text, p_motivo text default null, p_tienda text default null
) returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_candidatos int;
  v_estado_nuevo text;
  v_pos_ini int; v_pos_fin int;
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
      return jsonb_build_object('ok', false, 'error', 'Hay varios pedidos con este número en tiendas distintas — ábrelo desde 🔍 Buscar para identificar la tienda correcta');
    end if;
    select * into v_pedido from staging.pedidos where ped = p_num_ped and silueta is not null for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado en silueta'); end if;
  end if;

  v_pos_ini := nullif(v_pedido.pos_ini, '')::int;
  v_pos_fin := nullif(v_pedido.pos_fin, '')::int;
  if v_pos_ini is not null then
    perform staging._liberar_ocupacion(v_pedido.silueta, v_pos_ini, v_pos_fin, v_pedido.ped);
  end if;

  v_estado_nuevo := case p_disposicion
    when 'almacen' then 'DEVUELTO_ALMACEN'
    when 'tienda' then 'ENVIADO_TIENDA'
    when 'desmarcar' then 'COMPLETADO_LISTO'
    else 'SALIDA_MANUAL'
  end;

  -- Quita el pedido de su carga activa si tenía (mismo criterio que
  -- _quitarPedidoDeSuCargaActiva: solo si la carga sigue GENERADA -- si ya
  -- está CERRADA, su membresía se conserva como registro histórico).
  delete from staging.cargas_pedidos
    where pedido_id = v_pedido.id
      and carga_id in (select id from staging.cargas where estado = 'GENERADA');

  update staging.pedidos set estado = v_estado_nuevo, silueta = null, pos_ini = null, pos_fin = null, numero_carga = null, actualizado = now()
    where id = v_pedido.id;

  return jsonb_build_object('ok', true, 'silueta', v_pedido.silueta, 'estado', v_estado_nuevo);
end $$;
