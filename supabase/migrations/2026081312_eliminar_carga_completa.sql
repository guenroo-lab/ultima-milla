create or replace function staging.eliminar_carga_completa(p_id_carga text)
returns jsonb language plpgsql as $$
declare
  v_carga staging.cargas%rowtype;
  v_liberados int;
begin
  select * into v_carga from staging.cargas where id = p_id_carga for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Carga no encontrada'); end if;
  if v_carga.estado is distinct from 'GENERADA' then
    return jsonb_build_object('ok', false, 'error', 'Esta carga ya está cerrada, no se puede eliminar');
  end if;

  update staging.cargas set estado = 'ELIMINADA' where id = p_id_carga;

  -- NULL, no '' -- misma convención que quitar_pedido_de_carga.
  -- NO se borran las filas de cargas_pedidos: quedan como registro histórico
  -- de qué pedidos iban en esta carga eliminada (igual que la fila de CARGAS
  -- se marca ELIMINADA en vez de borrarse -- ver nota completa en el spec).
  update staging.pedidos set numero_carga = null
    where id in (select pedido_id from staging.cargas_pedidos where carga_id = p_id_carga);
  get diagnostics v_liberados = row_count;

  return jsonb_build_object('ok', true, 'numCarga',
    case when v_carga.num_carga ~ '^[0-9]+$' then v_carga.num_carga::int else null end,
    'pedidosLiberados', v_liberados);
end $$;
