-- Fase 3, Lote 4 -- marcar_lineas_direccion (hot path)
-- Traduce marcarDireccion (Backend.gs:294). Marca TODAS las líneas de una
-- dirección a la vez y recalcula pct/estado del pedido en la misma operación.
--
-- CANDADO: el original usa LockService.getScriptLock() -- un candado GLOBAL
-- de todo el script -- con tryLock(15000) best-effort: si no consigue el
-- candado en 15s, sigue SIN protección (no falla). El propio comentario del
-- original dice que el motivo real es evitar que dos marcas DEL MISMO PEDIDO
-- se solapen. Postgres nos da una herramienta más precisa que la que había
-- disponible en Apps Script: un advisory lock con clave compuesta
-- (nombre_función, id_pedido), BLOQUEANTE (no try). Esto es una mejora real
-- y deliberada sobre la traducción literal, no un capricho: al ser hot path
-- (se llama en cada marca de artículo/dirección durante el picking, mucho
-- más a menudo que crear_carga/etc.), un candado global de guion literal
-- serializaría a TODOS los operarios de TODO el almacén entre sí en cada
-- marca; el candado por pedido solo serializa cuando dos marcas caen sobre
-- el MISMO pedido a la vez (raro), que es exactamente lo que el comentario
-- original decía que quería evitar.
--
-- El aviso a Chat (NO_ENCONTRADO/NO_SALE) es una llamada externa lenta que en
-- el original va FUERA del candado -- aquí no puede hacerse desde SQL, así
-- que se devuelve 'notificar' + los datos para que el futuro llamador
-- (Apps Script, Pieza 2) dispare la notificación tras recibir la respuesta,
-- igual que ya se decidió para otras funciones con efectos externos.
create or replace function staging.marcar_lineas_direccion(
  p_id_pedido text, p_dir text, p_estado_nuevo text,
  p_motivo text default null, p_operario text default null,
  p_vuelve_al_final boolean default false
) returns jsonb language plpgsql as $$
declare
  v_max_idx int;
  v_base_idx int;
  v_ts timestamptz := now();
  v_total int; v_procesadas int; v_preparadas int;
  v_pct int; v_estado_pedido text;
  v_pedido staging.pedidos%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('staging.marcar_lineas_direccion'), hashtext(p_id_pedido));

  if not exists (select 1 from staging.lineas_preparacion where id_pedido = p_id_pedido and dir = p_dir) then
    return jsonb_build_object('ok', false, 'error', 'Dirección no encontrada');
  end if;

  if p_vuelve_al_final then
    select coalesce(max(idx), 0) into v_max_idx from staging.lineas_preparacion where id_pedido = p_id_pedido;
    v_base_idx := v_max_idx + 1;
    with ordenadas as (
      select id, row_number() over (order by idx) - 1 as k
      from staging.lineas_preparacion where id_pedido = p_id_pedido and dir = p_dir
    )
    update staging.lineas_preparacion l
      set estado = p_estado_nuevo, motivo = coalesce(p_motivo, ''), operario = coalesce(p_operario, ''),
          ts = v_ts, idx = v_base_idx + ordenadas.k
      from ordenadas where l.id = ordenadas.id;
  else
    update staging.lineas_preparacion
      set estado = p_estado_nuevo, motivo = coalesce(p_motivo, ''), operario = coalesce(p_operario, ''), ts = v_ts
      where id_pedido = p_id_pedido and dir = p_dir;
  end if;

  select count(*),
    count(*) filter (where estado in ('PREPARADO','NO_SALE','NO_ENCONTRADO')),
    count(*) filter (where estado = 'PREPARADO')
    into v_total, v_procesadas, v_preparadas
    from staging.lineas_preparacion where id_pedido = p_id_pedido;

  v_pct := case when v_total > 0 then round((v_procesadas::numeric / v_total) * 100) else 0 end;
  v_estado_pedido := case
    when v_procesadas = v_total and v_preparadas = v_total then 'COMPLETADO_LISTO'
    when v_procesadas = v_total then 'PARCIAL_LISTO'
    when v_procesadas > 0 then 'EN_PREPARACION'
    else 'PENDIENTE'
  end;

  update staging.pedidos set
    pct = v_pct, estado = v_estado_pedido,
    operario = coalesce(nullif(p_operario, ''), operario),
    actualizado = v_ts,
    en_revision = case when p_estado_nuevo = 'POSPUESTO' then true else en_revision end
  where id = p_id_pedido
  returning * into v_pedido;

  return jsonb_build_object(
    'ok', true, 'ped', v_pedido.ped, 'pct', v_pct, 'estado', v_estado_pedido,
    'notificar', (p_estado_nuevo in ('NO_ENCONTRADO','NO_SALE'))
  );
end $$;

grant execute on function staging.marcar_lineas_direccion(text, text, text, text, text, boolean) to service_role;
