# Incidencias (panel admin + panel operario) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir un módulo de Incidencias (2 hojas nuevas, backend en `Incidencias.gs`, pestaña nueva en `Index.html`) para que administración dé de alta incidencias sobre un pedido y el equipo de operarios las trabaje desde el móvil con un hilo de comentarios (texto + fotos), según la spec aprobada en `docs/superpowers/specs/2026-09-24-incidencias-operario-admin-design.md`.

**Architecture:** Todo en el Apps Script existente. Dos hojas nuevas (`INCIDENCIAS` cabecera + `INCIDENCIAS_COMENTARIOS` hilo) declaradas en `Configuracion.gs` — se autocrean vía `getHoja()` (`EstructuraSheets.gs`), sin tocar ese archivo. Backend nuevo en `Incidencias.gs`, usando los mismos helpers (`anadirFila`/`actualizarFila`/`leerHoja`/`buscarFilaPorCampo`/`buscarFilasPorCampo`) que el resto del proyecto — ninguna de las dos hojas está en `TABLAS_PUBLIC_` (Postgres), así que se comportan como Sheets normales sin cambios en `Pieza3Publico.gs`. Fotos a Google Drive (`DriveApp`, servicio core, sin tocar `appsscript.json`), compartidas por enlace de dominio para que se vean en un `<img>`. Frontend nuevo en `Index.html`: pestaña "🚨 Incidencias" (visible en `TABS_ADMIN` y `TABS_OPERARIO`), tres pantallas nuevas (listado+alta admin, listado operario, detalle común), con redimensionado de fotos en `<canvas>` antes de enviarlas.

**Tech Stack:** Google Apps Script (`.gs`, sin arrow functions ni template literals), HTML/JS de cliente (`Index.html`, ES6 permitido), Google Sheets como almacenamiento, `DriveApp` para las fotos.

---

## Nota sobre pruebas y verificación (leer antes de empezar)

Este proyecto **no tiene runner de tests** para Apps Script (confirmado por convención existente: funciones `probarX()` que el usuario ejecuta a mano desde el editor de Apps Script y lee en Ver → Registros — ver `probarNotificacion()`, `probarRetiradaPedido()`). Por eso:

- No hay "run pytest". La verificación de cada tarea de backend es: `clasp push` sin error + ejecutar manualmente la función `probarX` correspondiente desde el editor.
- La verificación del frontend es manual en el navegador (no se puede renderizar una plantilla de Apps Script en local).
- **Antes de la primera prueba real tras este cambio**, el usuario tendrá que volver a autorizar el script: `Incidencias.gs` usa `DriveApp` (creación de carpetas/archivos), un ámbito (`https://www.googleapis.com/auth/drive`) que el proyecto no pedía hasta ahora. Apps Script lo añadirá solo (detección automática de ámbitos, `appsscript.json` no tiene `oauthScopes` explícito) pero la primera ejecución pedirá reautorizar.
- Cada tarea de código termina con `git add` + `git commit` (si el repo tiene cambios que commitear) — no hay que esperar a que el usuario lo pida para cada commit local, pero **no se hace push a ningún remoto salvo que el usuario lo pida explícitamente** en su turno.

---

### Task 1: Hojas nuevas + carpeta de Drive (`Configuracion.gs`)

**Files:**
- Modify: `Configuracion.gs:8-16` (par `getSpreadsheetId`/`setSpreadsheetId`)
- Modify: `Configuracion.gs:174-184` (bloque `HOJAS`)
- Modify: `Configuracion.gs:187-199` (bloque `COLUMNAS`)

- [ ] **Step 1: Añadir el par `getIncidenciasFolderId`/`setIncidenciasFolderId`**

En `Configuracion.gs`, justo debajo de `setSpreadsheetId` (después de la línea 16, antes del comentario `// === WEBHOOK GOOGLE CHAT...`), insertar:

```javascript
// === CARPETA DE DRIVE PARA FOTOS DE INCIDENCIAS ===
// Se crea automáticamente la primera vez que se sube una foto. Guardada en
// PropertiesService, mismo patrón que SPREADSHEET_ID.
function getIncidenciasFolderId() {
  return PropertiesService.getScriptProperties().getProperty('INCIDENCIAS_FOLDER_ID');
}
function setIncidenciasFolderId(id) {
  PropertiesService.getScriptProperties().setProperty('INCIDENCIAS_FOLDER_ID', id);
}
```

- [ ] **Step 2: Añadir las claves de hoja a `HOJAS`**

Sustituir:

```javascript
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
```

por:

```javascript
const HOJAS = {
  PEDIDOS: 'PEDIDOS',
  LINEAS: 'LINEAS_PREPARACION',
  OCUPACION: 'OCUPACION_SILUETAS',
  CARGAS: 'CARGAS',
  HISTORIAL: 'HISTORIAL_ENTREGAS',
  LOG: 'LOG_ACTIVIDAD',
  VISAS: 'VISAS',
  RETIRADAS: 'RETIRADAS_STOCK',
  HIST_TRANSP: 'HISTORIAL_TRANSPORTISTA',
  INCIDENCIAS: 'INCIDENCIAS',
  INC_COMENTARIOS: 'INCIDENCIAS_COMENTARIOS'
};
```

- [ ] **Step 3: Añadir las columnas de las 2 hojas nuevas a `COLUMNAS`**

Sustituir la línea final del bloque `COLUMNAS`:

```javascript
  HIST_TRANSP: ['id', 'idPedido', 'ped', 'tienda', 'transportista', 'flujo', 'evento', 'fecha']
};
```

por:

```javascript
  HIST_TRANSP: ['id', 'idPedido', 'ped', 'tienda', 'transportista', 'flujo', 'evento', 'fecha'],
  INCIDENCIAS: ['id', 'idPedido', 'ped', 'tienda', 'tipo', 'prioridad', 'estado', 'asignado', 'creadoPor', 'creadoTs', 'actualizado'],
  INC_COMENTARIOS: ['id', 'idIncidencia', 'autor', 'rol', 'texto', 'fotos', 'ts']
};
```

- [ ] **Step 4: Comprobación estática**

Releer el archivo completo y confirmar que las llaves/comas de `HOJAS` y `COLUMNAS` quedan bien cerradas. No hace falta ejecutar `inicializarSistema()` a mano — `getHoja()` autocrea la hoja la primera vez que algo la usa (mismo mecanismo que `VISAS`/`RETIRADAS`, ver `EstructuraSheets.gs:148-170`).

- [ ] **Step 5: Commit**

```bash
git add Configuracion.gs
git commit -m "Añadir hojas INCIDENCIAS/INCIDENCIAS_COMENTARIOS y carpeta de Drive"
```

---

### Task 2: Backend — fotos a Drive y `crearIncidencia` (`Incidencias.gs`, parte 1)

**Files:**
- Create: `Incidencias.gs`

- [ ] **Step 1: Crear el archivo con la cabecera y los helpers de fotos**

```javascript
/**
 * ============================================================
 * Incidencias.gs
 * Módulo de incidencias: administración da de alta, el equipo de
 * operarios las trabaja desde el móvil con un hilo de comentarios
 * (texto + fotos). Siempre ligadas a un pedido existente.
 * Ver docs/superpowers/specs/2026-09-24-incidencias-operario-admin-design.md
 * ============================================================
 */

// === FOTOS (Google Drive) ===

function _carpetaIncidenciasRaiz_() {
  var id = getIncidenciasFolderId();
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* ID inválido: se recrea abajo */ }
  }
  var carpeta = DriveApp.createFolder('Incidencias LM Málaga');
  setIncidenciasFolderId(carpeta.getId());
  return carpeta;
}

function _subcarpetaIncidencia_(idIncidencia, ped) {
  var raiz = _carpetaIncidenciasRaiz_();
  var nombre = 'INC-' + idIncidencia + '-' + ped;
  var it = raiz.getFoldersByName(nombre);
  if (it.hasNext()) return it.next();
  return raiz.createFolder(nombre);
}

/**
 * Guarda UNA foto (base64) en la subcarpeta de la incidencia, la comparte
 * por enlace de dominio (si no, el operario que no sea el dueño del
 * archivo ve un icono roto en vez de la foto) y devuelve su fileId.
 */
function _guardarFotoIncidencia(idIncidencia, ped, base64, mime) {
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, mime || 'image/jpeg', idIncidencia + '_' + new Date().getTime() + '.jpg');
  var carpeta = _subcarpetaIncidencia_(idIncidencia, ped);
  var archivo = carpeta.createFile(blob);
  archivo.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  return archivo.getId();
}

/**
 * Guarda hasta 4 fotos (array de { base64, mime }), en orden, ignorando
 * silenciosamente cualquiera que falle (no debe bloquear el resto).
 * Devuelve el array de fileIds guardados.
 */
function _guardarFotosIncidencia(idIncidencia, ped, fotosBase64) {
  var ids = [];
  (fotosBase64 || []).slice(0, 4).forEach(function(f) {
    if (!f || !f.base64) return;
    try { ids.push(_guardarFotoIncidencia(idIncidencia, ped, f.base64, f.mime)); }
    catch (e) { console.error('Error guardando foto de incidencia:', e); }
  });
  return ids;
}
```

- [ ] **Step 2: Añadir `crearIncidencia`**

En el mismo archivo, debajo de lo anterior:

```javascript
// === CREAR (solo administración) ===

/**
 * Crea una incidencia sobre un pedido YA existente (idPedido = PEDIDOS.id).
 * El texto de indicaciones se guarda como el PRIMER comentario del hilo
 * (rol='admin') — no hay un campo de "indicaciones" aparte.
 */
function crearIncidencia(idPedido, tipo, prioridad, asignado, texto, fotosBase64) {
  var pedido = buscarFilaPorCampo('PEDIDOS', 'id', idPedido);
  if (!pedido) return { ok: false, error: 'Pedido no encontrado' };
  var txt = String(texto || '').trim();
  if (!txt) return { ok: false, error: 'Escribe las indicaciones para el equipo' };

  var ahora = new Date().toISOString();
  var idIncidencia = 'INC_' + new Date().getTime();

  anadirFila('INCIDENCIAS', {
    id: idIncidencia,
    idPedido: pedido.id,
    ped: pedido.ped,
    tienda: pedido.tienda,
    tipo: tipo,
    prioridad: prioridad || 'NORMAL',
    estado: 'PENDIENTE',
    asignado: asignado || '',
    creadoPor: 'Administración',
    creadoTs: ahora,
    actualizado: ahora
  });

  var fotoIds = _guardarFotosIncidencia(idIncidencia, pedido.ped, fotosBase64 || []);
  anadirFila('INC_COMENTARIOS', {
    id: 'INCC_' + new Date().getTime(),
    idIncidencia: idIncidencia,
    autor: 'Administración',
    rol: 'admin',
    texto: txt,
    fotos: fotoIds,
    ts: ahora
  });

  logActividad('INCIDENCIA_CREADA', 'Incidencia ' + idIncidencia + ' · pedido ' + pedido.ped + ' (' + tipo + ')', 'admin');
  return { ok: true, id: idIncidencia };
}
```

- [ ] **Step 3: Comprobación estática**

Confirmar que no hay arrow functions ni template literals, y que `buscarFilaPorCampo`, `anadirFila`, `logActividad` ya existen en el proyecto (`EstructuraSheets.gs`) — no hace falta definirlos de nuevo.

- [ ] **Step 4: `clasp push`**

```bash
clasp push
```

Expected: `Incidencias.gs` (y `Configuracion.gs`) listados sin error de sintaxis.

- [ ] **Step 5: Commit**

```bash
git add Incidencias.gs
git commit -m "Añadir Incidencias.gs: fotos a Drive + crearIncidencia"
```

---

### Task 3: Backend — listar, ver, comentar, cerrar y reasignar (`Incidencias.gs`, parte 2)

**Files:**
- Modify: `Incidencias.gs` (añadir al final del archivo creado en Task 2)

- [ ] **Step 1: Añadir `listarIncidencias` y `obtenerIncidenciaConComentarios`**

```javascript
// === LISTAR Y VER DETALLE ===

/**
 * filtros = { estado, tienda, tipo, asignado } — todos opcionales. Para
 * "asignado": pasar '' explícitamente filtra el pool (sin asignar); no
 * pasar la clave devuelve todos los asignados y sin asignar mezclados.
 */
function listarIncidencias(filtros) {
  filtros = filtros || {};
  var filas = leerHoja('INCIDENCIAS');
  var res = filas.filter(function(f) {
    if (filtros.estado && f.estado !== filtros.estado) return false;
    if (filtros.tienda && f.tienda !== filtros.tienda) return false;
    if (filtros.tipo && f.tipo !== filtros.tipo) return false;
    if (filtros.asignado !== undefined && filtros.asignado !== null && String(f.asignado || '') !== String(filtros.asignado)) return false;
    return true;
  });
  res.sort(function(a, b) { return String(b.actualizado || '').localeCompare(String(a.actualizado || '')); });
  return res.map(function(f) {
    return {
      id: f.id, ped: f.ped, tienda: f.tienda, tipo: f.tipo, prioridad: f.prioridad,
      estado: f.estado, asignado: f.asignado || '', creadoPor: f.creadoPor,
      creadoTs: f.creadoTs, actualizado: f.actualizado
    };
  });
}

function obtenerIncidenciaConComentarios(idIncidencia) {
  var inc = buscarFilaPorCampo('INCIDENCIAS', 'id', idIncidencia);
  if (!inc) return { ok: false, error: 'Incidencia no encontrada' };
  var comentarios = buscarFilasPorCampo('INC_COMENTARIOS', 'idIncidencia', idIncidencia);
  comentarios.sort(function(a, b) { return String(a.ts).localeCompare(String(b.ts)); });
  return {
    ok: true,
    incidencia: {
      id: inc.id, ped: inc.ped, tienda: inc.tienda, tipo: inc.tipo, prioridad: inc.prioridad,
      estado: inc.estado, asignado: inc.asignado || '', creadoPor: inc.creadoPor, creadoTs: inc.creadoTs
    },
    comentarios: comentarios.map(function(c) {
      return { id: c.id, autor: c.autor, rol: c.rol, texto: c.texto, fotos: parseJSON(c.fotos, []), ts: c.ts };
    })
  };
}
```

- [ ] **Step 2: Añadir `anadirComentarioIncidencia`**

```javascript
// === HILO DE COMENTARIOS (admin y operario) ===

/**
 * Añade un comentario (texto y/o fotos) al hilo. Si quien comenta es un
 * operario: si la incidencia estaba sin 'asignado' se autoasigna a
 * 'autor', y si estaba PENDIENTE pasa a EN_CURSO. Un comentario de admin
 * nunca cambia asignado ni estado — solo da indicaciones.
 */
function anadirComentarioIncidencia(idIncidencia, autor, rol, texto, fotosBase64) {
  var inc = buscarFilaPorCampo('INCIDENCIAS', 'id', idIncidencia);
  if (!inc) return { ok: false, error: 'Incidencia no encontrada' };
  if (inc.estado === 'RESUELTA' || inc.estado === 'CANCELADA') return { ok: false, error: 'Esta incidencia ya está cerrada' };

  var txt = String(texto || '').trim();
  var fotos = fotosBase64 || [];
  if (!txt && !fotos.length) return { ok: false, error: 'Escribe un texto o adjunta una foto' };

  var ahora = new Date().toISOString();
  var fotoIds = _guardarFotosIncidencia(idIncidencia, inc.ped, fotos);

  anadirFila('INC_COMENTARIOS', {
    id: 'INCC_' + new Date().getTime(),
    idIncidencia: idIncidencia, autor: autor, rol: rol, texto: txt, fotos: fotoIds, ts: ahora
  });

  var cambios = { actualizado: ahora };
  if (rol === 'operario') {
    if (!inc.asignado) cambios.asignado = autor;
    if (inc.estado === 'PENDIENTE') cambios.estado = 'EN_CURSO';
  }
  actualizarFila('INCIDENCIAS', inc._fila, cambios);

  return { ok: true };
}
```

- [ ] **Step 3: Añadir `cambiarEstadoIncidencia` y `reasignarIncidencia`**

```javascript
// === CERRAR (Resolver / Cancelar) Y REASIGNAR ===

/**
 * nuevoEstado: 'RESUELTA' (operario) o 'CANCELADA' (admin). Exige texto
 * (nota final) y solo es válido desde PENDIENTE/EN_CURSO — una incidencia
 * ya cerrada no se puede volver a cerrar.
 */
function cambiarEstadoIncidencia(idIncidencia, nuevoEstado, autor, rol, texto, fotosBase64) {
  if (nuevoEstado !== 'RESUELTA' && nuevoEstado !== 'CANCELADA') return { ok: false, error: 'Estado no válido' };
  var inc = buscarFilaPorCampo('INCIDENCIAS', 'id', idIncidencia);
  if (!inc) return { ok: false, error: 'Incidencia no encontrada' };
  if (inc.estado !== 'PENDIENTE' && inc.estado !== 'EN_CURSO') return { ok: false, error: 'Esta incidencia ya está cerrada' };
  var txt = String(texto || '').trim();
  if (!txt) return { ok: false, error: 'Escribe una nota antes de cerrar la incidencia' };

  var ahora = new Date().toISOString();
  var fotoIds = _guardarFotosIncidencia(idIncidencia, inc.ped, fotosBase64 || []);

  anadirFila('INC_COMENTARIOS', {
    id: 'INCC_' + new Date().getTime(),
    idIncidencia: idIncidencia, autor: autor, rol: rol, texto: txt, fotos: fotoIds, ts: ahora
  });

  actualizarFila('INCIDENCIAS', inc._fila, { estado: nuevoEstado, actualizado: ahora });
  logActividad('INCIDENCIA_' + nuevoEstado, 'Incidencia ' + idIncidencia + ' · pedido ' + inc.ped, autor);
  return { ok: true };
}

// Solo la llama la UI de admin.
function reasignarIncidencia(idIncidencia, nuevoAsignado) {
  var inc = buscarFilaPorCampo('INCIDENCIAS', 'id', idIncidencia);
  if (!inc) return { ok: false, error: 'Incidencia no encontrada' };
  actualizarFila('INCIDENCIAS', inc._fila, { asignado: nuevoAsignado || '', actualizado: new Date().toISOString() });
  return { ok: true };
}
```

- [ ] **Step 4: Añadir la función de prueba manual**

```javascript
/**
 * Prueba manual — ejecutar desde el editor de Apps Script (Ejecutar →
 * probarIncidencias). Crea una incidencia de prueba sobre el PRIMER
 * pedido que encuentre (no afecta a datos reales del pedido, solo añade
 * una fila en INCIDENCIAS/INCIDENCIAS_COMENTARIOS — se puede borrar a
 * mano después desde la hoja).
 */
function probarIncidencias() {
  var pedidos = leerHoja('PEDIDOS');
  if (!pedidos.length) { Logger.log('No hay pedidos para probar.'); return; }
  var pedido = pedidos[0];
  var r = crearIncidencia(pedido.id, 'OTRA', 'NORMAL', '', 'Prueba automática desde probarIncidencias()', []);
  Logger.log('crearIncidencia: ' + JSON.stringify(r));
  if (!r.ok) return;
  var detalle = obtenerIncidenciaConComentarios(r.id);
  Logger.log('obtenerIncidenciaConComentarios: ' + JSON.stringify(detalle));
  var com = anadirComentarioIncidencia(r.id, 'Operario de prueba', 'operario', 'Comentario de prueba', []);
  Logger.log('anadirComentarioIncidencia: ' + JSON.stringify(com));
  var cierre = cambiarEstadoIncidencia(r.id, 'RESUELTA', 'Operario de prueba', 'operario', 'Resuelta en la prueba', []);
  Logger.log('cambiarEstadoIncidencia: ' + JSON.stringify(cierre));
}
```

- [ ] **Step 5: `clasp push`**

```bash
clasp push
```

Expected: todos los archivos suben sin error de sintaxis.

- [ ] **Step 6: Probar manualmente (el usuario, desde el editor de Apps Script)**

Ejecutar `probarIncidencias()` desde el editor, abrir Ver → Registros y confirmar:
1. `crearIncidencia` devuelve `{ ok: true, id: 'INC_...' }`.
2. `obtenerIncidenciaConComentarios` devuelve la incidencia con estado `PENDIENTE` y 1 comentario (rol `admin`).
3. `anadirComentarioIncidencia` devuelve `{ ok: true }` — al releer la incidencia (o en el propio flujo del navegador más adelante) debería quedar `estado: 'EN_CURSO'` y `asignado: 'Operario de prueba'`.
4. `cambiarEstadoIncidencia` devuelve `{ ok: true }` y la incidencia queda `RESUELTA`.

Abrir el Spreadsheet de datos y confirmar que las hojas `INCIDENCIAS` e `INCIDENCIAS_COMENTARIOS` se crearon solas, con esas filas.

- [ ] **Step 7: Commit**

```bash
git add Incidencias.gs
git commit -m "Completar backend de Incidencias: listar, comentar, cerrar, reasignar"
```

---

### Task 4: Frontend — pestaña nueva, constantes y helper de fotos (`Index.html`)

**Files:**
- Modify: `Index.html:875-891` (arrays `TABS_OPERARIO`/`TABS_ADMIN`)
- Modify: `Index.html:899-915` (`switchTab`)
- Modify: `Index.html:5221-5222` (justo antes de `</script>`, final del archivo)

- [ ] **Step 1: Añadir la pestaña a ambos paneles**

Sustituir:

```javascript
const TABS_OPERARIO = [
  { id: 'app',      label: '📦 Operario' },
  { id: 'revisar',  label: '⚠️ Revisar' },
  { id: 'muelles',  label: '🚧 Muelles' },
  { id: 'buscar',   label: '🔍 Buscar' }
];
const TABS_ADMIN = [
  { id: 'importar', label: '📥 Importar' },
  { id: 'carga',    label: '🚛 Cargas' },
  { id: 'silueta',  label: '📐 Silueta' },
  { id: 'entregas', label: '📦 Entregas' },
  { id: 'muelles',  label: '🚧 Muelles' },
  { id: 'dash',     label: '📊 Pantalla' },
  { id: 'storedelivery', label: '🗂️ Store Delivery' },
  { id: 'visas',    label: '🛂 Visas' },
  { id: 'buscar',   label: '🔍 Buscar' }
];
```

por:

```javascript
const TABS_OPERARIO = [
  { id: 'app',      label: '📦 Operario' },
  { id: 'revisar',  label: '⚠️ Revisar' },
  { id: 'muelles',  label: '🚧 Muelles' },
  { id: 'incidencias', label: '🚨 Incidencias' },
  { id: 'buscar',   label: '🔍 Buscar' }
];
const TABS_ADMIN = [
  { id: 'importar', label: '📥 Importar' },
  { id: 'carga',    label: '🚛 Cargas' },
  { id: 'silueta',  label: '📐 Silueta' },
  { id: 'entregas', label: '📦 Entregas' },
  { id: 'muelles',  label: '🚧 Muelles' },
  { id: 'dash',     label: '📊 Pantalla' },
  { id: 'storedelivery', label: '🗂️ Store Delivery' },
  { id: 'visas',    label: '🛂 Visas' },
  { id: 'incidencias', label: '🚨 Incidencias' },
  { id: 'buscar',   label: '🔍 Buscar' }
];
```

- [ ] **Step 2: Enganchar la pestaña en `switchTab`**

Sustituir:

```javascript
  else if (t === 'visas') pantallaVisas();
  else if (t === 'buscar') pantallaBuscar();
  else if (t === 'revisar') pantallaRevisarPedidos();
  else if (estado.operario) pantallaRaiz();
```

por:

```javascript
  else if (t === 'visas') pantallaVisas();
  else if (t === 'incidencias') pantallaIncidencias();
  else if (t === 'buscar') pantallaBuscar();
  else if (t === 'revisar') pantallaRevisarPedidos();
  else if (estado.operario) pantallaRaiz();
```

- [ ] **Step 3: Añadir constantes y el helper de fotos, al final del script**

En `Index.html`, localizar el final de `descargarProgramaRetiradas()` (línea 5221, `}`) justo antes de `</script>` (línea 5222). Insertar:

```javascript
// === INCIDENCIAS (admin da de alta, operario gestiona) ===
const TIPOS_INCIDENCIA = [
  { id: 'SALDADA', label: 'Mercancía saldada en plataforma' },
  { id: 'DEVOLUCION', label: 'Devolución' },
  { id: 'DEVOLUCION_TIENDA', label: 'Petición de devolución a tienda' },
  { id: 'OTRA', label: 'Incidencia varia / otros' }
];
const ESTADOS_INCIDENCIA_LABEL = { PENDIENTE: 'Pendiente', EN_CURSO: 'En curso', RESUELTA: 'Resuelta', CANCELADA: 'Cancelada' };
const ESTADOS_INCIDENCIA_COLOR = { PENDIENTE: 'var(--gold)', EN_CURSO: 'var(--cyan)', RESUELTA: 'var(--grn)', CANCELADA: 'var(--tx3)' };

function urlFotoIncidencia(fileId) {
  return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(fileId) + '&sz=w800';
}

// Redimensiona UNA foto en un <canvas> (lado mayor ~1280px, calidad ~0.7)
// antes de mandarla — una foto de móvil sin comprimir (3-8 MB) puede
// reventar el payload o el watchdog de 20s de gas().
function redimensionarFoto(file) {
  return new Promise(function(resolve, reject) {
    const lector = new FileReader();
    lector.onerror = function() { reject(new Error('No se pudo leer la foto')); };
    lector.onload = function() {
      const img = new Image();
      img.onerror = function() { reject(new Error('No se pudo procesar la foto')); };
      img.onload = function() {
        const maxLado = 1280;
        let w = img.width, h = img.height;
        if (w > maxLado || h > maxLado) {
          if (w > h) { h = Math.round(h * maxLado / w); w = maxLado; }
          else { w = Math.round(w * maxLado / h); h = maxLado; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        resolve({ base64: dataUrl.split(',')[1], mime: 'image/jpeg' });
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(file);
  });
}
// Lee hasta 4 fotos de un <input type="file" multiple> ya redimensionadas,
// lista para mandar a gas(). Una foto que falle se omite (con aviso) en vez
// de bloquear el resto.
async function capturarFotosRedimensionadas(inputEl) {
  const archivos = Array.prototype.slice.call((inputEl && inputEl.files) || []).slice(0, 4);
  const fotos = [];
  for (let i = 0; i < archivos.length; i++) {
    try { fotos.push(await redimensionarFoto(archivos[i])); }
    catch (e) { toast('Una foto no se pudo procesar y se ha omitido', 'err'); }
  }
  return fotos;
}

function pantallaIncidencias() {
  if (MODO_PANEL === 'admin') pantallaIncidenciasAdmin();
  else pantallaIncidenciasOperario();
}

// Lista de tarjetas compartida entre admin/operario/histórico.
function renderListaIncidencias(contId, lista) {
  const cont = document.getElementById(contId);
  if (!cont) return;
  if (!lista.length) { cont.innerHTML = '<div class="empty-state"><div class="icon">🚨</div>No hay incidencias.</div>'; return; }
  cont.innerHTML = lista.map(inc => {
    const tipoLabel = (TIPOS_INCIDENCIA.find(t => t.id === inc.tipo) || {}).label || inc.tipo;
    return `<div class="section-card" style="padding:12px 14px;margin-bottom:8px;cursor:pointer" onclick="pantallaDetalleIncidencia('${esc(inc.id)}')">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <b style="font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:.5px">${esc(inc.ped)}</b>
        <span style="font-size:11px;font-weight:700;color:${ESTADOS_INCIDENCIA_COLOR[inc.estado] || 'var(--tx2)'}">${esc(ESTADOS_INCIDENCIA_LABEL[inc.estado] || inc.estado)}</span>
      </div>
      <div style="font-size:12px;color:var(--tx2);margin-top:4px">${esc(tipoLabel)} · ${esc(inc.tienda)}${inc.prioridad === 'URGENTE' ? ' · <span style="color:var(--red);font-weight:700">🔴 URGENTE</span>' : ''}</div>
      <div style="font-size:11px;color:var(--tx3);margin-top:4px">${inc.asignado ? '👤 ' + esc(inc.asignado) : '🔓 Sin asignar'}</div>
    </div>`;
  }).join('');
}
```

- [ ] **Step 4: `clasp push` y comprobación visual**

```bash
clasp push
```

En el navegador (recargando la app), confirmar que aparece la pestaña "🚨 Incidencias" tanto en `?vista=admin` como en `?vista=app` (dentro de operario, tras elegir usuario) — al pulsarla dará un error en consola "pantallaIncidenciasAdmin is not defined" / "pantallaIncidenciasOperario is not defined": normal, se resuelve en las Tasks 5 y 6.

- [ ] **Step 5: Commit**

```bash
git add Index.html
git commit -m "Añadir pestaña Incidencias, constantes y helper de fotos"
```

---

### Task 5: Frontend — pantalla admin (listado + alta) (`Index.html`)

**Files:**
- Modify: `Index.html` (insertar justo después del bloque añadido en la Task 4, Step 3 — después de `renderListaIncidencias`, antes de `</script>`)

- [ ] **Step 1: Añadir `pantallaIncidenciasAdmin` y su listado filtrado**

```javascript
let INC_PEDIDO_SEL = null; // pedido elegido en el formulario de alta (vía buscarPedido)

function pantallaIncidenciasAdmin() {
  bread();
  app().innerHTML = `
    <div class="step-title">🚨 Incidencias</div>
    <div class="section-card">
      <button class="btn-submit" onclick="toggleFormNuevaIncidencia()">➕ Nueva incidencia</button>
      <div id="formNuevaIncidencia" style="display:none;margin-top:12px"></div>
    </div>
    <div class="section-card" style="padding:10px 14px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="incFiltroEstado" onchange="cargarIncidenciasAdmin()" style="flex:1;min-width:130px">
          <option value="">Todos los estados</option>
          ${Object.keys(ESTADOS_INCIDENCIA_LABEL).map(e => `<option value="${e}">${esc(ESTADOS_INCIDENCIA_LABEL[e])}</option>`).join('')}
        </select>
        <select id="incFiltroTienda" onchange="cargarIncidenciasAdmin()" style="flex:1;min-width:130px">
          <option value="">Todas las tiendas</option>
          ${TIENDAS.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
        </select>
        <select id="incFiltroTipo" onchange="cargarIncidenciasAdmin()" style="flex:1;min-width:150px">
          <option value="">Todos los tipos</option>
          ${TIPOS_INCIDENCIA.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}
        </select>
        <select id="incFiltroAsignado" onchange="cargarIncidenciasAdmin()" style="flex:1;min-width:150px">
          <option value="">Todos los operarios</option>
          <option value="__SIN__">🔓 Sin asignar</option>
          ${OPERARIOS.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="listaIncidenciasAdmin"><div class="empty-state"><div class="icon">⏳</div>Cargando…</div></div>
  `;
  cargarIncidenciasAdmin();
}

async function cargarIncidenciasAdmin() {
  const filtros = {};
  const estadoSel = document.getElementById('incFiltroEstado').value;
  const tiendaSel = document.getElementById('incFiltroTienda').value;
  const tipoSel = document.getElementById('incFiltroTipo').value;
  const asignadoSel = document.getElementById('incFiltroAsignado').value;
  if (estadoSel) filtros.estado = estadoSel;
  if (tiendaSel) filtros.tienda = tiendaSel;
  if (tipoSel) filtros.tipo = tipoSel;
  if (asignadoSel === '__SIN__') filtros.asignado = '';
  else if (asignadoSel) filtros.asignado = asignadoSel;
  let lista;
  try { lista = await gas('listarIncidencias', filtros); }
  catch (e) { toast('Error: ' + e.message, 'err'); return; }
  renderListaIncidencias('listaIncidenciasAdmin', lista);
}
```

- [ ] **Step 2: Añadir el formulario de alta**

```javascript
function toggleFormNuevaIncidencia() {
  const cont = document.getElementById('formNuevaIncidencia');
  const abrir = cont.style.display === 'none';
  cont.style.display = abrir ? 'block' : 'none';
  if (abrir) renderFormNuevaIncidencia();
}

function renderFormNuevaIncidencia() {
  INC_PEDIDO_SEL = null;
  const cont = document.getElementById('formNuevaIncidencia');
  cont.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <input type="text" id="incBuscarPed" inputmode="numeric" placeholder="Nº de pedido" style="flex:1">
      <button class="btn-opc" style="flex:0 0 auto;justify-content:center" onclick="buscarPedidoNuevaIncidencia()">Buscar</button>
    </div>
    <div id="incPedidoInfo" style="font-size:12px;color:var(--tx2);margin-bottom:10px"></div>
    <div id="incRestoForm" style="display:none">
      <div class="field" style="margin-bottom:8px"><label>Tipo</label>
        <select id="incTipo">${TIPOS_INCIDENCIA.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select>
      </div>
      <div class="field" style="margin-bottom:8px"><label>Prioridad</label>
        <select id="incPrioridad"><option value="NORMAL">Normal</option><option value="URGENTE">🔴 Urgente</option></select>
      </div>
      <div class="field" style="margin-bottom:8px"><label>Asignar a</label>
        <select id="incAsignado"><option value="">Sin asignar (pool)</option>${OPERARIOS.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>
      </div>
      <div class="field" style="margin-bottom:8px"><label>Indicaciones</label>
        <textarea id="incTexto" placeholder="Explica qué hay que hacer…"></textarea>
      </div>
      <div class="field" style="margin-bottom:10px"><label>Fotos (opcional, máx. 4)</label>
        <input type="file" id="incFotos" accept="image/*" multiple>
      </div>
      <button class="btn-submit" onclick="conBoton(this, () => enviarNuevaIncidencia())">✓ Crear incidencia</button>
    </div>`;
}

async function buscarPedidoNuevaIncidencia() {
  const num = document.getElementById('incBuscarPed').value.trim();
  const info = document.getElementById('incPedidoInfo');
  if (!num) { toast('Escribe un número de pedido', 'err'); return; }
  info.textContent = 'Buscando…';
  let p;
  try { p = await gas('buscarPedido', num); }
  catch (e) { info.textContent = 'Error: ' + e.message; return; }
  if (!p) { info.textContent = '✗ Pedido no encontrado'; document.getElementById('incRestoForm').style.display = 'none'; INC_PEDIDO_SEL = null; return; }
  INC_PEDIDO_SEL = p;
  info.innerHTML = `✓ <b>${esc(p.ped)}</b> · ${esc(p.tienda)} · ${esc(FLUJO_LABELS[p.flujo] || p.flujo)}`;
  document.getElementById('incRestoForm').style.display = 'block';
}

async function enviarNuevaIncidencia() {
  if (!INC_PEDIDO_SEL) { toast('Busca primero el pedido', 'err'); return; }
  const texto = document.getElementById('incTexto').value.trim();
  if (!texto) { toast('Escribe las indicaciones', 'err'); return; }
  const tipo = document.getElementById('incTipo').value;
  const prioridad = document.getElementById('incPrioridad').value;
  const asignado = document.getElementById('incAsignado').value;
  const fotos = await capturarFotosRedimensionadas(document.getElementById('incFotos'));
  let r;
  try { r = await gas('crearIncidencia', INC_PEDIDO_SEL.id, tipo, prioridad, asignado, texto, fotos); }
  catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!r.ok) { toast('Error: ' + r.error, 'err'); return; }
  toast('✓ Incidencia creada', 'ok');
  document.getElementById('formNuevaIncidencia').style.display = 'none';
  cargarIncidenciasAdmin();
}
```

- [ ] **Step 3: `clasp push` y prueba manual en el navegador**

```bash
clasp push
```

En `?vista=admin` → pestaña "🚨 Incidencias": confirmar que carga el listado (vacío o con la incidencia de prueba de la Task 3), que los 4 filtros lo actualizan, que "➕ Nueva incidencia" despliega el formulario, que buscar un pedido real muestra sus datos y habilita el resto del formulario, y que "✓ Crear incidencia" la añade al listado (con foto adjunta si se prueba con una).

- [ ] **Step 4: Commit**

```bash
git add Index.html
git commit -m "Añadir pantalla admin de Incidencias (listado + alta)"
```

---

### Task 6: Frontend — pantalla operario y detalle común (`Index.html`)

**Files:**
- Modify: `Index.html` (insertar justo después del bloque añadido en la Task 5, antes de `</script>`)

- [ ] **Step 1: Añadir `pantallaIncidenciasOperario` y el histórico**

```javascript
async function pantallaIncidenciasOperario() {
  bread();
  app().innerHTML = `
    <div class="step-title">🚨 Incidencias</div>
    <div class="step-title" style="font-size:14px;margin-top:14px">🔵 Asignadas a mí</div>
    <div id="incMias"><div class="empty-state"><div class="icon">⏳</div>Cargando…</div></div>
    <div class="step-title" style="font-size:14px;margin-top:18px">🔓 Sin asignar</div>
    <div id="incPool"><div class="empty-state"><div class="icon">⏳</div>Cargando…</div></div>
    <button class="back-btn" style="margin-top:16px" onclick="pantallaIncidenciasHistorico()">🗂️ Ver histórico (resueltas/canceladas)</button>
  `;
  await cargarIncidenciasOperario();
}

async function cargarIncidenciasOperario() {
  let mias, pool;
  try {
    mias = await gas('listarIncidencias', { asignado: estado.operario });
    pool = await gas('listarIncidencias', { asignado: '' });
  } catch (e) { toast('Error: ' + e.message, 'err'); return; }
  mias = mias.filter(i => i.estado === 'PENDIENTE' || i.estado === 'EN_CURSO');
  pool = pool.filter(i => i.estado === 'PENDIENTE' || i.estado === 'EN_CURSO');
  renderListaIncidencias('incMias', mias);
  renderListaIncidencias('incPool', pool);
}

async function pantallaIncidenciasHistorico() {
  bread();
  app().innerHTML = `<div class="step-title">🗂️ Histórico de incidencias</div><div id="incHistorico"><div class="empty-state"><div class="icon">⏳</div>Cargando…</div></div>
    <button class="back-btn" style="margin-top:16px" onclick="pantallaIncidenciasOperario()">← Volver</button>`;
  let lista;
  try { lista = await gas('listarIncidencias', {}); }
  catch (e) { toast('Error: ' + e.message, 'err'); return; }
  lista = lista.filter(i => i.estado === 'RESUELTA' || i.estado === 'CANCELADA');
  renderListaIncidencias('incHistorico', lista);
}
```

- [ ] **Step 2: Añadir `pantallaDetalleIncidencia` (hilo + comentar)**

```javascript
let INC_DETALLE = null;

async function pantallaDetalleIncidencia(id) {
  bread();
  app().innerHTML = '<div class="empty-state"><div class="icon">⏳</div>Cargando…</div>';
  let r;
  try { r = await gas('obtenerIncidenciaConComentarios', id); }
  catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!r.ok) { toast('Error: ' + r.error, 'err'); volverListaIncidencias(); return; }
  INC_DETALLE = r;
  renderDetalleIncidencia();
}

function volverListaIncidencias() {
  if (MODO_PANEL === 'admin') pantallaIncidenciasAdmin();
  else pantallaIncidenciasOperario();
}

function renderDetalleIncidencia() {
  const inc = INC_DETALLE.incidencia;
  const tipoLabel = (TIPOS_INCIDENCIA.find(t => t.id === inc.tipo) || {}).label || inc.tipo;
  const cerrada = inc.estado === 'RESUELTA' || inc.estado === 'CANCELADA';
  let html = `
    <button class="back-btn" onclick="volverListaIncidencias()">← Volver</button>
    <div class="step-title">${esc(inc.ped)} · ${esc(inc.tienda)}</div>
    <div class="section-card" style="padding:12px 14px">
      <div style="font-size:12px;color:var(--tx2)">${esc(tipoLabel)}${inc.prioridad === 'URGENTE' ? ' · <span style="color:var(--red);font-weight:700">🔴 URGENTE</span>' : ''}</div>
      <div style="font-size:12px;color:var(--tx2);margin-top:2px">Estado: <b style="color:${ESTADOS_INCIDENCIA_COLOR[inc.estado] || 'var(--tx2)'}">${esc(ESTADOS_INCIDENCIA_LABEL[inc.estado] || inc.estado)}</b> · ${inc.asignado ? '👤 ' + esc(inc.asignado) : '🔓 Sin asignar'}</div>
    </div>
    <div id="incHilo" style="margin:12px 0">
      ${INC_DETALLE.comentarios.map(c => `
        <div class="section-card" style="padding:10px 12px;margin-bottom:8px;${c.rol === 'admin' ? 'border-left:3px solid var(--gold)' : 'border-left:3px solid var(--cyan)'}">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--tx3)">
            <b>${c.rol === 'admin' ? '🗂️ ' : '👤 '}${esc(c.autor)}</b><span>${esc(new Date(c.ts).toLocaleString('es-ES'))}</span>
          </div>
          ${c.texto ? `<div style="font-size:13px;margin-top:6px;white-space:pre-wrap">${esc(c.texto)}</div>` : ''}
          ${c.fotos && c.fotos.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${c.fotos.map(fid => `<img src="${urlFotoIncidencia(fid)}" style="width:90px;height:90px;object-fit:cover;border-radius:8px;cursor:pointer" onclick="window.open('${urlFotoIncidencia(fid)}','_blank')">`).join('')}</div>` : ''}
        </div>`).join('')}
    </div>`;
  if (!cerrada) {
    html += `
    <div class="section-card">
      <div class="field" style="margin-bottom:8px"><label>Nuevo comentario</label><textarea id="incComentarioTexto" placeholder="Escribe una actualización…"></textarea></div>
      <div class="field" style="margin-bottom:10px"><label>Fotos (opcional, máx. 4)</label><input type="file" id="incComentarioFotos" accept="image/*" multiple></div>
      <button class="btn-submit" onclick="conBoton(this, () => enviarComentarioIncidencia())">💬 Añadir comentario</button>
    </div>`;
    if (MODO_PANEL === 'admin') {
      html += `
      <div class="section-card" style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="incReasignarSel" style="flex:1;min-width:150px">
          <option value="">Sin asignar (pool)</option>
          ${OPERARIOS.map(o => `<option value="${esc(o)}" ${o === inc.asignado ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        </select>
        <button class="btn-opc" style="flex:0 0 auto;justify-content:center" onclick="conBoton(this, () => reasignarIncidenciaUI())">🔁 Reasignar</button>
        <button class="btn-opc" style="flex:0 0 auto;justify-content:center;background:var(--red);color:#fff" onclick="cancelarIncidenciaUI()">⛔ Cancelar incidencia</button>
      </div>`;
    } else {
      html += `<button class="btn-submit" style="background:var(--grn)" onclick="resolverIncidenciaUI()">✅ Resolver incidencia</button>`;
    }
  }
  app().innerHTML = html;
}
```

Nota respecto a la spec: el botón "▶️ Marcar en curso" que describía la spec para el operario se simplifica — el backend (`anadirComentarioIncidencia`, Task 3) ya pasa la incidencia de PENDIENTE a EN_CURSO automáticamente en cuanto el operario añade su primer comentario, así que un botón aparte sin texto ni foto no aporta nada (el propio backend rechazaría un comentario totalmente vacío).

- [ ] **Step 3: Añadir las acciones (comentar, resolver, cancelar, reasignar)**

```javascript
async function enviarComentarioIncidencia() {
  const texto = document.getElementById('incComentarioTexto').value.trim();
  const fotos = await capturarFotosRedimensionadas(document.getElementById('incComentarioFotos'));
  if (!texto && !fotos.length) { toast('Escribe algo o adjunta una foto', 'err'); return; }
  const autor = MODO_PANEL === 'admin' ? 'Administración' : estado.operario;
  const rol = MODO_PANEL === 'admin' ? 'admin' : 'operario';
  let r;
  try { r = await gas('anadirComentarioIncidencia', INC_DETALLE.incidencia.id, autor, rol, texto, fotos); }
  catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!r.ok) { toast('Error: ' + r.error, 'err'); return; }
  toast('✓ Comentario añadido', 'ok');
  pantallaDetalleIncidencia(INC_DETALLE.incidencia.id);
}

async function resolverIncidenciaUI() {
  const texto = prompt('Nota final de la resolución:');
  if (texto === null) return;
  const t = texto.trim();
  if (!t) { toast('Escribe una nota para resolver', 'err'); return; }
  let r;
  try { r = await gas('cambiarEstadoIncidencia', INC_DETALLE.incidencia.id, 'RESUELTA', estado.operario, 'operario', t, []); }
  catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!r.ok) { toast('Error: ' + r.error, 'err'); return; }
  toast('✓ Incidencia resuelta', 'ok');
  pantallaIncidenciasOperario();
}

async function cancelarIncidenciaUI() {
  const texto = prompt('Motivo de la cancelación:');
  if (texto === null) return;
  const t = texto.trim();
  if (!t) { toast('Escribe un motivo para cancelar', 'err'); return; }
  let r;
  try { r = await gas('cambiarEstadoIncidencia', INC_DETALLE.incidencia.id, 'CANCELADA', 'Administración', 'admin', t, []); }
  catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!r.ok) { toast('Error: ' + r.error, 'err'); return; }
  toast('✓ Incidencia cancelada', 'ok');
  pantallaIncidenciasAdmin();
}

async function reasignarIncidenciaUI() {
  const nuevo = document.getElementById('incReasignarSel').value;
  let r;
  try { r = await gas('reasignarIncidencia', INC_DETALLE.incidencia.id, nuevo); }
  catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!r.ok) { toast('Error: ' + r.error, 'err'); return; }
  toast('✓ Reasignada', 'ok');
  pantallaDetalleIncidencia(INC_DETALLE.incidencia.id);
}
```

- [ ] **Step 4: `clasp push`**

```bash
clasp push
```

- [ ] **Step 5: Commit**

```bash
git add Index.html
git commit -m "Añadir pantallas operario y detalle de Incidencias (hilo, resolver, cancelar, reasignar)"
```

---

### Task 7: Despliegue y prueba manual end-to-end

**Files:** ninguno (solo despliegue y verificación)

- [ ] **Step 1: Nueva versión del despliegue**

Desde el editor de Apps Script: Implementar → Gestionar implementaciones → editar (lápiz) el despliegue en vivo → Versión: Nueva versión → Implementar. (Imprescindible: `clasp push` sube el código al editor pero la URL `/exec` sigue sirviendo la versión anterior hasta que se publica una nueva versión.)

- [ ] **Step 2: Reautorizar el script**

La primera vez que se ejecute algo que use `DriveApp` (crear una incidencia con foto, o `probarIncidencias()`), Google pedirá reautorizar el script porque se ha añadido el ámbito de Drive. Aceptar la pantalla de permisos.

- [ ] **Step 3: Probar el flujo completo en el navegador**

1. Abrir `?vista=admin` → pestaña "🚨 Incidencias" → "➕ Nueva incidencia" → buscar un pedido real → tipo "Mercancía saldada en plataforma" → prioridad "🔴 Urgente" → dejar "Sin asignar (pool)" → escribir unas indicaciones → adjuntar 1-2 fotos → "✓ Crear incidencia". Confirmar que aparece en el listado con el estado "Pendiente" y la marca 🔴 URGENTE.
2. Abrir `?vista=app` (operario) → elegir un usuario → pestaña "🚨 Incidencias" → confirmar que la incidencia aparece en "🔓 Sin asignar" (no en "Asignadas a mí").
3. Abrirla, confirmar que se ven las fotos (miniaturas cargando desde Drive, sin icono roto — si sale roto, revisar que `archivo.setSharing` se está ejecutando) y el texto de indicaciones.
4. Añadir un comentario con texto (y opcionalmente otra foto) → confirmar que aparece en el hilo y que, al volver al listado, la incidencia ya sale en "🔵 Asignadas a mí" con estado "En curso".
5. Pulsar "✅ Resolver incidencia", escribir una nota final → confirmar que desaparece de "Asignadas a mí"/"Sin asignar" y aparece en "🗂️ Ver histórico" con estado "Resuelta".
6. Volver a `?vista=admin` → pestaña Incidencias → filtrar por estado "Resuelta" → confirmar que aparece con todo el hilo completo (indicaciones iniciales + comentario del operario + nota de resolución, cada uno con su autor y fecha).
7. Repetir brevemente el flujo de "⛔ Cancelar incidencia" desde admin sobre otra incidencia de prueba, confirmando que pide motivo y que queda "Cancelada".
8. Borrar desde la propia hoja de cálculo las filas de prueba (`INCIDENCIAS`/`INCIDENCIAS_COMENTARIOS`) y las subcarpetas de Drive correspondientes, si no se quieren dejar datos de prueba en producción.

- [ ] **Step 4: Confirmar en la hoja de cálculo**

Abrir el Spreadsheet de datos y comprobar que `INCIDENCIAS` e `INCIDENCIAS_COMENTARIOS` reflejan fielmente lo probado (mismo `id`/`idIncidencia`, estados y timestamps coherentes).

Con esto, el módulo de Incidencias queda operativo de extremo a extremo: alta desde administración con indicaciones y fotos, trabajo del equipo desde el móvil con su propio hilo de fotos y texto, cierre con nota final, y consulta del histórico.
