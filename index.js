const express = require('express');
const bodyParser = require('body-parser');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
require('dotenv').config();

console.log("🧪 Variáveis de ambiente carregadas:", process.env);
console.log("🔑 ZAPI_INSTANCE_ID:", process.env.ZAPI_INSTANCE_ID);
console.log("🔑 ZAPI_TOKEN:", process.env.ZAPI_TOKEN);
console.log("🔑 DF_PROJECT_ID:", process.env.DF_PROJECT_ID);

const app = express();
app.use(bodyParser.json());

let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  const auth = new GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/dialogflow']
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  accessToken = tokenResponse.token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
}

app.post('/zapi-webhook', async (req, res) => {
  console.log('📥 Mensagem recebida da Z-API:', req.body);
  console.log("📥 Webhook recebido:", JSON.stringify(req.body, null, 2));

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

    if (!message) {
      throw new Error("Mensagem inválida: 'message' está vazia ou null");
    }

    if (!sessionId) {
      throw new Error("SessionId inválido");
    }

    const body = {
      queryInput: {
        text: {
          text: message,
          languageCode: 'pt-BR'
        }
      }
    };

    const dialogflowUrl = `https://dialogflow.googleapis.com/v2/projects/${process.env.DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`;

    console.log("📡 Enviando para Dialogflow:", dialogflowUrl);
    console.log("📝 Conteúdo da mensagem:", message);
    console.log("📦 Corpo enviado para Dialogflow:", JSON.stringify(body, null, 2));
    console.log("🔑 Usando token de acesso:", accessToken);

    const dialogflowResponse = await axios.post(
      dialogflowUrl,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const reply = dialogflowResponse.data.queryResult.fulfillmentText;
    console.log("🤖 Resposta do Dialogflow:", reply);

    await axios.post(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-messages`,
      {
        phone: from,
        message: reply,
      }
    );

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Erro ao chamar o Dialogflow:");

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
app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`));
