# Inventario técnico exacto — LM Málaga (`lm_produccion`)

Preparado como base para una migración de Google Sheets a una base de datos externa.
Todo lo que sigue está verificado leyendo el código en `C:\Users\30081048\Desktop\Proyectos\lm_produccion`
(no se ha asumido nada; se cita archivo y línea). No incluye opinión sobre qué base de datos usar —
la recomendación y el plan están en `2026-07-28-migracion-sheets-supabase-design.md`.

---

## 1. Funciones helper de acceso a datos

Todas viven en **`EstructuraSheets.gs`** (única capa de acceso "oficial"; `Configuracion.gs`
lo confirma explícitamente: *"Toda escritura a Sheets pasa por los helpers de EstructuraSheets.gs"*).

### 1.1 Acceso al Spreadsheet / hoja

| Función | Firma exacta | Qué hace | Memoización |
|---|---|---|---|
| `getSS()` | `getSS()` | Abre (`SpreadsheetApp.openById`) el Spreadsheet activo usando el ID guardado en `PropertiesService`. Lanza error si el sistema no está inicializado. | **Sí** — variable de módulo `_SS_MEMO`, memoizada **por ejecución** (cada invocación de Apps Script reinicia las variables globales, así que nunca queda obsoleta entre peticiones distintas). Comentario explícito: *"openById cuesta ~0,5 s y antes se repetía en cada lectura de hoja"* (EstructuraSheets.gs:129-142). |
| `getHoja(clave)` | `getHoja(clave)` — `clave` es una key de `HOJAS` (p.ej. `'PEDIDOS'`) | Devuelve el objeto `Sheet` correspondiente. Si la hoja no existe físicamente todavía (p.ej. se añadió una hoja nueva al código en producción, como pasó con `VISAS`), la **autocrea** con su cabecera en ese mismo momento. | **Sí** — objeto `_HOJA_MEMO` (diccionario por clave), memoizado por ejecución (EstructuraSheets.gs:147-170). |

### 1.2 Lectura

| Función | Firma exacta | Qué hace |
|---|---|---|
| `leerHoja(clave)` | `leerHoja(clave)` | Lee **la hoja entera** (`getDataRange().getValues()`) y la convierte en array de objetos, usando como cabecera **la constante `COLUMNAS[clave]` del código**, NO la fila 1 física de la hoja (salvo que no haya `COLUMNAS` definido para esa clave). Esto es deliberado: como las columnas solo se añaden al final, una columna nueva se lee bien aunque la hoja antigua tenga cabecera corta. Añade `obj._fila` = número de fila real (1-based) a cada objeto, imprescindible para los updates posteriores. Devuelve `[]` si la hoja está vacía. (EstructuraSheets.gs:172-203) |

**No hay caché de datos entre peticiones para `leerHoja`.** Cada llamada relee la hoja completa desde
Sheets. Un comentario en `Backend.gs:4610` lo confirma sin ambigüedad: *"TODA la app lee esas hojas
enteras en casi cada petición"*. La única "caché" es la memoización de `getSS()`/`getHoja()` (el objeto
Sheet en sí), no de los datos/filas.

### 1.3 Escritura

| Función | Firma exacta | Qué hace |
|---|---|---|
| `anadirFila(clave, obj)` | `anadirFila(clave, obj)` | Añade **una** fila con `sheet.appendRow(...)`, mapeando el objeto a array en el orden exacto de `COLUMNAS[clave]`. Serializa a JSON cualquier valor `object`. Devuelve el nº de fila resultante. (EstructuraSheets.gs:205-219) |
| `anadirFilas(clave, objs)` | `anadirFilas(clave, objs)` | Añade **varias filas de golpe** en una sola escritura (`setValues`, no un `appendRow` por fila). Intenta un `LockService.getScriptLock()` (10 s); si lo consigue, primero **garantiza capacidad de la grid** (`insertRowsAfter` si faltan filas, porque `setValues` no amplía la grid como sí hacía `appendRow`) y escribe con `getRange(...).setValues(...)`. Si NO consigue el lock, cae a `appendRow` fila a fila (atómico por fila, sin el lock). (EstructuraSheets.gs:246-274) |
| `actualizarFila(clave, numFila, cambios)` | `actualizarFila(clave, numFila, cambios)` | Actualiza una fila existente por nº de fila con un objeto **parcial**: relee la fila entera, sobreescribe solo las claves presentes en `cambios`, reescribe la fila completa. Serializa objetos a JSON; `null` → `''`. (EstructuraSheets.gs:221-236) |
| `escribirFila(clave, numFila, obj)` | `escribirFila(clave, numFila, obj)` | Igual que `actualizarFila` pero **sin releer la fila antes** — escribe directo un objeto que YA trae todas las columnas (típicamente uno obtenido de `leerHoja`). La mitad de operaciones que `actualizarFila`. (EstructuraSheets.gs:276-286) |
| `actualizarColumnaLote(clave, numFilas, nombreCol, valor)` | `actualizarColumnaLote(clave, numFilas, nombreCol, valor)` | Escribe el **mismo** valor en una columna para muchas filas en una sola operación, usando `RangeList` (p.ej. marcar el mismo estado en N pedidos). (EstructuraSheets.gs:295-307) |
| `limpiarHoja(clave)` | `limpiarHoja(clave)` | Borra todas las filas de datos de una hoja manteniendo la cabecera (`deleteRows(2, last-1)`). (EstructuraSheets.gs:309-316) |

### 1.4 Helpers de logging / historial (construidos sobre lo anterior)

| Función | Firma exacta | Qué hace |
|---|---|---|
| `logActividad(tipo, detalle, usuario)` | `logActividad(tipo, detalle, usuario)` | `anadirFila('LOG', {ts, tipo, detalle, usuario})`. Envuelto en try/catch: un fallo de log nunca debe bloquear el flujo principal. (EstructuraSheets.gs:319-333) |
| `registrarHistorialTransportista(idPedido, ped, tienda, transportista, flujo, evento)` | igual | `anadirFila('HIST_TRANSP', {...})`. Es **de solo-añadir** (append-only), a diferencia de `PEDIDOS.transportista` que se sobreescribe; existe para no perder el rastro de transportistas anteriores cuando un pedido cambia de transportista o "vuelve" (no se entrega, se recarga otro día). Se llama desde alta de pedido, reclasificación, cambio manual de flujo, reconversión y reapertura. (EstructuraSheets.gs:335-362) |
| `_celda(v)` | `_celda(v)` | Helper interno de serialización de valores de celda (JSON para objetos que no son `Date`, `''` para `null`/`undefined`), compartido por `anadirFilas`/`actualizarFila`/`escribirFila`/`actualizarColumnaLote`. (EstructuraSheets.gs:238-243) |
| `_colLetra(n)` | `_colLetra(n)` | Nº de columna (1-based) → letra A1. Uso interno de `actualizarColumnaLote`. (EstructuraSheets.gs:288-293) |

### 1.5 Otras funciones de estructura (no CRUD de datos, gestión del propio Spreadsheet)

- `inicializarSistema()`, `_crearHojas(ss)`, `repararCabeceras()`, `dondeEstanLosDatos()`,
  `vincularSheetExistente(urlOId)` — creación/reparación/vinculación del Spreadsheet, pensadas para
  ejecutarse a mano desde el editor de Apps Script (no desde la web app).

### 1.6 Otra memoización relevante fuera de EstructuraSheets.gs

- `posicionesPorSiluetaEfectivo()` / `_POS_POR_SILUETA_MEMO` (Configuracion.gs:101-116): mismo patrón
  (memoización por ejecución) para el override de capacidad de siluetas guardado en
  `PropertiesService` (`POSICIONES_POR_SILUETA_OVERRIDE`), fusionado sobre `CONFIG.POSICIONES_POR_SILUETA`.
- `getSSDisponibilidad()` / `_SS_DISPONIBILIDAD_MEMO` (Configuracion.gs:141-147): mismo patrón para el
  Spreadsheet **externo** de "Pedidos Disponibles" (ver sección 5).
- `CacheService.getScriptCache()` se usa en dos sitios **ajenos** a `leerHoja`/`getHoja`:
  - `marcarResumenObsoleto()` / `actualizarResumen()` (Backend.gs:5459-5541): un flag `RESUMEN_OBSOLETO`
    con TTL 6h, para no reconstruir la hoja `RESUMEN_ADMIN` en cada cierre de pedido.
  - `_cacheGetInv()` / `_cachePutInv()` (Inventario.gs:138-176): caché (30 min, `INV_CACHE_KEY='INV_IDX_v1'`)
    del índice de inventario Pyxis (partido en trozos de 90 000 caracteres por el límite de tamaño de
    `CacheService`), para no reconvertir los Excel de Drive en cada clasificación. No tiene relación con
    las 9 hojas de Sheets, pero es caché real (persiste entre ejecuciones, a diferencia de `_SS_MEMO`).

---

## 2. Todos los usos de `LockService` (grep completo, 15 ocurrencias: 12 locks reales + 1 comentario + 2 más)

`grep "LockService"` da **15 líneas en 3 archivos**: `Backend.gs` (13, de las cuales 1 es solo un
comentario que menciona el término), `EstructuraSheets.gs` (1) e `ImportarClasificacion.gs` (1).
Todas usan `LockService.getScriptLock()` (nunca `getUserLock()`/`getDocumentLock()`) con `tryLock(ms)`
y liberación en `finally`; si no se consigue el lock en el timeout, cada función tiene su propia
estrategia de fallback (no bloquean nunca la petición esperando indefinidamente).

| Archivo:línea | Función | Timeout | Invariante que protege |
|---|---|---|---|
| `EstructuraSheets.gs:258` | `anadirFilas(clave, objs)` | 10 s | Que dos ejecuciones simultáneas no "pisen" las mismas filas al escribir en bloque con `setValues`, y garantiza capacidad de la grid antes de escribir (ver 1.3). Si no consigue el lock, cae a `appendRow` fila a fila (atómico por fila, sin el candado). |
| `Backend.gs:94` (`actualizarPosicionesSilueta`) | ajuste manual de capacidad de silueta | 10 s | El override de capacidad es **un único JSON con todas las siluetas dentro** en `PropertiesService`; sin el candado, dos admins guardando casi a la vez (misma silueta o distinta) harían que la segunda escritura **pisara por completo** el JSON de la primera (read-modify-write clásico), perdiendo en silencio el cambio recién guardado. |
| `Backend.gs:299` (`marcarDireccion`) | marcar todas las líneas de una dirección | 15 s | Si dos marcas del mismo pedido se solapan (el frontend `gasBg` no espera entre direcciones), la segunda debe leer **después** de que la primera escriba, o el `pct`/`estado` del pedido se grabaría sin contar la otra marca. |
| `Backend.gs:553` (`intentarCompartirFrenteRemansur`) | compartir el "delante" de una posición Remansur | 10 s | **Es el candado más cercano al ejemplo mencionado** (dos operarios ocupando la misma posición de silueta): evita que dos pedidos Remansur cerrándose casi a la vez intenten compartir **el mismo delante**; sin el candado, el segundo en escribir "ganaría" en silencio y el primero quedaría con datos inconsistentes. |
| `Backend.gs:886` (`quitarPedidoDeCarga`) | sacar un pedido de una carga activa | 10 s | Si dos administradores quitan pedidos **distintos** de la MISMA carga casi a la vez, sin el candado la segunda escritura de `items` (JSON con todo el snapshot de la carga) pisaría a la primera partiendo de una copia ya obsoleta — el pedido quitado antes "reaparecería". Comentario explícito: no se anida con otros locks. |
| `Backend.gs:933` (`_quitarPedidoDeSuCargaActiva`) | mismo patrón, invocado internamente | 10 s | Mismo invariante que `quitarPedidoDeCarga`, reutilizado por cualquier función que resuelva un pedido "por otra vía" (liberar a almacén/tienda, convertir a Ya Cargados) sin pasar por `quitarPedidoDeCarga`. |
| `Backend.gs:958` (`_sincronizarFlujoEnCargaActiva`) | sincronizar transportista/flujo en una carga ya generada | 10 s | Evita que una carga activa quede con el snapshot de transportista/flujo **desactualizado** tras una reclasificación, si dos escrituras sobre `CARGAS.items` coincidieran. |
| `Backend.gs:1010` (`eliminarCargaCompleta`) | borrar una carga entera | 10 s | Protege la lectura+decisión+escritura de "¿está la carga en estado GENERADA? bórrala" frente a otra operación concurrente sobre la misma carga. |
| `Backend.gs:1048` (`anadirPedidoACarga`) | añadir un pedido a una carga ya creada | 10 s | Mismo patrón: lee `CARGAS.items` (JSON), decide, reescribe; el candado evita que dos altas casi simultáneas sobre la misma carga se pisen. |
| `Backend.gs:3602` (`liberarPosicionesLote`) | liberar varios rangos de `OCUPACION` de golpe | 10 s | No chocar con **cierres de pedido simultáneos** sobre la misma hoja `OCUPACION`. Si no consigue el lock, cae al método clásico (`liberarPosiciones` fila a fila, sin candado). |
| `Backend.gs:3716` (`sincronizarPosicionEnCargaActiva`) | actualizar posición vieja→nueva dentro del snapshot de una carga activa | 10 s | Explícito en el comentario: `quitarPedidoDeCarga()` **también** lee-modifica-escribe `CARGAS.items` bajo su propio candado — sin este, un "mover" y un "quitar" casi simultáneos sobre la MISMA carga podrían pisarse. Se llama **secuencialmente**, nunca anidado con otro lock. |
| `Backend.gs:3742` (`_sincronizarPosicionesEnCargasLote`) | igual que el anterior, pero en lote (varias cargas) | 10 s | Mismo invariante, versión batch. |
| `Backend.gs:4648` (`purgarPedidosAntiguos`) | purga de pedidos resueltos >90 días | 10 s | Que la decisión "qué se borra" y el borrado en sí se calculen sobre **la misma lectura**, dentro del candado (no decidido antes y aplicado después) — cierra la ventana en la que algo pudiera cambiar entre decidir y borrar. |
| `ImportarClasificacion.gs:154` (`resincronizarPedidosActivos`) | reimportación periódica (cada 15 min, disparador) | **2 s** (único timeout corto) | Evita que dos pases de reimportación se solapen (uno manual + uno automático, o un pase que tarda >15 min con inventario grande) y acaben creando la **misma línea nueva duplicada** por partida doble. Si no consigue el lock en 2 s, **no espera**: devuelve `omitidoPorSolape:true`. |

### Hallazgo relevante: qué NO está bajo lock

Dos rutas críticas — **`cerrarPedido()`** (asigna un pedido a una posición de silueta, Backend.gs:619-702)
y **`confirmarEntregas()`** (libera siluetas al confirmar entrega, Backend.gs:1103+) — **no tienen su
propio `LockService` en el nivel superior**. En `cerrarPedido()`: `leerHoja('PEDIDOS')` →
`validarAsignacionManual()` (lee `OCUPACION`) → `anadirFilas('OCUPACION', ...)` (su lock solo garantiza
capacidad de grid, no serializa el check-then-write de "¿está libre?"). Solo el sub-caso "compartir
delante Remansur" tiene lock explícito. El propio código lo documenta como riesgo **aceptado
conscientemente** (Backend.gs:4627-4641): *"Riesgo residual ACEPTADO conscientemente... otras funciones
(moverPedidoDeSilueta, liberarPedidoDeSilueta, confirmarEntregas) leen el número de fila... y escriben
sobre él más tarde SIN este mismo candado... Mitigado en la práctica porque la operativa está CERRADA
de 22:00 a 06:00"*. Para una migración con más concurrencia real, esta ventana de carrera en la
asignación de posiciones es un punto a decidir explícitamente.

---

## 3. Las 9 hojas del sistema — copia literal de `Configuracion.gs`

```javascript
// === NOMBRES DE HOJAS ===
const HOJAS = {
  PEDIDOS: 'PEDIDOS',
  LINEAS: 'LINEAS_PREPARACION',
  OCUPACION: 'OCUPACION_SILUETAS',
  CARGAS: 'CARGAS',
  HISTORIAL: 'HISTORIAL_ENTREGAS',
  LOG: 'LOG_ACTIVIDAD',
  VISAS: 'VISAS',
  RETIRADAS: 'RETIRADAS_STOCK',
  HIST_TRANSP: 'HISTORIAL_TRANSPORTISTA'
};

// === COLUMNAS DE CADA HOJA (orden exacto) ===
const COLUMNAS = {
  PEDIDOS: ['id', 'ped', 'tienda', 'transportista', 'flujo', 'estado', 'pct',
            'operario', 'silueta', 'posIni', 'posFin', 'numeroCarga', 'soportes', 'nLin', 'nUbic', 'actualizado', 'intentoCarga', 'comentario', 'tipoEntrega', 'enRevision', 'sdImpreso'],
  LINEAS: ['id', 'idPedido', 'idx', 'dir', 'ref', 'ean', 'des', 'ctd',
           'tipoUbic', 'esPicking', 'estado', 'motivo', 'operario', 'ts', 'muelleHecho'],
  OCUPACION: ['silueta', 'pos', 'layer', 'pedido', 'tienda', 'flujo', 'reservado'],
  CARGAS: ['id', 'numCarga', 'fecha', 'estado', 'items', 'responsable', 'cargador', 'fechaCierre'],
  HISTORIAL: ['pedido', 'tienda', 'transportista', 'silueta', 'posIni', 'posFin', 'cargador', 'ts', 'confirmadoTs', 'responsable'],
  LOG: ['ts', 'tipo', 'detalle', 'usuario'],
  VISAS: ['id', 'ped', 'tienda', 'estado', 'numeroCarga', 'fechaAlta', 'fechaResuelta', 'motivoAlerta'],
  RETIRADAS: ['fecha', 'tienda', 'pedido', 'cliente', 'resultado', 'code', 'ts'],
  HIST_TRANSP: ['id', 'idPedido', 'ped', 'tienda', 'transportista', 'flujo', 'evento', 'fecha']
};
```

(`Configuracion.gs:150-175`, literal.) `PEDIDOS` tiene 21 columnas (`intentoCarga`, `comentario`,
`tipoEntrega`, `enRevision`, `sdImpreso` se añadieron después del set original de 16). `LINEAS` tiene 15
columnas (`muelleHecho` es la más reciente). El `CLAUDE.md` de planificación inicial en la raíz del
proyecto documenta un modelo de datos más antiguo con menos columnas — **está desactualizado**; para la
migración hay que usar la lista de arriba, no ese documento.

**Importante**: el sistema tiene además una **10ª hoja física no listada en `HOJAS`/`COLUMNAS`**
(`RESUMEN_ADMIN`) construida con la API de Sheets directamente, fuera de toda la capa de acceso descrita
en la sección 1 — ver hallazgo en la sección 5.

---

## 4. Volumen aproximado de datos

El código **no fija un límite de filas** para `PEDIDOS`/`LINEAS`/`OCUPACION` — `leerHoja` relee la hoja
entera en cada petición sin paginar. Datos concretos de volumen encontrados:

- **Cifra real citada como validación** (`Inventario.gs:19`): *"validada contra un export real (**036 =
  Málaga: 4014 líneas → 1313 pedidos**)"*. Export de Pyxis de la tienda Málaga en un momento dado — 4014
  filas de línea/ubicación agrupadas en 1313 pedidos (≈3 líneas/pedido de media). No etiquetado
  explícitamente "por día", pero es la mejor aproximación en el código al volumen de pedidos "vivos".
- **3 tiendas activas en siluetas** (`CONFIG.TIENDAS = ['Málaga', 'Marbella', 'Mijas']`, Configuracion.gs:34),
  aunque `CONFIG.CODIGO_TIENDA` y los mapas de Disponibilidad/Retiradas incluyen una 4ª, **Granada**
  (código `043`) — inconsistencia no resuelta en el código, a confirmar con el equipo.
- **Purga automática a 90 días** (`PURGA_DIAS_ANTIGUEDAD = 90`, Backend.gs:4602; `PURGA_INTERVALO_DIAS = 90`,
  SnapshotDiario.gs:97): pedidos terminales con >90 días desde `actualizado` se borran cada noche a las
  23:00. El comentario (Backend.gs:4604-4612) confirma el motivo: *"TODA la app lee esas hojas enteras en
  casi cada petición, así que con los años irían ralentizando cada vez más"* — el propio equipo ya
  identificó el crecimiento de filas como problema de rendimiento, relevante para justificar la migración.
- **Límite de resultados de búsqueda (no de almacenamiento)**: `buscarPedidosFiltro()` (Backend.gs:5617-5625)
  trunca a **200 filas** devueltas *"para no volcar la hoja PEDIDOS entera"* — confirma que la hoja puede
  superar 200 filas activas tranquilamente; no es tope de capacidad, solo de una respuesta de búsqueda.
- No hay cifra explícita de "pedidos/día por tienda". La única referencia día-a-día explícita es
  operativa: `CONFIG.HORA_CAMBIO_MODO = 14` (mañana <14h expide lo preparado ayer; tarde ≥14h prepara
  mañana), Configuracion.gs:30.

---

## 5. Casos donde el equipo mira o edita las Sheets a mano (dependencias ocultas)

### 5.1 `RESUMEN_ADMIN` — hoja con checkboxes marcados a mano en Sheets (hallazgo principal)

`actualizarResumen()` (Backend.gs:5453-5541) crea/reconstruye una pestaña `RESUMEN_ADMIN` **directamente
con la API de `SpreadsheetApp`**, **fuera de toda la capa `HOJAS`/`COLUMNAS`/`leerHoja`/`actualizarFila`**
— es una 10ª hoja ad-hoc, no una de las 9 oficiales. Su última columna, **"Store Delivery"**, son
**checkboxes reales de Google Sheets** que administración marca **a mano, directamente en la hoja** (no
hay pantalla en la web app para esto). Antes de borrar y regenerar la hoja, el código **lee el valor
actual de esos checkboxes por nº de pedido** y los **reescribe** para no perderlos (comentario: *"para no
perder las casillas marcadas a mano al regenerar la hoja"*). El botón "Borrar hoja administración"
avisa: *"Se perderán también las casillas de Store Delivery marcadas... no se recuperan"*. → Migrar esto
exige decidir dónde vive ese estado de checkbox (hoy solo existe en celdas de Sheets).

### 5.2 Ajuste de capacidad de silueta — vía panel admin, guardado en `PropertiesService`

`actualizarPosicionesSilueta()` (Backend.gs:63-112): dato de configuración operativa que vive fuera
tanto de `CONFIG` como de las hojas; la migración debe decidir dónde persistirlo.

### 5.3 Spreadsheet externo "Pedidos Disponibles" — escrito por esta app, gestionado a mano por otro equipo

`DISPONIBILIDAD_SHEET_ID` (Configuracion.gs:130) es un Spreadsheet **distinto y externo** (pestañas
DISP_MALAGA/MARBELLA/MIJAS/GRANADA). `actualizarPaletsBultosDisponibilidad()` (Backend.gs:571-613)
escribe ahí en bruto (`getRange`/`setValue`, sin pasar por la capa de la sección 1) el resumen de
palets/bultos, **igual que el otro equipo lo escribiría a mano** (comentario explícito). Este
Spreadsheet no debería tocarse al migrar sin coordinarlo aparte con ese equipo externo.

### 5.4 Snapshots diarios en Drive — pensados para abrirse y revisarse a mano

`SnapshotDiario.gs::generarSnapshotPedidos()` genera cada día laborable (23:00) un Google Sheet nuevo y
permanente con el estado de todos los pedidos, archivado en Drive. Comentario: *"sirve de histórico para
revisar que se ha sacado todo"* — pensado para lectura humana en Drive; ninguna función de la app lo
relee después.

### 5.5 `RESUMEN_ADMIN` se abre "desde Drive" para consulta manual

Comentario de cabecera (Backend.gs:5421-5422): *"Se abre desde Drive"* — confirma que, aparte de los
checkboxes (5.1), esta pestaña es una vista de consulta que el admin abre directamente en Sheets.

### 5.6 `RETIRADAS_STOCK` — hoja definida en el esquema pero SIN ningún lector/escritor activo hoy

`RETIRADAS_STOCK` está en `HOJAS`/`COLUMNAS` con columnas para registrar resultados, pero `grep RETIRADAS`
en `Backend.gs` **no da resultados**: ninguna función llama a `anadirFila('RETIRADAS', ...)` ni
`leerHoja('RETIRADAS')`. La función real ("Retiradas de pedido") está en `Index.html::descargarProgramaRetiradas()`
(líneas 4622-4708) como script de PowerShell **descargable que el operario ejecuta en su propio PC**
— *"nada de esto pasa por el servidor de Apps Script... Leroy Merlin bloquea las llamadas que salen de
plataformas de nube... pero no las de un PC normal"*. Ese script solo imprime resultados en la consola
local (`Write-Host`); no sube nada de vuelta ni a la app ni a `RETIRADAS_STOCK`. Existe un plan
(`docs/superpowers/plans/2026-07-20-retiradas-store-delivery.md`) que describía una arquitectura
server-side distinta con `anadirFila('RETIRADAS', ...)` explícito, descartada por el bloqueo de Adeo.
**Conclusión**: `RETIRADAS_STOCK` es hoy una hoja del esquema sin flujo de datos real — confirmar con el
equipo antes de migrarla.

### 5.7 Subida manual del inventario Pyxis a Drive (proceso previo, ahora semi-automatizado)

`Inventario.gs:319-323`: *"antes el proceso era manual: alguien sacaba el listado en Pyxis y lo subía a
mano a Drive"* (origen probable de un bug histórico de inventario desactualizado). Existe un "Robot de
inventarios" (script descargable) que automatiza la subida, pero sigue corriendo fuera de la app.

### 5.8 Funciones de mantenimiento para ejecutar a mano desde el editor de Apps Script

`inicializarSistema()`, `repararCabeceras()`, `dondeEstanLosDatos()`, `vincularSheetExistente()`
(EstructuraSheets.gs); `probarSnapshotAhora()`, `probarPurgaAhora()` (SnapshotDiario.gs);
`repararOcupacionInconsistente()`, `repararCerradosSinSiluetaAtascados()` — vía de intervención humana
directa que se salta la web app (sí usan los helpers de la sección 1, no editan celdas a mano) y que una
BD externa tendría que reproducir de algún modo (consola/admin tool).

---

## Archivos citados
`Configuracion.gs`, `EstructuraSheets.gs`, `Backend.gs`, `ImportarClasificacion.gs`, `ImportarPyxis.gs`,
`Inventario.gs`, `SnapshotDiario.gs`, `Index.html`, `WebApp.gs`, `CLAUDE.md` (desactualizado),
`docs/superpowers/plans/2026-07-20-retiradas-store-delivery.md`.

---

## Los tres hallazgos que más importan para diseñar la migración

1. `cerrarPedido()`/`confirmarEntregas()` no tienen lock propio — riesgo de carrera aceptado hoy solo
   porque la operativa está cerrada de noche.
2. `RESUMEN_ADMIN` es una 10ª hoja fuera del esquema con checkboxes editados a mano que el código trata
   como fuente de verdad.
3. `RETIRADAS_STOCK` está en el esquema pero no tiene ningún lector/escritor activo — probablemente hoja
   muerta tras el cambio a PowerShell client-side.
