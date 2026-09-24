/**
 * ============================================================
 * MigracionFase3Lote2.gs · Wrappers Apps Script → RPC (Lote 2), solo staging
 * ============================================================
 * Fase 3 "Pieza 2" de la migración a Supabase, acotada al Lote 2 (gestión de
 * cargas: crear_carga, quitar_pedido_de_carga, eliminar_carga_completa,
 * anadir_pedido_a_carga) y SOLO contra el esquema `staging`.
 *
 * Reutiliza _rpcStaging_ / _restStaging_ / _dispararEnParalelo_ ya definidos
 * en MigracionFase3Lote1.gs (mismo proyecto, mismo scope global de Apps
 * Script) -- NO se duplican aquí. Mismo motivo que el Lote 1: el esquema va
 * fijo en las cabeceras Accept-Profile/Content-Profile: 'staging' de esos
 * helpers, a propósito, para que sea físicamente imposible llamar a
 * `public` (producción real) desde aquí. Backend.gs NO se toca en este
 * bloque.
 */

// Backend.gs real: crearCarga(listaNumPedidos, responsable, esCamionGrua, agencia)
// EXCEPCIÓN de firma (ver Backend.gs real, cambio de 2026-09-01): esCamionGrua
// y agencia son parámetros nuevos para exportar la carga a "CARGAS TAISA" --
// el RPC crear_carga (diseñado semanas antes) todavía no los conoce, así que
// este wrapper NO los recibe ni los envía. Diferencia de alcance documentada,
// no un olvido: exportar a Taisa no tiene equivalente en staging todavía.
function crearCargaViaSupabase(listaNumPedidos, responsable) {
  return _rpcStaging_('crear_carga', {
    p_numeros_pedido: listaNumPedidos, p_responsable: responsable || ''
  });
}

// Backend.gs real: quitarPedidoDeCarga(idCarga, numPed)
function quitarPedidoDeCargaViaSupabase(idCarga, numPed) {
  return _rpcStaging_('quitar_pedido_de_carga', {
    p_id_carga: idCarga, p_num_ped: String(numPed)
  });
}

// Backend.gs real: eliminarCargaCompleta(idCarga)
function eliminarCargaCompletaViaSupabase(idCarga) {
  return _rpcStaging_('eliminar_carga_completa', { p_id_carga: idCarga });
}

// Backend.gs real: anadirPedidoACarga(idCarga, numPed)
// _rpcStaging_ es el mismo helper del Lote 1 -- el candado real que protege
// esta operación en Postgres es un FOR UPDATE OF p1 sobre la fila del
// pedido candidato (serializa solo cuando DOS altas apuntan al MISMO
// pedido), NO un candado global equivalente al LockService.getScriptLock()
// de Backend.gs (que sí serializa las 4 operaciones de este lote ENTRE SÍ
// en producción). crear_carga usa además su propio advisory lock
// (pg_advisory_xact_lock sobre hashtext('staging.crear_carga')), que solo
// serializa llamadas a crear_carga contra sí mismas -- no se coordina con
// el FOR UPDATE de esta función ni con las demás RPC del lote. Sin test de
// concurrencia cruzada entre crear_carga y esta función (fuera de alcance
// de este bloque; ninguna de las dos toca max(num_carga) de la otra, así
// que el riesgo real es bajo, pero no está verificado empíricamente).
function anadirPedidoACargaViaSupabase(idCarga, numPed) {
  return _rpcStaging_('anadir_pedido_a_carga', {
    p_id_carga: idCarga, p_num_ped: String(numPed)
  });
}
