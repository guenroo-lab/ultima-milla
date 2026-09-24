# Robot de inventarios — variante LibreOffice Calc

## Contexto

El robot de inventarios (`PLANTILLA_ROBOT_INVENTARIOS_PS1` en `Backend.gs`, ver
[[lm-malaga-robot-inventarios-navegador]]) automatiza: Pyxis genera el
"Listado de inventario Pedido Cliente" → se abre en la app de hojas de cálculo
por defecto del PC → el robot lo guarda como `<codigo tienda>.xlsx` en el
Escritorio → lo sube a la app (Drive) vía navegador ya autenticado.

El usuario quiere poder correr este flujo en un PC donde la app que abre el
listado es **LibreOffice Calc**, no Microsoft Excel. El diálogo "Guardar
como" de LibreOffice es distinto al de Excel (atajo, nombre del desplegable
de tipo, opción a elegir).

## Alcance

- **Nuevo** script independiente para LibreOffice Calc. **No se toca**
  `PLANTILLA_ROBOT_INVENTARIOS_PS1` (Excel) ni `BLOQUE_EJECUCION_BUCLE_INVENTARIOS_PS1`
  — quedan exactamente como están, en uso.
- Fuera de alcance por ahora: variante "en bucle" (PC aislado) para
  LibreOffice — se añadirá más adelante si hace falta, no en este cambio.
- Fuera de alcance: botón de descarga en la UI de la app. Igual que la
  variante en bucle, este script se genera **a mano desde el editor de Apps
  Script**, no desde Index.html.

## Diseño

### Nuevos artefactos en `Backend.gs`

- `PLANTILLA_ROBOT_INVENTARIOS_LIBREOFFICE_PS1`: copia completa de
  `PLANTILLA_ROBOT_INVENTARIOS_PS1` con un único cambio funcional, dentro de
  `Exportar-InventarioTienda`: el bloque que dispara y resuelve el diálogo
  "Guardar como" (ver detalle abajo). Todo lo demás —Add-Type/Win32Mouse/UIA
  helpers, `Ir-AInicioPyxis`, `Subir-Inventarios`/`Subir-InventariosIntento`,
  `Cerrar-PestanaSubida`, el bloque `# EJECUCION`— se copia tal cual, sin
  modificar ni una línea, para no arriesgar nada del flujo ya probado en
  producción.
- `generarScriptRobotInventariosLibreOffice()`: mismo patrón que
  `generarScriptRobotInventarios()` — sustituye `__WEBAPP_URL__` y
  `__TOKEN__` con `ScriptApp.getService().getUrl()` y
  `getOCrearTokenRobotInventario()` (el mismo token que ya usan las otras dos
  variantes, es el mismo PC/uso).
- Salida al generar: texto de un `.ps1` que el usuario guarda como
  `robot_inventarios_libreoffice.ps1` (y opcionalmente un `.bat` lanzador
  idéntico en forma a `robot_inventarios_bucle.bat`, solo cambia el nombre
  del `.ps1` que invoca).

### Cambio dentro de `Exportar-InventarioTienda` (solo el paso de guardado)

1. **Disparo:** `[System.Windows.Forms.SendKeys]::SendWait("^+s")`
   (Ctrl+Mayús+S) en vez de `{F12}`.
2. **Nombre de archivo:** sin cambio — misma ruta
   `Desktop\<codigo tienda>.xlsx` (campo de nombre, `Ctrl+A` + escribir ruta
   completa, igual que ahora).
3. **Localizar el desplegable de tipo:** se prueban varios nombres de campo
   candidatos en orden (`"Tipo de archivo:"`, `"Tipo:"`) en vez de asumir uno
   solo — LibreOffice puede rotular el combo distinto al diálogo nativo de
   Windows que usa Excel.
4. **Elegir el formato:** se busca el ítem de la lista cuyo texto
   **contenga** "Excel 2007-365" (coincidencia por texto, no por posición —
   la posición en la lista puede variar entre versiones; el texto es el dato
   estable que dio el usuario).
5. **Diálogo opcional "mantener formato":** LibreOffice puede preguntar si
   mantener el formato ajeno (Excel) o usar ODF al guardar. Se trata como
   **best-effort**: tras pulsar Guardar, se espera hasta ~3s una ventana
   nueva; si aparece, se busca un botón cuyo texto contenga "Excel" o
   "usar"/"mantener" y se pulsa; si no aparece, se continúa sin más (no debe
   bloquear el flujo si la suposición de que aparece resulta incorrecta).
6. **Diálogo de sobrescritura** (si el archivo del día anterior ya existe):
   mismo tratamiento best-effort que ya tiene la versión Excel (buscar
   ventana "Confirmar Guardar como" / similar, pulsar "Sí" si aparece).
7. **Resto de la función sin cambios:** esperar a que el archivo exista en
   disco, cerrar el proceso por PID para liberar el lock, cerrar el diálogo
   de Pyxis con "Cancelar".

### Riesgo conocido y cómo se maneja

No hay forma de verificar en vivo los nombres exactos de los controles del
diálogo de LibreOffice desde este entorno (no hay LibreOffice accesible
aquí). Por eso los pasos 3-6 usan **coincidencia por varios candidatos /
best-effort** en vez de un único nombre fijo, y cada `throw` existente ya da
un mensaje descriptivo de qué paso falló — si algo no encaja la primera vez
que se corre de verdad, el error señala directamente qué nombre de control
hay que ajustar, sin tocar el resto del script. Esto es consistente con
cómo se depuró originalmente la automatización de Pyxis (ver
[[lm-malaga-robot-muelles-pyxis-uia]]): iterar contra la app real.

## Pendiente de verificar en el primer uso real

- Si el diálogo "Guardar como" de LibreOffice es el nativo de Windows o el
  propio de LibreOffice (cambia qué nombres de control aparecen).
- Si realmente aparece el diálogo de "mantener formato" y con qué texto de
  botón exacto.
- Texto exacto del ítem de formato en el desplegable (se asume que contiene
  literalmente "Excel 2007-365").
