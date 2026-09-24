create or replace function staging.compartir_frente_remansur(
  p_silueta text, p_pos int, p_ped text, p_tienda text, p_flujo text
) returns boolean language plpgsql as $$
declare v_filas int;
begin
  update staging.ocupacion_siluetas front
  set pedido = p_ped, tienda = p_tienda, flujo = p_flujo, reservado = false
  from staging.ocupacion_siluetas back
  where front.silueta = p_silueta and front.pos::int = p_pos and front.layer = 'front'
    and back.silueta = p_silueta and back.pos::int = p_pos and back.layer = 'back'
    and back.flujo in ('remansur_transporte', 'remansur_pro')
    and front.reservado = true;
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end $$;
