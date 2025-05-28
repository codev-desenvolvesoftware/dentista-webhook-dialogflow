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
  const texto = rawText.replace(/\s+/g, ' ').trim(); // Normaliza espaços

  // Expressões regulares
  const dataRegex = /(\d{1,2})[\/\-](\d{1,2})/;
  const horaRegex = /\b(\d{1,2})\s*[h:]\s*(\d{0,2})\b/;

  let nome = '';
  let data = '';
  let hora = '';
  let procedimento = '';

  // Extrair data
  const dataMatch = texto.match(dataRegex);
  let dataIndex = -1;
  if (dataMatch) {
    const dia = parseInt(dataMatch[1], 10);
    const mes = parseInt(dataMatch[2], 10);
    const hoje = new Date();
    let ano = hoje.getFullYear();
    const tentativa = new Date(ano, mes - 1, dia);
    if (tentativa.setHours(0, 0, 0, 0) < hoje.setHours(0, 0, 0, 0)) {
      ano += 1;
    }
    data = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}T00:00:00-03:00`;
    dataIndex = dataMatch.index ?? -1;
  }

  // Extrair hora
  let horaIndex = -1;
  const horaMatch = texto.match(horaRegex);
  if (horaMatch) {
    const h = parseInt(horaMatch[1], 10);
    const m = horaMatch[2] ? parseInt(horaMatch[2], 10) : 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hora = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      horaIndex = horaMatch.index ?? -1;
    }
  }

  // Extrair nome — tudo antes da data/hora (mínimo entre dataIndex e horaIndex)
  let corte = Math.min(...[dataIndex, horaIndex].filter(i => i >= 0));
  if (corte === Infinity) corte = texto.length;

  // Se não houver data ou hora, pega o texto todo
  const nomeCompleto = texto.slice(0, corte).trim();
  const palavrasNome = nomeCompleto.split(/\s+/).slice(0, 4);
  nome = palavrasNome.join(' ');

  // Extrair até 5 palavras no procedimento — tudo após a hora
  if (horaIndex >= 0) {
    const afterHora = texto.slice(horaIndex + horaMatch[0].length).trim();
    procedimento = afterHora.split(/\s+/).slice(0, 5).join(' ');
  }

  return { nome, data, hora, procedimento };
}

// Formata data e hora
function formatarDataHora(valor, tipo) {
  if (typeof valor !== 'string') return '';

  // Remover caracteres invisíveis e espaços
  valor = valor.normalize("NFKD").replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  if (valor === '') {
    return tipo === 'data' ? 'Data inválida' : '';
  }

  console.log(`📥 formatarDataHora | tipo: ${tipo} | valor limpo: "${valor}"`);

  try {
    if (tipo === 'hora') {
      const valorLimpo = valor
        .replace(/[^\d\w:h\sT\-:+]/g, '') // manter ISO e h/min
        .replace(/\s/g, '')
        .toLowerCase();

      let horas, minutos;

      // Novo: se for timestamp ISO com hora
      if (/^\d{4}-\d{2}-\d{2}t\d{1,2}:\d{2}/i.test(valorLimpo)) {
        const data = new Date(valorLimpo);
        if (!isNaN(data.getTime())) {
          const horaLocal = data.toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'America/Sao_Paulo'
          });
          return horaLocal;
        }
        return 'Hora inválida';
      }

      if (/^\d{1,2}h\d{1,2}$/.test(valorLimpo)) {
        [horas, minutos] = valorLimpo.split('h');
      } else if (/^\d{1,2}h$/.test(valorLimpo)) {
        horas = valorLimpo.replace('h', '');
        minutos = '00';
      } else if (/^\d{1,2}:\d{1,2}h$/.test(valorLimpo)) {
        [horas, minutos] = valorLimpo.replace('h', '').split(':');
      } else if (/^\d{1,2}:\d{1,2}$/.test(valorLimpo)) {
        [horas, minutos] = valorLimpo.split(':');
      } else if (/^\d{4}$/.test(valorLimpo)) {
        horas = valorLimpo.slice(0, 2);
        minutos = valorLimpo.slice(2);
      } else if (/^\d{1,2}$/.test(valorLimpo)) {
        horas = valorLimpo;
        minutos = '00';
      } else if (/\d{4}-\d{2}-\d{2}t\d{1,2}:\d{2}/i.test(valorLimpo)) {
        const dateFromISO = new Date(valorLimpo);
        if (!isNaN(dateFromISO.getTime())) {
          const horaLocal = dateFromISO.toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'America/Sao_Paulo'
          });
          return horaLocal;
        }
        return 'Hora inválida';
      } else {
        return 'Hora inválida';
      }

      horas = horas.padStart(2, '0');
      minutos = minutos.padStart(2, '0');

      return `${horas}:${minutos}`;
    }

    if (tipo === 'data') {
      const isoLike = /^\d{4}-\d{2}-\d{2}$/;
      const slashFormat = /^\d{2}\/\d{2}\/\d{4}$/;
      const dashUSFormat = /^\d{2}-\d{2}-\d{4}$/;
      const slashYearFirst = /^\d{4}\/\d{2}\/\d{2}$/;

      let dateObj;

      if (isoLike.test(valor)) {
        const [ano, mes, dia] = valor.split('-').map(Number);
        if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return 'Data inválida';
        dateObj = new Date(Date.UTC(ano, mes - 1, dia));
      } else if (slashFormat.test(valor)) {
        const [dia, mes, ano] = valor.split('/').map(Number);
        if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return 'Data inválida';
        dateObj = new Date(Date.UTC(ano, mes - 1, dia));
      } else if (dashUSFormat.test(valor)) {
        const [mes, dia, ano] = valor.split('-').map(Number);
        if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return 'Data inválida';
        dateObj = new Date(Date.UTC(ano, mes - 1, dia));
      } else if (slashYearFirst.test(valor)) {
        const [ano, mes, dia] = valor.split('/').map(Number);
        if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return 'Data inválida';
        dateObj = new Date(Date.UTC(ano, mes - 1, dia));
      } else {
        // Verificação extra: impedir que datas truncadas tipo "2025-05" sejam válidas
        if (/^\d{4}-\d{2}$/.test(valor) || /^\d{4}$/.test(valor)) {
          return 'Data inválida';
        }
        dateObj = new Date(valor);
      }

      if (isNaN(dateObj.getTime())) return 'Data inválida';

      const dia = dateObj.getUTCDate().toString().padStart(2, '0');
      const mes = (dateObj.getUTCMonth() + 1).toString().padStart(2, '0');
      const ano = dateObj.getUTCFullYear();

      return `${dia}/${mes}/${ano}`;
    }

    return '';
  } catch (e) {
    console.error("❌ Erro ao formatar data/hora:", e);
    console.warn(`⚠️ Tipo não reconhecido em formatarDataHora: "${tipo}"`);
    return '';
  }
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
    const intent = queryResult?.intent?.displayName;
    const parameters = queryResult?.parameters || {};

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

    const handleAgendamento = async (tipoAgendamento) => {
      try {
        const fallback = extractFallbackFields(message);

        let nomeRaw;
        if (parameters?.nome?.name) {
          nomeRaw = parameters.nome.name;
        } else if (Array.isArray(parameters?.nome)) {
          nomeRaw = parameters.nome.join(' ');
        } else {
          nomeRaw = parameters?.nome;
        }

        const nomeFinal = nomeRaw || fallback.nome || 'Cliente';
        const nomeFormatado = capitalizarNomeCompleto(nomeFinal);
        console.log('🔍 nomeFormatado:', nomeFormatado);

        const procedimentoRaw = Array.isArray(parameters?.procedimento)
          ? parameters.procedimento.join(' ')
          : parameters?.procedimento;

        const procedimento = procedimentoRaw || fallback.procedimento || 'procedimento a ser analisado';

        let data = formatarDataHora(parameters?.data || fallback.data, 'data');

        // 🕒 Extração manual da hora direto da mensagem original
        let hora = formatarDataHora(parameters?.hora || fallback.hora, 'hora');
        const matchHoraTexto = message.match(/\b\d{1,2}[:h]?\d{0,2}\b/i);
        if (matchHoraTexto) {
          const horaExtraidaTexto = formatarDataHora(matchHoraTexto[0], 'hora');
          if (horaExtraidaTexto && horaExtraidaTexto !== 'Hora inválida') {
            console.log('🛠️ Sobrescrevendo hora com base no texto da mensagem:', horaExtraidaTexto);
            hora = horaExtraidaTexto;
          }
        }

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

    if (intent === 'AgendarAvaliacaoFinal') {
      await handleAgendamento('avaliação');
      return res.status(200).send("OK");
    }

    if (intent === 'AgendarConsultaFinal') {
      await handleAgendamento('consulta');
      return res.status(200).send("OK");
    }

    if (intent === 'VerificarConvenio') {
      const normalize = (text) =>
        text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, '').trim();

      const convenioInformado = normalize(parameters?.convenio_aceito || '');
      const convenioEncontrado = conveniosAceitos.find(c => convenioInformado.includes(normalize(c)));
      const atende = Boolean(convenioEncontrado);

      const novaIntent = atende ? 'ConvenioAtendido' : 'ConvenioNaoAtendido';
      const respostaFinal = atende
        ? `✅ Maravilha! Atendemos o convênio *${convenioEncontrado.toUpperCase()}*!\nVamos agendar uma consulta? 🦷\n_Digite_: *Sim* ou _Não_`
        : `Humm, não encontrei esse convênio na nossa lista... Mas não se preocupe! 😉\nVamos agendar uma avaliação gratuita? 🦷\n_Digite_: *Sim* ou _Não_`;

      await logToSheet({ phone: cleanPhone, message: convenioInformado, type: 'bot', intent: novaIntent });
      await sendZapiMessage(respostaFinal);
      return res.status(200).send("OK");
    }

    if (intent === 'FalarComAtendente') {
      await notifyTelegram(cleanPhone, message);
      await logToSheet({ phone: cleanPhone, message, type: 'transbordo humano', intent });
    }

    if (reply) {
      await sendZapiMessage(reply);
      await logToSheet({ phone: cleanPhone, message, type: 'bot', intent });
      return res.status(200).send("OK");
    }

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