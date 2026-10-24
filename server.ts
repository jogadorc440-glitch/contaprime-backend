/**
 * ContaPrime backend — proxy server-side para a Routeis Partner API.
 *
 * Por que um backend? A chave da Routeis (ROUTEIS_API_KEY) NUNCA pode ir
 * para o site (frontend): qualquer visitante veria a chave no código-fonte
 * e poderia gastar o seu saldo. Este servidor guarda a chave e expõe só o
 * que o site precisa, sem chave e sem log de entrega.
 *
 * Rode (server-side apenas):
 *   ROUTEIS_API_KEY=sk_live_... PORT=3001 FRONTEND_ORIGIN=https://seu-site npx tsx server.ts
 *
 * Endpoints (o site ContaPrime chama ESTES, nunca a api.cmpdr.dev direto):
 *   GET  /api/health   -> status da API Routeis
 *   GET  /api/catalog  -> catálogo ao vivo (campos seguros, sem chave)
 *   POST /api/orders   -> { productRef, quantity, externalOrderId }
 *                         cria o pedido na Routeis e devolve o pedido.
 *
 * ATENÇÃO — pagamento: este endpoint cria o pedido IMEDIATAMENTE e devolve
 * a entrega ao comprador. Em produção, chame-o SOMENTE DEPOIS de confirmar
 * o pagamento do cliente (Pix/gateway). Sem essa trava, qualquer visitante
 * poderia gerar entregas de graça e drenar o seu saldo na Routeis.
 * A entrega devolvida aqui é segredo: não a logue, não a guarde em log.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RouteisClient, RouteisApiError } from "./routeis-client";

const PORT = Number(process.env.PORT ?? 3001);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "*";

const client = new RouteisClient(); // lê ROUTEIS_API_KEY do ambiente

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    if (req.method === "GET" && req.url === "/api/health") {
      sendJson(res, 200, await client.health());
      return;
    }

    if (req.method === "GET" && req.url === "/api/catalog") {
      const catalog = await client.listProducts({ description: true });
      // Só campos seguros para o frontend. Nada de chave, nada interno.
      sendJson(res, 200, {
        locale: catalog.meta.locale,
        data: catalog.data.map((p) => ({
          id: p.id,
          productRef: p.productRef,
          name: p.name,
          price: p.price, // string, sem arredondar
          currency: p.currency,
          deliveryType: p.deliveryType,
          description: p.description,
          stock: p.stock,
        })),
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/orders") {
      const body = await readJson(req);
      const productRef = typeof body.productRef === "string" ? body.productRef : "";
      const quantity = typeof body.quantity === "number" ? body.quantity : 1;
      const externalOrderId = typeof body.externalOrderId === "string" ? body.externalOrderId : "";
      if (!productRef || !externalOrderId) {
        sendJson(res, 400, { ok: false, error: { code: "INVALID_REQUEST", message: "productRef e externalOrderId são obrigatórios." } });
        return;
      }
      // TODO (produção): verificar o pagamento do cliente ANTES desta linha.
      const order = await client.createOrder(productRef, quantity, externalOrderId);
      // Devolve a entrega ao comprador — NÃO a logue aqui.
      sendJson(res, 200, {
        ok: true,
        orderCode: order.orderCode,
        externalOrderId: order.externalOrderId,
        status: order.status,
        product: order.product,
        quantity: order.quantity,
        unitPrice: order.unitPrice,
        totalCharged: order.totalCharged,
        currency: order.currency,
        isReplay: order.isReplay,
        deliveryContents: order.deliveryContents,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Rota não encontrada." } });
  } catch (err) {
    // Log seguro: só código e orderCode, nunca chave nem entrega.
    if (err instanceof RouteisApiError) {
      console.error(`Routeis [${err.code}] HTTP ${err.status}`);
      sendJson(res, err.status || 500, {
        ok: false,
        error: { code: err.code, message: err.message, requestId: err.requestId },
      });
      return;
    }
    console.error("Erro interno no backend.");
    sendJson(res, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "Erro interno." } });
  }
});

server.listen(PORT, () => {
  console.log(`ContaPrime backend ouvindo na porta ${PORT} (chave lida do ambiente, nunca exposta).`);
});
