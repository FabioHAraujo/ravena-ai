const CommandHandler = require('./CommandHandler');
const Database = require('./utils/Database');
const Group = require('./models/Group');
const Logger = require('./utils/Logger');
const LLMService = require('./services/LLMService');
const SpeechCommands = require('./functions/SpeechCommands');
const SummaryCommands = require('./functions/SummaryCommands');
const NSFWPredict = require('./utils/NSFWPredict');
const { processListReaction } = require('./functions/ListCommands');
const fs = require('fs').promises;
const path = require('path');

class EventHandler {
  constructor() {
    this.logger = new Logger('event-handler');
    this.database = Database.getInstance();
    this.commandHandler = new CommandHandler();
    this.llmService = new LLMService({});
    this.nsfwPredict = NSFWPredict.getInstance();
    this.groups = {};
    this.loadGroups();
  }

  /**
   * Carrega todos os grupos do banco de dados
   */
  async loadGroups() {
    try {
      const groups = await this.database.getGroups();
      if (groups && Array.isArray(groups)) {
        for (const groupData of groups) {
          this.groups[groupData.id] = new Group(groupData);
        }
      }
      this.logger.info(`Carregados ${Object.keys(this.groups).length} grupos`);
    } catch (error) {
      this.logger.error('Erro ao carregar grupos:', error);
    }
  }

  /**
   * Obtém grupo por ID, cria se não existir
   * @param {string} groupId - O ID do grupo
   * @param {string} name - O nome do grupo (opcional)
   * @returns {Promise<Group>} - O objeto do grupo
   */
  async getOrCreateGroup(groupId, name = null) {
    try {
      if (!this.groups[groupId]) {
        this.logger.info(`Criando novo grupo: ${groupId} com nome: ${name || 'desconhecido'}`);
        
        // Obtém grupos do banco de dados para garantir que temos o mais recente
        const groups = await this.database.getGroups();
        const existingGroup = Array.isArray(groups) ? 
          groups.find(g => g.id === groupId) : null;
        
        if (existingGroup) {
          this.logger.info(`Grupo existente encontrado no banco de dados: ${groupId}`);
          this.groups[groupId] = new Group(existingGroup);
        } else {
          // Cria novo grupo
          const displayName = name || 
            (groupId.split('@')[0].toLowerCase().replace(/\s+/g, '').substring(0, 16));
            
          const group = new Group({
            id: groupId,
            name: displayName,
            addedBy: "test@c.us" // Para teste
          });
          
          this.groups[groupId] = group;
          
          // Salva no banco de dados
          const saveResult = await this.database.saveGroup(group);
          this.logger.debug(`Resultado de salvamento do grupo: ${saveResult ? 'sucesso' : 'falha'}`);
        }
      }
      return this.groups[groupId];
    } catch (error) {
      this.logger.error('Erro em getOrCreateGroup:', error);
      // Cria um objeto de grupo básico se tudo falhar
      return new Group({ id: groupId, name: name || 'grupo-desconhecido' });
    }
  }

  /**
   * Manipula evento de conexão
   * @param {WhatsAppBot} bot - A instância do bot
   */
  onConnected(bot) {
    this.logger.info(`Bot ${bot.id} conectado`);
  }

  /**
   * Manipula evento de desconexão
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {string} reason - Motivo da desconexão
   */
  onDisconnected(bot, reason) {
    this.logger.info(`Bot ${bot.id} desconectado: ${reason}`);
  }

  /**
   * Manipula evento de mensagem
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Object} message - A mensagem formatada
   */
  onMessage(bot, message) {
    // Processa mensagem sem aguardar para evitar bloquear a thread de eventos
    this.processMessage(bot, message).catch(error => {
      this.logger.error('Erro em processMessage:', error);
    });
  }

  /**
   * Processa uma mensagem recebida
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Object} message - A mensagem formatada
   */
  async processMessage(bot, message) {
    try {
      // Verifica links de convite em chats privados
      if (!message.group) {
        // Verifica se é uma mensagem de link de convite
        const isInviteHandled = await bot.inviteSystem.processMessage(message);
        if (isInviteHandled) return;
        
        // Verifica se é uma mensagem de acompanhamento para um convite
        const isFollowUpHandled = await bot.inviteSystem.processFollowUpMessage(message);
        if (isFollowUpHandled) return;
      }
      
      // Se mensagem de grupo, obtém ou cria o grupo
      let group = null;
      if (message.group) {
        group = await this.getOrCreateGroup(message.group);
        
        // Armazena mensagem para histórico de conversação
        await SummaryCommands.storeMessage(message, group);
        
        // Verifica se o grupo está pausado
        if (group.paused) {        
          // Obtém conteúdo de texto da mensagem (corpo ou legenda)
          const textContent = message.type === 'text' ? message.content : message.caption;
          
          // Verifica se é o comando g-pausar antes de ignorar completamente
          const prefix = (group && group.prefix !== undefined) ? group.prefix : bot.prefix;
          const isPauseCommand = textContent && 
                                textContent.startsWith(prefix) && 
                                textContent.substring(prefix.length).startsWith('g-pausar');
          
          // Só continua o processamento se for o comando g-pausar
          if (!isPauseCommand) {
            return;
          }
        }
        
        // Verifica se o usuário está ignorado
        if (group && group.ignoredNumbers && Array.isArray(group.ignoredNumbers)) {
          // Check if any part of the author's number matches an ignored number
          const isIgnored = group.ignoredNumbers.some(number => 
            message.author.includes(number) && number.length >= 8
          );
          
          if (isIgnored) {
            this.logger.debug(`Ignorando mensagem de ${message.author} (ignorado no grupo)`);
            return; // Skip processing this message
          }
        }

        // Verifica se é pra ignorar a mensagem por conteúdo
        if (group && group.mutedStrings && Array.isArray(group.mutedStrings) && textContent) {
          const isIgnored = group.mutedStrings.some(str => 
            textContent.toLowerCase().startsWith(str.toLowerCase())
          );
          
          if (isIgnored) {
            this.logger.debug(`Ignorando processamento de mensagem por causa do conteudo: ${textContent.substring(0, 20)}...`);
            return; // Skip processing this message
          }
        }

        // Aplica filtros
        if (await this.applyFilters(bot, message, group)) {
          return; // Mensagem foi filtrada
        }
      }
      
      // Obtém conteúdo de texto da mensagem (corpo ou legenda)
      const textContent = message.type === 'text' ? message.content : message.caption;
      
      // Se não houver conteúdo de texto, não pode ser um comando ou menção
      if (!textContent) {
        return this.processNonCommandMessage(bot, message, group);
      }
      
      // Verifica menções ao bot
      const isMentionHandled = await bot.mentionHandler.processMention(bot, message, textContent);
      if (isMentionHandled) return;
      
      // Obtém prefixo do grupo ou prefixo padrão do bot
      const prefix = (group && group.prefix !== undefined) ? group.prefix : bot.prefix;
      
      // CORREÇÃO: Verificação adequada para prefixo vazio
      const isCommand = prefix === '' || textContent.startsWith(prefix);
      

      if (isCommand) {
        // Se o prefixo for vazio, usa o texto completo como comando
        // Se não, remove o prefixo do início
        const commandText = prefix === '' ? textContent : textContent.substring(prefix.length);
        
        // IMPORTANTE: Verificação especial para comandos de gerenciamento mesmo com prefixo vazio
        if (commandText.startsWith('g-')) {
          this.logger.debug(`Comando de gerenciamento detectado: ${commandText}`);
          
          // Processa comando sem aguardar para evitar bloqueio
          this.commandHandler.handleCommand(bot, message, commandText, group).catch(error => {
            this.logger.error('Erro em handleCommand:', error);
          });
          
          return; // Evita processamento adicional
        }
        


        // Processa comando normal
        this.commandHandler.handleCommand(bot, message, commandText, group).catch(error => {
          this.logger.error('Erro em handleCommand:', error);
        });
      } else {
        // Processa mensagem não-comando
        this.processNonCommandMessage(bot, message, group).catch(error => {
          this.logger.error('Erro em processNonCommandMessage:', error);
        });
      }
    } catch (error) {
      this.logger.error('Erro ao processar mensagem:', error);
    }
  }

  /**
   * Processa mensagens que não são comandos
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Object} message - A mensagem formatada
   * @param {Group} group - O objeto do grupo (se em grupo)
   */
  async processNonCommandMessage(bot, message, group) {

    // Verifica se é uma mensagem de voz para processamento automático de STT    
    const processed = await SpeechCommands.processAutoSTT(bot, message, group);
    if (processed) return;
        
    // Manipula comandos personalizados acionados automaticamente (aqueles que não requerem prefixo)
    if (group) {
      try {
        const textContent = message.type === 'text' ? message.content : message.caption;
        if (textContent) {
          await this.commandHandler.checkAutoTriggeredCommands(bot, message, textContent, group);
        }
      } catch (error) {
        this.logger.error('Erro ao verificar comandos acionados automaticamente:', error);
      }
    }
  }

  /**
   * Aplica filtros de mensagem
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Object} message - A mensagem formatada
   * @param {Group} group - O objeto do grupo
   * @returns {Promise<boolean>} - True se a mensagem foi filtrada (deve ser ignorada)
   */
  async applyFilters(bot, message, group) {
    if (!group || !group.filters) return false;
    
    const textContent = message.type === 'text' ? message.content : message.caption;
    
    const filters = group.filters;
    
    // Verifica filtro de palavras
    if (filters.words && Array.isArray(filters.words) && filters.words.length > 0) {
      if (textContent) {
        const lowerText = textContent.toLowerCase();
        for (const word of filters.words) {
          if (lowerText.includes(word.toLowerCase())) {
            this.logger.info(`Mensagem filtrada no grupo ${group.id} - contém palavra proibida: ${word}`);
            
            // Deleta a mensagem se possível - não bloqueia
            message.origin.delete(true).catch(error => {
              this.logger.error('Erro ao deletar mensagem filtrada:', error);
            });
            
            return true;
          }
        }
      }
    }
    
    // Verifica filtro de links
    if (filters.links && textContent && textContent.match(/https?:\/\/[^\s]+/g)) {
      this.logger.info(`Mensagem filtrada no grupo ${group.id} - contém link`);
      
      // Deleta a mensagem se possível - não bloqueia
      message.origin.delete(true).catch(error => {
        this.logger.error('Erro ao deletar mensagem filtrada:', error);
      });
      
      return true;
    }
    
    // Verifica filtro de pessoas
    if (filters.people && Array.isArray(filters.people) && filters.people.some(person => message.author.includes(person))) {
      this.logger.info(`Mensagem filtrada no grupo ${group.id} - de usuário banido: ${message.author}`);
      
      // Deleta a mensagem se possível - não bloqueia
      message.origin.delete(true).catch(error => {
        this.logger.error('Erro ao deletar mensagem filtrada:', error);
      });
      
      return true;
    }
    
    // Verifica filtro NSFW para imagens e vídeos
    if (filters.nsfw && (message.type === 'image' || message.type === 'video')) {
      // Processa a imagem/vídeo para detecção NSFW
      try {
        // Primeiro salvamos a mídia temporariamente
        const tempDir = path.join(__dirname, '../temp');
        
        // Garante que o diretório temporário exista
        try {
          await fs.access(tempDir);
        } catch (error) {
          await fs.mkdir(tempDir, { recursive: true });
        }
        
        // Gera nome de arquivo temporário único
        const fileExt = message.type === 'image' ? 'jpg' : 'mp4';
        const tempFilePath = path.join(tempDir, `nsfw-check-${Date.now()}-${Math.floor(Math.random() * 1000)}.${fileExt}`);
        
        // Salva a mídia
        const mediaBuffer = Buffer.from(message.content.data, 'base64');
        await fs.writeFile(tempFilePath, mediaBuffer);
        
        // Apenas imagens são verificadas para NSFW
        if (message.type === 'image') {
          // Verifica NSFW
          const result = await this.nsfwPredict.detectNSFW(tempFilePath);
          
          // Limpa o arquivo temporário
          fs.unlink(tempFilePath).catch(error => {
            this.logger.error(`Erro ao excluir arquivo temporário ${tempFilePath}:`, error);
          });
          
          if (result.isNSFW) {
            this.logger.info(`Mensagem filtrada no grupo ${group.id} - conteúdo NSFW detectado`);
            this.logger.debug('Scores NSFW:', result.scores);
            
            // Deleta a mensagem
            message.origin.delete(true).catch(error => {
              this.logger.error('Erro ao deletar mensagem NSFW:', error);
            });
            
            return true;
          }
        } else {
          // Para vídeos, apenas limpamos o arquivo temporário
          fs.unlink(tempFilePath).catch(error => {
            this.logger.error(`Erro ao excluir arquivo temporário ${tempFilePath}:`, error);
          });
        }
      } catch (nsfwError) {
        this.logger.error('Erro ao verificar conteúdo NSFW:', nsfwError);
      }
    }
    
    return false;
  }

  /**
   * Manipula evento de entrada no grupo
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Object} data - Dados do evento
   *
   */
  onGroupJoin(bot, data) {
    // Processa entrada sem aguardar para evitar bloquear a thread de eventos
    this.processGroupJoin(bot, data).catch(error => {
      this.logger.error('Erro em processGroupJoin:', error);
    });
  }
  
  /**
   * Processa entrada no grupo
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Object} data - Dados do evento
   */
  async processGroupJoin(bot, data) {
    console.log(data);
    this.logger.info(`Usuário ${data.user.name} (${data.user.id}) entrou no grupo ${data.group.name} (${data.group.id}). Quem adicionou: ${data.responsavel.name}/${data.responsavel.id}`);
    
    try {
      // Obtém os dados completos do chat
      const chat = await data.origin.getChat();
      
      // Verifica se o próprio bot é quem está entrando
      const isBotJoining = data.user.id === bot.client.info.wid._serialized;
      console.log(`isBotJoining (${isBotJoining}}) = data.user.id (${data.user.id}) === bot.client.info.wid._serialized ${bot.client.info.wid._serialized}`);
      
      // Obtém ou cria grupo
      const group = await this.getOrCreateGroup(data.group.id, data.group.name);
      this.logger.debug(`Informações do grupo: ${JSON.stringify(group)}`);
      
      // Envia notificação para o grupo de logs
      if (bot.grupoLogs) {
        try {
          if(isBotJoining){
            bot.sendMessage(bot.grupoLogs, `🚪 Bot ${bot.id} entrou no grupo: ${data.group.name} (${data.group.id})\nQuem add: ${data.responsavel.name}/${data.responsavel.id}`).catch(error => {
              this.logger.error('Erro ao enviar notificação de entrada no grupo para o grupo de logs:', error);
            });
          }
        } catch (error) {
          this.logger.error('Erro ao enviar notificação de entrada no grupo para o grupo de logs:', error);
        }
      }
      
      if (isBotJoining) {
        // Caso 1: Bot entrou no grupo
        this.logger.info(`Bot entrou no grupo ${data.group.name} (${data.group.id})`);
        
        // Busca pendingJoins para ver se esse grupo corresponde a um convite pendente
        const pendingJoins = await this.database.getPendingJoins();
        let foundInviter = null;
        
        // Obtém todos os membros do grupo para verificação
        const members = chat.participants.map(p => p.id._serialized);
        const stringifiedData = JSON.stringify(data);
        
        for (const pendingJoin of pendingJoins) {
          // Verifica se o autor do convite está no grupo (duas abordagens)
          if (members.includes(pendingJoin.authorId) || stringifiedData.includes(pendingJoin.authorId)) {
            foundInviter = pendingJoin;
            break;
          }
        }

        // Envia uma mensagem de boas-vindas padrão sobre o bot
        let botInfoMessage = `🦇 Olá, grupo! Eu sou a *ravenabot*, um bot de WhatsApp. Use "${group.prefix}cmd" para ver os comandos disponíveis.`;
        
        // Se encontramos o autor do convite, adiciona-o como admin adicional
        let llm_inviterInfo = "";
        if (foundInviter) {
          // Inicializa additionalAdmins se não existir
          if (!group.additionalAdmins) {
            group.additionalAdmins = [];
          }
          
          // Adiciona o autor como admin adicional se ainda não estiver na lista
          if (!group.additionalAdmins.includes(foundInviter.authorId)) {
            group.additionalAdmins.push(foundInviter.authorId);
            await this.database.saveGroup(group);   
          }

          if(foundInviter.authorName){
            botInfoMessage += `\n_(Adicionado por: ${foundInviter.authorName})_`;
            llm_inviterInfo = ` '${foundInviter.authorName}'`;
          }
          
          // Remove o join pendente
          await this.database.removePendingJoin(foundInviter.code);
        }
      
        
        // Gera e envia uma mensagem com informações sobre o grupo usando LLM
        try {
          // Extrai informações do grupo para o LLM
          const groupInfo = {
            name: chat.name,
            description: chat.groupMetadata?.desc || "",
            memberCount: chat.participants?.length || 0
          };
          
          const llmPrompt = `Você é um bot de WhatsApp chamado ravenabot e foi adicionado em um grupo de whatsapp chamado '${groupInfo.name}'${llm_inviterInfo}, este grupo é sobre '${groupInfo.description}' e tem '${groupInfo.memberCount}' participantes. Gere uma mensagem agradecendo a confiança e fazendo de conta que entende do assunto do grupo enviando algo relacionado junto pra se enturmar, seja natural.`;
          
          // Obtém conclusão do LLM sem bloquear
          this.llmService.getCompletion({
            prompt: llmPrompt,
            provider: 'openrouter',
            temperature: 0.7,
            maxTokens: 200
          }).then(groupWelcomeMessage => {
            // Envia a mensagem de boas-vindas gerada
            if (groupWelcomeMessage) {
              console.log(groupWelcomeMessage);
              bot.sendMessage(data.group.id, botInfoMessage+"\n\n"+groupWelcomeMessage).catch(error => {
                this.logger.error('Erro ao enviar mensagem de boas-vindas do grupo:', error);
              });
            }
          }).catch(error => {
            this.logger.error('Erro ao gerar mensagem de boas-vindas do grupo:', error);
            bot.sendMessage(data.group.id, botInfoMessage).catch(error => {
              this.logger.error('Erro ao enviar mensagem de informações do bot:', error);
            });
          });
        } catch (llmError) {
          this.logger.error('Erro ao gerar mensagem de boas-vindas do grupo:', llmError);
          bot.sendMessage(data.group.id, botInfoMessage).catch(error => {
            this.logger.error('Erro ao enviar mensagem de informações do bot:', error);
          });
        }
      } else {
        // Caso 2: Outra pessoa entrou no grupo
        // Gera e envia mensagem de boas-vindas para o novo membro
        if (group.greetings) {
          this.generateGreetingMessage(bot, group, data.user).then(welcomeMessage => {
            if (welcomeMessage) {
              bot.sendMessage(data.group.id, welcomeMessage).catch(error => {
                this.logger.error('Erro ao enviar mensagem de boas-vindas:', error);
              });
            }
          }).catch(error => {
            this.logger.error('Erro ao gerar mensagem de saudação:', error);
          });
        }
      }
    } catch (error) {
      this.logger.error('Erro ao processar entrada no grupo:', error);
    }
  }

  /**
   * Processa saída do grupo
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Object} data - Dados do evento
   */
  async processGroupLeave(bot, data) {
    console.log(data);
    this.logger.info(`Usuário ${data.user.name} (${data.user.id}) saiu do grupo ${data.group.name} (${data.group.id}). Quem removeu: ${data.responsavel.name}/${data.responsavel.id}`);
    
    try {
      // Obtém grupo
      const group = this.groups[data.group.id];
      
      // Verifica se é o bot que saiu
      const isBotLeaving = data.user.id === bot.client.info.wid._serialized;
      
      // Envia notificação para o grupo de logs
      if (bot.grupoLogs) {
        try {
          if(isBotLeaving){
            bot.sendMessage(bot.grupoLogs, `🚪 Bot ${bot.id} saiu do grupo: ${data.group.name} (${data.group.id})})\nQuem removeu: ${data.responsavel.name}/${data.responsavel.id}`).catch(error => {
              this.logger.error('Erro ao enviar notificação de entrada no grupo para o grupo de logs:', error);
            });
          }
        } catch (error) {
          this.logger.error('Erro ao enviar notificação de saída do grupo para o grupo de logs:', error);
        }
      }
      
      if (group && group.farewells && !isBotLeaving) {
        const farewellMessage = this.processFarewellMessage(group, data.user);
        if (farewellMessage) {
          bot.sendMessage(data.group.id, farewellMessage).catch(error => {
            this.logger.error('Erro ao enviar mensagem de despedida:', error);
          });
        }
      }
    } catch (error) {
      this.logger.error('Erro ao processar saída do grupo:', error);
    }
  }

  /**
   * Gera mensagem de saudação para novos membros do grupo
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Group} group - O objeto do grupo
   * @param {Object} user - O usuário que entrou
   * @returns {Promise<string|MessageMedia>} - A mensagem de saudação
   */
  async generateGreetingMessage(bot, group, user) {
    try {
      if (!group.greetings) return null;
      
      // Se saudação de texto
      if (group.greetings.text) {
        // Substitui variáveis
        let message = group.greetings.text;
        message = message.replace(/{pessoa}/g, user.name);
        
        return message;
      }
      
      // Se saudação de sticker
      if (group.greetings.sticker) {
        // TODO: Implementar saudação de sticker
      }
      
      // Se saudação de imagem
      if (group.greetings.image) {
        // TODO: Implementar saudação de imagem
      }
      
      // Saudação padrão
      //return `Bem-vindo ao grupo, ${user.name}!`;
      return false;
    } catch (error) {
      this.logger.error('Erro ao gerar mensagem de saudação:', error);
      return null;
    }
  }

  /**
   * Processa mensagem de despedida para membros que saem do grupo
   * @param {Group} group - O objeto do grupo
   * @param {Object} user - O usuário que saiu
   * @returns {string} - A mensagem de despedida
   */
  processFarewellMessage(group, user) {
    try {
      if (!group.farewells) return null;
      
      // Se despedida de texto
      if (group.farewells.text) {
        // Substitui variáveis
        let message = group.farewells.text;
        message = message.replace(/{pessoa}/g, user.name);
        
        return message;
      }
      
      // Despedida padrão
      //return `Adeus, ${user.name}!`;
      return false;
    } catch (error) {
      this.logger.error('Erro ao processar mensagem de despedida:', error);
      return null;
    }
  }
  
  /**
   * Manipula notificações gerais
   * @param {WhatsAppBot} bot - A instância do bot
   * @param {Object} notification - A notificação
   */
  onNotification(bot, notification) {
    // Implementação opcional para tratar outros tipos de notificações
  }
}

module.exports = EventHandler;