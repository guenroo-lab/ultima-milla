# Incidencias (panel admin + panel operario)

## Qué es esto

Módulo nuevo, independiente de la preparación (que ya notifica NO_ENCONTRADO/NO_SALE por su cuenta), para que **administración** dé de alta incidencias sobre un pedido — mercancía saldada que se ha quedado en la plataforma de Taisa, devoluciones, peticiones de devolución a tienda, o cualquier otra cosa — y el **equipo de operarios** las trabaje desde el móvil (panel operario), añadiendo fotos y texto según avanza, hasta resolverlas.

Vive como una pestaña nueva **🚨 Incidencias**, visible tanto en `?vista=admin` como en `?vista=operario` (mismo `Index.html`, cada modo ve las acciones que le tocan), con su propio archivo de backend `Incidencias.gs` y dos hojas nuevas en el Spreadsheet.

## Decisiones ya tomadas (brainstorming con el usuario)

- Toda incidencia va **siempre ligada a un pedido** existente (no hay incidencias "sueltas" sin pedido).
- Solo **administración crea** incidencias nuevas; los operarios las trabajan, comentan y cierran, no las crean.
- 4 categorías fijas: mercancía saldada en plataforma, devolución, petición de devolución a tienda, incidencia varia/otros.
- Al crear, admin **puede asignarla a un operario concreto o dejarla sin asignar** (pool común); cualquier operario sin asignación se la autoasigna en cuanto la toca.
- Estados: `PENDIENTE → EN_CURSO → RESUELTA`, más `CANCELADA` (la anula admin).
- El trabajo de la incidencia es una **línea de tiempo de comentarios** (texto + fotos), no un único cierre — tanto admin como operario pueden añadir comentarios con fotos en cualquier momento mientras está abierta. Las indicaciones iniciales de admin son, simplemente, el primer comentario del hilo.
- Prioridad: `NORMAL` / `URGENTE`.
- **Sin notificación a Google Chat** — a diferencia de NO_ENCONTRADO/NO_SALE, este módulo no toca `NotificacionesChat.gs`; es un cajón propio que se consulta dentro de la app.
- Sin login por rol: la separación admin/operario es la misma que ya usa todo el proyecto (`modo` de `?vista=`), no una restricción dura en el backend.

## Modelo de datos (2 hojas nuevas)

Se añaden a `HOJAS`/`COLUMNAS` en `Configuracion.gs` (autocreación vía `getHoja`, mismo mecanismo que el resto — no hace falta tocar `EstructuraSheets.gs` ni re-ejecutar `inicializarSistema()`):

**`INCIDENCIAS`** (cabecera, una fila por incidencia):
`id | idPedido | ped | tienda | tipo | prioridad | estado | asignado | creadoPor | creadoTs | actualizado`

- `tipo`: `SALDADA` / `DEVOLUCION` / `DEVOLUCION_TIENDA` / `OTRA`
- `prioridad`: `NORMAL` / `URGENTE`
- `estado`: `PENDIENTE` / `EN_CURSO` / `RESUELTA` / `CANCELADA`
- `asignado`: nombre de `CONFIG.OPERARIOS`, o cadena vacía = pool común
- `creadoPor`: nombre de quien la dio de alta (admin)
- `actualizado`: se refresca en cada comentario/cambio de estado (para poder ordenar el listado por actividad reciente)

**`INCIDENCIAS_COMENTARIOS`** (línea de tiempo, N filas por incidencia):
`id | idIncidencia | autor | rol | texto | fotos | ts`

- `rol`: `admin` / `operario` (para pintar el comentario a un lado u otro, como un chat)
- `fotos`: JSON con un array de **IDs de archivo de Drive** (no URLs completas — el frontend construye el link de miniatura que necesite a partir del ID). Array vacío si el comentario es solo texto.
- El primer comentario de toda incidencia (rol=admin) son las indicaciones iniciales.

## Fotos (Google Drive)

- Carpeta padre `Incidencias LM Málaga`, autocreada la primera vez que se necesita (`DriveApp.createFolder`), con su ID cacheado en `PropertiesService` — mismo patrón exacto que `getSpreadsheetId()`/`setSpreadsheetId()` en `Configuracion.gs` (par de funciones `getIncidenciasFolderId()`/`setIncidenciasFolderId()`, memoizado por ejecución igual que `_SS_MEMO`).
- Dentro, una subcarpeta por incidencia, nombrada `INC-<id>-<ped>` — se busca por nombre con `getFoldersByName` y se crea si no existe (no hace falta guardar su ID en ningún sitio; el volumen de incidencias no justifica cachear esa búsqueda).
- **Aviso operativo:** cada archivo de foto debe compartirse explícitamente al subirlo (`archivo.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW)`), igual de necesario que en cualquier archivo de Drive que se vaya a enseñar dentro de un `<img>` — si no, el operario que no sea el dueño del archivo (la webapp corre como `USER_DEPLOYING`) puede ver un icono roto en vez de la foto. El frontend pinta las miniaturas con `https://drive.google.com/thumbnail?id=<ID>&sz=w800`.
- El móvil captura con `<input type="file" accept="image/*" capture="environment" multiple>`. Antes de enviar, el JS del cliente redimensiona cada imagen en un `<canvas>` (lado mayor ≈1280px, calidad JPEG ≈0.7) — una foto de móvil sin comprimir (3-8 MB) puede reventar el payload o el watchdog de 20s de `gas()`; redimensionada baja a unos cientos de KB.
- Máximo **4 fotos por comentario** (fijo en el código, sin configuración — YAGNI). Se suben **una a una** desde el frontend (una llamada `gas()` por foto), mismo criterio que "un pedido por llamada" en Retiradas de pedido, para que cada llamada sea rápida y se pueda ver progreso en vivo si hay varias.

## Backend: `Incidencias.gs` (archivo nuevo)

```javascript
function crearIncidencia(idPedido, tipo, prioridad, asignado, texto, fotosBase64)
  // Solo la llama la UI de admin. Busca el pedido (idPedido) para sacar
  // ped/tienda, crea la fila en INCIDENCIAS (estado PENDIENTE), sube las
  // fotos si las hay y crea el primer comentario en INCIDENCIAS_COMENTARIOS
  // (autor=creadoPor, rol='admin', texto=texto). Devuelve la incidencia
  // creada con su id.

function listarIncidencias(filtros)
  // filtros = { estado, tienda, tipo, asignado } (todos opcionales).
  // Devuelve el array de cabeceras de INCIDENCIAS que cumplen los filtros,
  // ordenado por 'actualizado' descendente. La pantalla de operario llama
  // dos veces (asignado=<su nombre> y asignado='' ) para pintar
  // "Asignadas a mí" y "Sin asignar"; la de admin llama con los filtros
  // que tenga puestos.

function obtenerIncidenciaConComentarios(idIncidencia)
  // Devuelve { incidencia, comentarios } — comentarios ordenados por ts.

function anadirComentarioIncidencia(idIncidencia, autor, rol, texto, fotosBase64)
  // Sube las fotos (si hay), añade la fila a INCIDENCIAS_COMENTARIOS,
  // actualiza 'actualizado' de la cabecera. Si rol='operario': cuando la
  // incidencia estaba sin 'asignado' se autoasigna a 'autor', y cuando
  // estaba PENDIENTE pasa a EN_CURSO (un comentario de admin nunca cambia
  // ni asignado ni estado — solo dan indicaciones).

function cambiarEstadoIncidencia(idIncidencia, nuevoEstado, autor, rol, texto, fotosBase64)
  // nuevoEstado: RESUELTA o CANCELADA, solo válido si el estado actual es
  // PENDIENTE o EN_CURSO (una incidencia ya RESUELTA/CANCELADA no se puede
  // volver a cerrar — devuelve error). Exige texto no vacío (nota final).
  // Sube fotos si las hay, añade el comentario del cierre, actualiza
  // estado + 'actualizado' de la cabecera.

function reasignarIncidencia(idIncidencia, nuevoAsignado)
  // Solo UI de admin. Cambia 'asignado' de la cabecera.

function _guardarFotoIncidencia(idIncidencia, ped, base64, mime)
  // Helper interno: localiza/crea la subcarpeta INC-<id>-<ped>, decodifica
  // el base64, crea el archivo, lo comparte (DOMAIN_WITH_LINK) y devuelve
  // su fileId.
```

Todas las escrituras a las dos hojas nuevas pasan por `anadirFila`/`actualizarFila` de `EstructuraSheets.gs`, igual que el resto del proyecto. Sin arrow functions ni template literals (convención `.gs` existente).

## Frontend (`Index.html`, mismo archivo para admin y operario)

- Pestaña nueva **🚨 Incidencias** en `renderTabBar()`, visible en ambos modos.
- **Admin — `pantallaIncidencias()`:** listado con filtros (estado/tienda/tipo/asignado) arriba, botón **➕ Nueva incidencia** que abre un formulario: buscar pedido (reutiliza el mismo componente de búsqueda que ya existe en `pantallaBuscar()`) → tipo → prioridad → asignado (selector de `OPERARIOS` + opción "sin asignar") → texto de indicaciones → fotos opcionales → `crearIncidencia`.
- **Operario — `pantallaIncidenciasOperario()`:** dos bloques, "Asignadas a mí" y "Sin asignar", filtrados por defecto a `PENDIENTE`/`EN_CURSO`; una pestaña/filtro aparte para el histórico (`RESUELTA`/`CANCELADA`). Las `URGENTE` se destacan visualmente arriba de cada bloque.
- **Detalle de incidencia** (pantalla común, `pantallaDetalleIncidencia(id)`): cabecera con pedido/tienda/tipo/prioridad/estado/asignado, hilo tipo chat (foto+texto+autor+fecha, comentarios propios a un lado y los del otro rol al otro), caja inferior para comentar (texto + hasta 4 fotos vía cámara). Botones según estado/rol:
  - Operario: "▶️ Marcar en curso" (si PENDIENTE), "✅ Resolver" (pide nota final).
  - Admin: "🔁 Reasignar", "⛔ Cancelar" (pide motivo), cambiar prioridad.
- Overlay de carga mientras se sube cada foto (patrón ya usado en el resto de la app con `gas()`/`gasSinOverlay()`).

## Manejo de errores

- Pedido inexistente al crear la incidencia → error claro en el formulario, no se crea la fila.
- Fallo al subir una foto concreta (`UrlFetchApp`/Drive) → se captura, se avisa de qué foto falló, pero el comentario se guarda igual con el texto y las fotos que sí subieron (no bloquea todo el comentario por una foto).
- `cambiarEstadoIncidencia` a RESUELTA/CANCELADA sin texto → rechazado en frontend y backend (nota final obligatoria).
- Doble tap en "Resolver"/"Cancelar" → backend idempotente respecto al estado: si ya no está en un estado desde el que se pueda transicionar, devuelve error en vez de duplicar comentarios de cierre.

## Fuera de alcance ahora (YAGNI)

Sin vídeo (solo fotos). Sin exportar a Excel/PDF. Sin editar/borrar comentarios ya enviados. Sin límite configurable de nº de fotos (fijo en 4). Sin notificación a Chat. Sin integración visual dentro de `buscarPedido`/`pantallaCerrarPedido` (se puede añadir más adelante si hace falta ver de un vistazo si un pedido tiene incidencias abiertas).

## Checklist de implementación

- [ ] `HOJAS`/`COLUMNAS` nuevas (`INCIDENCIAS`, `INCIDENCIAS_COMENTARIOS`) en `Configuracion.gs`
- [ ] `getIncidenciasFolderId()`/`setIncidenciasFolderId()` en `Configuracion.gs` (mismo patrón que `getSpreadsheetId`)
- [ ] `Incidencias.gs` nuevo: `crearIncidencia`, `listarIncidencias`, `obtenerIncidenciaConComentarios`, `anadirComentarioIncidencia`, `cambiarEstadoIncidencia`, `reasignarIncidencia`, `_guardarFotoIncidencia`
- [ ] Pestaña "🚨 Incidencias" en `renderTabBar()` (admin y operario)
- [ ] `pantallaIncidencias()` (admin, con alta) en `Index.html`
- [ ] `pantallaIncidenciasOperario()` (asignadas a mí / pool / histórico) en `Index.html`
- [ ] `pantallaDetalleIncidencia(id)` común (hilo + comentar + acciones de estado)
- [ ] Redimensionado de fotos en cliente (canvas) antes de enviar
- [ ] `clasp push` + nueva versión del deployment
- [ ] Probar flujo completo: admin crea incidencia con foto e indicaciones → operario la ve en el pool, se autoasigna comentando, añade fotos, la resuelve con nota final → admin la ve resuelta en el listado
