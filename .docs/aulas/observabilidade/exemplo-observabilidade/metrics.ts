/**
 * As métricas do caixa, no formato de texto que o Prometheus lê.
 *
 * Um histograma só responde às três perguntas do método RED:
 *   Rate     quantas requisições por segundo?   → _count
 *   Errors   quantas deram erro?                → _count com status="5.."
 *   Duration quanto tempo levam?                → _bucket (dá o p50, o p95, o p99)
 */
const NAME = "http_server_request_duration_seconds";

// Os limites dos baldes, em segundos: quantas levaram até 5 ms? até 10 ms? ...
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Series = { buckets: number[]; sum: number; count: number };

// Uma série por combinação de rótulos. A rota é o padrão ("/pedidos"), nunca a
// URL com um id: cada valor novo de rótulo é mais uma série guardada para sempre.
const series = new Map<string, Series>();

export function observeRequest(method: string, route: string, status: number, seconds: number) {
  const labels = `method="${method}",route="${route}",status="${status}"`;
  let s = series.get(labels);
  if (!s) series.set(labels, (s = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
  // cumulativo: uma requisição de 30 ms conta em "até 50 ms" e em todos os maiores
  BUCKETS.forEach((le, i) => {
    if (seconds <= le) s.buckets[i]++;
  });
  s.sum += seconds;
  s.count++;
}

type QueueNumbers = { aguardando: number; pendentes: number; mortas: number };

/** O texto do /metrics. Sem a fila (null), só as métricas HTTP. */
export function renderMetrics(fila: QueueNumbers | null): string {
  const lines = [`# HELP ${NAME} Duração das requisições HTTP, em segundos.`, `# TYPE ${NAME} histogram`];
  for (const [labels, s] of series) {
    BUCKETS.forEach((le, i) => lines.push(`${NAME}_bucket{${labels},le="${le}"} ${s.buckets[i]}`));
    lines.push(`${NAME}_bucket{${labels},le="+Inf"} ${s.count}`);
    lines.push(`${NAME}_sum{${labels}} ${s.sum}`);
    lines.push(`${NAME}_count{${labels}} ${s.count}`);
  }

  // Gauges: o valor de agora, lido do Redis na hora da coleta.
  const gauge = (name: string, help: string, value: number) =>
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}{stream="pedidos"} ${value}`);
  if (fila) {
    gauge("queue_messages_waiting", "Mensagens publicadas e ainda não entregues a um worker.", fila.aguardando);
    gauge("queue_messages_pending", "Mensagens entregues e ainda não confirmadas.", fila.pendentes);
    gauge("queue_dead_letters", "Mensagens na fila de mortas: alguém precisa olhar.", fila.mortas);
  }
  return lines.join("\n") + "\n";
}
