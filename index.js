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
  console.log("🧾 Dados a serem salvos:", {
    nome,
    telefone,
    tipoAgendamento,
    data,
    hora,
    procedimento
  });
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
function extractFallbackFields(message) {
  const rawText = message?.text?.message || '';
  const texto = rawText.replace(/\s+/g, ' ').trim();
  const dataRegex = /(\d{1,2})[\/\-](\d{1,2})/;
  const horaRegex = /\b(\d{1,2})(?:[:h](\d{2}))?\b/;

  let nome = '';
  let data = '';
  let hora = '';
  let procedimento = '';

  // === Data ===
  const dataMatch = texto.match(dataRegex);
  let dataIndex = -1;
  if (dataMatch) {
    const [_, diaStr, mesStr] = dataMatch;
    const dia = parseInt(diaStr, 10);
    const mes = parseInt(mesStr, 10);
    const hoje = new Date();
    let ano = hoje.getFullYear();
    const dataTentativa = new Date(ano, mes - 1, dia);
    if (dataTentativa < hoje.setHours(0, 0, 0, 0)) ano += 1;

    data = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}T00:00:00-03:00`;
    dataIndex = dataMatch.index ?? -1;
  }
  // === Hora ===
  const horaMatch = texto.match(horaRegex);
  let horaIndex = -1;
  if (horaMatch) {
    const h = parseInt(horaMatch[1], 10);
    const m = horaMatch[2] ? parseInt(horaMatch[2], 10) : 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hora = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      horaIndex = horaMatch.index ?? -1;
    }
  }
  // === Nome ===
  const corte = Math.min(...[dataIndex, horaIndex].filter(i => i >= 0));
  const nomeCompleto = corte !== Infinity ? texto.slice(0, corte).trim() : texto;
  nome = nomeCompleto.split(/\s+/).slice(0, 4).join(' ');
  // === Procedimento ===
  if (horaIndex >= 0) {
    const depoisDaHora = texto.slice(horaIndex + horaMatch[0].length).trim();
    procedimento = depoisDaHora.split(/\s+/).slice(0, 5).join(' ');
  }
  return { nome, data, hora, procedimento };
}

// Formata data e hora
function formatarDataHora(valor, tipo) {
  if (!valor) return tipo === 'data' ? 'Data inválida' : 'Hora inválida';

  // LIMPA a entrada para capturar "8h", "08h", "8:00", "08:00", "8", "8h00", etc
  const horaRegex = /\b(\d{1,2})(?:[:h](\d{2}))?\b/;

  if (tipo === 'hora') {
    const match = valor.match(horaRegex);
    if (!match) return 'Hora inválida';

    let hora = parseInt(match[1]);
    let minutos = match[3] ? parseInt(match[3]) : 0;

    // CORRIGE casos como "8h" sendo interpretados como 20h
    if (hora >= 0 && hora <= 23 && minutos >= 0 && minutos <= 59) {
      // Garante formatação 2 dígitos
      const horaStr = hora.toString().padStart(2, '0');
      const minStr = minutos.toString().padStart(2, '0');
      return `${horaStr}:${minStr}`;
    }

    return 'Hora inválida';
  }

  if (tipo === 'data') {
    const date = new Date(valor);
    if (isNaN(date.getTime())) return 'Data inválida';
    return date.toLocaleDateString('pt-BR');
  }

  return '';
}

// Função para capitalizar a primeira letra de cada palavra
function capitalizarNomeCompleto(nome) {
  if (!nome || typeof nome !== 'string') return '';

  // Normaliza espaços
  nome = nome.trim().replace(/\s+/g, ' ');

  // Capitaliza cada palavra do nome
  return nome
    .split(' ')
    .map(palavra =>
      palavra
        .split(/(['-])/g) // separa mantendo hífen e apóstrofo como delimitadores
        .map(parte =>
          parte === '-' || parte === "'"
            ? parte // mantém hífen ou apóstrofo como está
            : parte.charAt(0).toUpperCase() + parte.slice(1).toLowerCase()
        )
        .join('')
    )
    .join(' ');
}

// Função para extrair convenio em frases
function detectarConvenioNaFrase(frase, listaConvenios) {
  const normalizar = (str) =>
    str.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .trim();

  const normalizadaFrase = normalizar(frase);

  console.log("🔎 Buscando convênio:", normalizadaFrase);

  // Mapeia lista com objetos { original, normalizado }
  const listaNormalizada = listaConvenios.map(c => ({
    original: c,
    normalizado: normalizar(c)
  }));

  listaNormalizada.forEach(c => console.log("-", c.normalizado));

  const detectado = listaNormalizada.find(({ normalizado }) =>
    normalizadaFrase.includes(normalizado) || normalizado.includes(normalizadaFrase)
  );

  return detectado?.original; // retorna o nome original do convênio, se encontrado
}

// Função para primeira letra maiúscula
function toTitleCase(str) {
  return str.replace(/\w\S*/g, (txt) =>
    txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase()
  );
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
  ) return res.status(200).send("Ignorado");

  const from = req.body.phone;
  const message = req.body.text?.message || '';
  const sessionId = `session-${from}`;
  const cleanPhone = String(from).replace(/\D/g, '');

  const normalize = (text) =>
    text.toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]+/g, "")
      .trim();

  if (!from || !message) return res.status(400).send('Dados inválidos');

  try {
    if (!accessToken || Date.now() >= tokenExpiry) await getDialogflowAccessToken();

    const dialogflowResponse = await axios.post(
      `https://dialogflow.googleapis.com/v2/projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
      { queryInput: { text: { text: message, languageCode: 'pt-BR' } } },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const queryResult = dialogflowResponse.data.queryResult;
    const reply = queryResult?.fulfillmentText?.trim();
    console.log("🤖 Resposta do bot:", reply);
    const intent = queryResult?.intent?.displayName;
    const parameters = queryResult?.parameters || {};

    console.log("🔍 Contextos ativos:", queryResult.outputContexts);
    console.log("🧠 Intent recebida:", intent);
    console.log("📦 Parâmetros recebidos:", parameters);

    const sendZapiMessage = async (text) => {
      return axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone: cleanPhone,
        message: text
      }, {
        headers: { 'Client-Token': ZAPI_CLIENT_TOKEN }
      });
    };

    const ctxConsulta = `projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}/contexts/aguardando-sim-consulta`;
    const ctxAvaliacao = `projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}/contexts/aguardando-sim-avaliacao`;

    const handleAgendamento = async (tipoAgendamento) => {
      try {
        const fallback = extractFallbackFields(message);
        const rawMessage = message?.text?.message || '';

        // 🧠 Nome
        const nomeRaw = parameters?.nome?.name
          || (Array.isArray(parameters?.nome) ? parameters.nome.join(' ') : parameters?.nome)
          || fallback.nome
          || 'Cliente';

        const nomeLimitado = nomeRaw.trim().split(/\s+/).slice(0, 4).join(' ');
        const nomeFormatado = capitalizarNomeCompleto(nomeLimitado);
        console.log('🔍 nomeFormatado:', nomeFormatado);

        // 🧠 Procedimento
        const procedimentoRaw = Array.isArray(parameters?.procedimento)
          ? parameters.procedimento.join(' ')
          : parameters?.procedimento;
        const procedimento = procedimentoRaw || fallback.procedimento || 'procedimento a ser analisado';

        // 📅 Data
        const data = formatarDataHora(parameters?.data || fallback.data, 'data');

        // ⏰ Hora
        let hora = '';

        function tentarExtrairHora(...fontes) {
          for (const fonte of fontes) {
            if (!fonte) continue;
            const tentativa = formatarDataHora(fonte, 'hora');
            if (tentativa && tentativa !== 'Hora inválida') {
              console.log('🛠️ Hora obtida de fonte:', fonte);
              return tentativa;
            }
          }
          return '';
        }

        // Ordem de prioridade: texto → fallback.hora → parameters.hora.original → parameters.hora
        // Isso cobre "8", "8h", "8:00", "08h", etc.
        const matchTexto = rawMessage.match(/\b(\d{1,2})([:h]?)(\d{0,2})\b/i);
        const horaTexto = matchTexto
          ? `${matchTexto[1]}:${matchTexto[3] || '00'}`
          : '';

        hora = tentarExtrairHora(
          horaTexto,
          fallback.hora,
          parameters?.['hora.original'],
          parameters?.hora
        );

        const respostaFinal = `Perfeito, ${nomeFormatado}! Sua ${tipoAgendamento} para ${procedimento} está agendada para ${data} às ${hora}. Até lá 🩵`;

        await logToAgendamentosSheet({
          nome: nomeFormatado,
          telefone: cleanPhone,
          tipoAgendamento,
          data,
          hora,
          procedimento
        });

        await sendZapiMessage(respostaFinal);
      } catch (err) {
        console.error("❌ Erro no agendamento:", err.message);
      }
    };


    // Identifica quando o usuário respondeu "sim" e está no contexto certo (consulta ou avaliação)
    if (normalize(message) === 'sim') {
      const contextNames = queryResult.outputContexts?.map(c => c.name) || [];

      const inConsultaContext = contextNames.some(name => name.includes('aguardando-sim-consulta'));
      const inAvaliacaoContext = contextNames.some(name => name.includes('aguardando-sim-avaliacao'));

      if (inConsultaContext) {
        console.log('📌 Direcionando para AgendarConsultaFinal');
        await handleAgendamento('consulta');
        return res.status(200).send("Agendamento de consulta realizado");
      }

      if (inAvaliacaoContext) {
        console.log('📌 Direcionando para AgendarAvaliacaoFinal');
        await handleAgendamento('avaliação');
        return res.status(200).send("Agendamento de avaliação realizado");
      }
    }

    if (intent === 'AgendarAvaliacaoFinal') {
      await handleAgendamento('avaliação');
      return res.status(200).send("OK");
    }

    if (intent === 'AgendarConsultaFinal') {
      await handleAgendamento('consulta');
      return res.status(200).send("OK");
    }

    if (intent === 'FalarComAtendente') {
      await notifyTelegram(cleanPhone, message);
      await logToSheet({ phone: cleanPhone, message, type: 'transbordo humano', intent });
      return res.status(200).send("OK");
    }

    if (intent === 'VerificarListaConvenios') {
      const ctxConfirmacao = queryResult.outputContexts?.find(ctx => ctx.name.includes('aguardando-confirmacao-lista-convenios'));

      if (ctxConfirmacao) {
        // Normalize a mensagem do usuário
        const messageNormalized = normalize(message);

        // Tentativa de obter o convênio informado via parâmetros
        let convenioInformado =
          parameters?.convenio_aceito ||
          parameters?.convenio;

        // Fallback se parameters estiverem vazios ou for um objeto vazio
        if (
          !convenioInformado ||
          (typeof convenioInformado === 'object' && Object.keys(convenioInformado).length === 0)
        ) {
          convenioInformado = detectarConvenioNaFrase(messageNormalized, conveniosAceitos);
        }

        // Normaliza o valor final do convênio informado
        const convenioTexto =
          typeof convenioInformado === 'string'
            ? convenioInformado
            : typeof convenioInformado?.value === 'string'
              ? convenioInformado.value
              : '';

        const textoConvenio = normalize(convenioTexto);

        // Detecta se é um convênio aceito
        const convenioDetectado = detectarConvenioNaFrase(textoConvenio, conveniosAceitos);

        const followup = convenioDetectado ? 'ConvenioAtendido' : 'ConvenioNaoAtendido';

        // ✅ Formata o nome do convênio com letras maiúsculas
        const convenioFormatado = toTitleCase(convenioDetectado || '');

        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'bot',
          intent: `${followup} (event redirect)`
        });

        // LOGS DE DEPURAÇÃO - CONVÊNIO
        console.log('🔎 Convênio detectado:', convenioDetectado);
        console.log('📤 Enviando evento:', followup, 'com parâmetro:', { convenio: convenioFormatado || '' });
        // Envia evento para Dialogflow com nome capitalizado
        const followupResponse = await axios.post(
          `https://dialogflow.googleapis.com/v2/projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
          {
            queryInput: {
              event: {
                name: followup,
                languageCode: 'pt-BR',
                parameters: {
                  convenio: convenioFormatado || ''
                }
              }
            }
          },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const followupText = followupResponse.data.queryResult.fulfillmentText;
        console.log("🤖 Resposta do evento:", followupText);

        if (followupText) {
          await sendZapiMessage(followupText);
        }

        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'bot',
          intent: `${followup} (evento disparado)`
        });

        return res.status(200).send("Followup executado");
      }
    }

    // Contador de tentativas de entendimento usando contexto de sessão com contagem de falhas
    if (intent && !reply) {
      const contextoTentativa = queryResult?.outputContexts?.find(ctx => ctx.name.includes('tentativa-entendimento'));
      const falhas = contextoTentativa?.parameters?.falhas || 0;

      if (falhas >= 1) {
        // Segunda falha: transbordo para atendente
        await sendZapiMessage('Vou acionar um atendente 👩‍💻 Aguarde só um instante ');
        await notifyTelegram(cleanPhone, message);
        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'transbordo humano',
          intent: 'FallbackDepoisDeFalha'
        });
        return res.status(200).json({
          fulfillmentText: 'Encaminhando para atendente...',
          outputContexts: [] // encerra o contexto
        });
      } else {
        // Primeira falha: responde e seta contexto com falhas = 1
        const respostaPadrao = 'Desculpe, não entendi direito... Pode repetir por favor?';
        await sendZapiMessage(respostaPadrao);
        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'bot',
          intent: 'RespostaVazia'
        });

        return res.status(200).json({
          fulfillmentText: respostaPadrao,
          outputContexts: [{
            name: `projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}/contexts/tentativa-entendimento`,
            lifespanCount: 1,
            parameters: {
              falhas: 1
            }
          }]
        });
      }
    }

    if (reply) {
      await sendZapiMessage(reply);
      await logToSheet({ phone: cleanPhone, message, type: 'bot', intent });
      return res.status(200).send("OK");
    } else {
      console.warn("⚠️ Nenhuma resposta definida para a intent.");
    }

    await logToSheet({ phone: cleanPhone, message, type: 'transbordo humano', intent: 'FallbackManual' });
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

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado na porta ${PORT}`);
  });
}

module.exports = {
  formatarDataHora,
  capitalizarNomeCompleto,
  extractFallbackFields
};