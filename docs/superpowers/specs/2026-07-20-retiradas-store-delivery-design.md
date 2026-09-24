# Retiradas de pedido (simulación de recogida cliente) — dentro de Store Delivery

## Qué es esto

Nueva sección dentro de la pestaña admin **🗂️ Store Delivery** ya existente en `lm_produccion` (`pantallaStoreDelivery()`, Index.html:3341). Permite pegar una lista de números de pedido de una tienda y registrar en bloque, contra la web pública de Leroy Merlin, la simulación de "el cliente viene a recoger su pedido" — el mismo efecto que produce el kiosco físico "Pedido cliente" cuando un cliente teclea su número y confirma que es el titular. Esto dispara el proceso de control de stock delivery que Taisa ya ejecuta por otro lado.

Todo vive en Apps Script. No hace falta navegador, extensión ni programa aparte: la API de Leroy Merlin es pública (sin login, CORS abierto), así que Apps Script la llama directo con `UrlFetchApp`.

## Contexto: cómo se descubrió la API

Inspeccionando el Network tab de Chrome (HAR) mientras se usaba manualmente `https://store-delivery-client-web-pro.sales-pro-eslm.tech.adeo.cloud/tienda/{tienda}`, se identificaron dos llamadas XHR sin autenticación (sin cookies, sin token, `access-control-allow-origin: *`):

**1. Buscar pedido**
```
GET https://store-delivery-api-pro.sales-pro-eslm.tech.adeo.cloud/v1/commands/check/{tienda}/{pedido}
```
Respuesta si el pedido es procesable:
```json
{"code":0,"command":{ ...objeto completo del pedido (customer, orderLines, etc.)... }}
```
Respuesta si NO es procesable por esta vía (equivale a la pantalla "Pregunta en el mostrador" del kiosco):
```json
{"code":2,"command":null,"pyxisAuth":null}
```
Cualquier `code` distinto de 0 se trata igual: no procesable automáticamente.

**Bug real encontrado y arreglado (2026-07-21):** primera prueba en producción con tienda Marbella (código `014`) dio `Exception: Solicitud incorrecta (400)` desde Apps Script, para una URL que, pegada tal cual en un navegador, funcionaba perfectamente (mismo pedido, mismo código de tienda, `code:0` con el pedido completo). Diagnóstico por descarte: como la URL/parámetros eran correctos (confirmado pegándola en el navegador), el problema no podía ser el código de tienda ni el pedido — tenía que ser algo en CÓMO `UrlFetchApp` hace la petición frente a cómo la hace un navegador real. Causa más probable: un filtro/WAF delante de `store-delivery-api-pro.sales-pro-eslm.tech.adeo.cloud` rechaza peticiones sin pinta de navegador (User-Agent de Apps Script, sin Origin/Referer). **Fix:** añadidas cabeceras `User-Agent`/`Accept`/`Origin`/`Referer` (constante `LM_RETIRADA_HEADERS` en Backend.gs) replicando las que manda el navegador real, en ambas llamadas (`_lmComprobarPedido` y `_lmConfirmarPedido`). **Intento 1 (4 cabeceras: User-Agent/Accept/Origin/Referer, con la versión de Chrome mal puesta) NO lo arregló** — mismo error exacto al reintentar. **Intento 2 (2026-07-21):** comparado contra el HAR original completo, se detectó que faltaban 7 cabeceras reales (Accept-Language, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, sec-fetch-dest/mode/site, priority) y la versión de Chrome no coincidía (120 vs 150 real). Corregido: réplica completa y fiel del HAR (sin `accept-encoding`, deliberadamente, para no romper la descompresión). Pendiente confirmar si esto resuelve el 400. **Si el intento 2 también falla:** habría que asumir que el filtro bloquea por huella TLS o por reputación de IP (Apps Script sale desde IPs de Google Cloud) — ninguna de las dos es solucionable ajustando cabeceras desde Apps Script, y tocaría reconsiderar la arquitectura completa (automatización de navegador real, como se descartó en el diseño inicial).

**2. Confirmar retirada** (equivale a pulsar "Recoger ahora" → "Sí, soy el titular" → "Ok" en el kiosco)
```
POST https://store-delivery-api-pro.sales-pro-eslm.tech.adeo.cloud/v1/commands/check
Content-Type: application/json
Body: el mismo objeto "command" devuelto por el GET, sin modificar
```
Respuesta de éxito: `{"code":0}`

**Aviso operativo importante:** esta es la API de **producción real** de Leroy Merlin, no hay entorno de pruebas. El GET es de solo lectura (inofensivo). El POST **afecta a un pedido real de un cliente real** — tiene el mismo efecto que si el cliente hubiera confirmado su recogida en el kiosco de la tienda. Las primeras pruebas de extremo a extremo deben hacerse con pedidos que realmente se quiera procesar, no con datos ficticios.

## UI: nueva sección dentro de "Store Delivery"

Dentro de `pantallaStoreDelivery()` (Index.html), debajo de la sección actual de "Plantillas de reparto", añadir una segunda `.section-card`:

```
🗂️ Store Delivery
├── (sección existente) Plantillas de reparto — sin cambios
└── (sección NUEVA) Retiradas de pedido
      Tienda: [select TIENDAS]           ← reutilizar el array global TIENDAS, igual que sdTienda
      Pedidos (uno por línea):
      [ textarea ]
      [Procesar retiradas]
      ↓ tabla de resultados (pedido | cliente | resultado | código)
```

- El selector de tienda reutiliza el mismo array `TIENDAS` que ya usa `sdTienda` (mismo patrón, nuevo id `retTienda`).
- El textarea acepta un número de pedido por línea (se hace `trim()` y se ignoran líneas vacías).
- Botón "Procesar retiradas" recorre la lista en el FRONTEND y llama a `gas('procesarRetiradaPedido', tienda, pedido)` **una vez por pedido** (no en lote), mostrando "Procesando N/M…" en vivo. **Cambio respecto a la versión inicial de esta spec** (decidido durante la planificación, al leer el código real de `gas()`): esa llamada tiene un watchdog de 20s en el cliente, y una única llamada por lote con listas largas podría superarlo. Procesar uno a uno evita el problema y además da progreso en vivo.
- Al terminar cada pedido se añade una fila a la tabla de resultados: número, nombre del cliente (de `command.customer`), resultado (**OK** / **Revisar en mostrador** / **Error**), y el `code` crudo devuelto (para depuración).

## Backend: funciones nuevas en Backend.gs

```
function _lmComprobarPedido(codTienda, pedido)
  → GET check/{codTienda}/{pedido}, parsear JSON
  → devuelve { code, command }

function _lmConfirmarPedido(command)
  → POST check con body = command (sin modificar)
  → devuelve { code }

function procesarRetiradaPedido(tienda, pedido)
  → procesa UN pedido (se llama una vez por pedido desde el frontend, no en lote):
      1. _lmComprobarPedido
      2. si code===0 y hay command → _lmConfirmarPedido → resultado 'OK' o 'ERROR_CONFIRMACION' si el POST falla
      3. si no → resultado 'REVISAR_MOSTRADOR'
      4. anadirFila a hoja RETIRADAS_STOCK (usar helper existente de EstructuraSheets.gs)
  → devuelve { pedido, cliente, resultado, code } para esa fila de la tabla

function probarRetiradaPedido(tienda, pedido)
  → prueba manual desde el editor de Apps Script (mismo patrón que probarNotificacion/probarAvisoChat)
```

`tienda` se trata siempre como texto (con ceros a la izquierda, ej. "036") — nunca como número.

## Modelo de datos: hoja nueva RETIRADAS_STOCK

`fecha | tienda | pedido | cliente | resultado | code | ts`

- `resultado`: `OK` / `REVISAR_MOSTRADOR` / `ERROR_CONFIRMACION`
- `cliente`: `command.customer.firstName + ' ' + command.customer.lastName` si existe, vacío si no
- Se crea automáticamente la primera vez que se usa (mismo patrón que las demás hojas de `EstructuraSheets.gs`)

## Manejo de errores

- Pedido no encontrado / no procesable (`code≠0`) → `REVISAR_MOSTRADOR`, se registra y se sigue con el siguiente pedido de la lista (no bloquea el lote).
- Fallo de red en el GET o el POST (excepción de `UrlFetchApp`) → se captura, se registra como `ERROR_CONFIRMACION` con el mensaje de error, y se continúa con el siguiente pedido.
- Pedidos duplicados en la misma lista pegada: se procesan igual, sin deduplicar (si el usuario los repite, se llama dos veces a la API — no se ha visto que esto cause un error, pero se recomienda no repetir pedidos en la lista).

## Límites conocidos

- Apps Script tiene un límite de 6 minutos por ejecución. Con lotes de varias decenas de pedidos (2 llamadas HTTP por pedido, ~200-300ms cada una en las pruebas) no debería ser un problema. Si en el uso real los lotes crecen mucho (cientos de pedidos), habría que trocear en varias llamadas — no se implementa por ahora (YAGNI), se revisa si hace falta.

## Checklist de implementación

- [x] `_lmComprobarPedido`, `_lmConfirmarPedido`, `procesarRetiradaPedido`, `probarRetiradaPedido` en Backend.gs
- [x] Hoja `RETIRADAS_STOCK` (constante de nombre + columnas en Configuracion.gs; creación automática vía `getHoja` en EstructuraSheets.gs, sin tocar ese archivo)
- [x] Segunda `.section-card` dentro de `pantallaStoreDelivery()` en Index.html
- [x] Funciones frontend: `procesarRetiradas()`, `renderResultadoRetiradas()` (+ `gasSinOverlay()`, añadida durante revisión de calidad para que el progreso en vivo sea visible)
- [x] `clasp push` (código ya subido al editor de Apps Script)
- [ ] Probar con un pedido real que realmente se vaya a procesar (no hay entorno de pruebas) — **pendiente, lo hace el usuario**
- [ ] Nueva versión del deployment en vivo (Implementar → Gestionar implementaciones → Nueva versión) — **pendiente, lo hace el usuario**
