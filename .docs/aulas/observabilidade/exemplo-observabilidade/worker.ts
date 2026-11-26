import { RedisClient } from "bun";
import { log } from "./log";
import { continueTrace, withTrace } from "./trace";

// O worker da aula de filas, com log em JSON e a comanda (traceparent) que
// chega junto com cada mensagem.
//   bun worker.ts            um worker chamado worker-<pid>
//   bun worker.ts chapa-2    dê um nome a cada um
const queue = new RedisClient("redis://localhost:6400");

const STREAM = "pedidos";
const GROUP = "workers";
const DEAD = `${STREAM}:mortas`;
const CONSUMER = process.argv[2] ?? `worker-${process.pid}`;

const PREP_MS = 3000;
const RETRY_AFTER_MS = 8000;
const MAX_DELIVERIES = 3;

type Entry = [id: string, fields: string[]];

try {
  await queue.send("XGROUP", ["CREATE", STREAM, GROUP, "0", "MKSTREAM"]);
} catch (error) {
  if (!String(error).includes("BUSYGROUP")) throw error;
}

async function prepare(senha: number) {
  const key = `pedido:${senha}`;
  const order = await queue.hgetall(key);
  if (order.status === "pronto") return;
  if (order.item === "pedra") throw new Error("não sei fazer sopa de pedra");

  await queue.send("HSET", [key, "status", "em preparo", "worker", CONSUMER]);
  Bun.sleepSync(PREP_MS);
  await queue.send("HSET", [key, "status", "pronto"]);
}

async function run([id, fields]: Entry, deliveries: number) {
  // fields = ["dados", '{"senha":7}', "traceparent", "00-4bf9…-01"]
  const field = (name: string) => fields[fields.indexOf(name) + 1];
  // A comanda que veio na mensagem continua aqui, num trecho novo (span novo).
  // Mensagem antiga, sem o campo? Começa um trace novo, sem quebrar nada.
  const traceparent = continueTrace(field("traceparent"));

  await withTrace(traceparent, async () => {
    const { senha } = JSON.parse(field("dados"));
    await queue.send("HSET", [`pedido:${senha}`, "tentativas", String(deliveries)]);
    const about = { senha, mensagem: id, worker: CONSUMER, tentativa: deliveries };
    try {
      await prepare(senha);
      await queue.send("XACK", [STREAM, GROUP, id]);
      log("info", "pedido pronto", about);
    } catch (error) {
      const reason = (error as Error).message;
      if (deliveries < MAX_DELIVERIES) {
        log("warn", "pedido falhou; vai voltar para a fila", { ...about, error: reason });
        return;
      }
      // ...fields leva o traceparent junto: na gaveta, a comanda continua legível
      await queue.send("XADD", [DEAD, "*", ...fields, "erro", reason, "origem", id]);
      await queue.send("XACK", [STREAM, GROUP, id]);
      await queue.send("HSET", [`pedido:${senha}`, "status", "falhou"]);
      log("error", "pedido foi para as mortas", { ...about, error: reason });
    }
  });
}

async function retryStuck() {
  const stuck = await queue.send("XPENDING", [STREAM, GROUP, "IDLE", String(RETRY_AFTER_MS), "-", "+", "10"]);
  for (const [id, , , deliveries] of stuck) {
    const claimed: Entry[] = await queue.send("XCLAIM", [STREAM, GROUP, CONSUMER, String(RETRY_AFTER_MS), id]);
    for (const entry of claimed) await run(entry, deliveries + 1);
  }
}

async function readNew() {
  const reply = await queue.send("XREADGROUP", [
    "GROUP", GROUP, CONSUMER, "COUNT", "1", "BLOCK", "2000", "STREAMS", STREAM, ">",
  ]);
  for (const entry of reply?.[STREAM] ?? []) await run(entry, 1);
}

log("info", "worker esperando pedidos", { worker: CONSUMER });
while (true) {
  try {
    await retryStuck();
    await readNew();
  } catch (error) {
    log("warn", "fila fora do ar; nova tentativa em 1 s", { worker: CONSUMER, error: (error as Error).message });
    await Bun.sleep(1000);
  }
}
