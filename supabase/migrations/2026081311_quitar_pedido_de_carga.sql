create or replace function staging.quitar_pedido_de_carga(p_id_carga text, p_num_ped text)
returns jsonb language plpgsql as $$
declare
  v_carga staging.cargas%rowtype;
  v_pedido_id text;
  v_quedan int;
begin
  select * into v_carga from staging.cargas where id = p_id_carga for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Carga no encontrada'); end if;
  if v_carga.estado is distinct from 'GENERADA' then
    return jsonb_build_object('ok', false, 'error', 'Esta carga ya está cerrada, no se puede modificar');
  end if;

  select cp.pedido_id into v_pedido_id
    from staging.cargas_pedidos cp join staging.pedidos p on p.id = cp.pedido_id
    where cp.carga_id = p_id_carga and p.ped = p_num_ped
    order by cp.pedido_id
    limit 1;
  if v_pedido_id is null then
    return jsonb_build_object('ok', false, 'error', 'Ese pedido no está en esta carga');
  end if;

  delete from staging.cargas_pedidos where carga_id = p_id_carga and pedido_id = v_pedido_id;
  -- NULL, no '' -- convención ya establecida y probada en Fase 1
  -- (sincronizarPedidoSupabase_) y en el Lote 1 (liberar_pedido_de_silueta):
  -- "sin carga" se representa como NULL en Postgres, nunca como texto vacío.
  update staging.pedidos set numero_carga = null where id = v_pedido_id;

  select count(*) into v_quedan from staging.cargas_pedidos where carga_id = p_id_carga;
  return jsonb_build_object('ok', true, 'ped', p_num_ped, 'numCarga',
    case when v_carga.num_carga ~ '^[0-9]+$' then v_carga.num_carga::int else null end,
    'quedan', v_quedan);
end $$;
