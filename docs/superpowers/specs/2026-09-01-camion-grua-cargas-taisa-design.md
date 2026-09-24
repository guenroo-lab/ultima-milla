# Camión Grúa → CARGAS TAISA — Diseño

## Contexto

Cuando una carga sale en un camión grúa (un transporte especial, gestionado por una agencia
externa — Remansur, Correcaminos o Malaga Transport), hay que registrar cada pedido de esa
carga en una hoja de Google Sheets externa y ya existente, mantenida por otro equipo:
**"PANEL RUTAS GRÚA MÁLAGA"** (id `1BShlbVdf3UWetJlOGKzFsOO19VwxWd2DkTkqO2XqJjg`), pestaña
**"CARGAS TAISA"**.

Columnas reales de esa hoja (confirmadas leyendo la hoja en vivo, no supuestas):

| Col | Campo | Formato real |
|---|---|---|
| A | AGENCIA | `REMANSUR` / `CORRECAMINOS` / `MALAGA TRANSPORT` |
| B | FECHA | fecha de carga |
| C | TIENDA | código sin ceros: `14`=Marbella, `36`=Málaga, `279`=Mijas |
| D | PC | número de pedido |
| E | TIPO CLIENTE | `PRO` / `PARTICULAR` |
| F | LOCALIDAD | ciudad de envío |
| G | C.P. | código postal de envío |
| H | KG | peso |
| I | OBSERVACIONES | texto libre (no se rellena desde la app) |

**Este proyecto (lm_produccion) no tiene hoy ninguna de las columnas E-H** (tipo cliente,
localidad, CP, peso) en su propio modelo de datos — el inventario de Pyxis que ya se importa
(`INVENTARIO_FOLDER_ID`, archivos `036.xlsx`/`014.xlsx`/`279.xlsx`/`043.xlsx`) solo trae
dirección/referencia/EAN/descripción/cantidad, nada de dirección de envío ni peso.

**Fuente real de esos datos, confirmada por el usuario**: el mismo `INVENTARIO_FOLDER_ID`
contiene también `pedidos_totales.csv` (un export completo de Pyxis, actualizado a diario,
~35 MB, separado por `;`) con, entre muchas otras, estas columnas por línea de pedido:
`Nº Pedido cliente`, `Cliente PRO` (`si`/`no`), `Peso`, `Código postal envío`, `Ciudad envío`.
Un mismo pedido aparece en varias filas (una por línea de artículo) pero estos campos son
idénticos en todas sus filas — basta la primera coincidencia por número de pedido.

## Decisiones ya acordadas con el usuario

1. **Se marca la CARGA entera**, no pedidos sueltos — un checkbox "🏗️ Es Camión Grúa" en el
   formulario de "Nueva carga", junto al campo de chófer que ya existe. Al marcarlo, aparece
   un selector de Agencia (Remansur / Correcaminos / Malaga Transport).
2. **El volcado a CARGAS TAISA es automático**, en el mismo momento de crear la carga — sin
   botón aparte ni paso manual adicional.
3. **Best-effort, no bloqueante** — si un pedido no aparece en `pedidos_totales.csv`, la fila
   se crea igual con las celdas de localidad/CP/peso/tipo cliente en blanco. Si escribir en
   la hoja externa fallara del todo, la carga ya se ha creado de todas formas — no se pierde
   ni se revierte nada, mismo criterio que la sincronización a Supabase ya existente en el
   resto de la app.
4. **Se guarda en la propia carga** (hoja `CARGAS`) que es Camión Grúa + la agencia elegida,
   para poder consultarlo después.

## Diseño técnico

### 1. Esquema — nuevas columnas en `CARGAS`

Dos columnas nuevas, añadidas por posición (mismo patrón ya usado en este proyecto para
columnas nuevas de `PEDIDOS` — ver `migrarColumnaParcialPedidos()` en `Pruebas.gs` como
referencia del patrón, aunque aquí basta con añadirlas al final de `COLUMNAS.CARGAS` y a la
hoja real, sin necesidad de migrar datos existentes ya que empiezan vacías/false):

- `esCamionGrua` (booleano, por defecto `false`)
- `agencia` (texto, vacío si no es Camión Grúa)

### 2. Servidor — `crearCarga` (Backend.gs)

Firma extendida: `crearCarga(listaNumPedidos, responsable, esCamionGrua, agencia)` — los dos
parámetros nuevos son opcionales (`undefined`/`false` para cargas normales, sin cambiar nada
del comportamiento actual).

Tras crear la carga con éxito (mismo punto donde ya se hace
`pendienteSyncsCarga.push(...)`), si `esCamionGrua` es verdadero: por cada `item` de la
carga, se busca su fila en el índice cacheado de `pedidos_totales.csv` (ver más abajo) y se
añade una fila a la pestaña "CARGAS TAISA" de la hoja externa, envuelto en `try/catch` para
que un fallo ahí (hoja externa caída, sin permisos, etc.) no afecte a la respuesta ya
correcta de "carga creada".

### 3. Índice cacheado de `pedidos_totales.csv`

Nueva función `_indicePedidosTotales()` (patrón calcado de `cargarInventario`/
`_cacheGetInv`/`_cachePutInv`, mismo `CacheService`): abre el CSV desde
`INVENTARIO_FOLDER_ID`, lo trocea por `;` (NO por `,` — el fichero real usa punto y coma),
construye un mapa `Nº Pedido cliente → { peso, cp, ciudad, esPro }` quedándose con la
PRIMERA fila de cada pedido (los campos de cabecera de pedido son idénticos en todas sus
líneas), y cachea el resultado el resto del día (el propio usuario confirma que el fichero
se actualiza una vez al día). Un fallo al leer/parsear el CSV no debe romper la creación de
la carga — se captura y cada pedido de esa carga queda simplemente sin datos de esas 4
columnas.

### 4. Escritura en la hoja externa

Función `_anadirFilasCargasTaisa_(agencia, fecha, items, indiceCsv)`: abre
`SpreadsheetApp.openById('1BShlbVdf3UWetJlOGKzFsOO19VwxWd2DkTkqO2XqJjg')`, la pestaña
`'CARGAS TAISA'`, y añade una fila por `item` con las 8 columnas (A-H; I se deja vacía) —
tienda mapeada a su código SIN ceros (`Number(codigoTienda(item.tienda))`, ya que
`codigoTienda` devuelve texto con ceros tipo `'036'`), tipo cliente `'PRO'`/`'PARTICULAR'`
según `esPro` (`undefined` si el pedido no está en el índice → celda vacía).

### 5. Cliente (Index.html)

En el formulario "Nueva carga" (`renderCargas`/función que pinta el campo "Chofer del
vehículo"): checkbox `🏗️ Es Camión Grúa` justo debajo del campo de chófer. Al marcarlo,
aparece un `<select>` con las 3 agencias (oculto si no está marcado). `crearCarga()`
(cliente) recoge estos dos valores nuevos y los añade a la llamada existente.

## Alcance explícitamente fuera (YAGNI)

- No se construye ninguna pantalla nueva de administración para ver/editar filas ya volcadas
  a CARGAS TAISA — esa hoja la gestiona el otro equipo directamente.
- No se reintenta automáticamente si falla la escritura en la hoja externa — es best-effort,
  igual que el resto de integraciones externas de este proyecto.
- No se toca el concepto ya existente "GruaRemansur" (flujo `grua_remansur`, cajón propio del
  operario para picking) — es un concepto totalmente distinto (a qué cajón pertenece un
  pedido para prepararlo) del que se diseña aquí (cómo se transportó físicamente una carga ya
  preparada, para un reporte externo).

## Pruebas

1. Verificar en vivo el parseo de `pedidos_totales.csv` (separador `;`, columnas correctas)
   contra un pedido real conocido, comparando con lo que se ve a simple vista en el CSV.
2. Probar `_anadirFilasCargasTaisa_` de forma AISLADA (sin pasar por `crearCarga` real, para
   no tener que fabricar una carga real completa con siluetas/posiciones/candados): llamarla
   directamente con un `items` sintético (tienda/ped inventados, claramente identificables
   como prueba) y confirmar que la fila que aparece en CARGAS TAISA tiene las 8 columnas
   correctas — luego borrar esa fila de prueba a mano en la hoja externa.
3. Confirmar que una carga NORMAL (checkbox sin marcar) se sigue creando exactamente igual
   que hoy, sin ninguna llamada a la hoja externa — probado desde la pantalla real, con un
   pedido real, verificando que no aparece ninguna fila nueva en CARGAS TAISA.
4. Confirmar que un pedido inventado que no esté en `pedidos_totales.csv` no rompe nada —
   fila creada con las 4 columnas en blanco (mismo test aislado del punto 2, con un número de
   pedido que no exista en el CSV).
