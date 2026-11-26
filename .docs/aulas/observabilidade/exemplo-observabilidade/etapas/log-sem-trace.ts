import { basename } from "node:path";

// Quem escreveu a linha: "index" (o caixa) ou "worker" (a cozinha).
const SERVICE = basename(Bun.main, ".ts");

type Level = "info" | "warn" | "error";

/**
 * Uma linha de log é um objeto JSON numa linha só.
 * Texto solto ("✗ pedido 7 falhou") serve para gente ler. JSON serve para a
 * máquina filtrar: os campos têm nome e são sempre os mesmos.
 */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const line = { time: new Date().toISOString(), level, service: SERVICE, msg, ...fields };
  console.log(JSON.stringify(line));
}
