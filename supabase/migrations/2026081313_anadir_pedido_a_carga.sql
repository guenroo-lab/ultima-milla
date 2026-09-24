create or replace function staging.anadir_pedido_a_carga(p_id_carga text, p_num_ped text)
returns jsonb language plpgsql as $$
declare
  v_carga staging.cargas%rowtype;
  v_pedido staging.pedidos%rowtype;
  v_posicion int;
  v_total int;
begin
  select * into v_carga from staging.cargas where id = p_id_carga for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Carga no encontrada'); end if;
  if v_carga.estado is distinct from 'GENERADA' then
    return jsonb_build_object('ok', false, 'error', 'Esta carga ya está cerrada, no se puede modificar');
  end if;

  if exists (select 1 from staging.cargas_pedidos cp join staging.pedidos p on p.id = cp.pedido_id
             where cp.carga_id = p_id_carga and p.ped = p_num_ped) then
    return jsonb_build_object('ok', false, 'error', 'Ese pedido ya está en esta carga');
  end if;

  -- FOR UPDATE bloquea la fila candidata: si dos altas concurrentes apuntan
  -- al MISMO pedido en DOS cargas GENERADA distintas, la segunda espera a que
  -- la primera confirme su INSERT en cargas_pedidos, y su propio NOT EXISTS
  -- se reevalúa contra el estado YA actualizado al desbloquear (semántica
  -- estándar de FOR UPDATE bajo READ COMMITTED) -- sin esto, dos altas
  -- concurrentes podían meter el mismo pedido en dos cargas a la vez, algo
  -- que el candado global del original impedía (verificado con prueba real).
  select p1.* into v_pedido from staging.pedidos p1
    where p1.ped = p_num_ped and p1.silueta is not null and p1.silueta <> ''
      and coalesce(p1.estado, '') <> 'ENTREGADO'
      and not exists (
        select 1 from staging.cargas_pedidos cp2 join staging.cargas c2 on c2.id = cp2.carga_id
        where cp2.pedido_id = p1.id and c2.estado = 'GENERADA'
      )
    order by p1.id
    limit 1
    for update of p1;

  if not found then
    select p2.* into v_pedido from staging.pedidos p2 where p2.ped = p_num_ped order by p2.id limit 1;
    if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado'); end if;
    if v_pedido.silueta is null or v_pedido.silueta = '' then return jsonb_build_object('ok', false, 'error', 'Este pedido no está en ninguna silueta'); end if;
    if v_pedido.estado = 'ENTREGADO' then return jsonb_build_object('ok', false, 'error', 'Este pedido ya está entregado'); end if;
    return jsonb_build_object('ok', false, 'error', 'Este pedido ya está incluido en otra carga activa');
  end if;

  -- total se calcula con count(*) real, NUNCA max(posicion)+1: liberar_pedido_de_silueta
  -- (Lote 1) ya borra filas de cargas_pedidos de cargas GENERADA, dejando huecos
  -- reales en posicion -- verificado con una prueba explícita contra staging.
  select coalesce(max(posicion), -1) + 1 into v_posicion from staging.cargas_pedidos where carga_id = p_id_carga;
  insert into staging.cargas_pedidos (carga_id, pedido_id, posicion) values (p_id_carga, v_pedido.id, v_posicion);
  update staging.pedidos set numero_carga =
    case when v_carga.num_carga ~ '^[0-9]+$' then v_carga.num_carga::int::text else v_carga.num_carga end
    where id = v_pedido.id;

  select count(*) into v_total from staging.cargas_pedidos where carga_id = p_id_carga;
  return jsonb_build_object('ok', true, 'ped', p_num_ped, 'numCarga',
    case when v_carga.num_carga ~ '^[0-9]+$' then v_carga.num_carga::int else null end,
    'total', v_total);
end $$;
