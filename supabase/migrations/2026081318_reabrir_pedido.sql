create or replace function staging.reabrir_pedido(p_num_ped text, p_tienda text default null)
returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_candidatos int;
  v_n_lineas int;
begin
  if p_tienda is not null then
    select * into v_pedido from staging.pedidos
      where ped = p_num_ped and tienda = p_tienda
      for update;
    if not found then
      select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped;
      return jsonb_build_object('ok', false, 'error',
        case when v_candidatos > 0 then 'Este pedido no coincide con la tienda esperada — refresca y vuelve a intentarlo'
        else 'Pedido no encontrado' end);
    end if;
  else
    select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped;
    if v_candidatos > 1 then
      return jsonb_build_object('ok', false, 'error', 'Hay varios pedidos con este número en tiendas distintas — ábrelo desde 🔍 Buscar para identificar la tienda correcta');
    end if;
    select * into v_pedido from staging.pedidos where ped = p_num_ped order by id limit 1 for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado'); end if;
  end if;

  if not (coalesce(v_pedido.estado, '') = any(array['ENTREGADO','DEVUELTO_ALMACEN','ENVIADO_TIENDA','SALIDA_MANUAL','CERRADO_SIN_SILUETA'])) then
    return jsonb_build_object('ok', false, 'error', 'Este pedido no está en un estado que se pueda reabrir (sigue activo en el sistema)');
  end if;

  update staging.pedidos set
    estado = 'PENDIENTE', pct = 0, operario = null,
    silueta = null, pos_ini = null, pos_fin = null, numero_carga = null,
    soportes = '[]'::jsonb, intento_carga = null, comentario = null,
    actualizado = now()
    where id = v_pedido.id;

  delete from staging.cargas_pedidos
    where pedido_id = v_pedido.id
      and carga_id in (select id from staging.cargas where estado = 'GENERADA');

  update staging.lineas_preparacion set
    estado = 'PENDIENTE', motivo = null, operario = null, ts = null, muelle_hecho = null
    where id_pedido = v_pedido.id;
  get diagnostics v_n_lineas = row_count;

  begin
    insert into staging.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
      values (
        v_pedido.id || '::' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text,
        v_pedido.id, v_pedido.ped, v_pedido.tienda, v_pedido.transportista, v_pedido.flujo, 'REABIERTO', now()
      );
  exception when others then
    null;
  end;

  return jsonb_build_object('ok', true, 'nLineas', v_n_lineas);
end $$;

grant execute on function staging.reabrir_pedido(text, text) to service_role;
