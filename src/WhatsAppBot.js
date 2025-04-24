const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Database = require('./utils/Database');
const Logger = require('./utils/Logger');
const path = require('path');
const fs = require('fs');
const LoadReport = require('./LoadReport');
const ReactionsHandler = require('./ReactionsHandler');
const MentionHandler = require('./MentionHandler');
const InviteSystem = require('./InviteSystem');
const StreamSystem = require('./StreamSystem');
const LLMService = require('./services/LLMService');
const AdminUtils = require('./utils/AdminUtils');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class WhatsAppBot {
  /**
   * Cria uma nova instância de bot WhatsApp
   * @param {Object} options - Opções de configuração
   * @param {string} options.id - Identificador único para esta instância de bot
   * @param {string} options.phoneNumber - Número de telefone para solicitar código de pareamento
   * @param {Object} options.eventHandler - Instância do manipulador de eventos
   * @param {string} options.prefix - Prefixo de comando (padrão: '!')
   * @param {Object} options.puppeteerOptions - Opções para o puppeteer
   */
  constructor(options) {
    this.id = options.id;
    this.phoneNumber = options.phoneNumber;
    this.eventHandler = options.eventHandler;
    this.prefix = options.prefix || process.env.DEFAULT_PREFIX || '!';
    this.logger = new Logger(`bot-${this.id}`);
    this.client = null;
    this.database = Database.getInstance(); // Instância de banco de dados compartilhada
    this.isConnected = false;
    this.safeMode = options.safeMode !== undefined ? options.safeMode : (process.env.SAFE_MODE === 'true');
    this.puppeteerOptions = options.puppeteerOptions || {};
    
    // Novas propriedades para notificações de grupos da comunidade
    this.grupoLogs = options.grupoLogs || process.env.GRUPO_LOGS;
    this.grupoInvites = options.grupoInvites || process.env.GRUPO_INVITES;
    this.grupoAvisos = options.grupoAvisos || process.env.GRUPO_AVISOS;
    this.grupoInteracao = options.grupoInteracao || process.env.GRUPO_INTERACAO;
    
    // Inicializa rastreador de relatórios de carga
    this.loadReport = new LoadReport(this);
    
    // Inicializa sistema de convites
    this.inviteSystem = new InviteSystem(this);
    
    // Inicializa manipulador de menções
    this.mentionHandler = new MentionHandler();

    // Inicializa manipulador de reações
    this.reactionHandler = new ReactionsHandler();

    // Inicializa StreamSystem (será definido em initialize())
    this.streamSystem = null;
    this.streamMonitor = null;
    
    this.llmService = new LLMService({});
    this.adminUtils = AdminUtils.getInstance();

    this.sessionDir = path.join(__dirname, '..', '.wwebjs_auth', this.id);
  }

  /**
   * Inicializa o cliente WhatsApp
   */
  async initialize() {
    this.logger.info(`Inicializando instância de bot ${this.id}`);

    // Cria cliente com dados de sessão
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.id }),
      puppeteer: this.puppeteerOptions
    });

    // Registra manipuladores de eventos
    this.registerEventHandlers();

    // Inicializa cliente
    await this.client.initialize();
      
    this.logger.info(`Bot ${this.id} inicializado`);
    await sleep(5000);

    try {
      this.blockedContacts = await this.client.getBlockedContacts();
      this.logger.info(`Carregados ${this.blockedContacts.length} contatos bloqueados`);
    } catch (error) {
      this.logger.error('Erro ao carregar contatos bloqueados:', error);
      this.blockedContacts = [];
    }

    // Envia notificação de inicialização para o grupo de logs
    if (this.grupoLogs && this.isConnected) {
      try {
        const startMessage = `🤖 Bot ${this.id} inicializado com sucesso em ${new Date().toLocaleString()}`;
        await this.sendMessage(this.grupoLogs, startMessage);
      } catch (error) {
        this.logger.error('Erro ao enviar notificação de inicialização:', error);
      }
    }
    
    return this;
  }

  /**
   * Registra manipuladores de eventos para o cliente WhatsApp
   */
  registerEventHandlers() {
    // Evento de QR Code
    this.client.on('qr', (qr) => {
      this.logger.info('QR Code recebido, escaneie para autenticar');
      qrcode.generate(qr, { small: true });
    });

    // Evento de pronto
    this.client.on('ready', async () => {
      this.isConnected = true;
      this.logger.info('Cliente está pronto');
      this.eventHandler.onConnected(this);

      // Inicializa o sistema de streaming agora que estamos conectados
      this.streamSystem = new StreamSystem(this);
      await this.streamSystem.initialize();
      this.streamMonitor = this.streamSystem.streamMonitor;
    });

    // Evento de autenticado
    this.client.on('authenticated', () => {
      this.logger.info('Cliente autenticado');
    });

    // Evento de falha de autenticação
    this.client.on('auth_failure', (msg) => {
      this.isConnected = false;
      this.logger.error('Falha de autenticação:', msg);
    });

    // Evento de desconectado
    this.client.on('disconnected', (reason) => {
      this.isConnected = false;
      this.logger.info('Cliente desconectado:', reason);
      this.eventHandler.onDisconnected(this, reason);
    });

    // Evento de mensagem
    this.client.on('message', async (message) => {
      try {
        // Verifica se o autor está na lista de bloqueados
        if (this.blockedContacts && Array.isArray(this.blockedContacts)) {
          const isBlocked = this.blockedContacts.some(contact => 
            contact.id._serialized === message.author
          );
          
          if (isBlocked) {
            this.logger.debug(`Ignorando mensagem de contato bloqueado: ${message.author}`);
            return; // Ignora processamento adicional
          }
        }

        // Formata mensagem para o manipulador de eventos
        const formattedMessage = await this.formatMessage(message);
        this.eventHandler.onMessage(this, formattedMessage);
      } catch (error) {
        this.logger.error('Erro ao processar mensagem:', error);
      }
    });

    // Evento de reação
    this.client.on('message_reaction', async (reaction) => {
      try {
        // Processa apenas reações de outros usuários, não do próprio bot
        if (reaction.senderId !== this.client.info.wid._serialized) {
          // Verifica se o autor está na lista de bloqueados
          if (this.blockedContacts && Array.isArray(this.blockedContacts)) {
            const isBlocked = this.blockedContacts.some(contact => 
              contact.id._serialized === reaction.senderId
            );
            
            if (isBlocked) {
              this.logger.debug(`Ignorando reaction de contato bloqueado: ${reaction.senderId}`);
              return; // Ignora processamento adicional
            }
          }
          
          await this.reactionHandler.processReaction(this, reaction);
        }
      } catch (error) {
        this.logger.error('Erro ao tratar reação de mensagem:', error);
      }
    });

    // Evento de entrada no grupo
    this.client.on('group_join', async (notification) => {
      try {
        const group = await notification.getChat();
        const users = await notification.getRecipients();
        const responsavel = await notification.getContact();

        if(users){
          for(let user of users){
            this.eventHandler.onGroupJoin(this, {
              group: {
                id: group.id._serialized,
                name: group.name
              },
              user: {
                id: user.id._serialized,
                name: user.pushname || 'Desconhecido'
              },
              responsavel: {
                id: responsavel.id._serialized,
                name: responsavel.pushname || 'Desconhecido'
              },
              origin: notification
            });
          }
        }
      } catch (error) {
        this.logger.error('Erro ao processar entrada no grupo:', error);
      }
    });

    // Evento de saída do grupo
    this.client.on('group_leave', async (notification) => {
      try {
        const group = await notification.getChat();
        const users = await notification.getRecipients();
        const responsavel = await notification.getContact();

        if(users){
          for(let user of users){
            this.eventHandler.onGroupLeave(this, {
              group: {
                id: group.id._serialized,
                name: group.name
              },
              user: {
                id: user.id._serialized,
                name: user.pushname || 'Desconhecido'
              },
              responsavel: {
                id: responsavel.id._serialized,
                name: responsavel.pushname || 'Desconhecido'
              },
              origin: notification
            });
          }
        }
      } catch (error) {
        this.logger.error('Erro ao processar saída do grupo:', error);
      }
    });

    // Ligação
    this.client.on('incoming_call', async (call) => {
      this.logger.info(`[Call] Rejeitando chamada: ${JSON.stringify(call)}`)
      call.reject();
    });

    // Evento de notificação geral
    this.client.on('notification', (notification) => {
      this.eventHandler.onNotification(this, notification);
    });
  }

  /**
   * Formata uma mensagem do WhatsApp para nosso formato padrão
   * @param {Object} message - A mensagem bruta do whatsapp-web.js
   * @returns {Promise<Object>} - Objeto de mensagem formatado
   */
  async formatMessage(message) {
    try {
      const chat = await message.getChat();
      const sender = await message.getContact();
      const isGroup = chat.isGroup;
      
      // Rastreia mensagem recebida
      this.loadReport.trackReceivedMessage(isGroup);
      
      let type = 'text';
      let content = message.body;
      let caption = null;
      
      // Determina tipo de mensagem e conteúdo
      if (message.hasMedia) {
        const media = await message.downloadMedia();
        type = media.mimetype.split('/')[0]; // imagem, vídeo, áudio, etc.
        content = media;
        caption = message.body;
      } else if (message.type === 'sticker') {
        type = 'sticker';
        content = await message.downloadMedia();
      }
      
      return {
        group: isGroup ? chat.id._serialized : null,
        author: sender.id._serialized,
        authorName: sender.pushname || sender.name || 'Desconhecido',
        type,
        content,
        caption,
        origin: message
      };
    } catch (error) {
      this.logger.error('Erro ao formatar mensagem:', error);
      throw error;
    }
  }

  /**
   * Envia uma mensagem para um chat
   * @param {string} chatId - O ID do chat para enviar a mensagem
   * @param {string|Object} content - O conteúdo a enviar (texto ou mídia)
   * @param {Object} options - Opções adicionais
   * @returns {Promise<Object>} - A mensagem enviada
   */
  async sendMessage(chatId, content, options = {}) {
    try {
      // Rastreia mensagem enviada
      const isGroup = chatId.endsWith('@g.us');
      this.loadReport.trackSentMessage(isGroup);

      // Opções padrão
      if(!options.linkPreview){
        options.linkPreview = false;
      }
      
      // Verifica se está em modo seguro
      if (this.safeMode) {
        this.logger.info(`[MODO SEGURO] Enviaria para ${chatId}: ${typeof content === 'string' ? content : '[Mídia]'}`);
        return { id: { _serialized: 'safe-mode-msg-id' } };
      }

      if (typeof content === 'string') {
        return await this.client.sendMessage(chatId, content, options);
      } else if (content instanceof MessageMedia) {
        const fullOpts = {
          caption: options.caption,
          sendMediaAsSticker: options.asSticker || false,
          ...options
        };

        try{
          return await this.client.sendMessage(chatId, content, fullOpts);
        } catch(err){
          this.logger.error(`Erro ao enviar mensagem pra ${chatId}:`, err, content, fullOpts);
        }
      }
    } catch (error) {
      this.logger.error(`Erro ao enviar mensagem para ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Sends one or more ReturnMessage objects
   * @param {ReturnMessage|Array<ReturnMessage>} returnMessages - ReturnMessage or array of ReturnMessages to send
   * @returns {Promise<Array>} - Array of results from sending each message
   */
  async sendReturnMessages(returnMessages) {
    try {
      // Ensure returnMessages is an array
      if (!Array.isArray(returnMessages)) {
        returnMessages = [returnMessages];
      }

      // Filter out invalid messages
      const validMessages = returnMessages.filter(msg => 
        msg && msg.isValid && msg.isValid()
      );

      if (validMessages.length === 0) {
        this.logger.warn('No valid ReturnMessages to send');
        return [];
      }

      const results = [];
      
      // Process each message
      for (const message of validMessages) {
        // Apply any delay if specified
        if (message.delay > 0) {
          await new Promise(resolve => setTimeout(resolve, message.delay));
        }

        // Send the message
        const result = await this.sendMessage(
          message.chatId, 
          message.content, 
          message.options
        );


        // Apply reactions if specified
        if (message.reactions && result) {
          try {
            // if (message.reactions.after) {
            //   setTimeout((rsl,rct) =>{
            //     rsl.react(rct);
            //   }, 1000, result, message.reactions.after); // removido pq faz reagir na imagem enviada...
            // }

            // Store message ID for potential future reactions
            if (message.metadata) {
              message.metadata.messageId = result.id._serialized;
            }
          } catch (reactError) {
            this.logger.error('Error applying reaction to message:', reactError);
          }
        }

        results.push(result);
      }

      return results;
    } catch (error) {
      this.logger.error('Error sending ReturnMessages:', error);
      throw error;
    }
  }

  /**
   * Cria um objeto de mídia a partir de um caminho de arquivo
   * @param {string} filePath - Caminho para o arquivo de mídia
   * @returns {Promise<MessageMedia>} - O objeto de mídia
   */
  async createMedia(filePath) {
    try {
      return MessageMedia.fromFilePath(filePath);
    } catch (error) {
      this.logger.error(`Erro ao criar mídia de ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Verifica se um usuário é administrador em um grupo
   * @param {string} userId - ID do usuário a verificar
   * @param {string} groupId - ID do grupo
   * @returns {Promise<boolean>} - True se o usuário for admin
   */
  async isUserAdminInGroup(userId, groupId) {
    try {
      // Obtém o objeto de grupo do banco de dados
      const group = await this.database.getGroup(groupId);
      if (!group) return false;
      
      // Obtém o objeto de chat
      let chat = null;
      try {
        chat = await this.client.getChatById(groupId);
      } catch (chatError) {
        this.logger.error(`Erro ao obter chat para verificação de admin: ${chatError.message}`);
      }
      
      // Utiliza o AdminUtils para verificar
      return await this.adminUtils.isAdmin(userId, group, chat, this.client);
    } catch (error) {
      this.logger.error(`Erro ao verificar se usuário ${userId} é admin no grupo ${groupId}:`, error);
      return false;
    }
  }

  /**
   * Destrói o cliente WhatsApp
   */
  async destroy() {
    this.logger.info(`Destruindo instância de bot ${this.id}`);
    
    // Limpa loadReport
    if (this.loadReport) {
      this.loadReport.destroy();
    }
    
    // Limpa sistema de convites
    if (this.inviteSystem) {
      this.inviteSystem.destroy();
    }

    // Limpa StreamSystem
    if (this.streamSystem) {
      this.streamSystem.destroy();
      this.streamSystem = null;
      this.streamMonitor = null;
    }
    
    // Envia notificação de desligamento para o grupo de logs
    if (this.grupoLogs && this.isConnected) {
      try {
        const shutdownMessage = `🔌 Bot ${this.id} desligando em ${new Date().toLocaleString()}`;
        await this.sendMessage(this.grupoLogs, shutdownMessage);
      } catch (error) {
        this.logger.error('Erro ao enviar notificação de desligamento:', error);
      }
    }

    await sleep(5000);
    
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.isConnected = false;
    }
  }
}

module.exports = WhatsAppBot;