# Forzar reimportación de pedidos "ya resueltos" — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar al Clasificador un botón "↩ Forzar" por cada pedido omitido por estar en estado
terminal, que lo resetea a Pendiente y sustituye sus líneas por las direcciones frescas de
Pyxis (completas o solo las marcadas), sin tocar `reabrirPedido` ni el resto del import.

**Architecture:** Se factoriza el tramo de `crearPedidoConLineas` que dedupe/ordena/inserta
líneas en un helper compartido (`_construirEInsertarLineas`), reutilizado tanto por el alta
normal como por el nuevo bloque "forzados" de `importarClasificacion`. El cliente
(Clasificador.html) añade chips por cada omitido forzable y un selector de direcciones
propio (independiente del de "Añadir parcial", para no compartir estado con él).

**Tech Stack:** Google Apps Script (V8, ES6) + HTML/JS cliente vía `google.script.run`. Sin
framework de test — verificación manual con funciones `Pruebas.gs` ejecutadas desde el
editor de Apps Script (convención ya establecida en este proyecto), Logger.log como salida.

**Nota de despliegue (importante, léela antes de empezar):** este proyecto NO tiene un
esquema Postgres/staging para el código de Apps Script — a diferencia de las migraciones
Supabase de sesiones anteriores, aquí `clasp push` sube directamente a la MISMA copia del
proyecto que sirve la app en producción. `clasp push` por sí solo NO afecta a los usuarios
reales: actualiza el código HEAD del proyecto, pero la URL `/exec` que usa la gente sigue
sirviendo la versión desplegada anteriormente hasta que se publique una "Nueva
implementación" desde el editor. Por eso todas las pruebas de este plan (Tareas 1-4) son
seguras de hacer tras cada `clasp push` sin afectar a nadie; el único paso que SÍ afecta a
los usuarios reales es la Tarea 6 (desplegar), que queda marcada aparte y requiere
confirmación explícita del usuario antes de ejecutarla — mismo criterio que se ha seguido
con toda la parte de Supabase.

---

### Task 1: Factorizar la construcción/inserción de líneas (`ImportarPyxis.gs`)

**Files:**
- Modify: `ImportarPyxis.gs:235-293` (función `crearPedidoConLineas`)

- [ ] **Paso 1: Añadir el helper `_construirEInsertarLineas` justo antes de `crearPedidoConLineas`**

Extrae el tramo de dedup/orden/cálculo de `nUbic` + el bucle de inserción de LINEAS de
`crearPedidoConLineas`, sin cambiar ni una línea de esa lógica (mismo dedup, mismo orden,
mismos campos por línea). Nota: esto adelanta la escritura de LINEAS a ANTES de la escritura
de PEDIDOS (antes era al revés). Es seguro: ningún lector de LINEAS busca por `idPedido` sin
antes encontrar la fila PEDIDOS correspondiente (`obtenerPedidoConLineas` comprueba
`pedidos.find(...)` primero y devuelve `null` de inmediato si no existe, sin mirar líneas) —
así que una línea "huérfana" transitoria de unos milisegundos nunca es observable.

```javascript
/**
 * Dedupe+ordena lineasRaw (mismo criterio que crearPedidoConLineas) e inserta las filas
 * LINEAS resultantes para idPedido. Compartido entre crearPedidoConLineas (alta nueva) y
 * el bloque "forzados" de importarClasificacion (reemplazo de líneas de un pedido ya
 * existente que se fuerza a reimportar) -- MISMA lógica de construcción en los dos sitios,
 * para que nunca diverja cómo se calculan/ordenan/clasifican las líneas.
 * Devuelve { nLin, nUbic }.
 */
function _construirEInsertarLineas(idPedido, numPed, lineasRaw) {
  var lineasOrdenadas = ordenarLineasPyxis(lineasRaw);

  // DEDUPLICAR (2026-08-03, bug real: "salen 4 cerraduras en vez de 2" -- la línea se
  // duplicaba, un operario tenía que marcar el doble de lo que hacía falta). Dos causas
  // confirmadas con datos reales, distintas entre sí: (a) una condición de carrera ya
  // corregida con candados (v193/v195, dos ejecuciones creaban la MISMA línea nueva cada
  // una por su cuenta) y (b) el propio Excel de Pyxis a veces trae la MISMA referencia+
  // dirección repetida de origen, sin que medie ninguna carrera. Esta salvaguarda protege
  // contra las DOS causas a la vez, colapsando a una sola línea cualquier grupo que
  // comparta referencia+dirección+cantidad exactas -- NO se suman cantidades (si el
  // duplicado fuera un reparto real en dos lotes con cantidades DISTINTAS, eso no se toca,
  // se deja tal cual: no hay evidencia de que eso ocurra, y sumar a ciegas sería peor que
  // no tocarlo).
  var dedupCrear = deduplicarLineasPyxis_(lineasOrdenadas);
  if (dedupCrear.colapsadas > 0) {
    logActividad('LINEAS_DUPLICADAS_COLAPSADAS', 'Pedido ' + numPed + ' (' + idPedido + '): ' + dedupCrear.colapsadas +
      ' línea(s) duplicada(s) en origen (Pyxis o reintento) colapsada(s) a 1 antes de crear', 'sistema');
  }
  lineasOrdenadas = dedupCrear.lineas;

  var ubic = {};
  lineasOrdenadas.forEach(function(l) { ubic[l.dir] = true; });
  var nUbic = Object.keys(ubic).length;

  lineasOrdenadas.forEach(function(l, j) {
    anadirFila('LINEAS', {
      id: idPedido + '::L' + j, idPedido: idPedido, idx: j,
      dir: l.dir, ref: l.ref, ean: l.ean, des: l.des, ctd: l.ctd,
      tipoUbic: clasificarUbicacion(l.dir), esPicking: esPicking(l.dir),
      estado: 'PENDIENTE', motivo: '', operario: '', ts: ''
    });
  });

  return { nLin: lineasOrdenadas.length, nUbic: nUbic };
}
```

- [ ] **Paso 2: Añadir el helper `_borrarLineasDePedido` justo debajo del anterior**

Necesario para el bloque "forzados" de la Tarea 3 (sustituir líneas viejas por frescas).
Borra de abajo hacia arriba por número de fila para no desplazar filas aún no borradas
(mismo criterio ya usado en el resto del proyecto para evitar el bug de desplazamiento de
filas físicas).

```javascript
/**
 * Borra TODAS las filas LINEAS de un idPedido. Usado por el bloque "forzados" de
 * importarClasificacion antes de insertar las líneas frescas de Pyxis -- a diferencia de
 * marcarLinea/marcarDireccion (que solo cambian estado), aquí las líneas viejas ya no
 * sirven de nada: se sustituyen enteras.
 */
function _borrarLineasDePedido(idPedido) {
  var sheet = getHoja('LINEAS');
  var filas = leerHoja('LINEAS')
    .filter(function(l) { return l.idPedido === idPedido; })
    .map(function(l) { return l._fila; })
    .sort(function(a, b) { return b - a; }); // de abajo hacia arriba
  filas.forEach(function(f) { sheet.deleteRows(f, 1); });
}
```

- [ ] **Paso 3: Reescribir `crearPedidoConLineas` para usar el helper**

Reemplaza el cuerpo completo de la función (`ImportarPyxis.gs:235-293`) por esta versión —
mismo comportamiento observable, solo delega la parte factorizada:

```javascript
function crearPedidoConLineas(idPedido, numPed, tienda, transportista, lineasRaw, esParcial, comentario, sinSyncInmediato) {
  var flujo = CONFIG.TRANSPORTISTAS_FLUJO[transportista] || 'transporte';
  var r = _construirEInsertarLineas(idPedido, numPed, lineasRaw);

  var pedidoNuevo = {
    id: idPedido, ped: numPed, tienda: tienda, transportista: transportista,
    flujo: flujo, estado: 'PENDIENTE', pct: 0, operario: '',
    silueta: '', posIni: '', posFin: '', numeroCarga: '',
    soportes: '[]', nLin: r.nLin, nUbic: r.nUbic,
    actualizado: new Date().toISOString(), parcial: !!esParcial,
    comentario: comentario ? String(comentario).trim() : ''
  };
  anadirFila('PEDIDOS', pedidoNuevo);
  // Fase 1 (Supabase): sinSyncInmediato=true (usado por importarClasificacion, que llama a
  // esta función bajo un candado LockService) difiere el HTTP a Supabase hasta después de
  // soltar el candado -- no debe alargar cuánto esperan por él otras operaciones.
  if (!sinSyncInmediato) sincronizarPedidoSupabase_(pedidoNuevo, {});
  registrarHistorialTransportista(idPedido, numPed, tienda, transportista, flujo, 'ALTA');

  return { nLin: r.nLin, nUbic: r.nUbic, pedido: pedidoNuevo };
}
```

- [ ] **Paso 4: Push y verificación de regresión desde el editor**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

En el editor de Apps Script, ejecutar `probarInventario()` (ya existente, Inventario.gs) y
confirmar que sigue logueando tiendas y nº de pedidos sin error — no ejercita
`crearPedidoConLineas` directamente, pero confirma que el fichero sigue cargando sin errores
de sintaxis tras el refactor. La verificación real de `crearPedidoConLineas`/
`_construirEInsertarLineas` llega en la Tarea 4 (se prueba junto con el resto).

---

### Task 2: Etiqueta del nuevo evento de historial (`Index.html`)

**Files:**
- Modify: `Index.html:4374`

- [ ] **Paso 1: Añadir `REABIERTO_FORZADO` al mapa de etiquetas**

Antes:
```javascript
const EVENTO_LABEL_HT = { ALTA:'Alta', REIMPORTADO:'Reclasificado', CAMBIO_MANUAL:'Cambio manual', RECOGIDAS:'Recogidas', YA_CARGADOS:'Ya Cargados', REABIERTO:'Volvió (reabierto)' };
```

Después:
```javascript
const EVENTO_LABEL_HT = { ALTA:'Alta', REIMPORTADO:'Reclasificado', CAMBIO_MANUAL:'Cambio manual', RECOGIDAS:'Recogidas', YA_CARGADOS:'Ya Cargados', REABIERTO:'Volvió (reabierto)', REABIERTO_FORZADO:'Volvió (forzado, líneas nuevas)' };
```

- [ ] **Paso 2: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 3: Bloque "forzados" en `importarClasificacion` (`ImportarClasificacion.gs`)

**Files:**
- Modify: `ImportarClasificacion.gs:38-179` (función `importarClasificacion`)

- [ ] **Paso 1: Declarar `omitidosForzables` junto a los demás acumuladores**

En `ImportarClasificacion.gs:88`, cambiar:
```javascript
    var creados = [], omitidos = [], noEncontrados = [], colisiones = [];
```
por:
```javascript
    var creados = [], omitidos = [], noEncontrados = [], colisiones = [], omitidosForzables = [];
```

- [ ] **Paso 2: Registrar el motivo forzable en la rama de omisión por estado terminal**

En `ImportarClasificacion.gs:125-128`, cambiar:
```javascript
      if (ESTADOS_TERMINALES[estadoExistente]) {
        omitidos.push(numPed + ' (' + (ESTADO_LABEL[estadoExistente] || estadoExistente) + ', ya resuelto — no se toca)');
        return;
      }
```
por:
```javascript
      if (ESTADOS_TERMINALES[estadoExistente]) {
        omitidos.push(numPed + ' (' + (ESTADO_LABEL[estadoExistente] || estadoExistente) + ', ya resuelto — no se toca)');
        omitidosForzables.push({ ped: numPed, tienda: tienda, transporte: transporte, estadoLabel: ESTADO_LABEL[estadoExistente] || estadoExistente });
        return;
      }
```

- [ ] **Paso 3: Añadir el bloque de proceso "3) forzados"**

En `ImportarClasificacion.gs:169` (justo después del bloque "2) parciales" que ya existe,
antes de la línea `logActividad('IMPORTAR_CLASIF', ...)`), insertar:

```javascript
    // 3) forzados: pedidos que YA se saltaron por estado terminal en una importación
    // anterior y el usuario decide, explícitamente y uno a uno desde el Clasificador, que
    // SÍ han vuelto de verdad y hay que volver a prepararlos -- con las direcciones
    // FRESCAS de Pyxis ahora mismo (no las líneas viejas: para eso ya existe
    // reabrirPedido). opciones.forzados: [{ ped, tienda, dirsSel }] -- no lleva
    // 'transporte': el forzado NO cambia transportista/flujo, se queda el que ya tenía el
    // pedido (solo se usa el zona→transportista al darlo de alta la primera vez).
    var forzadosOk = [], forzadosError = [];
    (opciones.forzados || []).forEach(function(f) {
      var numPedF = String(f.ped).trim();
      var tiendaF = f.tienda;
      var idPedidoF = codigoTienda(tiendaF) + '::' + numPedF;

      // Revalidar AHORA, no fiarse del estado que tenía cuando se listó como omitido --
      // puede haber pasado tiempo desde entonces (alguien más pudo reabrirlo mientras
      // tanto por otra vía, p.ej. reabrirPedido desde 🔍 Buscar).
      var estadoActualF = existentes[idPedidoF];
      if (estadoActualF === undefined || !ESTADOS_TERMINALES[estadoActualF]) {
        forzadosError.push({ ped: numPedF, motivo: 'Ya no está en un estado que se pueda forzar (puede que alguien ya lo reabriera)' });
        return;
      }

      var entryF = indice[numPedF];
      if (!entryF || !entryF.porTienda[tiendaF]) {
        forzadosError.push({ ped: numPedF, motivo: 'Ya no está en el inventario de Pyxis' });
        return;
      }

      var lineasRawF = entryF.porTienda[tiendaF].lineas;
      if (f.dirsSel && f.dirsSel.length) {
        lineasRawF = lineasRawF.filter(function(l) { return f.dirsSel.indexOf(l.dir) !== -1; });
      }
      if (!lineasRawF.length) {
        forzadosError.push({ ped: numPedF, motivo: 'No queda ninguna dirección seleccionada' });
        return;
      }

      var pedidoRowF = leerHoja('PEDIDOS').find(function(p) { return p.id === idPedidoF; });
      if (!pedidoRowF) {
        forzadosError.push({ ped: numPedF, motivo: 'Pedido no encontrado' });
        return;
      }
      var numeroCargaAnteriorF = pedidoRowF.numeroCarga;

      _borrarLineasDePedido(idPedidoF);
      var rF = _construirEInsertarLineas(idPedidoF, numPedF, lineasRawF);

      var cambiosForzarF = {
        estado: 'PENDIENTE', pct: 0, operario: '',
        silueta: '', posIni: '', posFin: '', numeroCarga: '',
        soportes: '[]', intentoCarga: '', comentario: '',
        nLin: rF.nLin, nUbic: rF.nUbic, parcial: !!(f.dirsSel && f.dirsSel.length),
        actualizado: new Date().toISOString()
      };
      actualizarFila('PEDIDOS', pedidoRowF._fila, cambiosForzarF);
      pendientesSyncSupabase.push(Object.assign({}, pedidoRowF, cambiosForzarF));
      if (numeroCargaAnteriorF) _quitarPedidoDeSuCargaActiva(numeroCargaAnteriorF, numPedF);

      registrarHistorialTransportista(idPedidoF, numPedF, pedidoRowF.tienda, pedidoRowF.transportista, pedidoRowF.flujo, 'REABIERTO_FORZADO');

      existentes[idPedidoF] = 'PENDIENTE';
      forzadosOk.push(numPedF);
    });
```

- [ ] **Paso 4: Extender el log final y el `return`**

En `ImportarClasificacion.gs:171-172`, cambiar:
```javascript
    logActividad('IMPORTAR_CLASIF', creados.length + ' creados, ' + omitidos.length + ' omitidos, ' + noEncontrados.length + ' no encontrados', '');
    return { ok: true, creados: creados, omitidos: omitidos, noEncontrados: noEncontrados, colisiones: colisiones };
```
por:
```javascript
    logActividad('IMPORTAR_CLASIF', creados.length + ' creados, ' + omitidos.length + ' omitidos, ' + noEncontrados.length + ' no encontrados' +
      ((forzadosOk.length || forzadosError.length) ? ' · ' + forzadosOk.length + ' forzados, ' + forzadosError.length + ' forzados con error' : ''), '');
    return { ok: true, creados: creados, omitidos: omitidos, noEncontrados: noEncontrados, colisiones: colisiones, omitidosForzables: omitidosForzables, forzadosOk: forzadosOk, forzadosError: forzadosError };
```

- [ ] **Paso 5: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 4: Pruebas del bloque "forzados" (`Pruebas.gs`, contra Sheets real con datos de prueba)

**Files:**
- Modify: `Pruebas.gs` (nueva función, primera del archivo — mismo patrón "wrapper primero"
  ya establecido en este proyecto para que el editor de Apps Script la autoseleccione sin
  depender del desplegable, que ya demostró poder ejecutar la función equivocada en
  silencio en una sesión anterior)

- [ ] **Paso 1: Escribir la función de prueba completa**

Prueba las 3 rutas SIN depender de datos reales de Pyxis para los casos de guarda (que no lo
necesitan), y con un pedido real actualmente en Pyxis solo para el caso feliz (elegido a
mano por el usuario en el Paso 3, no hardcodeado aquí). Usa el prefijo `TESTFORZ_` en los
`id`/`ped` para que sea inequívoco y fácil de limpiar — mismo criterio que el resto de
pruebas de este proyecto.

```javascript
/**
 * Prueba el bloque "forzados" de importarClasificacion (2026-08-31). Wrapper primero del
 * archivo para que el editor lo autoseleccione sin depender del desplegable de funciones.
 * NO toca ningún pedido real -- todos los datos de prueba llevan el prefijo TESTFORZ_ y se
 * limpian al final, incluso si algo falla a mitad (try/finally).
 */
function ejecutarPruebaForzarReimportacion() {
  return probarForzarReimportacion();
}

function probarForzarReimportacion() {
  var idsCreados = [];
  try {
    Logger.log('--- Caso 1: guarda -- pedido YA NO está en estado terminal ---');
    var idNoTerminal = '999::TESTFORZ_NOTERM';
    anadirFila('PEDIDOS', {
      id: idNoTerminal, ped: 'TESTFORZ_NOTERM', tienda: 'Málaga', transportista: 'Correcaminos',
      flujo: 'transporte', estado: 'PENDIENTE', pct: 0, operario: '', silueta: '', posIni: '', posFin: '',
      numeroCarga: '', soportes: '[]', nLin: 0, nUbic: 0, actualizado: new Date().toISOString(), parcial: false, comentario: ''
    });
    idsCreados.push(idNoTerminal);
    var r1 = importarClasificacion({}, { forzados: [{ ped: 'TESTFORZ_NOTERM', tienda: 'Málaga', dirsSel: [] }] });
    Logger.log('forzadosError esperado 1, motivo "ya no está en un estado que se pueda forzar": ' + JSON.stringify(r1.forzadosError));
    if (r1.forzadosError.length !== 1 || r1.forzadosOk.length !== 0) Logger.log('❌ FALLO caso 1');
    else Logger.log('✓ OK caso 1');

    Logger.log('--- Caso 2: guarda -- pedido terminal pero YA NO está en Pyxis ---');
    var idNoPyxis = '999::TESTFORZ_NOPYXIS';
    anadirFila('PEDIDOS', {
      id: idNoPyxis, ped: 'TESTFORZ_NOPYXIS', tienda: 'Málaga', transportista: 'Correcaminos',
      flujo: 'transporte', estado: 'ENTREGADO', pct: 100, operario: '', silueta: '', posIni: '', posFin: '',
      numeroCarga: '', soportes: '[]', nLin: 1, nUbic: 1, actualizado: new Date().toISOString(), parcial: false, comentario: ''
    });
    idsCreados.push(idNoPyxis);
    var r2 = importarClasificacion({}, { forzados: [{ ped: 'TESTFORZ_NOPYXIS', tienda: 'Málaga', dirsSel: [] }] });
    Logger.log('forzadosError esperado 1, motivo "ya no está en el inventario de Pyxis": ' + JSON.stringify(r2.forzadosError));
    if (r2.forzadosError.length !== 1 || r2.forzadosOk.length !== 0) Logger.log('❌ FALLO caso 2');
    else Logger.log('✓ OK caso 2');

    Logger.log('--- Caso 3: mecánica de reset+sustitución de líneas (sin pasar por Pyxis real) ---');
    var idMecanica = '999::TESTFORZ_MECANICA';
    anadirFila('PEDIDOS', {
      id: idMecanica, ped: 'TESTFORZ_MECANICA', tienda: 'Málaga', transportista: 'Correcaminos',
      flujo: 'transporte', estado: 'ENTREGADO', pct: 100, operario: 'Alguien', silueta: 'A', posIni: '3', posFin: '3',
      numeroCarga: '', soportes: '[]', nLin: 1, nUbic: 1, actualizado: new Date().toISOString(), parcial: false, comentario: ''
    });
    idsCreados.push(idMecanica);
    anadirFila('LINEAS', {
      id: idMecanica + '::L0', idPedido: idMecanica, idx: 0, dir: 'VIEJA-1', ref: 'REFVIEJA', ean: '', des: 'línea vieja',
      ctd: 1, tipoUbic: 'palet', esPicking: false, estado: 'PREPARADO', motivo: '', operario: 'Alguien', ts: new Date().toISOString()
    });
    var lineasAntes = leerHoja('LINEAS').filter(function(l) { return l.idPedido === idMecanica; });
    Logger.log('Líneas antes de forzar (esperado 1): ' + lineasAntes.length);

    _borrarLineasDePedido(idMecanica);
    var rMec = _construirEInsertarLineas(idMecanica, 'TESTFORZ_MECANICA', [
      { dir: 'FRESCA-1', ref: 'REF1', ean: 'EAN1', des: 'línea fresca 1', ctd: 2 },
      { dir: 'FRESCA-2', ref: 'REF2', ean: 'EAN2', des: 'línea fresca 2', ctd: 1 }
    ]);
    var lineasDespues = leerHoja('LINEAS').filter(function(l) { return l.idPedido === idMecanica; });
    Logger.log('nLin/nUbic devueltos: ' + JSON.stringify(rMec) + ' · líneas reales tras sustituir: ' + lineasDespues.length +
      ' · dirs: ' + lineasDespues.map(function(l) { return l.dir; }).join(','));
    var mecanicaOk = rMec.nLin === 2 && rMec.nUbic === 2 && lineasDespues.length === 2 &&
      lineasDespues.every(function(l) { return l.dir.indexOf('FRESCA-') === 0; });
    Logger.log(mecanicaOk ? '✓ OK caso 3 (líneas viejas fuera, frescas dentro, conteos correctos)' : '❌ FALLO caso 3');

  } finally {
    idsCreados.forEach(function(id) {
      _borrarLineasDePedido(id);
      var fila = leerHoja('PEDIDOS').find(function(p) { return p.id === id; });
      if (fila) getHoja('PEDIDOS').deleteRow(fila._fila);
    });
    Logger.log('--- Limpieza completa: ' + idsCreados.length + ' pedidos de prueba y sus líneas eliminados ---');
  }
}
```

- [ ] **Paso 2: Push y ejecutar**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

En el editor de Apps Script, abrir `Pruebas.gs` (se autoselecciona `ejecutarPruebaForzarReimportacion` por ser la primera función del archivo) y ejecutar. Revisar el log: los 3 casos deben salir `✓ OK`. Si alguno falla, **no seguir a la Tarea 5** — depurar primero (`systematic-debugging`: leer el error exacto del log antes de tocar nada).

- [ ] **Paso 3: Verificación manual del caso feliz completo (con Pyxis real)**

Los 3 casos anteriores cubren las guardas y la mecánica de sustitución de líneas de forma
aislada y segura, sin depender de qué haya ahora mismo en el inventario Pyxis real (que
cambia cada día). Falta un caso feliz de extremo a extremo pasando por
`importarClasificacion` de verdad con un pedido real. Pide al usuario que señale un pedido
real, actualmente en estado terminal (p.ej. uno que él sepa que ha vuelto de verdad), y
ejecuta a mano desde el editor:

```javascript
importarClasificacion({}, { forzados: [{ ped: 'EL_NUMERO_REAL', tienda: 'LA_TIENDA_REAL', dirsSel: [] }] });
```

Confirmar en el log de ejecución: `forzadosOk` contiene ese número, y en la hoja PEDIDOS ese
pedido volvió a `PENDIENTE` con líneas nuevas en LINEAS. **No ejecutar este paso sin que el
usuario confirme primero qué pedido usar** — es el único paso de esta tarea que toca datos
reales.

Además, comprobar la sincronización a Supabase (Fase 1, ya establecida para el resto de la
función): consultar `select estado, actualizado from public.pedidos where id = '<idPedido>'`
vía el conector MCP de Supabase y confirmar que `estado='PENDIENTE'` y `actualizado` es de
hace unos segundos — mismo patrón de verificación ya usado en el resto de esta migración.

---

### Task 5: Cliente — chips "Forzar" y selector de direcciones (`Clasificador.html`)

**Files:**
- Modify: `Clasificador.html` (HTML: tras el bloque `.acciones`; JS: variables de estado,
  `importar()`, `limpiar()`, funciones nuevas)

- [ ] **Paso 1: Añadir los contenedores HTML**

En `Clasificador.html:135-137`, cambiar:
```html
  <div id="colisiones"></div>
  <div id="avisos"></div>
  <div class="resultado" id="resultado"></div>
```
por:
```html
  <div id="forzables"></div>

  <div class="parcial-box" id="forzarBox" style="display:none">
    <div class="pf-row">
      <span style="font-size:13px;font-weight:700">↩ Forzar <span id="forzarPedNum"></span></span>
      <span class="estado" id="forzarEstado"></span>
      <button class="btn sec mini" onclick="cerrarForzar()">Cancelar</button>
      <button class="btn mini" onclick="confirmarForzar()">Confirmar forzado</button>
    </div>
    <div class="dirs-box" id="forzarDirs"></div>
  </div>

  <div id="colisiones"></div>
  <div id="avisos"></div>
  <div class="resultado" id="resultado"></div>
```

- [ ] **Paso 2: Declarar el estado nuevo junto a las variables existentes**

En `Clasificador.html:163` (justo debajo de `let pedidoBuscado = null;`), añadir:
```javascript
let omitidosForzablesActuales = []; // [{ped, tienda, transporte, estadoLabel}]
let forzando = null;                // {ped, tienda, transporte} mientras el selector está abierto
```

- [ ] **Paso 3: Añadir las funciones de "Forzar"**

Justo antes de la sección `// ---- LIMPIAR ----` (`Clasificador.html:235`), insertar:

```javascript
// ---- FORZAR OMITIDOS POR ESTADO TERMINAL ----
function renderForzables(lista) {
  const cont = document.getElementById('forzables');
  if (!lista.length) { cont.innerHTML = ''; return; }
  cont.innerHTML = `<div class="colision-box">
    <h4>↩ ${lista.length} pedido(s) omitido(s) por estado -- se pueden forzar</h4>
    <div class="lista" style="display:flex;flex-direction:column;gap:6px">` +
    lista.map(f => `<span class="parcial-chip">
        <span class="num">${esc(f.ped)}</span>
        <span>${esc(f.tienda)} · ${esc(f.estadoLabel)} · ${esc(f.transporte)}</span>
        <button class="btn sec mini" onclick="abrirForzar('${esc(f.ped)}','${esc(f.tienda)}')">↩ Forzar</button>
      </span>`).join('') +
    `</div>
  </div>`;
}
function abrirForzar(ped, tienda) {
  document.getElementById('forzarPedNum').textContent = ped;
  document.getElementById('forzarEstado').textContent = 'Buscando direcciones…';
  document.getElementById('forzarDirs').classList.remove('show');
  document.getElementById('forzarDirs').innerHTML = '';
  document.getElementById('forzarBox').style.display = 'block';
  forzando = null;
  google.script.run
    .withSuccessHandler(data => onDireccionesForzar(ped, tienda, data))
    .withFailureHandler(e => { document.getElementById('forzarEstado').textContent = 'Error: ' + e.message; })
    .obtenerPedido(ped, tienda);
}
function onDireccionesForzar(ped, tienda, data) {
  if (!data || !data.dirs.length) {
    document.getElementById('forzarEstado').textContent = 'Ya no está en el inventario Pyxis -- no se puede forzar.';
    return;
  }
  forzando = { ped: ped, tienda: tienda };
  document.getElementById('forzarEstado').textContent = data.dirs.length + ' direcciones disponibles';
  const box = document.getElementById('forzarDirs');
  box.innerHTML = `<div class="dirs-tools">
      <span>${data.dirs.length} direcciones</span>
      <button onclick="marcarDirsForzar(true)">Todas</button>
      <button onclick="marcarDirsForzar(false)">Ninguna</button>
    </div>` + data.dirs.map(d => `
    <label class="dir-item">
      <input type="checkbox" class="dir-chk-forzar" value="${esc(d.dir)}" checked>
      <span class="d">${esc(d.dir)}</span><span class="ds">${esc(d.des)}</span>
    </label>`).join('');
  box.classList.add('show');
}
function marcarDirsForzar(v) { document.querySelectorAll('.dir-chk-forzar').forEach(c => c.checked = v); }
function cerrarForzar() {
  document.getElementById('forzarBox').style.display = 'none';
  document.getElementById('forzarDirs').classList.remove('show');
  forzando = null;
}
function confirmarForzar() {
  if (!forzando) return;
  const dirsSel = [...document.querySelectorAll('.dir-chk-forzar:checked')].map(c => c.value);
  if (!dirsSel.length) { document.getElementById('forzarEstado').textContent = 'Marca al menos una dirección.'; return; }
  if (!confirm('¿Forzar reimportación de ' + forzando.ped + '? Sus líneas actuales se sustituirán por estas ' + dirsSel.length + ' dirección(es) y volverá a Pendiente.')) return;
  document.getElementById('forzarEstado').textContent = 'Forzando…';
  google.script.run
    .withSuccessHandler(onForzado)
    .withFailureHandler(e => { document.getElementById('forzarEstado').textContent = 'Error: ' + e.message; })
    .importarClasificacion({}, { forzados: [{ ped: forzando.ped, tienda: forzando.tienda, dirsSel: dirsSel }] });
}
function onForzado(res) {
  cerrarForzar();
  let msg;
  if (res.forzadosOk && res.forzadosOk.length) {
    msg = '✓ Forzado: ' + res.forzadosOk.join(', ');
    omitidosForzablesActuales = omitidosForzablesActuales.filter(f => res.forzadosOk.indexOf(f.ped) === -1);
  } else if (res.forzadosError && res.forzadosError.length) {
    msg = '✗ ' + res.forzadosError.map(f => f.ped + ' (' + f.motivo + ')').join(', ');
  } else {
    msg = 'Sin cambios.';
  }
  document.getElementById('estado').textContent = msg;
  renderForzables(omitidosForzablesActuales);
}
```

- [ ] **Paso 4: Enganchar `renderForzables` al resultado de `importar()`**

En `Clasificador.html:333-339`, cambiar:
```javascript
    .withSuccessHandler(res => {
      btn.disabled = false;
      let msg = '✓ Importados ' + res.creados.length + ' · omitidos ' + res.omitidos.length + ' · no encontrados ' + res.noEncontrados.length;
      if (res.colisiones && res.colisiones.length) msg += ' · ' + res.colisiones.length + ' colisiones sin resolver';
      if (res.creados.length) msg += '\n✓ ' + res.creados.join(', ');
      if (res.omitidos.length) msg += '\n✗ Omitidos: ' + res.omitidos.join(', ');
      document.getElementById('estado').textContent = msg;
    })
```
por:
```javascript
    .withSuccessHandler(res => {
      btn.disabled = false;
      let msg = '✓ Importados ' + res.creados.length + ' · omitidos ' + res.omitidos.length + ' · no encontrados ' + res.noEncontrados.length;
      if (res.colisiones && res.colisiones.length) msg += ' · ' + res.colisiones.length + ' colisiones sin resolver';
      if (res.creados.length) msg += '\n✓ ' + res.creados.join(', ');
      if (res.omitidos.length) msg += '\n✗ Omitidos: ' + res.omitidos.join(', ');
      document.getElementById('estado').textContent = msg;
      omitidosForzablesActuales = res.omitidosForzables || [];
      renderForzables(omitidosForzablesActuales);
    })
```

- [ ] **Paso 5: Limpiar el estado nuevo en `limpiar()`**

En `Clasificador.html:236-245`, cambiar:
```javascript
function limpiar(){
  TRANSPORTES.forEach(t => { document.getElementById('ta_'+t).value=''; contar(t); });
  parciales = []; tiendaColisiones = null; renderParciales();
  document.getElementById('resultado').innerHTML='';
  document.getElementById('avisos').innerHTML='';
  document.getElementById('colisiones').innerHTML='';
  document.getElementById('estado').textContent='';
  window._ultimaClasificacion = null;
  document.getElementById('btnImportar').disabled = true;
}
```
por:
```javascript
function limpiar(){
  TRANSPORTES.forEach(t => { document.getElementById('ta_'+t).value=''; contar(t); });
  parciales = []; tiendaColisiones = null; renderParciales();
  document.getElementById('resultado').innerHTML='';
  document.getElementById('avisos').innerHTML='';
  document.getElementById('colisiones').innerHTML='';
  document.getElementById('estado').textContent='';
  window._ultimaClasificacion = null;
  document.getElementById('btnImportar').disabled = true;
  omitidosForzablesActuales = [];
  document.getElementById('forzables').innerHTML = '';
  cerrarForzar();
}
```

- [ ] **Paso 6: Push**

```bash
cd "C:\Users\30081048\Desktop\Proyectos\lm_produccion"
clasp push
```

---

### Task 6: Verificación end-to-end en una implementación de PRUEBA (no la de producción)

**Files:** ninguno — solo verificación en el navegador.

- [ ] **Paso 1: Crear (o reutilizar) una implementación de prueba**

En el editor de Apps Script: Implementar → Administrar implementaciones → (si no existe ya
una implementación de prueba) Implementar → Implementación de prueba. Esto da una URL
privada que SIEMPRE sirve el código HEAD recién subido (los cambios de las Tareas 1-5), sin
tocar la URL `/exec` real que usan los operarios ahora mismo.

- [ ] **Paso 2: Recorrido manual con datos reales pero de forma controlada**

Con el usuario (o él mismo, ya que requiere su sesión real de Leroy Merlin — el navegador
Chrome disponible en esta sesión no tiene esa cuenta activa, ver conversación previa):
1. Abrir `?vista=clasificador` en la URL de prueba.
2. Pegar el mismo pedido real que ya se usó en la Tarea 4 Paso 3 (o cualquier otro pedido
   real conocido en estado terminal) → Clasificar → Importar al sistema.
3. Confirmar que aparece el chip "↩ Forzar" para ese pedido en la nueva sección.
4. Pulsar Forzar → confirmar que se abre el selector con direcciones reales → marcar solo
   alguna (probar el caso parcial) → Confirmar forzado.
5. Confirmar el mensaje de éxito y que el chip desaparece.
6. Abrir 🔍 Buscar sobre ese mismo pedido → confirmar que está en Pendiente, con las nuevas
   líneas, y que el historial de transportista muestra "Volvió (forzado, líneas nuevas)".

Si algo falla en este recorrido, volver a la tarea correspondiente y corregir — **no pasar a
la Tarea 7 sin que este recorrido salga limpio**.

---

### Task 7: Desplegar a producción — REQUIERE CONFIRMACIÓN EXPLÍCITA DEL USUARIO

**Este es el único paso de todo el plan que afecta a los operarios reales ahora mismo en
plataforma.** No ejecutar sin que el usuario diga explícitamente que sí, en ese momento —
mismo criterio ya seguido durante toda la parte de Supabase de este proyecto.

- [ ] **Paso 1: Pedir confirmación explícita, explicando qué va a cambiar para los usuarios**
      ("los operarios verán una sección nueva 'Forzar' en el Clasificador tras importar;
      nada del flujo normal de importación/clasificación cambia").

- [ ] **Paso 2: Solo si el usuario confirma — Implementar → Nueva implementación → Aplicación
      web**, misma configuración que ya tenía (Ejecutar como: Yo; Acceso: según política
      actual), manteniendo la URL `/exec` fija.

- [ ] **Paso 3: Confirmar en la URL real de producción** (no la de prueba) que el Clasificador
      carga bien y que el flujo de importación normal (sin forzar nada) sigue funcionando
      igual que antes.
