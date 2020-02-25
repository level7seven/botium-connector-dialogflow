const util = require('util')
const uuidV1 = require('uuid/v1')
const mime = require('mime-types')
const dialogflow = require('dialogflow')
const _ = require('lodash')
const debug = require('debug')('botium-connector-dialogflow')

const { importDialogflowIntents, importDialogflowConversations } = require('./src/dialogflowintents')
const { extractIntentUtterances, trainIntentUtterances, cleanupIntentUtterances } = require('./src/nlp')

const structjson = require('./structjson')

const Capabilities = {
  DIALOGFLOW_PROJECT_ID: 'DIALOGFLOW_PROJECT_ID',
  DIALOGFLOW_CLIENT_EMAIL: 'DIALOGFLOW_CLIENT_EMAIL',
  DIALOGFLOW_PRIVATE_KEY: 'DIALOGFLOW_PRIVATE_KEY',
  DIALOGFLOW_LANGUAGE_CODE: 'DIALOGFLOW_LANGUAGE_CODE',
  DIALOGFLOW_INPUT_CONTEXT_NAME: 'DIALOGFLOW_INPUT_CONTEXT_NAME',
  DIALOGFLOW_INPUT_CONTEXT_LIFESPAN: 'DIALOGFLOW_INPUT_CONTEXT_LIFESPAN',
  DIALOGFLOW_INPUT_CONTEXT_PARAMETERS: 'DIALOGFLOW_INPUT_CONTEXT_PARAMETERS',
  DIALOGFLOW_OUTPUT_PLATFORM: 'DIALOGFLOW_OUTPUT_PLATFORM',
  DIALOGFLOW_FORCE_INTENT_RESOLUTION: 'DIALOGFLOW_FORCE_INTENT_RESOLUTION',
  DIALOGFLOW_BUTTON_EVENTS: 'DIALOGFLOW_BUTTON_EVENTS',
  DIALOGFLOW_ENABLE_KNOWLEDGEBASE: 'DIALOGFLOW_ENABLE_KNOWLEDGEBASE',
  DIALOGFLOW_FALLBACK_INTENTS: 'DIALOGFLOW_FALLBACK_INTENTS'
}

const Defaults = {
  [Capabilities.DIALOGFLOW_LANGUAGE_CODE]: 'en-US',
  [Capabilities.DIALOGFLOW_FORCE_INTENT_RESOLUTION]: true,
  [Capabilities.DIALOGFLOW_BUTTON_EVENTS]: true,
  [Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE]: false,
  [Capabilities.DIALOGFLOW_FALLBACK_INTENTS]: ['Default Fallback Intent']
}

class BotiumConnectorDialogflow {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps
  }

  Validate () {
    debug('Validate called')
    this.caps = Object.assign({}, Defaults, this.caps)

    if (!this.caps[Capabilities.DIALOGFLOW_PROJECT_ID]) throw new Error('DIALOGFLOW_PROJECT_ID capability required')
    if (!this.caps[Capabilities.DIALOGFLOW_CLIENT_EMAIL]) throw new Error('DIALOGFLOW_CLIENT_EMAIL capability required')
    if (!this.caps[Capabilities.DIALOGFLOW_PRIVATE_KEY]) throw new Error('DIALOGFLOW_PRIVATE_KEY capability required')

    if (!_.isArray(this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE]) && !_.isBoolean(this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE] && !_.isString(this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE]))) throw new Error('DIALOGFLOW_ENABLE_KNOWLEDGEBASE capability has to be an array of knowledge base identifiers, or a boolean')
    if (_.isString(this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE])) {
      this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE] = this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE] === 'true'
    }

    const contextSuffixes = this._getContextSuffixes()
    contextSuffixes.forEach((contextSuffix) => {
      if (!this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_NAME + contextSuffix] || !this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_LIFESPAN + contextSuffix]) {
        throw new Error(`DIALOGFLOW_INPUT_CONTEXT_NAME${contextSuffix} and DIALOGFLOW_INPUT_CONTEXT_LIFESPAN${contextSuffix} capability required`)
      }
    })
    return Promise.resolve()
  }

  Build () {
    debug('Build called')
    this.sessionOpts = {
      credentials: {
        client_email: this.caps[Capabilities.DIALOGFLOW_CLIENT_EMAIL],
        private_key: this.caps[Capabilities.DIALOGFLOW_PRIVATE_KEY]
      }
    }
    return Promise.resolve()
  }

  async Start () {
    debug('Start called')

    this.conversationId = uuidV1()
    this.queryParams = {}

    if (_.isBoolean(this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE]) && this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE]) {
      this.kbClient = new dialogflow.v2beta1.KnowledgeBasesClient(Object.assign({}, this.sessionOpts, {
        projectPath: this.caps[Capabilities.DIALOGFLOW_PROJECT_ID]
      }))
      const formattedParent = this.kbClient.projectPath(this.caps[Capabilities.DIALOGFLOW_PROJECT_ID])
      const [resources] = await this.kbClient.listKnowledgeBases({
        parent: formattedParent
      })
      this.kbNames = resources && resources.map(r => r.name)
    } else if (_.isArray(this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE])) {
      this.kbNames = this.caps[Capabilities.DIALOGFLOW_ENABLE_KNOWLEDGEBASE]
    }

    if (this.kbNames && this.kbNames.length > 0) {
      debug(`Using Dialogflow Knowledge Bases ${util.inspect(this.kbNames)}, switching to v2beta1 version of Dialogflow API`)
      this.sessionClient = new dialogflow.v2beta1.SessionsClient(this.sessionOpts)
      this.queryParams.knowledgeBaseNames = this.kbNames
    } else {
      this.sessionClient = new dialogflow.SessionsClient(this.sessionOpts)
    }

    this.sessionPath = this.sessionClient.sessionPath(this.caps[Capabilities.DIALOGFLOW_PROJECT_ID], this.conversationId)
    this.contextClient = new dialogflow.ContextsClient(this.sessionOpts)
    this.queryParams = {
      contexts: this._getContextSuffixes().map((c) => this._createInitialContext(c))
    }
    return Promise.resolve()
  }

  UserSays (msg) {
    debug('UserSays called')
    if (!this.sessionClient) return Promise.reject(new Error('not built'))

    const request = {
      session: this.sessionPath,
      queryInput: {
      }
    }
    if (this.caps[Capabilities.DIALOGFLOW_BUTTON_EVENTS] && msg.buttons && msg.buttons.length > 0 && (msg.buttons[0].text || msg.buttons[0].payload)) {
      let payload = msg.buttons[0].payload || msg.buttons[0].text
      try {
        payload = JSON.parse(payload)
        request.queryInput.event = Object.assign({}, { languageCode: this.caps[Capabilities.DIALOGFLOW_LANGUAGE_CODE] }, payload)
      } catch (err) {
        request.queryInput.event = {
          name: payload,
          languageCode: this.caps[Capabilities.DIALOGFLOW_LANGUAGE_CODE]
        }
      }
    } else {
      request.queryInput.text = {
        text: msg.messageText,
        languageCode: this.caps[Capabilities.DIALOGFLOW_LANGUAGE_CODE]
      }
    }

    const customContexts = this._extractCustomContexts(msg)
    // this.queryParams.contexts may contain a value just the first time.
    customContexts.forEach(customContext => {
      const index = this.queryParams.contexts.findIndex(c => c.name === customContext.name)
      if (index >= 0) {
        this.queryParams.contexts[index] = customContext
      } else {
        this.queryParams.contexts.push(customContext)
      }
    })

    const mergeQueryParams = {}
    if (msg.SET_DIALOGFLOW_QUERYPARAMS) {
      Object.assign(mergeQueryParams, msg.SET_DIALOGFLOW_QUERYPARAMS)
    }

    request.queryParams = Object.assign({}, this.queryParams, mergeQueryParams)
    debug(`dialogflow request: ${JSON.stringify(request, null, 2)}`)

    return this.sessionClient.detectIntent(request)
      .then((responses) => {
        this.queryParams.contexts = []
        const response = responses[0]

        response.queryResult.outputContexts.forEach(context => {
          context.parameters = structjson.jsonToStructProto(
            structjson.structProtoToJson(context.parameters)
          )
        })
        debug(`dialogflow response: ${JSON.stringify(response, null, 2)}`)

        const nlp = {
          intent: this._extractIntent(response),
          entities: this._extractEntities(response)
        }
        let fulfillmentMessages = response.queryResult.fulfillmentMessages.filter(f =>
          (this.caps[Capabilities.DIALOGFLOW_OUTPUT_PLATFORM] && f.platform === this.caps[Capabilities.DIALOGFLOW_OUTPUT_PLATFORM]) ||
          (!this.caps[Capabilities.DIALOGFLOW_OUTPUT_PLATFORM] && (f.platform === 'PLATFORM_UNSPECIFIED' || !f.platform))
        )

        // use default if platform specific is not found
        if (!fulfillmentMessages.length && this.caps[Capabilities.DIALOGFLOW_OUTPUT_PLATFORM]) {
          fulfillmentMessages = response.queryResult.fulfillmentMessages.filter(f =>
            (f.platform === 'PLATFORM_UNSPECIFIED' || !f.platform))
        }

        let forceIntentResolution = this.caps[Capabilities.DIALOGFLOW_FORCE_INTENT_RESOLUTION]
        fulfillmentMessages.forEach((fulfillmentMessage) => {
          let acceptedResponse = true
          const botMsg = { sender: 'bot', sourceData: response.queryResult, nlp }
          if (fulfillmentMessage.text) {
            botMsg.messageText = fulfillmentMessage.text.text[0]
          } else if (fulfillmentMessage.simpleResponses) {
            botMsg.messageText = fulfillmentMessage.simpleResponses.simpleResponses[0].textToSpeech
          } else if (fulfillmentMessage.image) {
            botMsg.media = [{
              mediaUri: fulfillmentMessage.image.imageUri,
              mimeType: mime.lookup(fulfillmentMessage.image.imageUri) || 'application/unknown'
            }]
          } else if (fulfillmentMessage.quickReplies) {
            botMsg.buttons = fulfillmentMessage.quickReplies.quickReplies.map((q) => ({ text: q }))
          } else if (fulfillmentMessage.card) {
            botMsg.messageText = fulfillmentMessage.card.title
            botMsg.cards = [{
              text: fulfillmentMessage.card.title,
              image: fulfillmentMessage.card.imageUri && {
                mediaUri: fulfillmentMessage.card.imageUri,
                mimeType: mime.lookup(fulfillmentMessage.card.imageUri) || 'application/unknown'
              },
              buttons: fulfillmentMessage.card.buttons && fulfillmentMessage.card.buttons.map((q) => ({ text: q.text, payload: q.postback }))
            }]
          } else if (fulfillmentMessage.basicCard) {
            botMsg.messageText = fulfillmentMessage.basicCard.title
            botMsg.cards = [{
              text: fulfillmentMessage.basicCard.title,
              image: fulfillmentMessage.basicCard.image && {
                mediaUri: fulfillmentMessage.basicCard.image.imageUri,
                mimeType: mime.lookup(fulfillmentMessage.basicCard.image.imageUri) || 'application/unknown',
                altText: fulfillmentMessage.basicCard.image.accessibilityText
              },
              buttons: fulfillmentMessage.basicCard.buttons && fulfillmentMessage.basicCard.buttons.map((q) => ({ text: q.title, payload: q.openUriAction && q.openUriAction.uri }))
            }]
          } else if (fulfillmentMessage.listSelect) {
            botMsg.messageText = fulfillmentMessage.listSelect.title
            botMsg.cards = fulfillmentMessage.listSelect.items.map(item => ({
              text: item.title,
              subtext: item.description,
              image: item.image && {
                mediaUri: item.image.imageUri,
                mimeType: mime.lookup(item.image.imageUri) || 'application/unknown',
                altText: item.image.accessibilityText
              },
              buttons: item.info && item.info.key && [{ text: item.info.key }]
            }))
          } else if (fulfillmentMessage.carouselSelect) {
            botMsg.cards = fulfillmentMessage.carouselSelect.items.map(item => ({
              text: item.title,
              subtext: item.description,
              image: item.image && {
                mediaUri: item.image.imageUri,
                mimeType: mime.lookup(item.image.imageUri) || 'application/unknown',
                altText: item.image.accessibilityText
              },
              buttons: item.info && item.info.key && [{ text: item.info.key }]
            }))
          } else if (fulfillmentMessage.suggestions) {
            botMsg.buttons = fulfillmentMessage.suggestions.suggestions && fulfillmentMessage.suggestions.suggestions.map((q) => ({ text: q.title }))
          } else if (fulfillmentMessage.linkOutSuggestion) {
            botMsg.buttons = [{ text: fulfillmentMessage.linkOutSuggestion.destinationName, payload: fulfillmentMessage.linkOutSuggestion.uri }]
          } else {
            acceptedResponse = false
          }
          if (acceptedResponse) {
            setTimeout(() => this.queueBotSays(botMsg), 0)
            forceIntentResolution = false
          }
        })

        if (forceIntentResolution) {
          setTimeout(() => this.queueBotSays({ sender: 'bot', sourceData: response.queryResult, nlp }), 0)
        }
      }).catch((err) => {
        debug(err)
        throw new Error(`Cannot send message to dialogflow container: ${err.message}`)
      })
  }

  Stop () {
    debug('Stop called')
    this.sessionClient = null
    this.sessionPath = null
    this.queryParams = null
    return Promise.resolve()
  }

  Clean () {
    debug('Clean called')
    this.sessionOpts = null
    return Promise.resolve()
  }

  _createInitialContext (contextSuffix) {
    return {
      name: this.contextClient.contextPath(this.caps[Capabilities.DIALOGFLOW_PROJECT_ID], this.conversationId, this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_NAME + contextSuffix]),
      lifespanCount: parseInt(this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_LIFESPAN + contextSuffix]),
      parameters: this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_PARAMETERS + contextSuffix] &&
        structjson.jsonToStructProto(this.caps[Capabilities.DIALOGFLOW_INPUT_CONTEXT_PARAMETERS + contextSuffix])
    }
  }

  _getContextSuffixes () {
    const suffixes = []
    const contextNameCaps = _.pickBy(this.caps, (v, k) => k.startsWith(Capabilities.DIALOGFLOW_INPUT_CONTEXT_NAME))
    _(contextNameCaps).keys().sort().each((key) => {
      suffixes.push(key.substring(Capabilities.DIALOGFLOW_INPUT_CONTEXT_NAME.length))
    })
    return suffixes
  }

  _extractCustomContexts (msg) {
    const result = []
    if (msg.SET_DIALOGFLOW_CONTEXT) {
      _.keys(msg.SET_DIALOGFLOW_CONTEXT).forEach(contextName => {
        const val = msg.SET_DIALOGFLOW_CONTEXT[contextName]
        if (_.isObject(val)) {
          result.push(this._createCustomContext(contextName, val.lifespan, val.parameters))
        } else {
          result.push(this._createCustomContext(contextName, val))
        }
      })
    }
    return result
  }

  _createCustomContext (contextName, contextLifespan, contextParameters) {
    const contextPath = this.contextClient.contextPath(this.caps[Capabilities.DIALOGFLOW_PROJECT_ID],
      this.conversationId, contextName)
    try {
      contextLifespan = parseInt(contextLifespan)
    } catch (err) {
      contextLifespan = 1
    }

    const context = {
      name: contextPath,
      lifespanCount: contextLifespan
    }
    if (contextParameters) {
      context.parameters = structjson.jsonToStructProto(contextParameters)
    }
    return context
  }

  _extractIntent (response) {
    if (response.queryResult.intent) {
      return {
        name: response.queryResult.intent.displayName,
        confidence: response.queryResult.intentDetectionConfidence,
        incomprehension: this.caps.DIALOGFLOW_FALLBACK_INTENTS.includes(response.queryResult.intent.displayName) ? true : undefined
      }
    }
    return {}
  }

  _extractEntities (response) {
    if (response.queryResult.parameters && response.queryResult.parameters.fields) {
      return this._extractEntitiesFromFields('', response.queryResult.parameters.fields)
    }
    return []
  }

  _extractEntitiesFromFields (keyPrefix, fields) {
    return Object.keys(fields).reduce((entities, key) => {
      return entities.concat(this._extractEntityValues(`${keyPrefix ? keyPrefix + '.' : ''}${key}`, fields[key]))
    }, [])
  }

  _extractEntityValues (key, field) {
    if (['numberValue', 'stringValue', 'boolValue', 'nullValue'].indexOf(field.kind) >= 0) {
      const value = field[field.kind]
      if (!_.isNil(value) && (!_.isString(value) || value.length)) {
        return [{
          name: key,
          value: `${field[field.kind]}`
        }]
      }
      return []
    }
    if (field.kind === 'structValue') {
      return this._extractEntitiesFromFields(key, field.structValue.fields)
    }
    if (field.kind === 'listValue') {
      if (field.listValue.values && field.listValue.values.length > 0) {
        return field.listValue.values.reduce((entities, lv, i) => {
          return entities.concat(this._extractEntityValues(`${key}.${i}`, lv))
        }, [])
      } else {
        return []
      }
    }
    debug(`Unsupported entity kind ${field.kind}, skipping entity.`)
    return []
  }
}

module.exports = {
  PluginVersion: 1,
  PluginClass: BotiumConnectorDialogflow,
  Utils: {
    importDialogflowIntents,
    importDialogflowConversations
  },
  NLP: {
    ExtractIntentUtterances: extractIntentUtterances,
    TrainIntentUtterances: trainIntentUtterances,
    CleanupIntentUtterances: cleanupIntentUtterances
  }
}
