const express = require('express');
const bodyParser = require('body-parser');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
require('dotenv').config();

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
  console.log('Mensagem recebida da Z-API:', req.body);

  try {
    const { from, message } = req.body;

    if (!accessToken || Date.now() >= tokenExpiry) {
      await getAccessToken();
    }

    const dialogflowResponse = await axios.post(
      `https://dialogflow.googleapis.com/v2/projects/${process.env.DF_PROJECT_ID}/agent/sessions/${from}/detectIntent`,
      {
        queryInput: {
          text: {
            text: message,
            languageCode: 'pt-BR'
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const reply = dialogflowResponse.data.queryResult.fulfillmentText;

    await axios.post(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-messages`,
      {
        phone: from,
        message: reply
      }
    );

    res.status(200).send('OK');
  } catch (err) {
    console.error('Erro ao chamar o Dialogflow:', err.response?.data || err.message);
    res.status(500).send('Erro ao processar');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`));
