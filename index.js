const express = require('express');
const bodyParser = require('body-parser');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const axios = require('axios');
require('dotenv').config();

const {
  ZAPI_INSTANCE_ID,
  ZAPI_INSTANCE_TOKEN,
  ZAPI_CLIENT_TOKEN,
  DF_PROJECT_ID,
  GOOGLE_APPLICATION_CREDENTIALS_BASE64,
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

if (!ZAPI_INSTANCE_ID || !ZAPI_INSTANCE_TOKEN || !ZAPI_CLIENT_TOKEN || !DF_PROJECT_ID || !GOOGLE_APPLICATION_CREDENTIALS_BASE64 || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !GOOGLE_SHEETS_ID) {
  console.error("❌ ERRO: Variáveis de ambiente obrigatórias não definidas!");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

let accessToken = null;
let tokenExpiry = 0;
let authClient = null;

async function getAccessToken() {
  if (!authClient) {
    const credentials = JSON.parse(Buffer.from(GOOGLE_APPLICATION_CREDENTIALS_BASE64, 'base64').toString('utf8'));
    const auth = new GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/dialogflow',
        'https://www.googleapis.com/auth/spreadsheets'
      ]
    });
    authClient = await auth.getClient();
  }

  const tokenResponse = await authClient.getAccessToken();
  accessToken = tokenResponse.token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
}

// Enviar log para o Google Sheets
async function logToSheet({ phone, message, type, intent }) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: 'Atendimentos!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[now, phone, message, type, intent || '']]
      }
    });
  } catch (err) {
    console.error("❌ Falha ao registrar no Google Sheets:", err.message);
  }
}

// Notifica Telegram
async function notifyTelegram(phone, message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text = `📞 *Novo pedido de atendimento humano*\n*Telefone:* ${phone}\n💬 *Mensagem:* ${message}`;

  const buttons  = {
    inline_keyboard: [
      [
        {
          text: "📲 Ver conversa no WhatsApp",
          url: `https://wa.me/${phone}`
        },
        ],
        [
        {
          text: '✅ Marcar como resolvido',
          callback_data: `resolve:${phone}`
        }
      ]
    ]
  };

  return axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: buttons
  });
}

app.post('/zapi-webhook', async (req, res) => {
  console.log('📥 Mensagem recebida da Z-API:', req.body);

  const from = req.body.phone;
  const message = req.body.text?.message || '';
  const sessionId = `session-${from}`;

  if (!from || !message) {
    console.error('❌ Dados inválidos: from ou message ausentes');
    return res.status(400).send('Dados inválidos');
  }

  try {
    if (!accessToken || Date.now() >= tokenExpiry) {
      await getAccessToken();
    }

    const dialogflowUrl = `https://dialogflow.googleapis.com/v2/projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`;
    const body = {
      queryInput: {
        text: {
          text: message,
          languageCode: 'pt-BR'
        }
      }
    };

    const dialogflowResponse = await axios.post(dialogflowUrl, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
    });

    const queryResult = dialogflowResponse.data.queryResult;
    const reply = queryResult?.fulfillmentText?.trim();
    const intent = queryResult?.intent?.displayName;

    if (!reply) {
      console.error("❌ Resposta vazia do Dialogflow");
      return res.status(400).send("Resposta inválida do Dialogflow");
    }

    const cleanPhone = String(from).replace(/\D/g, '');
    if (!cleanPhone.match(/^55\d{10,11}$/)) {
      console.error("❌ Telefone inválido:", cleanPhone);
      return res.status(400).send("Telefone inválido");
    }

    // 📝 Registrar mensagem do BOT
    await logToSheet({
      phone: cleanPhone,
      message,
      type: 'bot',
      intent
    });

    const zapiUrl = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`;

    await axios.post(zapiUrl, {
      phone: cleanPhone,
      message: reply
    }, {
      headers: {
        'Client-Token': ZAPI_CLIENT_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (intent === 'FalarComAtendente') {
      console.log('📢 Notificando Telegram...');
      await notifyTelegram(cleanPhone, message);

      // 📝 Registrar notificação ao humano
      await logToSheet({
        phone: cleanPhone,
        message,
        type: 'humano',
        intent
      });
    }

    res.status(200).send("OK");

  } catch (err) {
    console.error("❌ Erro ao processar mensagem:");
    if (err.response) {
      console.error("📄 Status:", err.response.status);
      console.error("📄 Data:", err.response.data);
    } else if (err.request) {
      console.error("📡 Nenhuma resposta recebida:", err.request);
    } else {
      console.error("💥 Erro:", err.message);
    }
    res.status(500).send("Erro ao processar");
  }
});

// Nova rota para o webhook do Telegram que escuta cliques nos botões
app.post('/telegram-webhook', async (req, res) => {
  const callbackQuery = req.body.callback_query;

  if (callbackQuery && callbackQuery.data) {
    const [action, phone] = callbackQuery.data.split(':');

    if (action === 'resolve') {
      const replyText = `✅ Atendimento com o número *${phone}* foi marcado como resolvido.`;
      const answerUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

      await axios.post(answerUrl, {
        chat_id: TELEGRAM_CHAT_ID,
        text: replyText,
        parse_mode: "Markdown"
      });

      // Opcional: envia mensagem de volta ao cliente no WhatsApp
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
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor iniciado na porta ${PORT}`));
