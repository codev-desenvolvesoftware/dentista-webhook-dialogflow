const express = require('express');
const bodyParser = require('body-parser');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const axios = require('axios');
require('dotenv').config();
const { JWT } = require('google-auth-library');
const fs = require('fs');

const {
  ZAPI_INSTANCE_ID,
  ZAPI_INSTANCE_TOKEN,
  ZAPI_CLIENT_TOKEN,
  DF_PROJECT_ID,
  GOOGLE_DIALOGFLOW_CREDENTIALS_BASE64,
  GOOGLE_SHEETS_CREDENTIALS_BASE64,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GOOGLE_SHEETS_ID
} = process.env;


console.log("🧪 Variáveis de ambiente carregadas:", {
  ZAPI_INSTANCE_ID,
  ZAPI_INSTANCE_TOKEN: !!ZAPI_INSTANCE_TOKEN,
  ZAPI_CLIENT_TOKEN: !!ZAPI_CLIENT_TOKEN,
  DF_PROJECT_ID,
  TELEGRAM_BOT_TOKEN: !!TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: !!TELEGRAM_CHAT_ID,
  GOOGLE_SHEETS_ID: !!GOOGLE_SHEETS_ID
});

if (!ZAPI_INSTANCE_ID || !ZAPI_INSTANCE_TOKEN || !ZAPI_CLIENT_TOKEN || !DF_PROJECT_ID || !GOOGLE_DIALOGFLOW_CREDENTIALS_BASE64 || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !GOOGLE_SHEETS_ID) {
  console.error("❌ ERRO: Variáveis de ambiente obrigatórias não definidas!");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

let dialogflowAuthClient = null;
let sheetsAuthClient = null;
let accessToken = null;
let tokenExpiry = 0;

// Autenticação Dialogflow
async function getDialogflowAccessToken() {
  if (!dialogflowAuthClient) {
    const credentials = JSON.parse(Buffer.from(GOOGLE_DIALOGFLOW_CREDENTIALS_BASE64, 'base64').toString('utf8'));
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/dialogflow']
    });
    dialogflowAuthClient = await auth.getClient();
  }

  const tokenResponse = await dialogflowAuthClient.getAccessToken();
  accessToken = tokenResponse.token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
}

// Autenticação Google Sheets
async function getSheetsAuthClient() {
  if (!sheetsAuthClient) {
    const credentials = JSON.parse(Buffer.from(GOOGLE_SHEETS_CREDENTIALS_BASE64, 'base64').toString('utf8'));
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsAuthClient = await auth.getClient();
  }
  return sheetsAuthClient;
}

// Verifica se as abas existem e cria se não existirem
async function ensureSheetTabsExist() {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEETS_ID });

    const existingTabs = metadata.data.sheets.map(s => s.properties.title);
    const requiredTabs = ['Atendimentos', 'Agendamentos'];

    const tabsToCreate = requiredTabs.filter(tab => !existingTabs.includes(tab));

    if (tabsToCreate.length > 0) {
      const requests = tabsToCreate.map(title => ({
        addSheet: { properties: { title } }
      }));

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEETS_ID,
        requestBody: { requests }
      });

      tabsToCreate.forEach(tab => {
        console.log(`✅ Aba '${tab}' criada automaticamente.`);
      });
    }
  } catch (err) {
    console.error("❌ Erro ao verificar/criar abas da planilha:", err.message);
  }
}


// Registros de atendimentos no Sheets
async function logToSheet({ phone, message, type, intent }) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const sheetName = 'Atendimentos';

    await ensureSheetTabsExist(sheetName);
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${sheetName}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[now, phone, message, type, intent || '']]
      }
    });
  } catch (err) {
    console.error("❌ Falha ao registrar no Google Sheets:", err.message);
  }
}

// Registros de agendamentos(avaliação/consulta) no Sheets
async function logToAgendamentosSheet({ nome, telefone, tipoAgendamento, data, hora, procedimento }) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
    const sheetName = 'Agendamentos';
    await ensureSheetTabsExist();

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${sheetName}!A:F`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[nome, telefone, tipoAgendamento, data, hora, procedimento]]
      }
    });

    console.log(`📆 Agendamento registrado com sucesso: ${nome}, ${data} às ${hora}`);
  } catch (err) {
    console.error("❌ Erro ao registrar agendamento no Google Sheets:", err.message);
  }
}


// Notifica Telegram
async function notifyTelegram(phone, message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text = `📞 *Novo pedido de atendimento humano*\n*Telefone:* ${phone}\n💬 *Mensagem:* ${message}`;
  const buttons = {
    inline_keyboard: [
      [{ text: "📲 Ver conversa no WhatsApp", url: `https://wa.me/${phone}` }],
      [{ text: '✅ Marcar como resolvido', callback_data: `resolve:${phone}` }],
      [{ text: '🕓 Ver mensagens recentes', callback_data: `historico:${phone}` }]
    ]
  };
  return axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: buttons
  });
}

// Extrai campos de fallback da mensagem caso o Dialogflow não consiga extrair os parâmetros
async function extractFallbackFields(message) {
  if (!message) return { nome: '', data: '', hora: '', procedimento: '' };

  // Normaliza
  const msg = message.toLowerCase();

  // Nome: assume que aparece no início ou antes da data
  const nomeMatch = msg.match(/^(.+?)(?=\s+\d{1,2}\/\d{1,2})/i);

  // Data: dd/mm ou dd/mm/yyyy
  const dataMatch = msg.match(/(\d{1,2}\/\d{1,2}(\/\d{2,4})?)/);

  // Hora: 10h, 10:30, 10h30 etc
  const horaMatch = msg.match(/(\d{1,2}[:h]\d{0,2})/);

  // Procedimento: assume que vem depois da hora
  let procedimento = '';
  if (horaMatch?.index !== undefined) {
    const afterHora = msg.slice(horaMatch.index + horaMatch[0].length).trim();
    procedimento = afterHora;
  }

  return {
    nome: nomeMatch?.[1]?.trim() || '',
    data: dataMatch?.[1] || '',
    hora: horaMatch?.[1]?.replace('h', ':') || '',
    procedimento: procedimento || ''
  };
}

// Formata data e hora
async function formatarDataHora(isoString, tipo) {
  if (!isoString) return '';

  const dataObj = new Date(isoString);
  if (tipo === 'data') {
    return dataObj.toLocaleDateString('pt-BR'); // ex: 24/05/2025
  }
  if (tipo === 'hora') {
    return dataObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); // ex: 13:00
  }
  return '';
}


// Lê o arquivo convenios.json e armazena os convênios aceitos
let conveniosAceitos = []; // Agora é mutável
try {
  const data = fs.readFileSync('./data/convenios.json', 'utf8');
  const parsedData = JSON.parse(data);

  if (!Array.isArray(parsedData.convenios)) {
    throw new Error("Arquivo JSON não possui um array 'convenios'");
  }

  // Convertendo todos para lowercase e removendo espaços extras
  conveniosAceitos = parsedData.convenios.map(c => c.toLowerCase().trim());
  console.log("✅ Convênios carregados:", conveniosAceitos.length);
} catch (err) {
  console.error("❌ Erro ao ler ou processar o arquivo convenios.json:", err.message);
}


// Rota do webhook da Z-API
app.post('/zapi-webhook', async (req, res) => {
  console.log('📥 Mensagem recebida da Z-API:', req.body);

  if (
    req.body.isNewsletter ||
    String(req.body.phone).includes('@newsletter') ||
    req.body.isGroup ||
    req.body.type !== 'ReceivedCallback'
  ) {
    console.log("🚫 Mensagem ignorada (newsletter, grupo ou tipo não suportado).");
    return res.status(200).send("Ignorado");
  }

  const from = req.body.phone;
  const message = req.body.text?.message || '';
  const sessionId = `session-${from}`;
  const cleanPhone = String(from).replace(/\D/g, '');

  if (!from || !message) return res.status(400).send('Dados inválidos');

  try {
    if (!accessToken || Date.now() >= tokenExpiry) await getDialogflowAccessToken();

    const dialogflowUrl = `https://dialogflow.googleapis.com/v2/projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`;
    const dialogflowResponse = await axios.post(dialogflowUrl, {
      queryInput: { text: { text: message, languageCode: 'pt-BR' } }
    }, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
    });

    const queryResult = dialogflowResponse.data.queryResult;
    const reply = queryResult?.fulfillmentText?.trim();
    const intent = queryResult?.intent?.displayName;
    const parameters = queryResult?.parameters || {};

    console.log("🧠 Intent recebida:", intent);
    console.log("📦 Parâmetros recebidos:", parameters);

    // === INTENT: ConvenioAtendido ===
    if (intent === 'ConvenioAtendido') {
      const convenioInformado = parameters?.convenio_aceito?.toLowerCase()?.trim();

      const normalize = (text) =>
        text.toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();

      const normalizado = normalize(convenioInformado);
      const convenioEncontrado = conveniosAceitos.find(c => normalizado.includes(normalize(c)));

      const atende = Boolean(convenioEncontrado);
      const novaIntent = atende ? 'ConvenioAtendido' : 'ConvenioNaoAtendido';

      const respostaFinal = atende
        ? `✅ Maravilha! Atendemos o convênio *${convenioEncontrado.toUpperCase()}*!\n\nVamos agendar uma consulta? 🦷\n_Digite_: *Consulta* ou _Não_`
        : `Humm, não encontrei esse convênio na nossa lista... Mas não se preocupe! 😉\n\nVamos agendar uma avaliação gratuita? 🦷\n_Digite_: *Avaliação* ou _Não_`;

      await logToSheet({
        phone: cleanPhone,
        message: convenioInformado,
        type: 'bot',
        intent: novaIntent
      });

      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone: cleanPhone,
        message: respostaFinal
      }, {
        headers: {
          'Client-Token': ZAPI_CLIENT_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      return res.status(200).send("OK");
    }

    // === INTENT: FalarComAtendente ===
    if (intent === 'FalarComAtendente') {
      await notifyTelegram(cleanPhone, message);
      await logToSheet({ phone: cleanPhone, message, type: 'transbordo humano', intent });
    }

    // === INTENT: AgendarAvaliacaoFinal ===
    if (intent === 'AgendarAvaliacaoFinal') {
      const tipoAgendamento = 'avaliação';
      let nome = parameters?.nome?.[0] || '';
      let dataRaw = parameters?.data || '';
      let horaRaw = parameters?.hora || '';
      let procedimento = parameters?.procedimento?.[0] || '';

      let data = formatarDataHora(dataRaw, 'data');
      let hora = formatarDataHora(horaRaw, 'hora');

      if (!nome || !data || !hora || !procedimento) {
        const fallback = extractFallbackFields(message);
        nome = nome || fallback.nome;
        procedimento = procedimento || fallback.procedimento;
        data = data || fallback.data;
        hora = hora || fallback.hora;
      }

      const respostaFinal = `Perfeito, ${nome}! Sua avaliação de ${procedimento} foi agendada para o dia ${data} às ${hora}. Te aguardamos 🩵`;

      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone: cleanPhone,
        message: respostaFinal
      }, {
        headers: {
          'Client-Token': ZAPI_CLIENT_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      await logToAgendamentosSheet({
        nome,
        telefone: cleanPhone,
        tipoAgendamento,
        data,
        hora,
        procedimento
      });

      return res.status(200).send("OK");
    }

    // === INTENT: AgendarConsultaFinal ===
    if (intent === 'AgendarConsultaFinal') {
      const tipoAgendamento = 'consulta';
      let nome = parameters?.nome?.[0] || '';
      let dataRaw = parameters?.data || '';
      let horaRaw = parameters?.hora || '';
      let procedimento = parameters?.procedimento?.[0] || '';

      let data = formatarDataHora(dataRaw, 'data');
      let hora = formatarDataHora(horaRaw, 'hora');

      if (!nome || !data || !hora || !procedimento) {
        const fallback = extractFallbackFields(message);
        nome = nome || fallback.nome;
        procedimento = procedimento || fallback.procedimento;
        data = data || fallback.data;
        hora = hora || fallback.hora;
      }

      const respostaFinal = `Perfeito, ${nome}! Sua consulta de ${procedimento} foi agendada para o dia ${data} às ${hora}. Até lá 🩵`;

      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone: cleanPhone,
        message: respostaFinal
      }, {
        headers: {
          'Client-Token': ZAPI_CLIENT_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      await logToAgendamentosSheet({
        nome,
        telefone: cleanPhone,
        tipoAgendamento,
        data,
        hora,
        procedimento
      });

      return res.status(200).send("OK");
    }

    // === Outras intents com reply ===
    if (reply) {
      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone: cleanPhone,
        message: reply
      }, {
        headers: {
          'Client-Token': ZAPI_CLIENT_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      await logToSheet({ phone: cleanPhone, message, type: 'bot', intent });
      return res.status(200).send("OK");
    }

    // === Sem resposta e não tratada: assume humano ===
    console.log("📌 Sem resposta do Dialogflow — pode ser atendimento humano.");
    await logToSheet({ phone: cleanPhone, message, type: 'atendente', intent: '' });
    return res.status(200).send("Mensagem humana registrada.");

  } catch (err) {
    console.error("❌ Erro ao processar mensagem:", err.message);
    res.status(500).send("Erro ao processar");
  }
});


// Rota para capturar as mensagens enviadas do atendente para o cliente
app.post('/zapi-outgoing', async (req, res) => {
  console.log("📩 Webhook de saída recebido:");
  console.dir(req.body, { depth: null });
  console.log("🔍 Tipo de evento:", req.body.type || 'sem tipo');

  const { type, phone } = req.body;
  let text = '';

  // Tenta extrair o texto da mensagem enviada
  if (typeof req.body.message === 'string') {
    text = req.body.message;
  } else if (req.body.message?.text?.body) {
    text = req.body.message.text.body;
  } else if (req.body.message?.message) {
    text = req.body.message.message;
  } else if (req.body.message?.body) {
    text = req.body.message.body;
  }

  if (type === 'SentCallback' && text && phone) {
    console.log("📝 Conteúdo detectado como mensagem humana:", text);
  }

  // Filtra somente mensagens que são de saída (enviadas pelo humano manualmente)
  if (type === 'SentCallback' && text && phone) {
    const cleanPhone = phone.replace(/\D/g, '');

    // Ignora mensagens automáticas
    if (!text.includes("Seu atendimento foi marcado como resolvido")) {
      await logToSheet({ phone: cleanPhone, message: text, type: 'humano' });
      console.log("✅ Mensagem humana registrada no Sheets:", text);
    }
  }
  res.sendStatus(200);
});


// Rota para o webhook do Telegram que escuta cliques nos botões
app.post('/telegram-webhook', async (req, res) => {
  const callbackQuery = req.body.callback_query;
  const messageText = req.body.message?.text;

  if (messageText === '/status') {
    try {
      const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: 'Atendimentos!A:D'
      });
      const values = response.data.values || [];
      const pendentes = values.filter(row => row[3] === 'transbordo humano');
      const msg = `🤖 Atualmente há *${pendentes.length}* atendimento(s) pendente(s).`;
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown'
      });
    } catch (err) {
      console.error("Erro ao responder /status:", err.message);
    }
  }

  // Comando /clientes para listar clientes em atendimento
  if (messageText === '/clientes') {
    try {
      const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: 'Atendimentos!A:D'
      });
      const values = response.data.values || [];

      // Filtra os que estão em atendimento humano
      const pendentes = values.filter(row => row[3] === 'humano');

      // Monta a mensagem apenas com nome, telefone e link do WhatsApp
      const msg = pendentes.length
        ? `*Clientes em atendimento:*\n${pendentes.map(p => {
          const nome = p[0];
          const telefone = p[1].replace(/\D/g, '');
          const telefoneFormatado = p[1];
          return `👤 *${nome}*\n📞 ${telefoneFormatado} | [Abrir WhatsApp](https://wa.me/${telefone})`;
        }).join('\n\n')}`
        : `✅ Nenhum cliente aguardando atendimento.`;

      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown',
        disable_web_page_preview: true // Removendo o preview do botão do WhatsApp (share on whatsapp)
      });
    } catch (err) {
      console.error("Erro ao responder /clientes:", err.message);
    }
  }


  if (callbackQuery && callbackQuery.data) {
    const [action, phone] = callbackQuery.data.split(':');

    if (action === 'resolve') {
      const replyText = `✅ Atendimento com o número *${phone}* foi marcado como resolvido.`;
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: replyText,
        parse_mode: "Markdown"
      });

      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone,
        message: "Seu atendimento foi marcado como resolvido. Qualquer dúvida, é só chamar 😊"
      }, {
        headers: {
          'Client-Token': ZAPI_CLIENT_TOKEN,
          'Content-Type': 'application/json'
        }
      });
    }

    if (action === 'historico') {
      try {
        const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_ID,
          range: 'Atendimentos!A:D'
        });


        const historico = response.data.values?.filter(row => row[1] === phone).slice(-10).reverse();

        const historicoText = historico.length
          ? `📜 *Últimas mensagens de ${phone}:*\n${historico.map(r => `🕓 ${r[0]}\n💬 ${r[2]}\n`).join('\n')}`
          : `Nenhum histórico recente encontrado.`;

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: historicoText,
          parse_mode: 'Markdown'
        });
      } catch (err) {
        console.error("Erro ao buscar histórico:", err.message);
      }
    }
  }

  res.sendStatus(200);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor iniciado na porta ${PORT}`));
