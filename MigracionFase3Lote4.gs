/**
 * ============================================================
 * MigracionFase3Lote4.gs · Wrappers Apps Script → RPC (Lote 4), solo staging
 * ============================================================
 * Fase 3 "Pieza 2" de la migración a Supabase, acotada al Lote 4 -- último
 * lote de esta pieza (hot path de marcado + mantenimiento periódico) -- y
 * SOLO contra el esquema `staging`.
 *
 * Reutiliza _rpcStaging_ / _restStaging_ / _dispararEnParalelo_ ya definidos
 * en MigracionFase3Lote1.gs (mismo proyecto, mismo scope global de Apps
 * Script -- NO se duplican aquí). Backend.gs NO se toca en este bloque.
 */

// Backend.gs real: marcarDireccion(idPedido, dir, estadoNuevo, motivo, operario, vuelveAlFinal) -- MISMA firma.
// HOT PATH: se llama en cada marca de artículo/dirección durante el picking.
// El original usa un candado GLOBAL best-effort (LockService.getScriptLock(),
// tryLock 15s, sigue sin candado si no lo consigue); la RPC usa un advisory
// lock BLOQUEANTE con clave compuesta (nombre_función, id_pedido) -- mejora
// real y deliberada: solo serializa marcas del MISMO pedido entre sí, no a
// todo el almacén (ver comentario completo en la migración SQL). El aviso a
// Chat (NO_ENCONTRADO/NO_SALE) no puede dispararse desde Postgres -- la RPC
// devuelve 'notificar':true/false para que el llamador (Pieza 2 futura) lo
// dispare tras recibir la respuesta, mismo patrón que otras funciones con
// efectos externos.
function marcarLineasDireccionViaSupabase(idPedido, dir, estadoNuevo, motivo, operario, vuelveAlFinal) {
  return _rpcStaging_('marcar_lineas_direccion', {
    p_id_pedido: idPedido, p_dir: dir, p_estado_nuevo: estadoNuevo,
    p_motivo: motivo || null, p_operario: operario || null, p_vuelve_al_final: !!vuelveAlFinal
  });
}

// Backend.gs real: purgarPedidosAntiguos() -- SIN parámetros.
// En Postgres es un DELETE simple; toda la gimnasia de deleteRows/
// clearContent del original era solo para esquivar límites de la API de
// Sheets, sin equivalente necesario aquí (ver comentario en la migración SQL).
function purgarPedidosAntiguosViaSupabase() {
  return _rpcStaging_('purgar_pedidos_antiguos', {});
}
