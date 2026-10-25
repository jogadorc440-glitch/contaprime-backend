/**
 * ContaPrime backend — proxy server-side para a Routeis Partner API,
 * COM TRAVA DE PAGAMENTO Asaas (Pix).
 *
 * REGRA DE OURO (instrução do dono, 2026-10-24):
 *   O produto só é liberado DEPOIS que o pagamento é confirmado.
 *   Sem pagamento confirmado, NADA é pedido na Routeis e NADA é
 *   descontado do saldo do dono.
 *
 * Fluxo automático (só para os produtos da tabela SALE_PRICES_CENTS):
 *   1. Site chama POST /api/payments { productRef, quantity,
 *      customerName, customerEmail }.
 *   2. Backend calcula o total com a PRÓPRIA tabela de preços (nunca
 *      confia no valor que o site manda) e cria a cobrança Pix no Asaas.
 *   3. Backend devolve o QR Code Pix + copia-e-cola. O cliente paga
 *      no banco dele. Nada é entregue aqui.
 *   4. Quando o Asaas confirma, o backend só libera se o status for
 *      "RECEIVED". "CONFIRMED" NÃO basta: em conta de pessoa física
 *      o Asaas avisa que CONFIRMED pode ser temporário (bloqueio
 *      cautelar de até 72h) e depois virar RECEIVED ou REFUNDED.
 *   5. Só então o backend chama a Routeis com externalOrderId fixo
 *      `asaas-<paymentId>`: se a entrega já aconteceu, a Routeis
 *      devolve o MESMO pedido (idempotência) e nunca cobra duas vezes.
 *
 * Como o pagamento é confirmado (dois caminhos, o segundo cobre o
 * primeiro se o webhook falhar ou o Render estiver dormindo):
 *   - Webhook do Asaas -> POST /api/payments/webhook (evento
 *     PAYMENT_RECEIVED).
 *   - O site consulta GET /api/payments/:id/status?productRef=&quantity=
 *     até o status virar RECEIVED — aí a entrega acontece na hora.
 *
 * Produtos FORA da tabela abaixo (Apple TV, Netflix, Disney, HBO Max,
 * Fornecedores Premium, Método Destrava, Acesso adulto, Lovable Pro
 * 30 dias +100 créditos) NÃO passam por este Pix automático: eles
 * continuam no fluxo manual via Telegram, porque a Routeis não os
 * tem (ou não tem exatamente essa variação). O backend recusa
 * qualquer tentativa de pagar por eles aqui (PRODUCT_NOT_PRICED).
 *
 * Segurança:
 * - ROUTEIS_API_KEY e ASAAS_API_KEY vêm SÓ de variáveis de ambiente
 *   do Render. Nunca vão para o site, para o GitHub, para logs ou
 *   para o chat.
 * - O endpoint antigo POST /api/orders agora é TRAVADO: sem um
 *   paymentId do Asaas com status RECEIVED e valor exato, ele
 *   devolve 402 e não pede nada na Routeis. Isso fecha o buraco
 *   da versão anterior, que entregava sem pagamento.
 * - A entrega devolvida é segredo: não a logue, não a guarde em log.
 *
 * Variáveis de ambiente (Render):
 *   ROUTEIS_API_KEY   (obrigatória, como antes)
 *   ASAAS_API_KEY     (obrigatória para /api/payments)
 *   ASAAS_BASE_URL    (opcional; padrão produção
 *                      https://api.asaas.com/v3 — para testar no
 *                      Sandbox use https://api-sandbox.asaas.com/v3
 *                      com a chave do Sandbox)
 *   ASAAS_WEBHOOK_TOKEN (opcional, mas recomendado: o token que você
 *                      define ao criar o webhook no painel do Asaas;
 *                      o backend recusa webhooks sem ele, se definido)
 *   PORT, FRONTEND_ORIGIN (como antes)
 *
 * v3 (2026-10-24, diagnóstico): o erro do Asaas agora aparece de
 * verdade na resposta (código ASAAS_ERROR + descrição do Asaas, sem
 * chave) e no log do Render, em vez de virar só "Erro interno".
 * Também reutiliza o cliente do Asaas pelo e-mail, para não criar
 * um cliente novo a cada tentativa de Pix.
 * v4 (2026-10-24, correção do bug da v3): ao reutilizar um cliente
 * já existente, ATUALIZA o CPF/CNPJ dele antes de criar a cobrança.
 * Sem isso, um cliente criado antes sem CPF (ex.: nas tentativas
 * sem o campo CPF) continuava sem CPF e o Asaas recusava a cobrança
 * mesmo com o CPF digitado no checkout novo.
 *
 * v5 (2026-10-25, e-mail do pedido para a cliente): depois que o
 * pagamento vira RECEIVED e a entrega acontece, o backend manda um
 * e-mail para o e-mail da cliente (o mesmo do checkout) com o
 * pedido e os dados da entrega. O e-mail é "melhor esforço": se o
 * envio falhar ou não estiver configurado, a entrega no site
 * continua valendo — o e-mail nunca desfaz uma entrega.
 * Para ligar o e-mail, no Render, além das chaves de antes:
 *   GMAIL_USER          (o Gmail que vai enviar, ex.: o Gmail da loja)
 *   GMAIL_APP_PASSWORD  (senha de app do Google, NÃO a senha normal
 *                        do Gmail — criada em Conta Google >
 *                        Segurança > Verificação em duas etapas >
 *                        Senhas de app; nunca vai para o chat, o
 *                        site ou o GitHub, só para o Render)
 *   GMAIL_FROM          (opcional; ex.: "ContaPrime <loja@gmail.com>")
 * Sem GMAIL_USER/GMAIL_APP_PASSWORD, o backend só pula o e-mail.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/catalog
 *   POST /api/payments          -> cria a cobrança Pix, devolve o QR Code
 *   GET  /api/payments/:id/status -> consulta e, se RECEIVED, entrega
 *   POST /api/payments/webhook  -> aviso do Asaas (PAYMENT_RECEIVED)
 *   POST /api/orders            -> TRAVADO: exige paymentId RECEIVED
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import nodemailer from "nodemailer";
import { RouteisClient, RouteisApiError } from "./routeis-client";

const PORT = Number(process.env.PORT ?? 3001);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "*";
const ASAAS_BASE_URL = (process.env.ASAAS_BASE_URL ?? "https://api.asaas.com/v3").replace(/\/$/, "");
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN ?? "";

const client = new RouteisClient(); // lê ROUTEIS_API_KEY do ambiente

// ------------------------------------------------------------------ preços
// Preço de VENDA em centavos (R$), por productRef EXATO da Routeis,
// conferido no catálogo ao vivo em 2026-10-24. Só estes 7 produtos
// passam pelo Pix automático. Todo o resto é recusado aqui.
const SALE_PRICES_CENTS: Record<string, number> = {
  "Canva Pro 1 Ano": 7000, // R$ 70,00
  "Canva Pro 30 dias": 1500, // R$ 15,00
  "Duolingo Super — 12 Months (Link)": 1500, // R$ 15,00
  "Gemini Pro 18 Meses Link": 1790, // R$ 17,90
  "Muse AI Account — 10 Billion Tokens": 8000, // R$ 80,00
  "Muse AI Account — 1 Billion Tokens": 1990, // R$ 19,90
  "Muse AI Account — 5 Billion Tokens": 5000, // R$ 50,00
};

// ------------------------------------------------------------------ utils
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, asaas-access-token",
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

function asaasKey(): string {
  const key = process.env.ASAAS_API_KEY ?? "";
  if (!key) throw new Error("ASAAS_API_KEY is not set.");
  return key;
}

async function asaasRequest<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ASAAS_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "ContaPrime",
      access_token: asaasKey(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const errors = json.errors as { description?: string }[] | undefined;
    throw new Error(
      `Asaas HTTP ${res.status}: ${errors?.[0]?.description ?? "erro na API do Asaas."}`,
    );
  }
  return json as T;
}

interface AsaasPayment {
  id: string;
  status: string;
  value: number;
  billingType: string;
}

interface AsaasQrCode {
  encodedImage?: string;
  payload?: string;
  expirationDate?: string;
}

function tomorrowDate(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ------------------------------------------------------- pedidos pendentes
interface Pending {
  paymentId: string;
  productRef: string;
  quantity: number;
  totalCents: number;
  externalOrderId: string;
  customerName?: string;
  customerEmail?: string;
  emailSent?: boolean;
  deliveredOrder?: Record<string, unknown>;
}

const pendingByPayment = new Map<string, Pending>();
const processedWebhookEvents = new Set<string>();

function getOrRebuildPending(
  paymentId: string,
  productRef: string,
  quantity: number,
  customerName?: string,
  customerEmail?: string,
): Pending | null {
  const existing = pendingByPayment.get(paymentId);
  if (existing) {
    // A consulta de status pode trazer o e-mail que faltava num
    // pedido reconstruído depois de um reinício do servidor.
    if (customerName && !existing.customerName) existing.customerName = customerName;
    if (customerEmail && !existing.customerEmail) existing.customerEmail = customerEmail;
    return existing;
  }
  // O Render gratuito dorme e pode reiniciar perdendo a memória: o site
  // sempre manda productRef + quantity na consulta, então dá para
  // reconstruir o pedido. O externalOrderId é derivado do paymentId,
  // então mesmo reconstruído a Routeis nunca cobra duas vezes.
  const unit = SALE_PRICES_CENTS[productRef];
  if (unit === undefined || !Number.isInteger(quantity) || quantity < 1) return null;
  const rebuilt: Pending = {
    paymentId,
    productRef,
    quantity,
    totalCents: unit * quantity,
    externalOrderId: `asaas-${paymentId}`,
    customerName,
    customerEmail,
  };
  pendingByPayment.set(paymentId, rebuilt);
  return rebuilt;
}

// ------------------------------------------------------- e-mail do pedido
// v5: manda o pedido para a cliente por e-mail (Gmail via SMTP), com
// os dados da entrega. Melhor esforço: nunca falha a entrega por
// causa do e-mail, e nunca loga o conteúdo da entrega nem a senha.
async function sendOrderEmail(
  pending: Pending,
  delivered: Record<string, unknown>,
): Promise<void> {
  if (!pending.customerEmail || pending.emailSent) return;
  const gmailUser = process.env.GMAIL_USER ?? "";
  const gmailPass = process.env.GMAIL_APP_PASSWORD ?? "";
  if (!gmailUser || !gmailPass) return; // e-mail ainda não configurado no Render
  try {
    const contents = delivered.deliveryContents as string[] | undefined;
    const deliveryText =
      contents && contents.length > 0
        ? contents.map((c, i) => `Conta ${i + 1}:\n${c}`).join("\n\n")
        : "Os dados da entrega estão na página do pedido no site.";
    const total = (pending.totalCents / 100).toFixed(2).replace(".", ",");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass },
    });
    await transporter.sendMail({
      from: process.env.GMAIL_FROM ?? `ContaPrime <${gmailUser}>`,
      to: pending.customerEmail,
      subject: `Seu pedido ContaPrime — ${pending.productRef}`,
      text: [
        `Olá${pending.customerName ? `, ${pending.customerName}` : ""}!`,
        "",
        "Seu pagamento foi confirmado e seu pedido da ContaPrime está pronto.",
        "",
        `Produto: ${pending.productRef}`,
        `Quantidade: ${pending.quantity}`,
        `Total pago: R$ ${total}`,
        `Pedido: ${String(delivered.orderCode ?? pending.externalOrderId)}`,
        "",
        "Dados da entrega:",
        deliveryText,
        "",
        "Guarde estes dados com cuidado e não compartilhe com ninguém.",
        "Precisa de ajuda? Fale com a ContaPrime no Telegram: @infoart009",
        "",
        "Obrigado pela compra!",
        "ContaPrime",
      ].join("\n"),
    });
    pending.emailSent = true;
  } catch {
    // Falha no e-mail não desfaz a entrega: a cliente continua
    // vendo os dados na página do pedido no site.
    console.error("Falha ao enviar o e-mail do pedido (entrega mantida).");
  }
}

async function deliver(pending: Pending): Promise<Record<string, unknown>> {
  if (pending.deliveredOrder) return pending.deliveredOrder;
  const order = await client.createOrder(
    pending.productRef,
    pending.quantity,
    pending.externalOrderId,
  );
  const delivered = {
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
  };
  pending.deliveredOrder = delivered;
  return delivered;
}

// ------------------------------------------------------------------ servidor
const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, await client.health());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/catalog") {
      const catalog = await client.listProducts({ description: true });
      sendJson(res, 200, {
        locale: catalog.meta.locale,
        data: catalog.data.map((p) => ({
          id: p.id,
          productRef: p.productRef,
          name: p.name,
          price: p.price,
          currency: p.currency,
          deliveryType: p.deliveryType,
          description: p.description,
          stock: p.stock,
        })),
      });
      return;
    }

    // ------------------------------------------------ POST /api/payments
    if (req.method === "POST" && url.pathname === "/api/payments") {
      const body = await readJson(req);
      const productRef = typeof body.productRef === "string" ? body.productRef : "";
      const quantity = typeof body.quantity === "number" ? body.quantity : 1;
      const customerName = typeof body.customerName === "string" ? body.customerName.trim() : "";
      const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail.trim() : "";
      const customerCpfCnpj =
        typeof body.customerCpfCnpj === "string" ? body.customerCpfCnpj.trim() : undefined;
      const unit = SALE_PRICES_CENTS[productRef];
      if (unit === undefined) {
        sendJson(res, 400, {
          ok: false,
          error: {
            code: "PRODUCT_NOT_PRICED",
            message:
              "Este produto não passa pelo Pix automático (é manual, via Telegram).",
          },
        });
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        sendJson(res, 400, {
          ok: false,
          error: { code: "INVALID_QUANTITY", message: "Quantidade inválida (1 a 10)." },
        });
        return;
      }
      if (!customerName || !customerEmail) {
        sendJson(res, 400, {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "Nome e e-mail do cliente são obrigatórios." },
        });
        return;
      }
      if (!process.env.ASAAS_API_KEY) {
        sendJson(res, 503, {
          ok: false,
          error: { code: "ASAAS_NOT_CONFIGURED", message: "Pagamento ainda não configurado no servidor." },
        });
        return;
      }
      const totalCents = unit * quantity;
      // Reutiliza o cliente pelo e-mail, se já existir, para não
      // criar um cliente novo a cada tentativa de Pix.
      let customerId: string | null = null;
      try {
        const found = await asaasRequest<{ data?: { id: string }[] }>(
          "GET",
          `/customers?email=${encodeURIComponent(customerEmail)}`,
        );
        if (found.data && found.data.length > 0) customerId = found.data[0].id;
      } catch {
        customerId = null; // busca falhou: segue criando o cliente
      }
      if (!customerId) {
        const customer = await asaasRequest<{ id: string }>("POST", "/customers", {
          name: customerName,
          email: customerEmail,
          ...(customerCpfCnpj ? { cpfCnpj: customerCpfCnpj } : {}),
        });
        customerId = customer.id;
      } else if (customerCpfCnpj) {
        // Cliente antigo pode ter sido criado SEM CPF (tentativas
        // antes do campo CPF): atualiza o CPF dele, senão o Asaas
        // continua recusando a cobrança mesmo com CPF no checkout.
        try {
          await asaasRequest("PUT", `/customers/${customerId}`, {
            name: customerName,
            email: customerEmail,
            cpfCnpj: customerCpfCnpj,
          });
        } catch {
          // Se a atualização falhar, segue com o cliente antigo:
          // a criação da cobrança vai devolver o erro real do Asaas.
        }
      }
      const payment = await asaasRequest<AsaasPayment>("POST", "/payments", {
        customer: customerId,
        billingType: "PIX",
        value: totalCents / 100,
        dueDate: tomorrowDate(),
        description: `ContaPrime - ${productRef} x${quantity}`,
      });
      // QR Code Pix (copia-e-cola + imagem). Se o Asaas ainda não tiver
      // gerado, o site consulta o status depois; não é erro fatal aqui.
      let qr: AsaasQrCode | null = null;
      try {
        qr = await asaasRequest<AsaasQrCode>("GET", `/payments/${payment.id}/pixQrCode`);
      } catch {
        qr = null;
      }
      pendingByPayment.set(payment.id, {
        paymentId: payment.id,
        productRef,
        quantity,
        totalCents,
        externalOrderId: `asaas-${payment.id}`,
        customerName,
        customerEmail,
      });
      sendJson(res, 200, {
        ok: true,
        paymentId: payment.id,
        productRef,
        quantity,
        totalBRL: totalCents / 100,
        status: payment.status,
        pixPayload: qr?.payload ?? null,
        pixEncodedImage: qr?.encodedImage ?? null,
        pixExpiration: qr?.expirationDate ?? null,
      });
      return;
    }

    // --------------------------------------- GET /api/payments/:id/status
    const statusMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      const paymentId = decodeURIComponent(statusMatch[1]);
      const productRef = url.searchParams.get("productRef") ?? "";
      const quantity = Number(url.searchParams.get("quantity") ?? "1");
      const customerName = url.searchParams.get("customerName") ?? undefined;
      const customerEmail = url.searchParams.get("customerEmail") ?? undefined;
      if (!process.env.ASAAS_API_KEY) {
        sendJson(res, 503, {
          ok: false,
          error: { code: "ASAAS_NOT_CONFIGURED", message: "Pagamento ainda não configurado no servidor." },
        });
        return;
      }
      const payment = await asaasRequest<AsaasPayment>("GET", `/payments/${paymentId}`);
      // RECEIVED é o único status que libera. CONFIRMED pode ser
      // temporário em conta de pessoa física (até 72h de análise).
      if (payment.status !== "RECEIVED") {
        sendJson(res, 200, {
          ok: true,
          paymentId,
          status: payment.status,
          delivered: false,
        });
        return;
      }
      const pending = getOrRebuildPending(paymentId, productRef, quantity, customerName, customerEmail);
      if (!pending) {
        sendJson(res, 400, {
          ok: false,
          error: {
            code: "PENDING_NOT_FOUND",
            message: "Pedido não localizado: informe productRef e quantity na consulta.",
          },
        });
        return;
      }
      if (Math.round(payment.value * 100) !== pending.totalCents) {
        sendJson(res, 402, {
          ok: false,
          error: { code: "PAYMENT_VALUE_MISMATCH", message: "Valor pago não confere com o pedido." },
        });
        return;
      }
      try {
        const delivered = await deliver(pending);
        await sendOrderEmail(pending, delivered);
        sendJson(res, 200, { ok: true, paymentId, status: payment.status, delivered: true, ...delivered });
      } catch (err) {
        // Pago mas sem entrega (ex.: sem saldo ou sem estoque na
        // Routeis): NÃO marca como entregue, para tentar de novo
        // depois — e o cliente deve falar com o atendimento.
        if (err instanceof RouteisApiError) {
          console.error(`Entrega pós-pagamento falhou [${err.code}]`);
          sendJson(res, 502, {
            ok: false,
            error: {
              code: "PAID_NOT_DELIVERED",
              message:
                "Pagamento confirmado, mas a entrega falhou no fornecedor. Fale com o atendimento no Telegram informando o paymentId.",
              routeisCode: err.code,
              paymentId,
            },
          });
          return;
        }
        throw err;
      }
      return;
    }

    // ------------------------------------------ POST /api/payments/webhook
    if (req.method === "POST" && url.pathname === "/api/payments/webhook") {
      if (ASAAS_WEBHOOK_TOKEN) {
        const token = req.headers["asaas-access-token"];
        if (token !== ASAAS_WEBHOOK_TOKEN) {
          sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Token do webhook inválido." } });
          return;
        }
      }
      const body = await readJson(req);
      const event = typeof body.event === "string" ? body.event : "";
      const eventId = typeof body.id === "string" ? body.id : "";
      const paymentObj = body.payment as { id?: string } | undefined;
      const paymentId = paymentObj?.id ?? "";
      // Responda 200 sempre após a autenticação: o Asaas reenvia
      // eventos sem 200, e a entrega também acontece pela consulta
      // de status — o webhook é um atalho, não o único caminho.
      if (event !== "PAYMENT_RECEIVED" || !paymentId) {
        sendJson(res, 200, { ok: true, ignored: true });
        return;
      }
      if (eventId && processedWebhookEvents.has(eventId)) {
        sendJson(res, 200, { ok: true, duplicate: true });
        return;
      }
      if (eventId) processedWebhookEvents.add(eventId);
      const pending = pendingByPayment.get(paymentId);
      if (!pending) {
        // Servidor reiniciou ou o pedido veio de outra instância: a
        // consulta de status do site (com productRef) resolve.
        sendJson(res, 200, { ok: true, pending: "unknown" });
        return;
      }
      try {
        const delivered = await deliver(pending);
        await sendOrderEmail(pending, delivered);
      } catch (err) {
        if (err instanceof RouteisApiError) {
          console.error(`Entrega via webhook falhou [${err.code}]`);
        }
      }
      sendJson(res, 200, { ok: true, delivered: pending.deliveredOrder !== undefined });
      return;
    }

    // --------------------------------------- POST /api/orders (TRAVADO)
    if (req.method === "POST" && url.pathname === "/api/orders") {
      const body = await readJson(req);
      const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
      const productRef = typeof body.productRef === "string" ? body.productRef : "";
      const quantity = typeof body.quantity === "number" ? body.quantity : 1;
      const customerName = typeof body.customerName === "string" ? body.customerName : undefined;
      const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail : undefined;
      if (!paymentId) {
        sendJson(res, 402, {
          ok: false,
          error: {
            code: "PAYMENT_REQUIRED",
            message: "Este endpoint agora exige um pagamento Asaas confirmado (paymentId).",
          },
        });
        return;
      }
      if (!process.env.ASAAS_API_KEY) {
        sendJson(res, 503, {
          ok: false,
          error: { code: "ASAAS_NOT_CONFIGURED", message: "Pagamento ainda não configurado no servidor." },
        });
        return;
      }
      const payment = await asaasRequest<AsaasPayment>("GET", `/payments/${paymentId}`);
      if (payment.status !== "RECEIVED") {
        sendJson(res, 402, {
          ok: false,
          error: { code: "PAYMENT_NOT_CONFIRMED", message: `Pagamento ainda não confirmado (status: ${payment.status}).` },
        });
        return;
      }
      const pending = getOrRebuildPending(paymentId, productRef, quantity, customerName, customerEmail);
      if (!pending) {
        sendJson(res, 400, {
          ok: false,
          error: { code: "PENDING_NOT_FOUND", message: "Produto ou quantidade inválidos para este pagamento." },
        });
        return;
      }
      if (Math.round(payment.value * 100) !== pending.totalCents) {
        sendJson(res, 402, {
          ok: false,
          error: { code: "PAYMENT_VALUE_MISMATCH", message: "Valor pago não confere com o pedido." },
        });
        return;
      }
      const delivered = await deliver(pending);
      await sendOrderEmail(pending, delivered);
      sendJson(res, 200, delivered);
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Rota não encontrada." } });
  } catch (err) {
    if (err instanceof RouteisApiError) {
      console.error(`Routeis [${err.code}] HTTP ${err.status}`);
      sendJson(res, err.status || 500, {
        ok: false,
        error: { code: err.code, message: err.message, requestId: err.requestId },
      });
      return;
    }
    // v3: mostra o erro REAL do Asaas (status + descrição, sem chave)
    // na resposta e no log, em vez de esconder tudo como "interno".
    if (err instanceof Error && err.message.startsWith("Asaas HTTP")) {
      console.error(`Asaas: ${err.message}`);
      sendJson(res, 502, {
        ok: false,
        error: { code: "ASAAS_ERROR", message: err.message },
      });
      return;
    }
    console.error("Erro interno no backend.");
    sendJson(res, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "Erro interno." } });
  }
});

server.listen(PORT, () => {
  console.log(`ContaPrime backend ouvindo na porta ${PORT} (chaves lidas do ambiente, nunca expostas).`);
});
