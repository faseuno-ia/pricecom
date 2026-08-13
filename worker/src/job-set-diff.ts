// 2G-R9-PR2 · §3 · prueba de exclusividad por DIFERENCIA DE CONJUNTOS (sin relojes). Reemplaza
// `createdAt > anchor` como prueba principal: el canary compara el conjunto de job IDs de DT antes y
// después de crear el job controlado y exige added == [CONTROLLED_JOB_ID] ∧ removed == []. PURO.

export function diffJobIds(preIds: string[], postIds: string[]): { added: string[]; removed: string[] } {
  const pre = new Set(preIds);
  const post = new Set(postIds);
  const added = [...post].filter((id) => !pre.has(id)).sort();
  const removed = [...pre].filter((id) => !post.has(id)).sort();
  return { added, removed };
}
