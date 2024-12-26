import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { 
  Experimental_LanguageModelV1Middleware as LanguageModelV1Middleware,
  LanguageModelV1StreamPart 
} from 'ai';

export class PineconeService {
  private pinecone: Pinecone | null = null;
  private index: any = null;
  private embedModel: any = null;

  constructor() {
    this.initialize();
  }

  private async initialize() {
    if (!this.pinecone) {
      this.pinecone = new Pinecone({
        apiKey:'pcsk_48pNCi_7z4viPmEujayoK2jtyFKXXY5uMFR5jMaPYnANZ9GRCQvtVd77jPaT8k6kMwzd6G'
      });

      this.index = this.pinecone.index('bit');
      
      const genAI = new GoogleGenerativeAI('AIzaSyDd0ktqwKnFOfaQCU0dryXuhcnhiuybXFQ');
      this.embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    }
  }

  async findSources(text: string) {
    try {
      if (!this.embedModel || !this.index) {
        await this.initialize();
      }

      const embeddingResult = await this.embedModel.embedContent(text);
      
      

      const queryResponse = await this.index.namespace('default').query({
        vector: embeddingResult.embedding.values,
        topK: 3,
        includeMetadata: true,
        
      });
      console.log('Query response:', queryResponse.matches[0].metadata.content);
      if (!queryResponse?.matches) {
        console.log('No matches found in query response');
        return [];
      }

      return queryResponse.matches
        .filter(match => match?.metadata?.content)
        .map(match => match.metadata.content);

    } catch (error) {
      console.error('Error in findSources:', error);
      return [];
    }
  }
}

const pineconeService = new PineconeService();

function getLastUserMessageText({ prompt }: { prompt: any[] }) {
  const userMessages = prompt.filter(msg => msg.role === 'user');
  const lastMessage = userMessages[userMessages.length - 1];
  
  if (!lastMessage?.content) return null;
  
  if (typeof lastMessage.content === 'string') {
    return lastMessage.content;
  }
  
  if (Array.isArray(lastMessage.content)) {
    return lastMessage.content
      .map(item => typeof item === 'string' ? item : item?.text || '')
      .join(' ');
  }
  
  return null;
}

export const pineconeMiddleware: LanguageModelV1Middleware = {
  transformParams: async ({ params }) => {
    try {
      const lastUserMessageText = getLastUserMessageText({ prompt: params.prompt });
      if (!lastUserMessageText) {
        console.log('No user message found');
        return params;
      }

      const sources = await pineconeService.findSources(lastUserMessageText);
      if (!sources.length) {
        console.log('No sources found');
        return params;
      }

      const context = sources.map(chunk => JSON.stringify(chunk)).join('\n');
      
      return {
        ...params,
        prompt: [
          {
            role: 'system',
            content: `Use this information to answer the question:\n${context}`
          },
          ...params.prompt
        ]
      };
    } catch (error) {
      console.error('Error in transformParams:', error);
      return params;
    }
  },

  wrapStream: async ({ doStream, params }) => {
    try {
      const { stream, ...rest } = await doStream();

      let generatedText = '';
      const transformStream = new TransformStream<
        LanguageModelV1StreamPart,
        LanguageModelV1StreamPart
      >({
        transform(chunk, controller) {
          if (chunk.type === 'text-delta') {
            generatedText += chunk.textDelta;
          }
          controller.enqueue(chunk);
        },
        flush() {
          console.log('Generated text:', generatedText);
        },
      });

      return {
        stream: stream.pipeThrough(transformStream),
        ...rest,
      };
    } catch (error) {
      console.error('Error in stream middleware:', error);
      return await doStream();
    }
  }
};

export default pineconeMiddleware;