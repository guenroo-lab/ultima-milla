-- Fase 3, Lote 4 -- purgar_pedidos_antiguos (mantenimiento)
-- Traduce purgarPedidosAntiguos (Backend.gs:6758). Borra pedidos en estado
-- terminal (ESTADOS_TERMINALES) con más de 90 días sin actualizar, salvo que
-- SU ped todavía aparezca en OCUPACION (mismo criterio del original: clave
-- por 'ped', NO por id -- así que si dos pedidos de tiendas distintas
-- comparten el mismo número de ped y uno sigue ocupando silueta, el otro
-- también se conserva por seguridad; comportamiento pre-existente, no se
-- cambia aquí).
--
-- En Postgres esto es un DELETE simple -- toda la gimnasia de deleteRows /
-- clearContent del original (líneas 6740-6829) es exclusivamente para
-- esquivar limitaciones de la API de Sheets (no se pueden borrar TODAS las
-- filas de una vez, el borrado desplaza números de fila físicos) y no tiene
-- ningún equivalente necesario aquí: DELETE por clave primaria no desplaza
-- nada ni tiene casos límite.
--
-- marcarResumenObsoleto() del original solo invalida una CacheService de
-- Apps Script (resumen admin cacheado) -- es un concepto puramente de
-- runtime de GAS, no hay nada que sincronizar en Postgres; el futuro
-- llamador (Apps Script, Pieza 2) seguirá invalidando su propia caché tras
-- llamar a esta RPC, igual que hace hoy tras cualquier otra escritura.
create or replace function staging.purgar_pedidos_antiguos()
returns jsonb language plpgsql as $$
declare
  v_limite timestamptz := now() - interval '90 days';
  v_borrados int := 0;
  v_omitidos int := 0;
  v_detalle text;
begin
  perform pg_advisory_xact_lock(hashtext('staging.purgar_pedidos_antiguos'));

  with candidatos as (
    select p.id, p.ped
    from staging.pedidos p
    where p.estado in ('ENTREGADO','DEVUELTO_ALMACEN','ENVIADO_TIENDA','SALIDA_MANUAL','CERRADO_SIN_SILUETA')
      and p.actualizado <= v_limite
  ),
  marcados as (
    select c.id, c.ped,
      exists (select 1 from staging.ocupacion_siluetas o where o.pedido = c.ped) as tiene_ocupacion
    from candidatos c
  ),
  a_borrar as (
    select id from marcados where not tiene_ocupacion
  ),
  del_lineas as (
    delete from staging.lineas_preparacion where id_pedido in (select id from a_borrar)
  ),
  del_pedidos as (
    delete from staging.pedidos where id in (select id from a_borrar)
    returning id
  )
  select (select count(*) from del_pedidos), (select count(*) from marcados where tiene_ocupacion)
    into v_borrados, v_omitidos;

  if v_borrados > 0 then
    v_detalle := v_borrados || ' pedidos resueltos (+90 días) borrados de PEDIDOS/LINEAS'
      || (case when v_omitidos > 0 then ' · ' || v_omitidos || ' omitidos por inconsistencia (aún con hueco en OCUPACION)' else '' end);
    begin
      insert into staging.log_actividad (ts, tipo, detalle, usuario) values (now(), 'PURGA_PEDIDOS', v_detalle, '');
    exception when others then null;
    end;
  end if;

  return jsonb_build_object('ok', true, 'borrados', v_borrados, 'omitidos', v_omitidos);
end $$;

grant execute on function staging.purgar_pedidos_antiguos() to service_role;
