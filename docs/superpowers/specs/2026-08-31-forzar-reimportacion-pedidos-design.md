# Forzar reimportación de pedidos "ya resueltos" — Diseño

## Contexto

`importarClasificacion` (ImportarClasificacion.gs) es idempotente a propósito: si un pedido
ya existe en PEDIDOS en un **estado terminal** (`ENTREGADO`, `DEVUELTO_ALMACEN`,
`ENVIADO_TIENDA`, `SALIDA_MANUAL`, `CERRADO_SIN_SILUETA`), la reimportación lo salta en
silencio — "ya resuelto — no se toca" — porque Pyxis puede seguir listando un pedido
varios días después de resuelto sin que el almacén lo actualice al instante. Esto evita un
bug real ya corregido antes (un pedido entregado se recreaba como fila duplicada PENDIENTE
cada vez que Pyxis lo seguía listando).

El problema: a veces el pedido **sí ha vuelto de verdad** (rechazo del cliente, incidencia
de transporte, devolución) y hay que volver a prepararlo — completo o solo algunas
direcciones. Hoy no hay ninguna forma de hacer eso desde el Clasificador; la única vía
existente es `reabrirPedido` (🔍 Buscar → Reabrir), que resetea el pedido a Pendiente pero
**reutiliza sus líneas antiguas tal cual**, sin traer las direcciones frescas que Pyxis
pueda tener ahora.

## Decisiones ya acordadas con el usuario

1. **Líneas frescas de Pyxis**, no las antiguas — al forzar, se descartan las líneas viejas
   del pedido y se traen sus direcciones actuales del inventario Pyxis, igual que una
   importación nueva. (`reabrirPedido` sigue existiendo tal cual para el caso "mismas
   líneas de siempre, solo hay que volver a repasarlas".)
2. **Un botón "↩ Forzar" junto a cada omitido**, en el resultado de "Importar al sistema"
   del Clasificador — no una herramienta aparte de pegar números. El alcance de "forzable"
   son los pedidos que aparecieron en `omitidos` de la importación que se acaba de hacer,
   por estar en estado terminal (no los otros motivos de omisión — "ya en silueta", "ya
   existe sin cambios" — esos no tienen sentido forzarlos, no están resueltos).
3. **El botón "Forzar" abre un selector de direcciones** (checkboxes, igual que el que ya
   existe para "Añadir parcial") — todas marcadas = completo, algunas = parcial. No hay un
   modo "forzar siempre trae todo" aparte.
4. **Arquitectura: extender `importarClasificacion`** con un tercer modo de proceso
   ("forzados"), en vez de una función completamente aparte — reutiliza la misma
   resolución de Pyxis, el mismo candado y el mismo cálculo de `idPedido` que ya usan los
   otros dos modos (bloques pegados / parciales), evitando que la lógica de "traer de
   Pyxis" diverja entre el import normal y el forzado.

## Diseño

### 1. Servidor — `importarClasificacion` (ImportarClasificacion.gs)

**Nuevo parámetro** `opciones.forzados`: array de `{ ped, tienda, transporte, dirsSel }`.
- `tienda` viene YA fijada (la que tenía el pedido cuando se creó la primera vez) — no hay
  que resolver colisión de tienda otra vez, es la misma fila existente.
- `dirsSel`: direcciones marcadas en el selector (`[]`/ausente = todas las que traiga Pyxis
  ahora mismo).

**Nuevo bloque de proceso** (además de "1) bloques pegados" y "2) parciales" que ya
existen), por cada entrada de `forzados`:

1. `idPedido = codigoTienda(tienda) + '::' + ped` (determinista, la tienda ya viene fija).
2. Releer el estado actual de ese `idPedido` en PEDIDOS (no fiarse del que tenía en el
   momento de classificar/importar — puede haber pasado tiempo). **Si ya NO está en un
   estado terminal** (alguien lo reabrió manualmente mientras tanto, o ya se está
   preparando) → rechazar esa entrada con un mensaje claro, no pisar trabajo en curso.
3. `entry = indice[ped]` (mismo índice Pyxis ya cargado al principio de la función). **Si
   ya no está en el inventario Pyxis** → rechazar esa entrada ("ya no está en el
   inventario, no se puede forzar").
4. `lineasRaw = entry.porTienda[tienda].lineas`, filtradas por `dirsSel` si se pasó
   (mismo patrón que el filtrado de parciales que ya existe en `procesar()`).
5. **Resetear la fila PEDIDOS** — exactamente los mismos campos que `_reabrirPedidoInterno`
   limpia (`cambiosReabrir`: estado→`PENDIENTE`, pct→0, operario→'', silueta/posIni/posFin→'',
   numeroCarga→'', soportes→'[]', intentoCarga→'', comentario→'', actualizado→ahora) — el
   selector de "Forzar" no ofrece escribir un comentario nuevo (fuera de alcance, YAGNI; si
   hace falta uno se añade después desde la pantalla de Silueta, igual que cualquier otro
   pedido). Si tenía una carga activa asociada, quitarlo de ella
   (`_quitarPedidoDeSuCargaActiva`, mismo que ya usa `reabrirPedido`).
6. **Borrar todas las líneas antiguas** de ese `idPedido` en LINEAS y **crear las líneas
   frescas** a partir de `lineasRaw` — mismo pipeline que ya usa `crearPedidoConLineas`
   (deduplicar, ordenar, `clasificarUbicacion`/`esPicking` por dirección). Para no duplicar
   esa lógica, factorizar el tramo de `crearPedidoConLineas` que construye+inserta LINEAS
   (líneas 235-260 y 283-290 de ImportarPyxis.gs) en un helper compartido, p.ej.
   `_construirEInsertarLineas(idPedido, lineasRaw)` → `{nLin, nUbic}`, usado tanto por
   `crearPedidoConLineas` (alta nueva) como por este bloque nuevo (reemplazo).
7. Registrar en `historial_transportista` un evento **nuevo y distinguible**,
   `REABIERTO_FORZADO` (no reutilizar `REABIERTO`, que ya significa "mismas líneas de
   siempre" — aquí las líneas son otras) — añadir su etiqueta a `EVENTO_LABEL_HT` en
   Index.html ("Volvió (forzado, líneas nuevas)").
8. Todo esto ocurre dentro del MISMO candado que ya protege el resto de
   `importarClasificacion` — sin candado nuevo.
9. La sincronización a Supabase de la fila PEDIDOS actualizada se difiere hasta soltar el
   candado, mismo patrón que el resto de la función (`pendientesSyncSupabase` /
   `sincronizarPedidoSupabase_` tras el `finally`) — **regla del proyecto**: cualquier
   cambio que toque PEDIDOS debe incluir su sync a Supabase en el mismo cambio.

**Valor de retorno**: además de `creados`/`omitidos`/`noEncontrados`/`colisiones` que ya
devuelve, se añade `forzadosOk: [ped,...]` y `forzadosError: [{ped, motivo}]` para que el
Clasificador pueda confirmar el resultado de cada forzado.

**`omitidosForzables` en el resultado de la importación normal**: además del array
`omitidos` (strings, sin tocar — se sigue mostrando igual que hoy), se añade un array
nuevo `omitidosForzables: [{ped, tienda, transporte, estadoLabel}]` — solo las entradas que
se saltaron por estar en estado terminal (no las otras dos razones de omisión). Esto es lo
que el cliente usa para saber a qué omitidos ponerles el botón "Forzar".

### 2. Cliente — Clasificador.html

- El bloque que hoy pinta `res.omitidos` como texto plano (`msg += '\n✗ Omitidos: ' +
  res.omitidos.join(', ')`) se mantiene igual. Se añade, debajo, una lista de chips por
  cada entrada de `res.omitidosForzables`, cada uno con su número + botón "↩ Forzar".
- Al pulsar "Forzar" en un pedido: llama a `obtenerPedido(ped, tienda)` (función YA
  existente en Inventario.gs, sin cambios) para traer las direcciones frescas ahora mismo.
  - Si devuelve `null` → aviso "ya no está en el inventario Pyxis, no se puede forzar",
    no se abre el selector.
  - Si devuelve datos → se abre el MISMO selector de checkboxes que ya existe para
    "Añadir parcial" (reutilizar el markup/lógica de `dirsBox`/`marcarDirs`), con las
    direcciones de esta llamada.
- Al confirmar el selector (con al menos una dirección marcada — igual que ya exige hoy
  "Añadir parcial"): llama a
  `importarClasificacion({}, {forzados:[{ped, tienda, transporte, dirsSel}]})` — payload de
  números nuevos vacío, solo ese forzado.
- Al recibir la respuesta: si `forzadosOk` incluye el ped, mostrar confirmación y quitar
  ese chip de la lista de forzables; si aparece en `forzadosError`, mostrar el motivo sin
  quitar el chip (para poder reintentar).

## Errores

| Caso | Comportamiento |
|---|---|
| Pedido ya no está en Pyxis al forzar | Aviso, no se abre el selector / no se procesa esa entrada. |
| Pedido ya salió del estado terminal entre listarse como omitido y pulsar Forzar (otra persona lo reabrió mientras tanto) | Rechazado con mensaje explícito, no se pisa el trabajo en curso. |
| Ninguna dirección marcada en el selector | No deja confirmar (igual que ya pasa hoy con "Añadir parcial"). |
| Fallo de red/servidor al forzar | Mismo patrón `withFailureHandler` que ya usan `clasificar()`/`importar()`. |

## Alcance explícitamente fuera (YAGNI)

- **No** hay que resolver colisión de tienda al forzar — la tienda ya quedó fijada la
  primera vez que el pedido se creó; se reutiliza tal cual, sin repetir esa UI.
- **No** se toca `reabrirPedido` — sigue existiendo igual, para el caso "mismas líneas de
  siempre, solo repasarlas", accesible desde 🔍 Buscar.
- **No** se añade una herramienta aparte de "pegar números a forzar" — el único punto de
  entrada es el botón junto a cada omitido, inmediatamente después de importar.

## Pruebas (contra `staging` / datos falsos en Sheets, antes de tocar producción)

1. Pedido en estado terminal (p.ej. `ENTREGADO`), forzado completo (todas las direcciones)
   → pedido vuelve a `PENDIENTE`, líneas antiguas desaparecen, líneas nuevas = las de Pyxis
   ahora mismo, historial con evento `REABIERTO_FORZADO`.
2. Mismo caso, forzado parcial (solo alguna dirección marcada) → solo esas líneas se crean,
   `PEDIDOS.parcial` queda marcado igual que un alta parcial normal.
3. Pedido que ya no está en el inventario Pyxis en el momento de forzar → rechazo limpio,
   nada se toca.
4. Carrera: pedido que deja de estar en estado terminal entre que se lista como omitido y
   que se pulsa Forzar → rechazo explícito, no se pisa el trabajo en curso de quien ya lo
   reabrió.
5. Verificar que no quedan líneas antiguas huérfanas tras el reemplazo (recuento de LINEAS
   para ese `idPedido` antes/después).
6. Verificar sync a Supabase de la fila PEDIDOS actualizada (mismo patrón que el resto de
   `importarClasificacion`).

## Archivos afectados

- `ImportarClasificacion.gs` — nuevo bloque de proceso "forzados" en `importarClasificacion`,
  nuevos campos de retorno.
- `ImportarPyxis.gs` — factorizar `_construirEInsertarLineas` a partir de
  `crearPedidoConLineas`, reutilizada por el nuevo bloque.
- `Clasificador.html` — chips "↩ Forzar" en el resultado de import, reutilización del
  selector de direcciones ya existente.
- `Index.html` — nueva etiqueta `REABIERTO_FORZADO` en `EVENTO_LABEL_HT`.
