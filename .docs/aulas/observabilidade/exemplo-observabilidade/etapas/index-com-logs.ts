import { RedisClient } from "bun";
import { log } from "./log";

// 1. A fila. Sem ela, falhar na hora (500) em vez de deixar o cliente esperando:
//    com a fila de comandos offline desligada, o Redis fora do ar vira erro em 1 ms.
const queue = new RedisClient("redis://localhost:6400", { enableOfflineQueue: false });
await queue.connect();

const STREAM = "pedidos";
const DEAD = `${STREAM}:mortas`;

async function queueNumbers() {
  const total = await queue.send("XLEN", [STREAM]);
  const dead = await queue.send("XLEN", [DEAD]);
  const [group] = total ? await queue.send("XINFO", ["GROUPS", STREAM]) : [];
  return {
    aguardando: group ? (group.lag ?? 0) : total,
    pendentes: group ? group.pending : 0,
    mortas: dead,
  };
}

type Handler = (req: Request) => Response | Promise<Response>;

// 2. Toda rota passa por aqui: uma linha de log por requisição, com a rota,
//    o status e quanto tempo levou. O erro inesperado vira 500 com log, em vez
//    de sumir na página de erro padrão do Bun.
function observe(route: string, handler: Handler): Handler {
  return async (req) => {
    const start = performance.now();
    let response: Response;
    try {
      response = await handler(req);
    } catch (error) {
      log("error", "erro inesperado", { route, error: (error as Error).message });
      response = Response.json({ error: "Erro interno" }, { status: 500 });
    }
    const duration_ms = Math.round(performance.now() - start);
    log("info", "requisição", { method: req.method, route, status: response.status, duration_ms });
    return response;
  };
}

Bun.serve({
  port: 3300,
  routes: {
    "/": () => new Response(Bun.file(new URL("./index.html", import.meta.url))),

    "/pedidos": {
      GET: observe("/pedidos", async () => {
        const last = Number((await queue.get("senha")) ?? 0);
        const pedidos = [];
        for (let senha = last; senha > Math.max(0, last - 12); senha--) {
          pedidos.push({ senha, ...(await queue.hgetall(`pedido:${senha}`)) });
        }
        return Response.json({ fila: await queueNumbers(), pedidos });
      }),

      POST: observe("/pedidos", async (req) => {
        const { item } = await req.json();
        if (typeof item !== "string" || !item.trim()) {
          return Response.json({ error: "Informe o item" }, { status: 400 });
        }
        const senha = await queue.incr("senha");
        await queue.send("HSET", [`pedido:${senha}`, "item", item.trim(), "status", "na fila"]);
        const id = await queue.send("XADD", [STREAM, "MAXLEN", "~", "1000", "*", "dados", JSON.stringify({ senha })]);
        log("info", "pedido na fila", { senha, item: item.trim(), mensagem: id });
        return Response.json({ senha, mensagem: id }, { status: 202 });
      }),
    },
  },
});

log("info", "caixa aberto", { url: "http://localhost:3300" });
