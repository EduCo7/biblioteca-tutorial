import { basename } from "node:path";
import { currentTraceparent, traceIdOf } from "./trace";

// Quem escreveu a linha: "index" (o caixa) ou "worker" (a cozinha).
const SERVICE = basename(Bun.main, ".ts");

type Level = "info" | "warn" | "error";

/**
 * Uma linha de log é um objeto JSON numa linha só.
 * Texto solto ("✗ pedido 7 falhou") serve para gente ler. JSON serve para a
 * máquina filtrar: os campos têm nome e são sempre os mesmos.
 */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  // o número da comanda entra sozinho em toda linha escrita dentro de withTrace
  const trace_id = traceIdOf(currentTraceparent()) ?? undefined;
  const line = { time: new Date().toISOString(), level, service: SERVICE, msg, trace_id, ...fields };
  console.log(JSON.stringify(line));
}
