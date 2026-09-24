grant execute on function staging._max_pos_silueta(text) to service_role;
grant execute on function staging._liberar_ocupacion(text, int, int, text) to service_role;
grant execute on function staging.compartir_frente_remansur(text, int, text, text, text) to service_role;
grant execute on function staging.cerrar_pedido(text, text, int, jsonb, jsonb, text) to service_role;
grant execute on function staging.mover_pedido_de_silueta(text, text, int, jsonb, text) to service_role;
grant execute on function staging.corregir_soportes_pedido(text, jsonb, jsonb, text, int, text) to service_role;
grant execute on function staging.liberar_pedido_de_silueta(text, text, text, text) to service_role;
grant execute on function staging.aplicar_compactar_siluetas(jsonb) to service_role;
