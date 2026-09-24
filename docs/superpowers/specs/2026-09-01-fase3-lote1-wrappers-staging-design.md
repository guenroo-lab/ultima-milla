# Fase 3 · Pieza 2 (Lote 1) — Wrappers Apps Script → RPC, validados solo contra `staging`

## Contexto

`docs/superpowers/specs/2026-08-13-fase3-rpc-postgres-lote1-design.md` diseñó y `supabase/migrations/2026081302..09_*.sql` implementó las 6 funciones RPC del Lote 1 (`cerrar_pedido`, `compartir_frente_remansur`, `mover_pedido_de_silueta`, `corregir_soportes_pedido`, `liberar_pedido_de_silueta`, `aplicar_compactar_siluetas`), ese mismo documento dejó explícitamente fuera de alcance:

> - **Pieza 2**: reescribir `EstructuraSheets.gs`/`Backend.gs` para llamar a estas funciones en vez de a `LockService` + Sheets, y auditar los usos de `._fila`.
> - **Pieza 3**: el corte real de lecturas (ventana 22:00-06:00), ensayo de rollback, runbook.

Estado real verificado hoy (2026-09-01), no solo memoria:

- **Las 12 funciones RPC del Lote 1-4 existen SOLO en el esquema `staging`** (confirmado con `select ... from pg_proc/pg_namespace`), ninguna en `public`.
- **`public` ya tiene datos reales y vivos** (3.975 pedidos, 154 filas de ocupación, 431 cargas — Fase 1/2 ya completadas, sincronización en sombra activa desde julio) pero **cero funciones RPC**.
- **Backend.gs no llama a ninguna RPC hoy** (grep sin resultados sobre `/rpc/` fuera de `Pruebas.gs`/`MigracionFase2.gs`) — todo lo que toca Supabase en producción real son los `sincronizarXSupabase_()` de Fase 1 (upserts sueltos, mecanismo distinto e independiente de las RPC).

Este documento diseña el primer paso de la Pieza 2, acotado **solo al Lote 1** y **solo contra `staging`** — decisión del usuario, ver más abajo.

## Decisiones ya acordadas con el usuario

1. **Por lotes, empezando por el Lote 1** — no las 4 lotes de golpe. Cada lote se construye y valida antes de pasar al siguiente.
2. **Este bloque llega solo hasta "construir y validar en staging"** — NO se promueve nada a `public`, NO se toca Backend.gs real, NO cablea ningún flujo que use un operario de verdad. Cablear Backend.gs de producción para que llame a estas RPC es una decisión aparte, explícita, para más adelante.

## Diseño técnico

### 1. Archivo nuevo: `MigracionFase3Lote1.gs`

Mismo patrón ya establecido en `MigracionFase2.gs`: primera función del archivo = wrapper de una línea (autoselección fiable en el desplegable del editor), todo lo relativo a `staging` sin ningún valor por defecto que pueda derivar a `public` por descuido.

### 2. Caller RPC — hardcodeado a `staging`, sin parámetro de esquema

A diferencia de `MigracionFase2.gs` (que sí acepta el esquema como parámetro, porque su trabajo es precisamente volcar a ambos), aquí **no existe manera de apuntar a `public`** — ni como parámetro opcional ni por configuración. Es la garantía física de que este bloque no puede tocar producción por error:

```javascript
function _rpcStaging_(nombreFuncion, payload) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (Propiedades del script vacías)');
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + nombreFuncion, {
    method: 'post',
    headers: {
      apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'Accept-Profile': 'staging', 'Content-Profile': 'staging',
      'User-Agent': 'GoogleAppsScript-lm_produccion-lote1-staging'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var body = resp.getContentText();
  if (resp.getResponseCode() >= 300) {
    throw new Error('_rpcStaging_(' + nombreFuncion + '): HTTP ' + resp.getResponseCode() + ' ' + body.slice(0, 500));
  }
  return body ? JSON.parse(body) : null;
}
```

`Accept-Profile`/`Content-Profile: staging` son las cabeceras reales de PostgREST para seleccionar esquema no-`public` (Supabase expone `staging` vía `exponer_esquema_staging_en_api`, migración `20260813113034`, ya aplicada). Sin esas cabeceras, PostgREST asume `public` — de ahí que vayan fijas en el helper, no como opción.

### 3. Las 5 funciones — mismo contrato que su gemela de Sheets, con una excepción explicada

Firmas reales confirmadas leyendo Backend.gs hoy (no las del documento de diseño de hace 3 semanas, por si habían cambiado — no habían cambiado, pero se verificó). Estas funciones son el **arnés de prueba de este bloque**, no el código final que terminará en Backend.gs — 4 de las 5 coinciden exactamente con la firma real porque el arnés las llama igual que llamaría un caller real. La excepción es `moverPedidoDeSiluetaViaSupabase`, que recibe `soportes` como parámetro EXTRA (la real `moverPedidoDeSilueta(numPed, nuevaSilueta, nuevaPosIni, tienda)` no lo tiene, porque en Sheets ese dato ya vive en la fila del pedido que se está moviendo): aquí lo aporta directamente el propio arnés de prueba, que sembró el pedido sintético y ya sabe qué soportes le dio, sin necesitar una lectura adicional a `staging.pedidos` solo para recuperar un dato que el llamador ya conoce. Cuando se cablee Backend.gs de verdad (fuera de alcance de este bloque), esa versión real sí tendrá que leer `soportes` de la fila del pedido antes de calcular `posiciones`.

```javascript
// Backend.gs real: cerrarPedido(idPedido, silueta, posIni, soportes, operario)
function cerrarPedidoViaSupabase(idPedido, silueta, posIni, soportes, operario) {
  var posiciones = calcularPosiciones(soportes); // pura, ya vive en Backend.gs — se reutiliza tal cual
  return _rpcStaging_('cerrar_pedido', {
    p_id_pedido: idPedido, p_silueta: silueta, p_pos_ini: posIni,
    p_posiciones: posiciones, p_soportes: soportes, p_operario: operario || null
  });
}

// Backend.gs real: moverPedidoDeSilueta(numPed, nuevaSilueta, nuevaPosIni, tienda)
function moverPedidoDeSiluetaViaSupabase(numPed, nuevaSilueta, nuevaPosIni, soportes, tienda) {
  var posiciones = calcularPosiciones(soportes);
  return _rpcStaging_('mover_pedido_de_silueta', {
    p_num_ped: String(numPed), p_nueva_silueta: nuevaSilueta, p_nueva_pos_ini: nuevaPosIni,
    p_posiciones: posiciones, p_tienda: tienda || null
  });
}

// Backend.gs real: corregirSoportesPedido(numPed, nuevosSoportes, nuevaSilueta, nuevaPosIni, tienda)
function corregirSoportesPedidoViaSupabase(numPed, nuevosSoportes, nuevaSilueta, nuevaPosIni, tienda) {
  var posiciones = calcularPosiciones(nuevosSoportes);
  return _rpcStaging_('corregir_soportes_pedido', {
    p_num_ped: String(numPed), p_nuevos_soportes: nuevosSoportes, p_posiciones: posiciones,
    p_nueva_silueta: nuevaSilueta || null, p_nueva_pos_ini: (nuevaPosIni === undefined ? null : nuevaPosIni),
    p_tienda: tienda || null
  });
}

// Backend.gs real: liberarPedidoDeSilueta(numPed, disposicion, motivo, tienda)
function liberarPedidoDeSiluetaViaSupabase(numPed, disposicion, motivo, tienda) {
  return _rpcStaging_('liberar_pedido_de_silueta', {
    p_num_ped: String(numPed), p_disposicion: disposicion, p_motivo: motivo || null, p_tienda: tienda || null
  });
}

// Backend.gs real: aplicarCompactarSiluetas(movimientos)
function aplicarCompactarSiluetasViaSupabase(movimientos) {
  return _rpcStaging_('aplicar_compactar_siluetas', { p_movimientos: movimientos });
}
```

`compartir_frente_remansur` no tiene wrapper propio — se ejercita indirectamente a través de `cerrarPedidoViaSupabase` en el caso Remansur de una posición (igual que en Sheets, `intentarCompartirFrenteRemansur` no se llama nunca directamente desde fuera de `cerrarPedido`).

### 4. Datos sintéticos — sembrados y limpiados por la propia prueba

`staging.pedidos`/`staging.ocupacion_siluetas` ya tienen datos (2.962 y 78 filas respectivamente, de la Fase 2), pero las pruebas de este lote necesitan pedidos con id/ped conocidos y huecos de silueta en un estado exacto y predecible — no reutilizar filas reales existentes de staging (podrían cambiar de estado entre ejecuciones y romper una prueba de forma no reproducible). Cada función de prueba:

1. Inserta (`_rpcStaging_` no sirve para INSERT plano — se usa `UrlFetchApp` directo con `Content-Profile: staging` contra `/rest/v1/pedidos`) 2-3 pedidos sintéticos con `id` prefijado `TEST_LOTE1_` y una silueta de prueba (p.ej. `silueta: 'ZTEST'`, fuera del rango real A-F, para no chocar nunca con datos reales de staging) con posiciones libres conocidas.
2. Ejecuta la función bajo prueba.
3. Verifica el resultado Y el estado final de `staging.ocupacion_siluetas`/`staging.pedidos` para esas filas de prueba.
4. Borra sus propias filas de prueba al final (`finally`), tanto si la prueba pasó como si falló — para no acumular basura en `staging` entre ejecuciones repetidas.

### 5. Pruebas de concurrencia — `UrlFetchApp.fetchAll()`, no un `for`

Un bucle `for` en Apps Script es de un solo hilo — nunca simula una carrera real, solo peticiones secuenciales. `UrlFetchApp.fetchAll(requests)` sí envía varias peticiones HTTP genuinamente en paralelo y espera todas las respuestas — es la única forma correcta de probar esto desde Apps Script:

```javascript
function _dispararEnParalelo_(nombreFuncion, payloads) {
  var cfg = getSupabaseConfig_();
  var requests = payloads.map(function(p) {
    return {
      url: cfg.url + '/rest/v1/rpc/' + nombreFuncion,
      method: 'post',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        'Accept-Profile': 'staging', 'Content-Profile': 'staging'
      },
      payload: JSON.stringify(p),
      muteHttpExceptions: true
    };
  });
  return UrlFetchApp.fetchAll(requests).map(function(r) {
    var body = r.getContentText();
    return { status: r.getResponseCode(), body: body ? JSON.parse(body) : null };
  });
}
```

Casos a cubrir (mismos del documento padre §6, reafirmados aquí porque son la razón de ser de este bloque):

1. **2 pedidos normales (no Remansur) contra el MISMO hueco**: exactamente una llamada `ok:true`, la otra `ok:false` con el error de conflicto; `ocupacion_siluetas` tiene solo las filas de la ganadora.
2. **2 pedidos Remansur contra el MISMO hueco**: las DOS deben poder ganar (regla de negocio §3.1 del documento padre, no un bug) — confirmar que efectivamente las dos ganan.
3. **2 intentos simultáneos de `compartir_frente_remansur` sobre el mismo `front`**: solo uno debe ganar el `reservado=false`.

Cada una de las 5 funciones que reclama posición se da por cerrada solo cuando pasa su prueba funcional Y (si aplica) su prueba de concurrencia — `liberarPedidoDeSiluetaViaSupabase` y `aplicarCompactarSiluetasViaSupabase` no reclaman hueco nuevo (liberan/reordenan lo ya existente), así que no necesitan caso de concurrencia de "dos ganan el mismo hueco", pero sí una prueba de que dos liberaciones simultáneas del mismo pedido no dejan el dato en un estado a medias.

## Alcance explícitamente fuera (YAGNI de este bloque)

- **No se toca Backend.gs.** Ni un solo call-site real cambia de Sheets a Supabase en este bloque.
- **No se promueve nada a `public`.** Las RPC siguen existiendo solo en `staging` al terminar este bloque.
- **No se audita `._fila`** todavía — ese trabajo es de cuando se decida cablear Backend.gs de verdad (Pieza 2, fase siguiente), no de este bloque.
- **`actualizarPaletsBultosDisponibilidad`** (la hoja externa de Disponibilidad, gestionada por otro equipo, llamada hoy desde `cerrarPedido` tras soltar el candado) **no se replica en estas pruebas** — sigue siendo explícitamente fuera de alcance de toda la migración (ver documento padre, riesgo #6).
- **`liberarPosicionesLote`** no tiene wrapper propio en este bloque — el documento padre (§5.5) ya estableció que no necesita RPC, se resuelve con `DELETE` directo cuando se cablee Backend.gs de verdad; no hay nada que construir/probar aquí que no sea un `DELETE` trivial ya cubierto por PostgREST estándar.

## Pruebas

1. Función funcional por cada una de las 5, con pedidos sintéticos `TEST_LOTE1_*` sembrados y limpiados por la propia prueba — cubriendo al menos: caso normal, caso Remansur (salta validación), caso bultos (0 posiciones → ubicación 0), caso "compartir delante" Remansur.
2. Los 3 casos de concurrencia real de §5, con `UrlFetchApp.fetchAll()`.
3. Verificación de que `staging.pedidos`/`staging.ocupacion_siluetas` quedan exactamente igual que antes de empezar tras ejecutar el conjunto completo (sin filas `TEST_LOTE1_*` residuales) — ejecutar el conjunto dos veces seguidas debe dar el mismo resultado ambas veces.
