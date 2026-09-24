-- Fase 3, Lote 1 -- Tarea 1: sembrar config_siluetas (staging) con la
-- capacidad EFECTIVA real leída de Apps Script (posicionesDeSilueta(), que
-- fusiona CONFIG.POSICIONES_POR_SILUETA con el override de PropertiesService).
-- Verificado empíricamente el 2026-08-13 vía ejecutarDiagnosticoCapacidadesSiluetas()
-- (Pruebas.gs): sin override activo, coincide con los valores por defecto del código.
insert into staging.config_siluetas (silueta, posiciones) values
  ('A', 16), ('B', 16), ('C', 16), ('D', 16), ('E', 27), ('F', 27)
on conflict (silueta) do update set posiciones = excluded.posiciones;
