import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import type {
  Experimental_LanguageModelV1Middleware as LanguageModelV1Middleware,
  LanguageModelV1StreamPart,
} from 'ai';

export class PineconeMiddleware {
  private pinecone: Pinecone | null = null;
  private index: any = null;
  private embedModel: any = null;
  private options: {
    indexName: string;
    indexHost: string;
    namespace: string;
    maxRetries: number;
    retryDelay: number;
    debugMode: boolean;
  };

  constructor(options = {}) {
    this.options = {
      indexName: 'bit',
      indexHost: "https://bit-gc4i8jv.svc.aped-4627-b74a.pinecone.io",
      namespace: 'default',
      maxRetries: 3,
      retryDelay: 1000,
      debugMode: false,
      ...options
    };
  }

  async initialize() {
   

    if (!this.pinecone) {
      this.pinecone = new Pinecone({
        apiKey: 'pcsk_48pNCi_7z4viPmEujayoK2jtyFKXXY5uMFR5jMaPYnANZ9GRCQvtVd77jPaT8k6kMwzd6G',
      });

      this.index = this.pinecone.index(this.options.indexName, this.options.indexHost);
      
      const genAI = new GoogleGenerativeAI('AIzaSyDd0ktqwKnFOfaQCU0dryXuhcnhiuybXFQ');
      this.embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    }
  }

  private async generateEmbedding(text: string) {
    if (!this.embedModel) {
      throw new Error('Embed model not initialized');
    }
    const result = await this.embedModel.embedContent(text);
    return result.embedding.values;
  }

  

  private extractUserQuery(params: any): string {
    if (!params?.prompt?.length) {
      console.log('No prompt array found in params:', params);
      return '';
    }
    const userMessages = params.prompt.filter((msg: any) => msg.role === 'user');
    if (!userMessages.length) {
      console.log('No user messages found');
      return '';
    }
  
    const lastUserMessage = userMessages[userMessages.length - 1];
    console.log('Processing last user message:', lastUserMessage);
  
    if (lastUserMessage.content && Array.isArray(lastUserMessage.content)) {
      return lastUserMessage.content
        .map(item => {
          if (typeof item === 'string') return item;
          if (typeof item === 'object' && item !== null) {
            return item.text || '';
          }
          return '';
        })
        .filter(Boolean)
        .join(' ')
        .trim();
    }
  
    if (typeof lastUserMessage.content === 'string') {
      return lastUserMessage.content.trim();
    }
  
    if (typeof lastUserMessage.content === 'object' && lastUserMessage.content !== null) {
      return (lastUserMessage.content.text || '').trim();
    }
  
    console.log('Unhandled content type:', typeof lastUserMessage.content);
    return '';
  }

 
  private async retrieveContext(query: string): Promise<string[]> {
    if (!this.index) {
      throw new Error('Pinecone index not initialized');
    }

    try {
      const queryEmbedding = await this.generateEmbedding(query);
      const searchResults = await this.index.namespace('default').query({
        vector: queryEmbedding,
        topK: 2,
        includeMetadata: true,
        includeValues: true
      });
      console.log('Search results:', searchResults.matches);
      if (!searchResults.matches || !Array.isArray(searchResults.matches)) {
        return [];
      }
      
      return searchResults.matches.map(match => 
        match.metadata?.content || ''
      ).filter(content => content !== '');
    } catch (error) {
      console.error('Error retrieving context:', error);
      return [];
    }
  }private generateSystemPrompt(contextData: string[], userQuery: string): string {
  
    const basePrompt = `You are a helpful AI assistant. You should:
  1. Provide relevant, natural responses to user queries
  2. Only use the provided context if it is directly relevant to the user's question
  3. If the context is not relevant to the query, respond based on your general knowledge
  4. Never force irrelevant context into your responses
  5. Keep responses concise and focused on what the user is actually asking
  
  USER QUERY:
  ${userQuery}
  
  CONTEXT EVALUATION INSTRUCTIONS:
  - First, evaluate if the following context is relevant to the user's query
  - Only use the context if it directly relates to what the user is asking
  - If the context is not relevant, ignore it and respond naturally to the user
  
  AVAILABLE CONTEXT:
  ${contextData.join('\n')}
  
  RESPONSE GUIDELINES:
  - If the context is relevant: Use it to provide accurate, specific information
  - If the context is not relevant: Respond naturally without mentioning the context
  - For greetings or casual conversation: Respond in a friendly, conversational way
  - Keep the tone warm and helpful
  - Stay focused on the user's actual query
  - Don't force connections to the context if they're not clearly relevant`;
  
    return basePrompt;
  }
  async wrapStream({ doStream, params }: {
    doStream: (newParams?: any) => Promise<{
      stream: ReadableStream<LanguageModelV1StreamPart>;
      rawCall: { rawPrompt: any; rawSettings: any };
    }>,
    params: any
  }) {
    try {
      await this.initialize();
  
      if (this.options.debugMode) {
        console.log('Incoming params:', JSON.stringify(params, null, 2));
      }
  
      let userQuery = this.extractUserQuery(params);
      console.log('User query:', userQuery);
      // Validate user query
      if (!userQuery || userQuery.trim().length === 0) {
        console.log('Empty user query, falling back to original stream');
        return await doStream(params);
      }
      
      userQuery = userQuery.trim();
      const contextData = await this.retrieveContext(userQuery);
      
      if (this.options.debugMode) {
        console.log('Retrieved context:', contextData);
      }
      
        if (!contextData || contextData.length === 0) {
          console.log('No context found, using original stream');
          return await doStream(params);
        }
  
      const systemPrompt = this.generateSystemPrompt(contextData, userQuery);

      return {
        stream: new ReadableStream({
          async start(controller) {
            try {
              const google = createGoogleGenerativeAI({
                apiKey: 'AIzaSyDd0ktqwKnFOfaQCU0dryXuhcnhiuybXFQ'
              });
              
              const result = await generateText({
                model: google('gemini-2.0-flash-exp'),
                prompt: userQuery,
                system: systemPrompt,
                topP: 0.7, 
              });
              
              if (!result || !result.text) {
                throw new Error('Empty response from Gemini');
              }
              
              const text = result.text;
              
              controller.enqueue({
                type: 'response-metadata',
                timestamp: new Date(),
              });

             
              const chunks = text.match(/[^.!?]+[.!?]+/g) || [text];
              for (const chunk of chunks) {
                controller.enqueue({
                  type: 'text-delta',
                  textDelta: chunk.trim() + ' ',
                });
                await new Promise(resolve => setTimeout(resolve, 50));
              }
              
              controller.close();
            } catch (error) {
              console.error('Error generating response:', error);
              controller.error(error);
            }
          }
        }),
        rawCall: { 
          rawPrompt: systemPrompt,
          rawSettings: {
            temperature: 0.7,
            maxTokens: 1000,
            topP: 0.9
          }
        }
      };
    } catch (error) {
      console.error('Error in PineconeMiddleware:', error);
      return await doStream(params);
    }
  }
}

export const pineconeMiddleware: LanguageModelV1Middleware = {
  wrapStream: async ({ doStream, params }) => {
    try {
      const wrapper = new PineconeMiddleware();
      return await wrapper.wrapStream({ 
        doStream: async () => {
          return await doStream();
        },
        params 
      });
    } catch (error) {
      console.error('Middleware stream error:', error);
      return await doStream();
    }
  }
};

export default pineconeMiddleware;