// src/functions/PintoGame.js
const path = require('path');
const Logger = require('../utils/Logger');
const ReturnMessage = require('../models/ReturnMessage');
const Command = require('../models/Command');
const Database = require('../utils/Database');

const logger = new Logger('pinto-game');
const database = Database.getInstance();

// Constantes do jogo
const MIN_FLACCID = 0.5;
const MAX_FLACCID = 15.0;
const MIN_ERECT = 0.5;
const MAX_ERECT = 40.0;
const MIN_GIRTH = 6.0;
const MAX_GIRTH = 20.0;
const MAX_SCORE = 1000;
const COOLDOWN_DAYS = 7; // 7 dias de cooldown

// Armazena os cooldowns por usuário
const playerCooldowns = {};

/**
 * Gera um valor aleatório entre min e max com 1 casa decimal
 * @param {number} min - Valor mínimo
 * @param {number} max - Valor máximo
 * @returns {number} - Valor aleatório com 1 casa decimal
 */
function generateRandomValue(min, max) {
  const value = Math.random() * (max - min) + min;
  return Math.round(value * 10) / 10; // Arredonda para 1 casa decimal
}

/**
 * Calcula o score com base nos valores
 * @param {number} flaccid - Comprimento flácido
 * @param {number} erect - Comprimento ereto
 * @param {number} girth - Circunferência
 * @returns {number} - Score calculado
 */
function calculateScore(flaccid, erect, girth) {
  // Normaliza os valores (0 a 1)
  const normFlaccid = (flaccid - MIN_FLACCID) / (MAX_FLACCID - MIN_FLACCID);
  const normErect = (erect - MIN_ERECT) / (MAX_ERECT - MIN_ERECT);
  const normGirth = (girth - MIN_GIRTH) / (MAX_GIRTH - MIN_GIRTH);
  
  // Calcula a média ponderada (dando mais peso para o comprimento ereto)
  const weightedAvg = (normFlaccid * 0.3 + normErect * 0.5 + normGirth * 0.2);
  
  // Converte para o score final
  return Math.round(weightedAvg * MAX_SCORE);
}

/**
 * Gera um comentário com base no score
 * @param {number} score - Score calculado
 * @returns {string} - Comentário engraçado
 */
function getComment(score) {
  if (score >= 900) {
    return "🔥 Impressionante! Você está no nível lendário!";
  } else if (score >= 800) {
    return "🏆 Excepcional! Um verdadeiro campeão!";
  } else if (score >= 700) {
    return "🌟 Incrível! Sem palavras para descrever!";
  } else if (score >= 600) {
    return "👏 Muito bem! Acima da média!";
  } else if (score >= 500) {
    return "👍 Bom resultado! Na média superior!";
  } else if (score >= 400) {
    return "😊 Resultado decente! Na média!";
  } else if (score >= 300) {
    return "🙂 Resultado aceitável. Um pouco abaixo da média.";
  } else if (score >= 200) {
    return "😐 Humm... Não é o melhor resultado, mas tudo bem.";
  } else if (score >= 100) {
    return "😬 Eita... Pelo menos você tem personalidade, certo?";
  } else {
    return "💀 F no chat... Mas tamanho não é documento!";
  }
}

/**
 * Formata data para exibição
 * @param {number} timestamp - Timestamp em milissegundos
 * @returns {string} - Data formatada
 */
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Gera os resultados do comando !pinto
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function pintoCommand(bot, message, args, group) {
  try {
    // Verifica se está em um grupo
    if (!message.group) {
      return new ReturnMessage({
        chatId: message.author,
        content: 'Este jogo só pode ser usado em grupos.'
      });
    }
    
    // Obtém IDs e nome
    const groupId = message.group;
    const userId = message.author;
    const userName = message.authorName || "Usuário";
    
    // Verifica cooldown
    const now = Date.now();
    const lastUsed = playerCooldowns[userId] || 0;
    const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    
    if (now - lastUsed < cooldownMs) {
      const nextAvailable = new Date(lastUsed + cooldownMs);
      const timeUntil = nextAvailable - now;
      const daysUntil = Math.ceil(timeUntil / (24 * 60 * 60 * 1000));
      
      return new ReturnMessage({
        chatId: groupId,
        content: `⏳ ${userName}, você já realizou sua avaliação recentemente.\n\nPróxima avaliação disponível em ${daysUntil} dia(s), dia ${formatDate(nextAvailable)}.`
      });
    }
    
    // Gera os valores aleatórios
    const flaccid = generateRandomValue(MIN_FLACCID, MAX_FLACCID);
    const erect = generateRandomValue(Math.max(flaccid, MIN_ERECT), MAX_ERECT); // Ereto é no mínimo igual ao flácido
    const girth = generateRandomValue(MIN_GIRTH, MAX_GIRTH);
    
    // Calcula o score
    const score = calculateScore(flaccid, erect, girth);
    
    // Obtém um comentário baseado no score
    const comment = getComment(score);
    
    // Atualiza o cooldown
    playerCooldowns[userId] = now;
    
    // Salva os resultados no banco de dados
    try {
      // Salva o resultado no ranking do grupo
      await savePlayerToGroupRanking(userId, userName, groupId, flaccid, erect, girth, score);
    } catch (dbError) {
      logger.error('Erro ao salvar dados do jogo:', dbError);
    }
    
    // Prepara a mensagem de resposta
    const response = `${userName}, fiz a análise completa de seu membro e cheguei nos seguintes resultados:\n\n` +
                    `• *Comprimento Flácido:* ${flaccid.toFixed(1)} cm\n` +
                    `• *Comprimento Ereto:* ${erect.toFixed(1)} cm\n` +
                    `• *Circunferência:* ${girth.toFixed(1)} cm\n` +
                    `• *Score:* _${score} pontos_\n\n` +
                    `${comment}\n\n` +
                    `> Você pode voltar daqui a 1 semana para refazermos sua avaliação.`;
    
    return new ReturnMessage({
      chatId: groupId,
      content: response
    });
  } catch (error) {
    logger.error('Erro no comando de pinto:', error);
    
    return new ReturnMessage({
      chatId: message.group || message.author,
      content: '❌ Erro ao processar o comando. Por favor, tente novamente.'
    });
  }
}

/**
 * Mostra o ranking do jogo Pinto
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function pintoRankingCommand(bot, message, args, group) {
  try {
    // Verifica se está em um grupo
    if (!message.group) {
      return new ReturnMessage({
        chatId: message.author,
        content: '🏆 O ranking do jogo só pode ser visualizado em grupos.'
      });
    }
    
    const groupId = message.group;
    
    // Obtém as variáveis customizadas
    const customVariables = await database.getCustomVariables();
    
    // Verifica se existem dados do jogo
    if (!customVariables.pintoGame || 
        !customVariables.pintoGame.groups || 
        !customVariables.pintoGame.groups[groupId] ||
        Object.keys(customVariables.pintoGame.groups[groupId]).length === 0) {
      return new ReturnMessage({
        chatId: groupId,
        content: '🏆 Ainda não há dados para o ranking neste grupo. Use !pinto para participar!'
      });
    }
    
    // Converte para array para poder ordenar
    const players = Object.entries(customVariables.pintoGame.groups[groupId]).map(([id, data]) => ({
      id,
      ...data
    }));
    
    // Ordena por score (maior para menor)
    players.sort((a, b) => b.score - a.score);
    
    // Limita a 10 jogadores
    const topPlayers = players.slice(0, 10);
    
    // Prepara a mensagem de ranking
    let rankingMessage = `🍆 *Ranking do Tamanho - ${group.name || "Grupo"}*\n\n`;
    
    topPlayers.forEach((player, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      rankingMessage += `${medal} ${player.name}: ${player.score} pontos\n`;
    });
    
    // Encontra a posição do autor da mensagem
    const authorPosition = players.findIndex(player => player.id === message.author);
    
    // Se o autor não está no top 10, mas está no ranking
    if (authorPosition >= 10) {
      rankingMessage += `\n...\n\n`;
      rankingMessage += `${authorPosition + 1}. Você: ${players[authorPosition].score} pontos`;
    }
    
    return new ReturnMessage({
      chatId: groupId,
      content: rankingMessage
    });
  } catch (error) {
    logger.error('Erro ao mostrar ranking do jogo:', error);
    
    return new ReturnMessage({
      chatId: message.group || message.author,
      content: '❌ Erro ao mostrar ranking. Por favor, tente novamente.'
    });
  }
}

/**
 * Salva os resultados do jogador no ranking do grupo
 * @param {string} userId - ID do usuário
 * @param {string} userName - Nome do usuário
 * @param {string} groupId - ID do grupo
 * @param {number} flaccid - Comprimento flácido
 * @param {number} erect - Comprimento ereto
 * @param {number} girth - Circunferência
 * @param {number} score - Pontuação total
 * @returns {Promise<boolean>} - Status de sucesso
 */
async function savePlayerToGroupRanking(userId, userName, groupId, flaccid, erect, girth, score) {
  try {
    // Obtém variáveis customizadas
    const customVariables = await database.getCustomVariables();
    
    // Inicializa estrutura de dados se não existir
    if (!customVariables.pintoGame) {
      customVariables.pintoGame = {
        groups: {},
        history: []
      };
    }
    
    if (!customVariables.pintoGame.groups) {
      customVariables.pintoGame.groups = {};
    }
    
    if (!customVariables.pintoGame.groups[groupId]) {
      customVariables.pintoGame.groups[groupId] = {};
    }
    
    // Salva ou atualiza os dados do jogador para este grupo
    customVariables.pintoGame.groups[groupId][userId] = {
      name: userName,
      flaccid,
      erect,
      girth,
      score,
      lastUpdated: Date.now()
    };
    
    // Adiciona ao histórico geral
    if (!customVariables.pintoGame.history) {
      customVariables.pintoGame.history = [];
    }
    
    customVariables.pintoGame.history.push({
      userId,
      userName,
      groupId,
      flaccid,
      erect,
      girth,
      score,
      timestamp: Date.now()
    });
    
    // Limita o histórico a 100 entradas
    if (customVariables.pintoGame.history.length > 100) {
      customVariables.pintoGame.history = customVariables.pintoGame.history.slice(-100);
    }
    
    // Salva as variáveis
    await database.saveCustomVariables(customVariables);
    
    return true;
  } catch (error) {
    logger.error('Erro ao salvar jogador no ranking do grupo:', error);
    return false;
  }
}


// Criar array de comandos usando a classe Command
const commands = [
  new Command({
    name: 'pinto',
    description: 'Gera uma avaliação de tamanho aleatória',
    category: "jogos",
    cooldown: 0, // 1 minuto de cooldown entre tentativas (o cooldown real é controlado internamente)
    reactions: {
      before: "📏",
      after: "🍆",
      error: "❌"
    },
    method: pintoCommand
  }),
  
  new Command({
    name: 'pinto-ranking',
    description: 'Mostra o ranking do jogo',
    category: "jogos",
    cooldown: 30,
    reactions: {
      after: "🏆",
      error: "❌"
    },
    method: pintoRankingCommand
  })
];

module.exports = { commands };