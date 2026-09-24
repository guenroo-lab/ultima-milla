create or replace function staging.borrar_pedido_no_sacado(p_num_ped text)
returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_n_lineas int;
begin
  select * into v_pedido from staging.pedidos
    where ped = p_num_ped
    order by id
    limit 1
    for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;

  if v_pedido.silueta is not null then
    return jsonb_build_object('ok', false, 'error',
      'Este pedido ya está en la silueta ' || v_pedido.silueta || '. Libéralo antes desde la Pantalla de administración.');
  end if;

  if exists (
    select 1 from staging.lineas_preparacion
    where id_pedido = v_pedido.id
      and estado is distinct from 'PENDIENTE'
  ) then
    return jsonb_build_object('ok', false, 'error',
      'Un operario ya ha empezado a preparar este pedido (ya tiene ubicaciones marcadas). Solo se puede borrar un pedido que nadie ha tocado todavía.');
  end if;

  with borradas as (
    delete from staging.lineas_preparacion
    where id_pedido = v_pedido.id
    returning 1
  )
  select count(*) into v_n_lineas from borradas;

  delete from staging.pedidos where id = v_pedido.id;

  return jsonb_build_object('ok', true, 'lineasBorradas', v_n_lineas);
end $$;

grant execute on function staging.borrar_pedido_no_sacado(text) to service_role;
