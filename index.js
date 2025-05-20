const express = require('express');
const bodyParser = require('body-parser');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
require('dotenv').config();

// 🔐 Variáveis de ambiente
const {
  ZAPI_INSTANCE_ID,
  ZAPI_TOKEN,
  DF_PROJECT_ID,
  GOOGLE_APPLICATION_CREDENTIALS_BASE64
} = process.env;

console.log("🧪 Variáveis de ambiente carregadas:", {
  ZAPI_INSTANCE_ID,
  ZAPI_TOKEN: ZAPI_TOKEN ? '*****' : null,
  DF_PROJECT_ID,
  GOOGLE_APPLICATION_CREDENTIALS_BASE64: GOOGLE_APPLICATION_CREDENTIALS_BASE64 ? 'definida' : 'NÃO DEFINIDA'
});

// 🚫 Verificação de variáveis obrigatórias
if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !DF_PROJECT_ID || !GOOGLE_APPLICATION_CREDENTIALS_BASE64) {
  console.error("❌ ERRO: Variáveis de ambiente obrigatórias não definidas! Verifique o arquivo .env");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

let accessToken = null;
let tokenExpiry = 0;
let authClient = null;

// 🔑 Geração e cache do token de acesso
async function getAccessToken() {
  if (!authClient) {
    const credentialsJson = Buffer.from(GOOGLE_APPLICATION_CREDENTIALS_BASE64, 'base64').toString('utf-8');
    const auth = new GoogleAuth({
      credentials: JSON.parse(credentialsJson),
      scopes: ['https://www.googleapis.com/auth/dialogflow']
    });
    authClient = await auth.getClient();
  }

  const tokenResponse = await authClient.getAccessToken();
  accessToken = tokenResponse.token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
}

app.post('/zapi-webhook', async (req, res) => {
  console.log('📥 Mensagem recebida da Z-API:', req.body);

  const from = req.body.phone;
  const message = req.body.text?.message?.trim() || '';
  const sessionId = `session-${from}`;

  if (!from || !message) {
    console.error('❌ Dados inválidos: número ou mensagem ausentes');
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

    console.log("📡 Enviando para Dialogflow:", dialogflowUrl);
    console.log("📝 Conteúdo da mensagem:", message);

    const dialogflowResponse = await axios.post(dialogflowUrl, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const reply = dialogflowResponse.data.queryResult?.fulfillmentText?.trim();

    if (!reply) {
      console.error("❌ Resposta vazia ou inválida do Dialogflow");
      return res.status(400).send("Resposta inválida do Dialogflow");
    }

    const cleanPhone = String(from).replace(/\D/g, '');
    if (!cleanPhone.match(/^55\d{10,11}$/)) {
      console.error("❌ Telefone inválido ou formato incorreto:", cleanPhone);
      return res.status(400).send("Telefone inválido");
    }

    const zapiPayload = {
      phone: cleanPhone,
      message: reply
    };

    console.log("📦 Payload final para Z-API:", JSON.stringify(zapiPayload, null, 2));

    const zapiUrl = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;

    const zapiResponse = await axios.post(zapiUrl, zapiPayload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log("✅ Mensagem enviada com sucesso:", zapiResponse.data);
    res.status(200).send("OK");

  } catch (err) {
    console.error("❌ Erro ao chamar o Dialogflow ou enviar mensagem:");
    if (err.response) {
      console.error("📄 Status:", err.response.status);
      console.error("📄 Headers:", err.response.headers);
      console.error("📄 Data:", err.response.data);
    } else if (err.request) {
      console.error("📡 Nenhuma resposta recebida:", err.request);
    } else {
      console.error("💥 Erro na configuração da requisição:", err.message);
    }
    res.status(500).send("Erro ao processar");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor iniciado na porta ${PORT}`));
