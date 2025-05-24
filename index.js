const express = require('express');
const bodyParser = require('body-parser');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const axios = require('axios');
require('dotenv').config();
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

// 1. Verificação inicial das variáveis de ambiente — OK
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

// 2. Variáveis para autenticação e token — boa estrutura
let dialogflowAuthClient = null;
let sheetsAuthClient = null;
let accessToken = null;
let tokenExpiry = 0;

// 3. Função para pegar token Dialogflow
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
  tokenExpiry = Date.now() + 50 * 60 * 1000; // 50 minutos de validade
}

// 4. Função para pegar autenticação Sheets
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

// 5. Função pra verificar e criar abas se necessário — boa prática
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

// 6. Função para logar dados no Sheets
async function logToSheet({ phone, message, type, intent }) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const sheetName = 'Atendimentos';

    await ensureSheetTabsExist();
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

// 7. Função para logar agendamentos
async function logToAgendamentosSheet({ nome, telefone, tipoAgendamento, data, hora, procedimento }) {
  console.log("🧾 Dados a serem salvos:", { nome, telefone, tipoAgendamento, data, hora, procedimento });
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

    console.log(`📆 Agendamento registrado com sucesso: ${nome}, ${data} às ${hora}, ${procedimento}`);
  } catch (err) {
    console.error("❌ Erro ao registrar agendamento no Google Sheets:", err.message);
  }
}

// 8. Função para notificar Telegram — bom uso do inline_keyboard
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

// 9. Extração fallback campos da mensagem — regex OK, cuidado com datas fixas!
function extractFallbackFields(message) {
  const nomeRegex = /^[a-zA-ZÀ-ÿ]+(?:\s+[a-zA-ZÀ-ÿ]+)+/;
  const dataRegex = /(\d{1,2})[\/\-](\d{1,2})/;
  const horaRegex = /(\d{1,2})[:h](\d{2})/;

  const nomeMatch = message.match(nomeRegex);
  const dataMatch = message.match(dataRegex);
  const horaMatch = message.match(horaRegex);

  const nome = nomeMatch ? nomeMatch[0].trim() : '';
  // Data gerada com ano fixo 2025, cuidado para não errar depois desse ano
  const data = dataMatch
    ? `2025-${dataMatch[2].padStart(2, '0')}-${dataMatch[1].padStart(2, '0')}T00:00:00-03:00`
    : '';
  const hora = horaMatch
    ? `2025-05-24T${horaMatch[1].padStart(2, '0')}:${horaMatch[2]}:00-03:00`
    : '';

  let procedimento = '';
  if (horaMatch && horaMatch.index !== undefined) {
    const afterHora = message.slice(horaMatch.index + horaMatch[0].length).trim();
    procedimento = afterHora;
  }

  return { nome, data, hora, procedimento };
}

// 10. Função para formatar datas/hora no padrão brasileiro — ok
function formatarDataHora(isoString, tipo) {
  if (!isoString || typeof isoString !== 'string') return '';

  const dataObj = new Date(isoString);
  if (isNaN(dataObj.getTime())) return 'Data inválida';

  if (tipo === 'data') {
    return dataObj.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }
  if (tipo === 'hora') {
    return dataObj.toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  return '';
}

// 11. Função para capitalizar nomes — boa prática
function capitalizarNome(nome) {
  if (!nome) return '';
  return nome
    .split(' ')
    .map(palavra => palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase())
    .join(' ');
}

// 12. Leitura do arquivo JSON local com convênios (exemplo)
// Considerar carregar apenas uma vez, cachear para performance
let convenios = null;
function carregarConvenios() {
  if (!convenios) {
    const rawdata = fs.readFileSync('./convenios.json', 'utf8');
    convenios = JSON.parse(rawdata);
  }
  return convenios;
}

// 13. Função para validar convênio
function validarConvenio(nomeConvenio) {
  const lista = carregarConvenios();
  if (!nomeConvenio) return false;
  return lista.includes(nomeConvenio.toLowerCase());
}

// 14. Endpoint webhook Dialogflow
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const intentName = body.queryResult.intent.displayName;
    const params = body.queryResult.parameters || {};
    const phone = params.telefone || '';
    const mensagem = body.queryResult.queryText || '';

    console.log("➡️ Intent detectada:", intentName);
    console.log("📱 Telefone:", phone);
    console.log("💬 Mensagem:", mensagem);

    // Ações por intent
    switch (intentName) {
      case 'AtendeConvenio':
        {
          const convenio = params.convenio?.toLowerCase();
          if (!validarConvenio(convenio)) {
            return res.json({
              followupEventInput: {
                name: 'ConvenioNaoAtendido',
                languageCode: 'pt-BR'
              }
            });
          }
          // Resposta para convênio válido
          return res.json({
            fulfillmentText: `Seu convênio ${convenio} é atendido. Em que posso ajudar?`
          });
        }

      case 'AgendarConsulta':
        {
          const { nome, telefone, tipoAgendamento, data, hora, procedimento } = params;

          // Caso não tenha preenchido, usar fallback extraction
          if (!nome || !data || !hora) {
            const fallback = extractFallbackFields(mensagem);
            if (!nome) params.nome = capitalizarNome(fallback.nome);
            if (!data) params.data = fallback.data;
            if (!hora) params.hora = fallback.hora;
            if (!procedimento) params.procedimento = fallback.procedimento;
          }

          await logToAgendamentosSheet({
            nome: capitalizarNome(params.nome),
            telefone: telefone || phone,
            tipoAgendamento: tipoAgendamento || 'Consulta',
            data: formatarDataHora(params.data, 'data'),
            hora: formatarDataHora(params.hora, 'hora'),
            procedimento: params.procedimento || ''
          });

          return res.json({
            fulfillmentText: `Olá ${capitalizarNome(params.nome)}, seu agendamento para ${params.tipoAgendamento} está confirmado para o dia ${formatarDataHora(params.data, 'data')} às ${formatarDataHora(params.hora, 'hora')}.`
          });
        }

      case 'SolicitarAtendimentoHumano':
        {
          // Logar no sheet e enviar Telegram
          await logToSheet({
            phone,
            message: mensagem,
            type: 'AtendimentoHumano',
            intent: intentName
          });

          await notifyTelegram(phone, mensagem);

          return res.json({
            fulfillmentText: 'Seu pedido de atendimento humano foi registrado. Em breve, um atendente entrará em contato.'
          });
        }

      default:
        {
          // Log genérico
          await logToSheet({
            phone,
            message: mensagem,
            type: 'Consulta',
            intent: intentName
          });
          return res.json({
            fulfillmentText: 'Sua mensagem foi recebida. Como posso ajudar?'
          });
        }
    }
  } catch (error) {
    console.error("❌ Erro no webhook:", error);
    return res.status(500).json({ fulfillmentText: 'Erro interno do servidor.' });
  }
});

// 15. Servidor ouvindo
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
